#!/usr/bin/env node
/* global process, console */
import { execFile } from 'node:child_process';
import { lstat, readdir, readFile, realpath, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Verification receipts are evidence: `merge:pr` looks one up by exact head, and
 * a merge record names the receipt it spent. They are also never collected, so a
 * working checkout accumulates one receipt and one log directory per run
 * (roughly a megabyte each) forever.
 *
 * This script is the opt-in answer. It never runs from `verify:local`, it is a
 * dry run unless `--apply` is passed, and it deletes only receipts whose head is
 * neither the current HEAD, a branch or tag tip, nor named by a merge record or
 * `latest.json`, and that are not among the newest `--keep` runs. Keeping branch
 * tips is what protects an unmerged but already verified PR: its receipt is the
 * one `merge:pr` will look up when the merge finally happens. `latest.json`,
 * `merges/` and the review capsules are never touched. An unreadable merge
 * record, receipt or latest pointer makes it refuse instead of guessing, because
 * the keep-set is the only thing that makes the deletion safe.
 */

const RECEIPT_PATTERN = /^(?<head>[0-9a-f]{12})-(?<verificationId>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/;
const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/;

/**
 * Splits receipts into what may stay and what is superseded. A receipt is kept
 * when its head is the current HEAD, when the head is still a branch or tag tip,
 * when a merge record spent it, when `latest.json` points at it, or when it is
 * one of the newest `keepRecent` runs. `keepRecent` is a floor, not a target: a
 * protected receipt is kept even when it is older than the newest runs.
 */
export function planEvidencePrune({
  receipts,
  mergeVerificationIds,
  latestVerificationId,
  protectedHeadShas,
  currentHeadSha,
  keepRecent = 5,
}) {
  const ordered = [...receipts].sort((left, right) => right.completedAt.localeCompare(left.completedAt));
  const recent = new Set(ordered.slice(0, Math.max(0, keepRecent)).map((receipt) => receipt.fileName));
  const keep = [];
  const remove = [];
  for (const receipt of receipts) {
    let reason;
    if (receipt.headSha === currentHeadSha) reason = 'current-head';
    else if (protectedHeadShas?.has(receipt.headSha)) reason = 'branch-tip';
    else if (mergeVerificationIds.has(receipt.verificationId)) reason = 'merge-record';
    else if (receipt.verificationId === latestVerificationId) reason = 'latest';
    else if (recent.has(receipt.fileName)) reason = 'recent';
    const entry = {
      fileName: receipt.fileName,
      verificationId: receipt.verificationId,
      headSha: receipt.headSha,
      reason: reason ?? 'superseded',
    };
    (reason === undefined ? remove : keep).push(entry);
  }
  const byName = (left, right) => left.fileName.localeCompare(right.fileName);
  return { keep: keep.sort(byName), remove: remove.sort(byName) };
}

async function listDirectory(directory) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function readJson(filePath) {
  try {
    return { ok: true, value: JSON.parse(await readFile(filePath, 'utf8')) };
  } catch (error) {
    return { ok: false, error };
  }
}

async function lstatOrUndefined(filePath) {
  try {
    return await lstat(filePath);
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * Removes one `logs/<verificationId>` entry. A symlink is unlinked rather than
 * followed, so a planted link cannot redirect a recursive delete outside the
 * evidence root.
 */
async function removeLogDirectory(logRoot, verificationId) {
  const target = path.join(logRoot, verificationId);
  const stats = await lstatOrUndefined(target);
  if (stats === undefined) return;
  if (stats.isSymbolicLink()) {
    await unlink(target);
    return;
  }
  if (stats.isDirectory()) await rm(target, { recursive: true, force: true });
}

export async function resolveProtectedHeads(root) {
  const [refs, worktrees] = await Promise.all([
    execFileAsync('git', ['-C', root, 'for-each-ref', '--format=%(objectname)'], { maxBuffer: 8 * 1024 * 1024 }),
    execFileAsync('git', ['-C', root, 'worktree', 'list', '--porcelain'], { maxBuffer: 8 * 1024 * 1024 }),
  ]);
  const heads = new Set(
    refs.stdout.split('\n').map((line) => line.trim()).filter((line) => FULL_SHA_PATTERN.test(line)),
  );
  for (const line of worktrees.stdout.split('\n')) {
    if (!line.startsWith('HEAD ')) continue;
    const sha = line.slice('HEAD '.length).trim();
    if (FULL_SHA_PATTERN.test(sha)) heads.add(sha);
  }
  return heads;
}

/**
 * Plans and, unless `dryRun`, deletes superseded receipts and their log
 * directories under `<root>/.unified-mpc/local-verify`.
 */
export async function pruneLocalVerifyEvidence({
  root,
  headSha,
  protectedHeadShas = [],
  keepRecent = 5,
  dryRun = false,
}) {
  const requestedRoot = path.join(root, '.unified-mpc', 'local-verify');
  const protectedHeads = protectedHeadShas instanceof Set ? protectedHeadShas : new Set(protectedHeadShas);

  // Deleting through a symlinked or dangling evidence root must never look like
  // "nothing to prune", so resolve the root before deciding anything.
  let receiptRoot;
  try {
    const resolvedRoot = await realpath(root);
    const requestedStats = await lstatOrUndefined(requestedRoot);
    if (requestedStats === undefined) {
      const metaStats = await lstatOrUndefined(path.join(root, '.unified-mpc'));
      if (metaStats !== undefined && !metaStats.isDirectory()) {
        return { status: 'refused', reason: 'local verification metadata root is not a real directory', keep: [], remove: [], dryRun };
      }
      return { status: 'missing', keep: [], remove: [], dryRun };
    }
    if (requestedStats.isSymbolicLink()) {
      return { status: 'refused', reason: 'local verification evidence root is a symlink', keep: [], remove: [], dryRun };
    }
    if (!requestedStats.isDirectory()) {
      return { status: 'refused', reason: 'local verification evidence root is not a real directory', keep: [], remove: [], dryRun };
    }
    receiptRoot = await realpath(requestedRoot);
    if (receiptRoot !== path.join(resolvedRoot, '.unified-mpc', 'local-verify')) {
      return { status: 'refused', reason: 'local verification evidence root is a symlink', keep: [], remove: [], dryRun };
    }
  } catch (error) {
    return {
      status: 'refused',
      reason: `cannot resolve local verification evidence root: ${error instanceof Error ? error.message : String(error)}`,
      keep: [],
      remove: [],
      dryRun,
    };
  }

  let entries;
  try {
    entries = await readdir(receiptRoot, { withFileTypes: true });
  } catch (error) {
    return {
      status: 'refused',
      reason: `cannot read local verification evidence root: ${error instanceof Error ? error.message : String(error)}`,
      keep: [],
      remove: [],
      dryRun,
    };
  }
  const logRoot = path.join(receiptRoot, 'logs');

  const mergesRoot = path.join(receiptRoot, 'merges');
  const mergesStats = await lstatOrUndefined(mergesRoot);
  if (mergesStats !== undefined && !mergesStats.isDirectory()) {
    return { status: 'refused', reason: 'merge records directory is not a real directory', keep: [], remove: [], dryRun };
  }
  const mergeEntries = await listDirectory(mergesRoot);
  const mergeVerificationIds = new Set();
  for (const entry of mergeEntries ?? []) {
    if (!entry.name.endsWith('.json')) continue;
    const record = await readJson(path.join(mergesRoot, entry.name));
    if (!record.ok || typeof record.value?.verificationId !== 'string') {
      return { status: 'refused', reason: `unreadable merge record: ${entry.name}`, keep: [], remove: [], dryRun };
    }
    mergeVerificationIds.add(record.value.verificationId);
  }

  const latest = await readJson(path.join(receiptRoot, 'latest.json'));
  let latestVerificationId;
  if (!latest.ok) {
    if (await lstatOrUndefined(path.join(receiptRoot, 'latest.json')) !== undefined) {
      return { status: 'refused', reason: 'unreadable latest receipt pointer', keep: [], remove: [], dryRun };
    }
  } else if (typeof latest.value?.verificationId === 'string') {
    latestVerificationId = latest.value.verificationId;
  } else {
    return { status: 'refused', reason: 'unreadable latest receipt pointer', keep: [], remove: [], dryRun };
  }

  const logRootStats = await lstatOrUndefined(logRoot);
  if (logRootStats !== undefined && !logRootStats.isDirectory()) {
    return { status: 'refused', reason: 'local verification log root is not a real directory', keep: [], remove: [], dryRun };
  }

  const receipts = [];
  for (const entry of entries) {
    if (entry.isDirectory()) continue;
    const match = RECEIPT_PATTERN.exec(entry.name);
    if (match === null) continue;
    const parsed = await readJson(path.join(receiptRoot, entry.name));
    if (!parsed.ok || typeof parsed.value?.headSha !== 'string' || typeof parsed.value?.completedAt !== 'string') {
      return { status: 'refused', reason: `unreadable receipt: ${entry.name}`, keep: [], remove: [], dryRun };
    }
    receipts.push({
      fileName: entry.name,
      headSha: parsed.value.headSha,
      verificationId: match.groups.verificationId,
      completedAt: parsed.value.completedAt,
    });
  }

  const plan = planEvidencePrune({
    receipts,
    mergeVerificationIds,
    latestVerificationId,
    protectedHeadShas: protectedHeads,
    currentHeadSha: headSha,
    keepRecent,
  });
  if (!dryRun) {
    for (const entry of plan.remove) {
      await rm(path.join(receiptRoot, entry.fileName), { force: true });
      await removeLogDirectory(logRoot, entry.verificationId);
    }
  }
  return { status: 'pruned', ...plan, dryRun };
}

function parseArguments(argv) {
  const options = { root: process.cwd(), keepRecent: 5, dryRun: true, protect: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') options.dryRun = false;
    else if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--keep') {
      const value = argv[index + 1];
      if (value === undefined) throw new Error('--keep requires a count');
      options.keepRecent = Number(value);
      if (!Number.isInteger(options.keepRecent) || options.keepRecent < 0) throw new Error('--keep requires a non-negative integer');
      index += 1;
    } else if (argument === '--protect') {
      const value = argv[index + 1];
      if (value === undefined) throw new Error('--protect requires a full commit SHA');
      if (!FULL_SHA_PATTERN.test(value)) throw new Error('--protect requires a full 40-character commit SHA');
      options.protect.push(value);
      index += 1;
    } else if (argument === '--root') {
      const value = argv[index + 1];
      if (value === undefined) throw new Error('--root requires a directory');
      options.root = path.resolve(value);
      index += 1;
    } else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const headSha = process.env.GIT_HEAD_SHA ?? process.env.UNIFIED_MPC_HEAD_SHA;
  if (typeof headSha !== 'string' || headSha.length === 0) {
    throw new Error('set GIT_HEAD_SHA to the current commit (for example: GIT_HEAD_SHA=$(git rev-parse HEAD))');
  }
  if (!FULL_SHA_PATTERN.test(headSha)) {
    throw new Error('GIT_HEAD_SHA must be the full 40-character commit SHA');
  }
  const protectedHeadShas = await resolveProtectedHeads(options.root);
  for (const sha of options.protect) protectedHeadShas.add(sha);
  const result = await pruneLocalVerifyEvidence({ ...options, headSha, protectedHeadShas });
  if (result.status === 'refused') {
    console.error(`evidence prune refused: ${result.reason}`);
    return 1;
  }
  if (result.status === 'missing') {
    console.log('no local verification evidence to prune');
    return 0;
  }
  const verb = result.dryRun ? 'would remove' : 'removed';
  for (const entry of result.remove) console.log(`${verb}: ${entry.fileName} (${entry.reason})`);
  console.log(
    `${verb} ${result.remove.length} receipt(s); kept ${result.keep.length}`
      + ` (${result.dryRun ? 'dry run, pass --apply to delete' : 'applied'})`,
  );
  return 0;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
