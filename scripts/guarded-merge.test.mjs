import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateEligibility,
  expectedFingerprint,
  findReceipt,
  parseArgs,
  parseRepositoryFromRemote,
} from './guarded-merge.mjs';
import { reviewFingerprint } from './review-gate.mjs';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const SKILL = { skillId: 'unified-code-review', skillVersion: 1, skillSha256: 'sha256:' + 'c'.repeat(64) };

const PR = {
  number: 534,
  state: 'OPEN',
  isDraft: false,
  baseRefName: 'main',
  baseRefOid: BASE,
  headRefName: 'feat/x',
  headRefOid: HEAD,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  title: 'feat: something (#144)',
  body: 'Refs #144',
};

const REVIEW = {
  reviewId: 'review-1',
  role: 'reviewer',
  prNumber: 534,
  baseSha: BASE,
  headSha: HEAD,
  skillId: SKILL.skillId,
  skillVersion: SKILL.skillVersion,
  skillSha256: SKILL.skillSha256,
  reviewedFingerprint: reviewFingerprint({ baseSha: BASE, headSha: HEAD, diff: '' }),
  findings: [],
  verdict: 'clean',
  blockingOpenCount: 0,
  createdAt: '2026-10-30T06:20:00.000Z',
};

const RECEIPT = {
  verificationId: 'verification-1',
  profile: 'merge',
  headSha: HEAD,
  dirty: false,
  mergeReady: true,
  ok: true,
  diffFingerprint: expectedFingerprint(HEAD),
  completedAt: '2026-10-30T06:10:00.000Z',
};

function evaluate(overrides = {}) {
  return evaluateEligibility({
    pr: { ...PR, ...(overrides.pr ?? {}) },
    receipt: 'receipt' in overrides ? overrides.receipt : RECEIPT,
    review: 'review' in overrides ? overrides.review : REVIEW,
    reviewSkill: overrides.reviewSkill ?? SKILL,
    reviewFingerprint: reviewFingerprint({ baseSha: BASE, headSha: HEAD, diff: '' }),
    headReceiptCount: overrides.headReceiptCount ?? 1,
    corruptReviewReceipts: overrides.corruptReviewReceipts ?? 0,
    expectedBase: 'main',
    headFingerprint: expectedFingerprint(HEAD),
  });
}

test('parseArgs defaults to squash on main and requires --pr', () => {
  assert.deepEqual(parseArgs(['--pr', '534']), {
    base: 'main',
    method: 'squash',
    dryRun: false,
    deleteBranch: true,
    repo: undefined,
    pr: 534,
  });
  assert.throws(() => parseArgs([]), /--pr is required/);
  assert.throws(() => parseArgs(['--pr', '0']), /--pr/);
  assert.throws(() => parseArgs(['--pr', '1', '--method', 'fast-forward']), /--method/);
  assert.throws(() => parseArgs(['--pr', '1', '--base', '  ']), /--base/);
  assert.throws(() => parseArgs(['--pr', '1', '--force']), /unknown argument/);
});

test('parseArgs accepts explicit repo, base, method and flags', () => {
  assert.deepEqual(
    parseArgs(['--pr', '7', '--repo', 'owner/repo', '--base', 'release', '--method', 'rebase', '--dry-run', '--no-delete-branch']),
    { base: 'release', method: 'rebase', dryRun: true, deleteBranch: false, repo: 'owner/repo', pr: 7 },
  );
});

test('parseRepositoryFromRemote handles https, scp, ssh URLs and host aliases', () => {
  assert.equal(parseRepositoryFromRemote('https://github.com/soulzerox/Unified-MPC-Server.git'), 'soulzerox/Unified-MPC-Server');
  assert.equal(parseRepositoryFromRemote('git@github.com:soulzerox/Unified-MPC-Server.git'), 'soulzerox/Unified-MPC-Server');
  assert.equal(parseRepositoryFromRemote('ssh://git@github.com/soulzerox/Unified-MPC-Server.git'), 'soulzerox/Unified-MPC-Server');
  assert.equal(parseRepositoryFromRemote('git@github.com-unified:soulzerox/Unified-MPC-Server.git'), 'soulzerox/Unified-MPC-Server');
  assert.equal(parseRepositoryFromRemote('github.com-unified:soulzerox/Unified-MPC-Server'), 'soulzerox/Unified-MPC-Server');
});

test('parseRepositoryFromRemote rejects empty and shapeless remotes', () => {
  assert.throws(() => parseRepositoryFromRemote(''), /empty/);
  assert.throws(() => parseRepositoryFromRemote('https://github.com/only-owner'), /cannot parse/);
  assert.throws(() => parseRepositoryFromRemote('git@github.com:owner/re po.git'), /cannot parse/);
});

