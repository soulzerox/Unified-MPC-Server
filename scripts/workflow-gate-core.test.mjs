import assert from 'node:assert/strict';
import test from 'node:test';

import { PROFILE_VERSION, expectedFingerprint } from './local-verify.mjs';
import { evaluateEligibility } from './guarded-merge.mjs';
import { verificationGateBlockers } from './review-gate.mjs';
import { createGatePolicy } from './workflow-gate-core.mjs';

/**
 * The shared policy takes its two profile rules as inputs (#821) so it can
 * outlive this repository's profile runner. Both CLIs build the policy from the
 * real profile, so every other suite exercises those values and nothing else:
 * a regression that ignored the injected rules would still pass all of them.
 * These tests bind the policy to *different* rules and assert the verdict moves.
 */

const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);

function verification(overrides = {}) {
  return {
    headSha: HEAD,
    mergeReady: true,
    dirty: false,
    profile: 'merge',
    profileVersion: PROFILE_VERSION,
    diffFingerprint: expectedFingerprint(HEAD),
    completedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

test('createGatePolicy fails closed at construction on every malformed rule', () => {
  // Construction-time, not evaluation-time: a gate that only notices a missing
  // rule while evaluating an eligible head would be reading a policy it never
  // had. Callers build the policy once at import, so this refuses to start.
  for (const options of [
    undefined,
    {},
    { profileVersion: PROFILE_VERSION },
    { fingerprintFor: expectedFingerprint },
    { profileVersion: '1', fingerprintFor: expectedFingerprint },
    { profileVersion: 1.5, fingerprintFor: expectedFingerprint },
    { profileVersion: PROFILE_VERSION, fingerprintFor: 'expectedFingerprint' },
  ]) {
    assert.throws(() => createGatePolicy(options), TypeError, JSON.stringify(options));
  }
});

test('the injected profile version is the rule the gate applies', () => {
  const otherVersion = PROFILE_VERSION + 1;
  const policy = createGatePolicy({ profileVersion: otherVersion, fingerprintFor: expectedFingerprint });

  // A receipt this checkout's profile accepts must be refused by a gate built
  // for a different profile, otherwise the seam is decorative.
  assert.deepEqual(policy.verificationGateBlockers({ verification: verification(), headSha: HEAD }), [
    `verification receipt used profile version ${PROFILE_VERSION}, current is ${otherVersion}`,
  ]);
  assert.deepEqual(verificationGateBlockers({ verification: verification(), headSha: HEAD }), []);
});

test('the injected fingerprint rule is the rule the gate applies', () => {
  const seen = [];
  const policy = createGatePolicy({
    profileVersion: PROFILE_VERSION,
    fingerprintFor: (headSha) => {
      seen.push(headSha);
      return 'sha256:' + 'f'.repeat(64);
    },
  });

  assert.deepEqual(policy.verificationGateBlockers({ verification: verification(), headSha: HEAD }), [
    'verification receipt fingerprint does not match the head',
  ]);
  // The rule receives the head being judged, not a head captured at construction.
  assert.deepEqual(seen, [HEAD]);
  assert.deepEqual(verificationGateBlockers({ verification: verification(), headSha: HEAD }), []);
});

test('selectVerificationReceipt keeps an accepted receipt when a newer run is weaker', () => {
  const headSha = HEAD;
  const policy = createGatePolicy({ profileVersion: PROFILE_VERSION, fingerprintFor: expectedFingerprint });
  const mergeReady = verification({ completedAt: '2026-01-01T00:00:00.000Z' });
  const laterTargeted = verification({
    completedAt: '2026-01-02T00:00:00.000Z',
    mergeReady: false,
    profile: 'targeted',
  });

  // Newest-wins would let a fast iteration run revoke a merge-ready receipt for
  // an unchanged tree, forcing a full re-verification of the same bytes.
  const selected = policy.selectVerificationReceipt([mergeReady, laterTargeted], headSha);
  assert.equal(selected, mergeReady);
  assert.deepEqual(policy.verificationGateBlockers({ verification: selected, headSha }), []);

  // With no accepted receipt the newest one is still returned, so the blockers
  // explain the refusal instead of the head looking unverified.
  const refused = policy.selectVerificationReceipt([laterTargeted], headSha);
  assert.equal(refused, laterTargeted);
  assert.match(
    policy.verificationGateBlockers({ verification: refused, headSha }).join('\n'),
    /not merge-ready/,
  );
});

test('the merge guard refuses a receipt for exactly the reasons the review gate does', () => {
  // #820 replaced the merge guard's private copy of the receipt checks with
  // `verificationGateBlockers` so the two gates cannot disagree. Nothing else
  // asserts that, and the two call sites are the ones that must agree.
  const stale = verification({ profileVersion: PROFILE_VERSION - 1, dirty: true });
  const reviewGateBlockers = verificationGateBlockers({ verification: stale, headSha: HEAD });
  assert.equal(reviewGateBlockers.length, 2);

  const { blockers } = evaluateEligibility({
    pr: {
      number: 1,
      state: 'OPEN',
      isDraft: false,
      baseRefName: 'main',
      baseRefOid: OTHER_HEAD,
      headRefName: 'feat/x',
      headRefOid: HEAD,
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      title: 'feat: something (Refs #142)',
      body: 'Refs #142',
    },
    receipt: stale,
    review: undefined,
    reviewSkill: { skillId: 'unified-code-review', skillVersion: 1, skillSha256: 'sha256:' + 'c'.repeat(64) },
    reviewFingerprint: 'sha256:' + 'd'.repeat(64),
    headReceiptCount: 0,
    corruptReviewReceipts: 0,
    expectedBase: 'main',
  });

  for (const blocker of reviewGateBlockers) {
    assert.ok(blockers.includes(blocker), `merge guard dropped: ${blocker}\n${blockers.join('\n')}`);
  }
});
