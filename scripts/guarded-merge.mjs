#!/usr/bin/env node
/* global process, console, Buffer, URL */
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findNegatedClosingKeywordHazards } from './check-issue-closing-keywords.mjs';
import { diffFingerprint } from './local-verify.mjs';
import { evaluateReviewEvidence, findReviewReceipt, readPullDiff, readPullRequest, readReviewReceipts, readSkillIdentity, reviewFingerprint } from './review-gate.mjs';

/**
 * Repository-level guarded merge (#144).
 *
 * The runtime already owns `guarded_pr_merge` for MCP callers. This is the CLI
 * path used from a shell session: it refuses to merge unless a merge-ready
 * local verification receipt and a clean exact-head review receipt exist for
 * the current PR head, then lets GitHub enforce the same head through
 * `--match-head-commit`.
 *
 * Advisory gates (PR body wording, base branch) are checked here because a
 * later fix would be a new commit and therefore a new head, which invalidates
 * the receipts anyway.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RECEIPT_ROOT = path.join(ROOT, '.unified-mpc', 'local-verify');
const MERGE_RECORD_ROOT = path.join(RECEIPT_ROOT, 'merges');
const METHODS = ['squash', 'merge', 'rebase'];
const HEAD_SHA_PATTERN = /^[0-9a-f]{40}$/;

export function parseArgs(argv) {
  const options = { base: 'main', method: 'squash', dryRun: false, deleteBranch: true, repo: undefined, pr: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--pr') {
      index += 1;
      const value = Number(argv[index]);
      if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('--pr must be a positive integer');
      options.pr = value;
    } else if (argument === '--repo') {
      index += 1;
      options.repo = argv[index];
    } else if (argument === '--base') {
      index += 1;
      options.base = argv[index];
    } else if (argument === '--method') {
      index += 1;
      options.method = argv[index];
    } else if (argument === '--dry-run') {
      options.dryRun = true;
    } else if (argument === '--no-delete-branch') {
      options.deleteBranch = false;
    } else if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else {
      throw new RangeError(`unknown argument '${String(argument)}'`);
    }
  }
  if (options.help === true) return options;
  if (options.pr === undefined) throw new RangeError('--pr is required');
  if (!METHODS.includes(options.method)) throw new RangeError(`--method must be one of ${METHODS.join(', ')}`);
  if (typeof options.base !== 'string' || options.base.trim() === '') throw new RangeError('--base must not be empty');
  return options;
}

/**
 * Accept the remote forms this repo uses: https, scp-like ssh, `ssh://`, and a
 * host alias such as `git@github.com-unified:owner/repo.git`.
 */
export function parseRepositoryFromRemote(remoteUrl) {
  const value = String(remoteUrl ?? '').trim();
  if (value === '') throw new Error('origin remote is empty');

  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/.exec(value);
  const candidate = scp !== null && !value.includes('://')
    ? scp[2]
    : (() => {
      const parsed = new URL(value);
      return parsed.pathname;
    })();

  const segments = candidate.replace(/^\/+/, '').replace(/\.git$/, '').split('/');
  if (segments.length < 2) throw new Error(`cannot parse repository from remote '${value}'`);
  const [owner, repository] = segments.slice(-2);
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error(`cannot parse repository from remote '${value}'`);
  }
  return `${owner}/${repository}`;
}

/** Latest receipt for the head, if the store has one. */
export function findReceipt(receipts, headSha) {
  const matches = receipts.filter((receipt) => receipt?.headSha === headSha);
  if (matches.length === 0) return undefined;
  return matches.reduce((latest, receipt) => (
    String(receipt.completedAt ?? '') >= String(latest.completedAt ?? '') ? receipt : latest
  ));
}

export function expectedFingerprint(headSha) {
  return diffFingerprint({ headSha, status: '', diff: '' });
}

/**
 * Every blocker is reported, not just the first, so one run tells the operator
 * everything that stands between this head and a merge.
 */
export function evaluateEligibility({ pr, receipt, review, reviewSkill, reviewFingerprint: headReviewFingerprint, headReceiptCount, corruptReviewReceipts, expectedBase, headFingerprint }) {
  const blockers = [];
  if (pr.state !== 'OPEN') blockers.push(`PR is not open (state=${pr.state})`);
  if (pr.isDraft === true) blockers.push('PR is a draft');
  if (pr.baseRefName !== expectedBase) blockers.push(`base is '${pr.baseRefName}', expected '${expectedBase}'`);
  if (typeof pr.headRefOid !== 'string' || !HEAD_SHA_PATTERN.test(pr.headRefOid)) {
    blockers.push(`PR head '${String(pr.headRefOid)}' is not a 40-character commit SHA`);
  }
  if (pr.mergeable !== 'MERGEABLE') blockers.push(`GitHub reports mergeable=${String(pr.mergeable)}`);
  if (pr.mergeStateStatus !== 'CLEAN') blockers.push(`merge state is ${String(pr.mergeStateStatus)}, expected CLEAN`);

  if (receipt === undefined) {
    blockers.push('no local verification receipt for the current PR head; run `pnpm verify:local` on that commit');
  } else {
    if (receipt.headSha !== pr.headRefOid) blockers.push('receipt was produced for a different head');
    if (receipt.mergeReady !== true) blockers.push('local verification receipt is not merge-ready');
    if (receipt.dirty !== false) blockers.push('local verification receipt was produced from a dirty worktree');
    if (receipt.profile !== 'merge') blockers.push(`local verification receipt used the '${String(receipt.profile)}' profile`);
    if (receipt.diffFingerprint !== headFingerprint) blockers.push('receipt fingerprint does not match the PR head');
  }

  const reviewEvaluation = evaluateReviewEvidence({
    receipt: review,
    headReceiptCount,
    corruptReceiptCount: corruptReviewReceipts,
    pr,
    skill: reviewSkill,
    fingerprint: headReviewFingerprint,
  });
  blockers.push(...reviewEvaluation.blockers);

  for (const hazard of findNegatedClosingKeywordHazards({ title: pr.title, body: pr.body })) {
    blockers.push(`PR ${hazard.source} retracts a closing keyword: "${hazard.excerpt}"`);
  }

  return { eligible: blockers.length === 0, blockers };
}