test('findReceipt returns the latest receipt for the exact head only', () => {
  const older = { ...RECEIPT, verificationId: 'older', completedAt: '2026-10-30T06:00:00.000Z' };
  const newer = { ...RECEIPT, verificationId: 'newer', completedAt: '2026-10-30T07:00:00.000Z' };
  const otherHead = { ...RECEIPT, verificationId: 'other', headSha: 'b'.repeat(40) };

  assert.equal(findReceipt([older, newer, otherHead], HEAD).verificationId, 'newer');
  assert.equal(findReceipt([otherHead], HEAD), undefined);
  assert.equal(findReceipt([], HEAD), undefined);
});

test('a green receipt on the exact head is eligible', () => {
  assert.deepEqual(evaluate(), { eligible: true, blockers: [] });
});

test('structural PR problems block the merge', () => {
  assert.match(evaluate({ pr: { state: 'MERGED' } }).blockers.join('\n'), /not open/);
  assert.match(evaluate({ pr: { isDraft: true } }).blockers.join('\n'), /draft/);
  assert.match(evaluate({ pr: { baseRefName: 'develop' } }).blockers.join('\n'), /base is 'develop'/);
  assert.match(evaluate({ pr: { headRefOid: 'not-a-sha' } }).blockers.join('\n'), /40-character commit SHA/);
  assert.match(evaluate({ pr: { mergeable: 'CONFLICTING' } }).blockers.join('\n'), /mergeable=CONFLICTING/);
  assert.match(evaluate({ pr: { mergeStateStatus: 'BLOCKED' } }).blockers.join('\n'), /merge state is BLOCKED/);
});

test('a missing, stale or weak receipt blocks the merge', () => {
  assert.match(evaluate({ receipt: undefined }).blockers.join('\n'), /no local verification receipt/);
  assert.match(evaluate({ receipt: { ...RECEIPT, mergeReady: false } }).blockers.join('\n'), /not merge-ready/);
  assert.match(evaluate({ receipt: { ...RECEIPT, dirty: true } }).blockers.join('\n'), /dirty worktree/);
  assert.match(evaluate({ receipt: { ...RECEIPT, profile: 'targeted' } }).blockers.join('\n'), /'targeted' profile/);
  assert.match(evaluate({ receipt: { ...RECEIPT, headSha: 'c'.repeat(40) } }).blockers.join('\n'), /different head/);
  assert.match(
    evaluate({ receipt: { ...RECEIPT, diffFingerprint: expectedFingerprint('c'.repeat(40)) } }).blockers.join('\n'),
    /fingerprint does not match/,
  );
});

test('a missing, stale or blocked review blocks the merge', () => {
  assert.match(evaluate({ review: undefined }).blockers.join('\n'), /no exact-head review receipt/);
  assert.match(evaluate({ review: { ...REVIEW, headSha: 'c'.repeat(40) } }).blockers.join('\n'), /review receipt was produced for a different head/);
  assert.match(evaluate({ review: { ...REVIEW, baseSha: 'c'.repeat(40) } }).blockers.join('\n'), /different base/);
  assert.match(evaluate({ review: { ...REVIEW, verdict: 'blocked', blockingOpenCount: 1 } }).blockers.join('\n'), /review verdict is 'blocked'/);
  assert.match(evaluate({ review: { ...REVIEW, blockingOpenCount: 1 } }).blockers.join('\n'), /blocking count does not match/);
  assert.match(evaluate({ reviewSkill: { ...SKILL, skillVersion: 2 } }).blockers.join('\n'), /bundled version is 2/);
  assert.match(
    evaluate({ reviewSkill: { ...SKILL, skillSha256: 'sha256:' + 'd'.repeat(64) } }).blockers.join('\n'),
    /different version of the bundled review skill/,
  );
});

test('ambiguous or unreadable review evidence blocks the merge', () => {
  assert.match(evaluate({ headReceiptCount: 2 }).blockers.join('\n'), /review evidence must be unique/);
  assert.match(evaluate({ corruptReviewReceipts: 1 }).blockers.join('\n'), /cannot be read/);
});

test('a PR body that retracts a closing keyword blocks the merge', () => {
  const result = evaluate({ pr: { body: 'Refs #144. This does not close #144.' } });
  assert.equal(result.eligible, false);
  assert.match(result.blockers.join('\n'), /retracts a closing keyword/);
});

test('every blocker is reported at once', () => {
  const result = evaluate({ pr: { state: 'CLOSED', isDraft: true, mergeable: 'UNKNOWN' }, receipt: undefined, review: undefined });
  assert.equal(result.blockers.length >= 5, true);
  assert.equal(result.eligible, false);
});

test('expectedFingerprint is the clean-tree fingerprint for the head', () => {
  assert.match(expectedFingerprint(HEAD), /^sha256:[a-f0-9]{64}$/);
  assert.equal(expectedFingerprint(HEAD), expectedFingerprint(HEAD));
  assert.notEqual(expectedFingerprint(HEAD), expectedFingerprint('b'.repeat(40)));
});
