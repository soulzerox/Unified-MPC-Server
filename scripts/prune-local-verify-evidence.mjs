#!/usr/bin/env node
/* global process, console */
import { readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Verification receipts are evidence: `merge:pr` looks one up by exact head, and
 * a merge record names the receipt it spent. They are also never collected, so a
 * working checkout accumulates one receipt and one log directory per run
 * (roughly a megabyte each) forever.
 *
 * This script is the opt-in answer. It never runs from `verify:local`, it is a
 * dry run unless `--apply` is passed, and it deletes only receipts whose head is
 * neither the current HEAD nor named by a merge record and that are not among
 * the newest `--keep` runs. `latest.json`, `merges/` and the review capsules are
 * never touched. An unreadable merge record or receipt makes it refuse instead
 * of guessing, because the keep-set is the only thing that makes the deletion
 * safe.
 */

const RECEIPT_PATTERN = /^(?<head>[0-9a-f]{12})-(?<verificationId>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/;

/**
 * Splits receipts into what may stay and what is superseded. A receipt is kept
 * when its head is the current HEAD, when a merge record spent it, or when it is
 * one of the newest `keepRecent` runs. `keepRecent` is a floor, not a target: a
 * protected receipt is kept even when it is older than the newest runs.
 */
export function planEvidencePrune({ receipts, mergeVerificationIds, currentHeadSha, keepRecent = 5 }) {
  const ordered = [...receipts].sort((left, right) => right.completedAt.localeCompare(left.completedAt));
  const recent = new Set(ordered.slice(0, Math.max(0, keepRecent)).map((receipt) => receipt.fileName));
  const keep = [];
  const remove = [];
  for (const receipt of receipts) {
    let reason;
    if (receipt.headSha === currentHeadSha) reason = 'current-head';
    else if (mergeVerificationIds.has(receipt.verificationId)) reason = 'merge-record';
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

/**
 * Plans and, unless `dryRun`, deletes superseded receipts and their log
 * directories under `<root>/.unified-mpc/local-verify`.
 */
export async function pruneLocalVerifyEvidence({ root, headSha, keepRecent = 5, dryRun = false }) {
  const receiptRoot = path.join(root, '.unified-mpc', 'local-verify');
  const logRoot = path.join(receiptRoot, 'logs');
  const entries = await listDirectory(receiptRoot);
  if (entries === undefined) return { status: 'missing', keep: [], remove: [], dryRun };

  const mergeEntries = await listDirectory(path.join(receiptRoot, 'merges'));
  const mergeVerificationIds = new Set();
  for (const entry of mergeEntries ?? []) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const record = await readJson(path.join(receiptRoot, 'merges', entry.name));
    if (!record.ok || typeof record.value?.verificationId !== 'string') {
      return { status: 'refused', reason: `unreadable merge record: ${entry.name}`, keep: [], remove: [], dryRun };
    }
    mergeVerificationIds.add(record.value.verificationId);
  }

  const receipts = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
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

  const plan = planEvidencePrune({ receipts, mergeVerificationIds, currentHeadSha: headSha, keepRecent });
  if (!dryRun) {
    for (const entry of plan.remove) {
      await rm(path.join(receiptRoot, entry.fileName), { force: true });
      await rm(path.join(logRoot, entry.verificationId), { recursive: true, force: true });
    }
  }
  return { status: 'pruned', ...plan, dryRun };
}

function parseArguments(argv) {
  const options = { root: process.cwd(), keepRecent: 5, dryRun: true };
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
  const result = await pruneLocalVerifyEvidence({ ...options, headSha });
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
