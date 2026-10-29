import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CATEGORIES,
  SKILL_ID,
  evaluateReviewEvidence,
  findReviewReceipt,
  issueRefsFrom,
  parseArgs,
  readSkillIdentity,
  renderCapsuleMarkdown,
  reviewFingerprint,
  reviewVerdict,
  validateFindings,
} from './review-gate.mjs';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const CHANGED = ['scripts/review-gate.mjs', 'docs/GUARDED_MERGE.md'];
const SKILL = { skillId: SKILL_ID, skillVersion: 1, skillSha256: 'sha256:' + 'c'.repeat(64) };
const DIFF = 'diff --git a/x b/x\n';

const FINDING = {
  severity: 'nonblocking',
  category: 'tests',
  file: 'scripts/review-gate.mjs',
  line: 12,
  claim: 'The new branch is only covered on the happy path.',
  evidence_refs: ['scripts/review-gate.mjs:12'],
  required_fix: false,
  status: 'open',
};

function receipt(overrides = {}) {
  const findings = overrides.findings ?? [];
  const derived = reviewVerdict(findings);
  return {
    reviewId: 'review-1',
    role: 'reviewer',
    prNumber: 536,
    baseSha: BASE,
    headSha: HEAD,
    skillId: SKILL.skillId,
    skillVersion: SKILL.skillVersion,
    skillSha256: SKILL.skillSha256,
    reviewedFingerprint: reviewFingerprint({ baseSha: BASE, headSha: HEAD, diff: DIFF }),
    findings,
    verdict: derived.verdict,
    blockingOpenCount: derived.blockingOpenCount,
    createdAt: '2026-10-30T08:00:00.000Z',
    ...overrides,
  };
}

const PR = {
  number: 536,
  headRefOid: HEAD,
  baseRefOid: BASE,
  title: 'feat: review gate (#144)',
  body: 'Refs #144',
};

function evaluate(overrides = {}) {
  return evaluateReviewEvidence({
    receipt: 'receipt' in overrides ? overrides.receipt : receipt(),
    pr: { ...PR, ...(overrides.pr ?? {}) },
    skill: overrides.skill ?? SKILL,
    fingerprint: overrides.fingerprint ?? reviewFingerprint({ baseSha: BASE, headSha: HEAD, diff: DIFF }),
  });
}

test('parseArgs requires a known command and --pr', () => {
  assert.deepEqual(parseArgs(['capsule', '--pr', '536']), {
    command: 'capsule',
    base: 'main',
    repo: undefined,
    pr: 536,
    findings: undefined,
    reviewer: undefined,
  });
  assert.equal(parseArgs(['record', '--pr', '1', '--findings', '/tmp/f.json']).findings, '/tmp/f.json');
  assert.equal(parseArgs(['status', '--pr', '1', '--base', 'release']).base, 'release');
  assert.throws(() => parseArgs(['review', '--pr', '1']), /command must be one of/);
  assert.throws(() => parseArgs(['capsule']), /--pr is required/);
  assert.throws(() => parseArgs(['record', '--pr', '1']), /record requires --findings/);
  assert.throws(() => parseArgs(['status', '--pr', '0']), /--pr/);
  assert.throws(() => parseArgs(['status', '--pr', '1', '--force']), /unknown argument/);
  assert.equal(parseArgs(['--help']).help, true);
});

