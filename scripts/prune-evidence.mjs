#!/usr/bin/env node
/* global process, console */
import { execFile } from 'node:child_process';
import { lstat, readdir, readFile, realpath, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Verification receipts and exact-head review evidence are audit evidence:
 * `merge:pr` looks a verification receipt up by exact head, a merge record names
 * the receipt and the review a merge spent, and nothing ever collects either
 * store. A working checkout therefore accumulates one receipt plus one log
 * directory per verification run, and one capsule plus one receipt per review,
 * forever.
 *
 * This script is the opt-in answer for both stores. It never runs from
 * `verify:local`, it is a dry run unless `--apply` is passed, and it deletes only
 * entries whose head is neither the current HEAD, a branch, tag or worktree tip,
 * nor named by a merge record, and that are not among the newest `--keep` runs.
 * Keeping branch tips is what protects an unmerged but already verified PR: its
 * receipt is the one `merge:pr` will look up when the merge finally happens, and
 * its capsule is the review evidence that receipt already stands on. A
 * verification that was killed leaves a log directory with no receipt at all;
 * those are collected too, but only when the directory is older than every run
 * the plan keeps, so a verification that is still writing is never deleted.
 *
 * Both stores are planned before either one is touched, and `--apply` deletes
 * exactly the entries that were planned, so a refusal in one store stops the run
 * before the other loses anything and there is no second planning pass that could
 * discover a new reason to refuse after the first store is already pruned. The
 * deletion roots are checked for identity again immediately before deleting, so a
 * root replaced, created or removed after planning is refused. `latest.json` and
 * `merges/` are never deleted. The evidence roots, plus `merges/`, `logs/`,
 * `capsules/` and `receipts/`, must be real directories and deletion never
 * follows a symlink. An unreadable branch ref, merge record, receipt, capsule or
 * latest pointer makes it refuse instead of guessing, because the keep-set is the
 * only thing that makes the deletion safe.
 */

const VERIFICATION_RECEIPT_PATTERN = /^(?<head>[0-9a-f]{12})-(?<verificationId>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/;
const VERIFICATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/;

/**
 * Splits verification receipts into what may stay and what is superseded. A
 * receipt is kept when its head is the current HEAD, when the head is still a
 * branch or tag tip, when a merge record spent it, when `latest.json` points at
 * it, or when it is one of the newest `keepRecent` runs. `keepRecent` is a floor,
 * not a target: a protected receipt is kept even when it is older than the newest
 * runs.
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

/**
 * A review capsule and the receipt recorded against it describe one head, so
 * they are pruned as a unit: deleting the capsule of a receipt that stays would
 * leave the receipt pointing at evidence nobody can inspect any more. The key is
 * the head and the pull request, because a head can be reviewed more than once.
 *
 * Kept are the current head, heads that are still a branch, tag or worktree tip,
 * heads and reviews a merge record spent, and the newest `keepRecent` entries of
 * each kind. As in the verification plan, `keepRecent` is a floor.
 */
export function planReviewEvidencePrune({
  capsules,
  receipts,
  mergeReviewIds = new Set(),
  mergeHeadShas = new Set(),
  protectedHeadShas = new Set(),
  currentHeadSha,
  keepRecent = 5,
}) {
  const byNewest = (left, right) => right.createdAt.localeCompare(left.createdAt) || left.name.localeCompare(right.name);
  const recentKeys = new Set();
  for (const group of [capsules, receipts]) {
    for (const entry of [...group].sort(byNewest).slice(0, Math.max(0, keepRecent))) recentKeys.add(entry.key);
  }
  // A merge record protects the whole pair, whichever half names it: the record
  // carries the review id and the head, so a capsule is kept together with the
  // receipt that quotes it.
  const mergeProtectedKeys = new Set();
  for (const entry of [...capsules, ...receipts]) {
    if (mergeHeadShas.has(entry.headSha)) mergeProtectedKeys.add(entry.key);
    if (entry.reviewId !== undefined && mergeReviewIds.has(entry.reviewId)) mergeProtectedKeys.add(entry.key);
  }
  const keep = [];
  const remove = [];
  for (const entry of [
    ...capsules.map((capsule) => ({ ...capsule, kind: 'capsule' })),
    ...receipts.map((receipt) => ({ ...receipt, kind: 'receipt' })),
  ]) {
    let reason;
    if (entry.headSha === currentHeadSha) reason = 'current-head';
    else if (protectedHeadShas.has(entry.headSha)) reason = 'branch-tip';
    else if (mergeProtectedKeys.has(entry.key)) reason = 'merge-record';
    else if (recentKeys.has(entry.key)) reason = 'recent';
    const planned = {
      kind: entry.kind,
      name: entry.name,
      headSha: entry.headSha,
      prNumber: entry.prNumber,
      reason: reason ?? 'superseded',
    };
    (reason === undefined ? remove : keep).push(planned);
  }
  const byName = (left, right) => left.name.localeCompare(right.name) || left.kind.localeCompare(right.kind);
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

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Removes one directory entry below a store root. A symlink is unlinked rather
 * than followed, so a planted link cannot redirect a recursive delete outside
 * the evidence root.
 */
async function removeDirectoryEntry(directory, name) {
  const target = path.join(directory, name);
  const stats = await lstatOrUndefined(target);
  if (stats === undefined) return;
  if (stats.isSymbolicLink()) {
    await unlink(target);
    return;
  }
  if (stats.isDirectory()) await rm(target, { recursive: true, force: true });
}

/**
 * Resolves one evidence store. A missing store is a young checkout with nothing
 * to prune; everything else that stops this run from naming the real directory
 * is a refusal, because deleting through a symlinked or dangling root must never
 * look like "nothing to prune".
 */
async function resolveStoreRoot(root, segments, label) {
  const requested = path.join(root, ...segments);
  try {
    const resolvedRoot = await realpath(root);
    const requestedStats = await lstatOrUndefined(requested);
    if (requestedStats === undefined) {
      const metaStats = await lstatOrUndefined(path.join(root, '.unified-mpc'));
      if (metaStats !== undefined && !metaStats.isDirectory()) {
        return { status: 'refused', reason: `${label} metadata root is not a real directory` };
      }
      return { status: 'missing' };
    }
    if (requestedStats.isSymbolicLink()) {
      return { status: 'refused', reason: `${label} evidence root is a symlink` };
    }
    if (!requestedStats.isDirectory()) {
      return { status: 'refused', reason: `${label} evidence root is not a real directory` };
    }
    const resolvedStore = await realpath(requested);
    if (resolvedStore !== path.join(resolvedRoot, ...segments)) {
      return { status: 'refused', reason: `${label} evidence root is a symlink` };
    }
    return { status: 'ok', path: resolvedStore };
  } catch (error) {
    return { status: 'refused', reason: `cannot resolve ${label} evidence root: ${message(error)}` };
  }
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
 * A merge record is the only durable statement that a verification receipt and a
 * review were spent. Both stores consult it, and an unreadable record is a
 * refusal in both, because a keep-set guessed without it would delete evidence a
 * merge still names.
 */
async function readMergeProtectionFrom(mergesRoot) {
  const stats = await lstatOrUndefined(mergesRoot);
  if (stats !== undefined && !stats.isDirectory()) {
    return { status: 'refused', reason: 'merge records directory is not a real directory' };
  }
  const entries = await listDirectory(mergesRoot);
  const verificationIds = new Set();
  const reviewIds = new Set();
  const heads = new Set();
  for (const entry of entries ?? []) {
    if (!entry.name.endsWith('.json')) continue;
    const record = await readJson(path.join(mergesRoot, entry.name));
    if (!record.ok || typeof record.value?.verificationId !== 'string') {
      return { status: 'refused', reason: `unreadable merge record: ${entry.name}` };
    }
    verificationIds.add(record.value.verificationId);
    if (typeof record.value.reviewId === 'string') reviewIds.add(record.value.reviewId);
    if (typeof record.value.headSha === 'string') heads.add(record.value.headSha);
  }
  return { status: 'ok', verificationIds, reviewIds, heads };
}

const EMPTY_PROTECTION = { verificationIds: new Set(), reviewIds: new Set(), heads: new Set() };

/**
 * Plans which receipts and log directories under
 * `<root>/.unified-mpc/local-verify` may go. Planning is separate from deleting
 * because the command decides both stores before touching either one.
 */
export async function planLocalVerifyEvidence({
  root,
  headSha,
  protectedHeadShas = [],
  keepRecent = 5,
}) {
  const protectedHeads = protectedHeadShas instanceof Set ? protectedHeadShas : new Set(protectedHeadShas);
  const resolved = await resolveStoreRoot(root, ['.unified-mpc', 'local-verify'], 'local verification');
  if (resolved.status !== 'ok') {
    return { status: resolved.status, ...(resolved.reason === undefined ? {} : { reason: resolved.reason }), keep: [], remove: [] };
  }
  const receiptRoot = resolved.path;
  const logRoot = path.join(receiptRoot, 'logs');

  const protection = await readMergeProtectionFrom(path.join(receiptRoot, 'merges'));
  if (protection.status !== 'ok') {
    return { status: 'refused', reason: protection.reason, keep: [], remove: [] };
  }

  const latest = await readJson(path.join(receiptRoot, 'latest.json'));
  let latestVerificationId;
  if (!latest.ok) {
    if (await lstatOrUndefined(path.join(receiptRoot, 'latest.json')) !== undefined) {
      return { status: 'refused', reason: 'unreadable latest receipt pointer', keep: [], remove: [] };
    }
  } else if (typeof latest.value?.verificationId === 'string') {
    latestVerificationId = latest.value.verificationId;
  } else {
    return { status: 'refused', reason: 'unreadable latest receipt pointer', keep: [], remove: [] };
  }

  const logRootStats = await lstatOrUndefined(logRoot);
  if (logRootStats !== undefined && !logRootStats.isDirectory()) {
    return { status: 'refused', reason: 'local verification log root is not a real directory', keep: [], remove: [] };
  }

  let entries;
  try {
    entries = await readdir(receiptRoot, { withFileTypes: true });
  } catch (error) {
    return {
      status: 'refused',
      reason: `cannot read local verification evidence root: ${message(error)}`,
      keep: [],
      remove: [],
    };
  }

  const receipts = [];
  for (const entry of entries) {
    if (entry.isDirectory()) continue;
    const match = VERIFICATION_RECEIPT_PATTERN.exec(entry.name);
    if (match === null) continue;
    const parsed = await readJson(path.join(receiptRoot, entry.name));
    if (!parsed.ok || typeof parsed.value?.headSha !== 'string' || typeof parsed.value?.completedAt !== 'string') {
      return { status: 'refused', reason: `unreadable receipt: ${entry.name}`, keep: [], remove: [] };
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
    mergeVerificationIds: protection.verificationIds,
    latestVerificationId,
    protectedHeadShas: protectedHeads,
    currentHeadSha: headSha,
    keepRecent,
  });
  return {
    status: 'pruned',
    store: 'verification',
    targets: { receiptRoot, logRoot },
    guards: [await identityGuard(receiptRoot), await identityGuard(logRoot)],
    keep: plan.keep,
    remove: [...plan.remove, ...await planOrphanLogs({
      logRoot,
      receipts,
      mergeVerificationIds: protection.verificationIds,
      latestVerificationId,
      keepRecent,
    })].sort((left, right) => (left.fileName ?? left.verificationId).localeCompare(right.fileName ?? right.verificationId)),
  };
}

/**
 * A verification writes `logs/<verificationId>` while it runs and the receipt
 * when it finishes, so a run that is killed leaves a log directory nothing
 * references. Deleting a log only together with its receipt therefore leaves
 * those directories immortal.
 *
 * An orphan is collectable only when an in-flight run cannot be the reason it has
 * no receipt. The newest `keepRecent` receipts are the most recent runs that did
 * finish, so a log directory older than all of them cannot belong to a run that
 * is still writing. With no kept run there is no such proof and nothing is
 * collected. A log whose id a merge record or `latest.json` still names is kept
 * even without its receipt: the record is then the only evidence left.
 */
async function planOrphanLogs({
  logRoot,
  receipts,
  mergeVerificationIds,
  latestVerificationId,
  keepRecent,
}) {
  const newest = [...receipts]
    .sort((left, right) => right.completedAt.localeCompare(left.completedAt))
    .slice(0, Math.max(0, keepRecent));
  if (newest.length === 0) return [];
  const cutoff = newest.reduce((oldest, receipt) => (receipt.completedAt < oldest ? receipt.completedAt : oldest), newest[0].completedAt);
  const knownIds = new Set(receipts.map((receipt) => receipt.verificationId));
  const orphans = [];
  for (const entry of await listDirectory(logRoot) ?? []) {
    if (!VERIFICATION_ID_PATTERN.test(entry.name)) continue;
    if (knownIds.has(entry.name)) continue;
    if (mergeVerificationIds.has(entry.name)) continue;
    if (entry.name === latestVerificationId) continue;
    const stats = await lstatOrUndefined(path.join(logRoot, entry.name));
    if (stats === undefined) continue;
    if (!stats.isDirectory() && !stats.isSymbolicLink()) continue;
    if (stats.mtime.toISOString() >= cutoff) continue;
    orphans.push({ kind: 'log', verificationId: entry.name, reason: 'orphan-log' });
  }
  return orphans;
}

/**
 * Records the device and inode of a deletion root so `applyEvidencePlan` can
 * prove it is deleting inside the same directory it planned against. A plan keeps
 * absolute paths; a path alone would resolve through a root that was replaced
 * with a symlink between planning and applying. A root that did not exist yet is
 * recorded as absent, because a directory created there after planning is not the
 * one this plan decided about.
 */
async function identityGuard(directory) {
  const stats = await lstatOrUndefined(directory);
  if (stats === undefined) return { path: directory, absent: true };
  return { path: directory, dev: stats.dev, ino: stats.ino };
}

/**
 * Returns a reason when a plan may no longer be applied, or `undefined` when the
 * deletion roots are the same directories they were at plan time. Symlinks are
 * refused rather than resolved: the whole point is that the target of the delete
 * must not have moved.
 *
 * A local writer that swaps a root inside the window between this check and the
 * delete is still possible; closing that would need `openat` on a directory file
 * descriptor, which Node does not expose. What this does guarantee is that the
 * decision and the deletion name the same directory, and `fs.rm` never follows a
 * symlink it does find.
 */
export async function evidencePlanBlocker(plan) {
  if (plan === undefined || plan.status !== 'pruned') return undefined;
  for (const guard of plan.guards ?? []) {
    const stats = await lstatOrUndefined(guard.path);
    if (guard.absent === true) {
      if (stats !== undefined) return `${guard.path} appeared after planning`;
      continue;
    }
    if (stats === undefined) return `${guard.path} disappeared after planning`;
    if (stats.isSymbolicLink()) return `${guard.path} became a symlink after planning`;
    if (!stats.isDirectory()) return `${guard.path} is not a directory any more`;
    if (stats.dev !== guard.dev || stats.ino !== guard.ino) return `${guard.path} was replaced after planning`;
  }
  return undefined;
}

/**
 * Deletes exactly the entries a planner reported. Applying never reads the store
 * again: a change that lands between planning and applying cannot turn a safe
 * plan into a half-finished one, and cannot produce a refusal after another
 * store was already pruned.
 */
export async function applyEvidencePlan(plan) {
  if (plan === undefined || plan.status !== 'pruned') return;
  const blocker = await evidencePlanBlocker(plan);
  if (blocker !== undefined) throw new Error(blocker);
  if (plan.store === 'verification') {
    for (const entry of plan.remove) {
      if (entry.fileName !== undefined) await rm(path.join(plan.targets.receiptRoot, entry.fileName), { force: true });
      await removeDirectoryEntry(plan.targets.logRoot, entry.verificationId);
    }
    return;
  }
  for (const entry of plan.remove) {
    if (entry.kind === 'capsule') await removeDirectoryEntry(plan.targets.capsuleRoot, entry.name);
    else await rm(path.join(plan.targets.receiptRoot, entry.name), { force: true });
  }
}

/** Plans, and unless `dryRun` applies, the verification store cleanup. */
export async function pruneLocalVerifyEvidence({ dryRun = false, ...options }) {
  const plan = await planLocalVerifyEvidence(options);
  if (!dryRun) await applyEvidencePlan(plan);
  return { ...plan, dryRun };
}

/**
 * Plans which capsules and receipts under `<root>/.unified-mpc/reviews` may go.
 * Merge records live in the verification store, so an unreadable verification
 * store is a refusal here too: without it this run cannot tell which reviews a
 * merge spent.
 */
export async function planReviewEvidence({
  root,
  headSha,
  protectedHeadShas = [],
  keepRecent = 5,
}) {
  const protectedHeads = protectedHeadShas instanceof Set ? protectedHeadShas : new Set(protectedHeadShas);
  const resolved = await resolveStoreRoot(root, ['.unified-mpc', 'reviews'], 'exact-head review');
  if (resolved.status !== 'ok') {
    return { status: resolved.status, ...(resolved.reason === undefined ? {} : { reason: resolved.reason }), keep: [], remove: [] };
  }
  const reviewRoot = resolved.path;
  const capsuleRoot = path.join(reviewRoot, 'capsules');
  const receiptRoot = path.join(reviewRoot, 'receipts');
  for (const [directory, label] of [[capsuleRoot, 'review capsule root'], [receiptRoot, 'review receipt root']]) {
    const stats = await lstatOrUndefined(directory);
    if (stats !== undefined && !stats.isDirectory()) {
      return { status: 'refused', reason: `${label} is not a real directory`, keep: [], remove: [] };
    }
  }

  const verification = await resolveStoreRoot(root, ['.unified-mpc', 'local-verify'], 'local verification');
  let protection = EMPTY_PROTECTION;
  if (verification.status === 'refused') {
    return { status: 'refused', reason: verification.reason, keep: [], remove: [] };
  }
  if (verification.status === 'ok') {
    protection = await readMergeProtectionFrom(path.join(verification.path, 'merges'));
    if (protection.status !== 'ok') {
      return { status: 'refused', reason: protection.reason, keep: [], remove: [] };
    }
  }

  const capsules = [];
  for (const entry of await listDirectory(capsuleRoot) ?? []) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const parsed = await readJson(path.join(capsuleRoot, entry.name, 'capsule.json'));
    if (!parsed.ok
      || typeof parsed.value?.headSha !== 'string'
      || !Number.isSafeInteger(parsed.value?.prNumber)
      || typeof parsed.value?.createdAt !== 'string') {
      return { status: 'refused', reason: `unreadable review capsule: ${entry.name}`, keep: [], remove: [] };
    }
    capsules.push({
      name: entry.name,
      key: `${parsed.value.headSha}-${String(parsed.value.prNumber)}`,
      headSha: parsed.value.headSha,
      prNumber: parsed.value.prNumber,
      createdAt: parsed.value.createdAt,
    });
  }

  const receipts = [];
  for (const entry of await listDirectory(receiptRoot) ?? []) {
    if (!entry.name.endsWith('.json')) continue;
    const parsed = await readJson(path.join(receiptRoot, entry.name));
    if (!parsed.ok
      || typeof parsed.value?.headSha !== 'string'
      || !Number.isSafeInteger(parsed.value?.prNumber)
      || typeof parsed.value?.createdAt !== 'string') {
      return { status: 'refused', reason: `unreadable review receipt: ${entry.name}`, keep: [], remove: [] };
    }
    receipts.push({
      name: entry.name,
      key: `${parsed.value.headSha}-${String(parsed.value.prNumber)}`,
      headSha: parsed.value.headSha,
      prNumber: parsed.value.prNumber,
      reviewId: typeof parsed.value.reviewId === 'string' ? parsed.value.reviewId : undefined,
      createdAt: parsed.value.createdAt,
    });
  }

  const plan = planReviewEvidencePrune({
    capsules,
    receipts,
    mergeReviewIds: protection.reviewIds,
    mergeHeadShas: protection.heads,
    protectedHeadShas: protectedHeads,
    currentHeadSha: headSha,
    keepRecent,
  });
  return {
    status: 'pruned',
    store: 'review',
    targets: { capsuleRoot, receiptRoot },
    guards: [await identityGuard(capsuleRoot), await identityGuard(receiptRoot)],
    ...plan,
  };
}

/** Plans, and unless `dryRun` applies, the review store cleanup. */
export async function pruneReviewEvidence({ dryRun = false, ...options }) {
  const plan = await planReviewEvidence(options);
  if (!dryRun) await applyEvidencePlan(plan);
  return { ...plan, dryRun };
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

function countByKind(entries) {
  const counts = { capsule: 0, receipt: 0, log: 0 };
  for (const entry of entries) {
    if (entry.kind === 'capsule') counts.capsule += 1;
    else if (entry.kind === 'log') counts.log += 1;
    else counts.receipt += 1;
  }
  return counts;
}

function describeCounts(entries) {
  const counts = countByKind(entries);
  const parts = [];
  if (counts.capsule > 0) parts.push(`${counts.capsule} capsule(s)`);
  if (counts.receipt > 0) parts.push(`${counts.receipt} receipt(s)`);
  if (counts.log > 0) parts.push(`${counts.log} log director${counts.log === 1 ? 'y' : 'ies'}`);
  return parts.length === 0 ? `${counts.receipt} receipt(s)` : parts.join(' and ');
}

function report(label, result, dryRun) {
  if (result.status === 'missing') {
    console.log(`${label}: no evidence to prune`);
    return;
  }
  const verb = dryRun ? 'would remove' : 'removed';
  for (const entry of result.remove) {
    console.log(`${verb} [${label}] ${entry.fileName ?? entry.name ?? `logs/${entry.verificationId}`} (${entry.reason})`);
  }
  console.log(`${label}: ${verb} ${describeCounts(result.remove)}; kept ${describeCounts(result.keep)}`);
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

  // Plan both stores before deleting in either one. `--apply` deletes exactly
  // what was planned, so no second pass can find a new reason to refuse after the
  // other store is already pruned.
  const stores = { root: options.root, headSha, protectedHeadShas, keepRecent: options.keepRecent };
  const [verification, review] = await Promise.all([
    planLocalVerifyEvidence(stores),
    planReviewEvidence(stores),
  ]);
  const refused = [verification, review].find((result) => result.status === 'refused');
  if (refused !== undefined) {
    console.error(`evidence prune refused: ${refused.reason}`);
    return 1;
  }
  // Both plans are checked before either is applied, so a deletion root that moved
  // after planning stops the run with both stores intact.
  for (const plan of [verification, review]) {
    const blocker = await evidencePlanBlocker(plan);
    if (blocker !== undefined) {
      console.error(`evidence prune refused: ${blocker}`);
      return 1;
    }
  }
  if (!options.dryRun) {
    await applyEvidencePlan(verification);
    await applyEvidencePlan(review);
  }
  report('local verification', verification, options.dryRun);
  report('exact-head review', review, options.dryRun);
  if (options.dryRun) console.log('dry run, pass --apply to delete');
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
