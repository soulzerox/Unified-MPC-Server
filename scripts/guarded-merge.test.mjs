import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateEligibility,
  expectedFingerprint,
  findReceipt,
  parseArgs,
  parseRepositoryFromRemote,
} from './guarded-merge.mjs';

const HEAD = 'a'.repeat(40);

const PR = {
  number: 534,
  state: 'OPEN',
  isDraft: false,
  baseRefName: 'main',
  headRefName: 'feat/x',
  headRefOid: HEAD,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  title: 'feat: something (#144)',
  body: 'Refs #144',
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

test('a PR body that retracts a closing keyword blocks the merge', () => {
  const result = evaluate({ pr: { body: 'Refs #144. This does not close #144.' } });
  assert.equal(result.eligible, false);
  assert.match(result.blockers.join('\n'), /retracts a closing keyword/);
});

test('every blocker is reported at once', () => {
  const result = evaluate({ pr: { state: 'CLOSED', isDraft: true, mergeable: 'UNKNOWN' }, receipt: undefined });
  assert.equal(result.blockers.length >= 4, true);
  assert.equal(result.eligible, false);
});

test('expectedFingerprint is the clean-tree fingerprint for the head', () => {
  assert.match(expectedFingerprint(HEAD), /^sha256:[a-f0-9]{64}$/);
  assert.equal(expectedFingerprint(HEAD), expectedFingerprint(HEAD));
  assert.notEqual(expectedFingerprint(HEAD), expectedFingerprint('b'.repeat(40)));
});