function run(argv) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => chunks.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      const output = Buffer.concat(chunks).toString('utf8');
      if (code !== 0) {
        reject(new Error(`${argv.join(' ')} failed (${code}): ${output.trim()}`));
        return;
      }
      resolve(output);
    });
  });
}

async function readReceipts(directory = RECEIPT_ROOT) {
  let names;
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  const receipts = [];
  for (const name of names) {
    if (!name.endsWith('.json') || name === 'latest.json') continue;
    try {
      receipts.push(JSON.parse(await readFile(path.join(directory, name), 'utf8')));
    } catch {
      // A corrupt verification receipt is not evidence; another one for the
      // same head may still be valid, so this store skips unreadable files.
    }
  }
  return receipts;
}

async function resolveRepository(explicit) {
  if (explicit !== undefined) return explicit;
  return parseRepositoryFromRemote(await run(['git', 'remote', 'get-url', 'origin']));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help === true) {
    console.log('usage: node scripts/guarded-merge.mjs --pr <n> [--repo owner/name] [--base main] [--method squash|merge|rebase] [--dry-run] [--no-delete-branch]');
    return 0;
  }

  const repository = await resolveRepository(options.repo);
  const pr = await readPullRequest(repository, options.pr);
  const [verificationReceipts, reviewStore, reviewSkill, prDiff] = await Promise.all([
    readReceipts(),
    readReviewReceipts(),
    readSkillIdentity(),
    readPullDiff(repository, options.pr),
  ]);
  const receipt = findReceipt(verificationReceipts, pr.headRefOid);
  const review = findReviewReceipt(reviewStore.records, pr.headRefOid);
  const { eligible, blockers } = evaluateEligibility({
    pr,
    receipt,
    review,
    reviewSkill,
    reviewFingerprint: reviewFingerprint({ baseSha: pr.baseRefOid, headSha: pr.headRefOid, diff: prDiff }),
    headReceiptCount: reviewStore.records.filter((record) => record?.headSha === pr.headRefOid).length,
    corruptReviewReceipts: reviewStore.corrupt.length,
    expectedBase: options.base,
    headFingerprint: expectedFingerprint(pr.headRefOid),
  });

  console.log(`guarded-merge ${repository}#${options.pr} head ${String(pr.headRefOid).slice(0, 12)}`);
  if (receipt !== undefined) {
    console.log(`  receipt ${String(receipt.verificationId)} (${String(receipt.profile)}, mergeReady=${String(receipt.mergeReady)})`);
  }
  if (review !== undefined) {
    console.log(`  review ${String(review.reviewId)} (${String(review.verdict)}, blockingOpen=${String(review.blockingOpenCount)})`);
  }

  if (!eligible) {
    console.error('refusing to merge:');
    for (const blocker of blockers) console.error(`  - ${blocker}`);
    return 1;
  }
  if (options.dryRun) {
    console.log('eligible: yes (dry run, nothing merged)');
    return 0;
  }

  const mergeArgs = ['gh', 'pr', 'merge', String(options.pr), '--repo', repository];
  mergeArgs.push(options.method === 'squash' ? '--squash' : options.method === 'rebase' ? '--rebase' : '--merge');
  mergeArgs.push('--match-head-commit', pr.headRefOid);
  if (options.deleteBranch) mergeArgs.push('--delete-branch');
  await run(mergeArgs);

  const merged = JSON.parse(await run([
    'gh', 'pr', 'view', String(options.pr), '--repo', repository, '--json', 'state,mergeCommit',
  ]));
  const mergeCommit = merged.mergeCommit?.oid;
  await mkdir(MERGE_RECORD_ROOT, { recursive: true });
  const recordPath = path.join(MERGE_RECORD_ROOT, `${pr.headRefOid}-${options.pr}.json`);
  await writeFile(recordPath, `${JSON.stringify({
    repository,
    prNumber: options.pr,
    headSha: pr.headRefOid,
    baseBranch: options.base,
    method: options.method,
    verificationId: receipt.verificationId,
    reviewId: review.reviewId,
    state: merged.state,
    mergeCommit,
    mergedAt: new Date().toISOString(),
  }, null, 2)}\n`, 'utf8');

  console.log(`merged: ${merged.state}${mergeCommit === undefined ? '' : ` as ${mergeCommit}`}`);
  console.log(`record: ${path.relative(ROOT, recordPath)}`);
  return 0;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