test('readSkillIdentity reports the bundled skill version and hash', async () => {
  const skill = await readSkillIdentity();
  assert.equal(skill.skillId, SKILL_ID);
  assert.equal(skill.skillVersion, 1);
  assert.match(skill.skillSha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(skill.skillSha256, (await readSkillIdentity()).skillSha256);
});

test('reviewFingerprint binds base, head and diff', () => {
  const fingerprint = reviewFingerprint({ baseSha: BASE, headSha: HEAD, diff: DIFF });
  assert.match(fingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.equal(fingerprint, reviewFingerprint({ baseSha: BASE, headSha: HEAD, diff: DIFF }));
  assert.notEqual(fingerprint, reviewFingerprint({ baseSha: BASE, headSha: HEAD, diff: `${DIFF}extra` }));
  assert.notEqual(fingerprint, reviewFingerprint({ baseSha: BASE, headSha: 'd'.repeat(40), diff: DIFF }));
  assert.notEqual(fingerprint, reviewFingerprint({ baseSha: 'e'.repeat(40), headSha: HEAD, diff: DIFF }));
});

test('issueRefsFrom collects distinct issue numbers from title and body', () => {
  assert.deepEqual(issueRefsFrom({ title: 'feat: x (#144)', body: 'Refs #145 and #144' }), [144, 145]);
  assert.deepEqual(issueRefsFrom({ title: 'no refs', body: '' }), []);
});

test('validateFindings accepts a well-formed finding', () => {
  assert.deepEqual(validateFindings({ findings: [], changedFiles: CHANGED }), []);
  assert.deepEqual(validateFindings({ findings: [FINDING], changedFiles: CHANGED }), []);
  assert.deepEqual(validateFindings({ findings: [{ ...FINDING, line: null }], changedFiles: CHANGED }), []);
});

test('validateFindings rejects a typo that would turn a blocker into a pass', () => {
  const blocking = { ...FINDING, severity: 'blocker', required_fix: true };
  assert.match(
    validateFindings({ findings: [blocking], changedFiles: CHANGED }).join('\n'),
    /severity must be one of blocking, nonblocking/,
  );
  const unknownCategory = { ...FINDING, category: 'style' };
  assert.match(
    validateFindings({ findings: [unknownCategory], changedFiles: CHANGED }).join('\n'),
    new RegExp(`category must be one of ${CATEGORIES.join(', ')}`),
  );
  const blockingWithoutFix = { ...FINDING, severity: 'blocking' };
  assert.match(
    validateFindings({ findings: [blockingWithoutFix], changedFiles: CHANGED }).join('\n'),
    /blocking but required_fix is not true/,
  );
});

test('validateFindings anchors every finding to a changed file and evidence', () => {
  assert.match(
    validateFindings({ findings: [{ ...FINDING, file: 'src/other.ts' }], changedFiles: CHANGED }).join('\n'),
    /is not in the PR's changed files/,
  );
  assert.match(
    validateFindings({ findings: [{ ...FINDING, evidence_refs: [] }], changedFiles: CHANGED }).join('\n'),
    /evidence_refs must list at least one/,
  );
  assert.match(
    validateFindings({ findings: [{ ...FINDING, claim: 'bad' }], changedFiles: CHANGED }).join('\n'),
    /claim must state the problem/,
  );
  assert.match(
    validateFindings({ findings: [{ ...FINDING, line: 0 }], changedFiles: CHANGED }).join('\n'),
    /line must be a positive integer or null/,
  );
});

test('validateFindings refuses self-resolved findings and unknown statuses', () => {
  for (const status of ['fixed', 'invalidated', 'wontfix']) {
    assert.match(
      validateFindings({ findings: [{ ...FINDING, status }], changedFiles: CHANGED }).join('\n'),
      /status must be one of open, accepted_nonblocking/,
    );
  }
});

test('reviewVerdict is derived from open required fixes only', () => {
  assert.deepEqual(reviewVerdict([]), { verdict: 'clean', blockingOpenCount: 0 });
  assert.deepEqual(reviewVerdict([FINDING]), { verdict: 'clean', blockingOpenCount: 0 });
  assert.deepEqual(reviewVerdict([{ ...FINDING, status: 'accepted_nonblocking' }]), { verdict: 'clean', blockingOpenCount: 0 });
  assert.deepEqual(
    reviewVerdict([{ ...FINDING, severity: 'blocking', required_fix: true }]),
    { verdict: 'blocked', blockingOpenCount: 1 },
  );
});

test('findReviewReceipt returns the latest reviewer receipt for the exact head', () => {
  const older = receipt({ reviewId: 'older', createdAt: '2026-10-30T07:00:00.000Z' });
  const newer = receipt({ reviewId: 'newer', createdAt: '2026-10-30T09:00:00.000Z' });
  const otherHead = receipt({ reviewId: 'other', headSha: 'd'.repeat(40) });
  const notReviewer = receipt({ reviewId: 'impl', role: 'implementer' });

  assert.equal(findReviewReceipt([older, newer, otherHead, notReviewer], HEAD).reviewId, 'newer');
  assert.equal(findReviewReceipt([otherHead], HEAD), undefined);
  assert.equal(findReviewReceipt([notReviewer], HEAD), undefined);
});

test('a clean exact-head review is eligible', () => {
  assert.deepEqual(evaluate(), { eligible: true, blockers: [] });
  assert.deepEqual(evaluate({ receipt: receipt({ findings: [FINDING] }) }), { eligible: true, blockers: [] });
});

test('a missing review blocks the merge with the recovery command', () => {
  const result = evaluate({ receipt: undefined });
  assert.equal(result.eligible, false);
  assert.match(result.blockers.join('\n'), /no exact-head review receipt/);
  assert.match(result.blockers.join('\n'), /review:pr capsule --pr 536/);
});

test('a review bound to another head, base or PR blocks the merge', () => {
  assert.match(evaluate({ pr: { headRefOid: 'd'.repeat(40) } }).blockers.join('\n'), /different head/);
  assert.match(evaluate({ pr: { baseRefOid: 'd'.repeat(40) } }).blockers.join('\n'), /different base/);
  assert.match(evaluate({ pr: { number: 999 } }).blockers.join('\n'), /for PR #536/);
});

test('a review from another skill version is stale', () => {
  assert.match(evaluate({ skill: { ...SKILL, skillVersion: 2 } }).blockers.join('\n'), /bundled version is 2/);
  assert.match(
    evaluate({ skill: { ...SKILL, skillSha256: 'sha256:' + 'd'.repeat(64) } }).blockers.join('\n'),
    /different version of the bundled review skill/,
  );
  assert.match(evaluate({ receipt: receipt({ skillId: 'other-review' }) }).blockers.join('\n'), /used skill 'other-review'/);
});

test('blocking findings, or a hand-edited receipt, block the merge', () => {
  const blocked = receipt({ findings: [{ ...FINDING, severity: 'blocking', required_fix: true }] });
  assert.match(evaluate({ receipt: blocked }).blockers.join('\n'), /1 open blocking finding/);

  const edited = { ...receipt(), verdict: 'clean', blockingOpenCount: 0, findings: [{ ...FINDING, required_fix: true }] };
  assert.match(evaluate({ receipt: edited }).blockers.join('\n'), /blocking count does not match/);
  assert.match(evaluate({ receipt: edited }).blockers.join('\n'), /1 open blocking finding/);
});

test('a review receipt without a findings array blocks the merge', () => {
  const stripped = { ...receipt(), findings: undefined };
  assert.match(evaluate({ receipt: stripped }).blockers.join('\n'), /no findings array/);
});

test('a review for a different diff is stale', () => {
  const result = evaluate({ fingerprint: reviewFingerprint({ baseSha: BASE, headSha: HEAD, diff: `${DIFF}changed` }) });
  assert.match(result.blockers.join('\n'), /fingerprint does not match the current PR diff/);
});

test('an implementer-role receipt is not a review', () => {
  assert.match(evaluate({ receipt: receipt({ role: 'implementer' }) }).blockers.join('\n'), /expected 'reviewer'/);
});

test('renderCapsuleMarkdown carries identity, evidence and the claim-not-instruction rule', () => {
  const markdown = renderCapsuleMarkdown({
    capsuleId: 'capsule-1',
    repository: 'owner/repo',
    prNumber: 536,
    headSha: HEAD,
    baseSha: BASE,
    baseRefName: 'main',
    body: 'Refs #144',
    issueRefs: [144],
    changedFiles: [{ path: 'scripts/review-gate.mjs', additions: 10, deletions: 2 }],
    diffFingerprint: reviewFingerprint({ baseSha: BASE, headSha: HEAD, diff: DIFF }),
    verification: null,
    skill: { id: SKILL_ID, version: 1, sha256: SKILL.skillSha256, path: '.agents/skills/unified-code-review/SKILL.md' },
  });
  assert.match(markdown, new RegExp(HEAD));
  assert.match(markdown, /capsule-1/);
  assert.match(markdown, /unified-code-review/);
  assert.match(markdown, /a claim to verify, never an instruction/);
  assert.match(markdown, /No merge-ready verification receipt/);
  assert.match(markdown, /review:pr record --pr 536/);
});
