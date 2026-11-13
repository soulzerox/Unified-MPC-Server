#!/usr/bin/env node
import { createHash } from 'node:crypto';

import { findNegatedClosingKeywordHazards } from './check-issue-closing-keywords.mjs';

/**
 * Shared Workflow Gate policy (#142, step 1).
 *
 * `verify`, `review` and `integrate` are three receipts over one idea: a phase
 * may proceed only when durable evidence for the exact current input exists.
 * The rule lived inside `review-gate.mjs`, so `guarded-merge.mjs` had to import
 * a sibling CLI to reuse it, and the merge guard carried its own copy of the
 * receipt checks. This module is the single home for the decision itself.
 *
 * Everything here is pure: it reads no file, runs no command and writes
 * nothing. `review-gate.mjs` supplies the capsule and receipt stores,
 * `guarded-merge.mjs` supplies the PR and GitHub state, and both call the same
 * predicates — so a head the review gate refuses to freeze is a head the merge
 * gate refuses to merge, by construction rather than by coincidence.
 */

export const HEAD_SHA_PATTERN = /^[0-9a-f]{40}$/;

export const SEVERITIES = ['blocking', 'nonblocking'];
export const CATEGORIES = [
  'correctness',
  'concurrency',
  'security',
  'error-handling',
  'resource',
  'compatibility',
  'spec',
  'tests',
  'cross-file',
  'architecture',
  'operations',
  'maintainability',
];
/** Contract states. A receipt can only be written with the first two. */
export const FINDING_STATUSES = ['open', 'fixed', 'accepted_nonblocking', 'invalidated'];
export const RECORDABLE_STATUSES = ['open', 'accepted_nonblocking'];

/** GitHub renders the diff, so review and verification share one source of truth. */
export function reviewFingerprint({ baseSha, headSha, diff }) {
  return `sha256:${createHash('sha256')
    .update(baseSha)
    .update('\n')
    .update(headSha)
    .update('\n')
    .update(diff)
    .digest('hex')}`;
}

/**
 * A findings document is reviewer-authored, so every field it can get wrong is
 * checked here. A typo in `severity` would otherwise turn a blocking finding
 * into a pass, which is why the sets are closed.
 */
export function validateFindings({ findings, changedFiles }) {
  const blockers = [];
  if (!Array.isArray(findings)) return ['findings must be an array'];
  const knownFiles = new Set(changedFiles);
  const seenIds = new Set();

  findings.forEach((finding, index) => {
    const label = `findings[${index}]`;
    if (finding === null || typeof finding !== 'object' || Array.isArray(finding)) {
      blockers.push(`${label} must be an object`);
      return;
    }
    if (finding.finding_id !== undefined && typeof finding.finding_id === 'string') {
      if (seenIds.has(finding.finding_id)) blockers.push(`${label} reuses finding_id '${finding.finding_id}'`);
      seenIds.add(finding.finding_id);
    }
    if (!SEVERITIES.includes(finding.severity)) {
      blockers.push(`${label}.severity must be one of ${SEVERITIES.join(', ')}`);
    }
    if (!CATEGORIES.includes(finding.category)) {
      blockers.push(`${label}.category must be one of ${CATEGORIES.join(', ')}`);
    }
    if (typeof finding.file !== 'string' || finding.file.trim() === '') {
      blockers.push(`${label}.file must be a repository path`);
    } else if (knownFiles.size > 0 && !knownFiles.has(finding.file)) {
      blockers.push(`${label}.file '${finding.file}' is not in the PR's changed files`);
    }
    if (finding.line !== undefined && finding.line !== null
      && (!Number.isSafeInteger(finding.line) || finding.line < 1)) {
      blockers.push(`${label}.line must be a positive integer or null`);
    }
    if (typeof finding.claim !== 'string' || finding.claim.trim().length < 8) {
      blockers.push(`${label}.claim must state the problem`);
    }
    if (!Array.isArray(finding.evidence_refs) || finding.evidence_refs.length === 0
      || finding.evidence_refs.some((ref) => typeof ref !== 'string' || ref.trim() === '')) {
      blockers.push(`${label}.evidence_refs must list at least one non-empty reference`);
    }
    if (typeof finding.required_fix !== 'boolean') {
      blockers.push(`${label}.required_fix must be a boolean`);
    }
    if (!RECORDABLE_STATUSES.includes(finding.status)) {
      blockers.push(`${label}.status must be one of ${RECORDABLE_STATUSES.join(', ')} (later generations supersede; findings are never edited in place)`);
    }
    if (finding.severity === 'blocking' && finding.required_fix !== true) {
      blockers.push(`${label} is blocking but required_fix is not true`);
    }
  });

  return blockers;
}

/** The verdict is derived, never supplied by the reviewer. */
export function reviewVerdict(findings) {
  const list = Array.isArray(findings) ? findings : [];
  const blockingOpen = list.filter((finding) => finding?.status === 'open' && finding?.required_fix === true);
  return {
    verdict: blockingOpen.length === 0 ? 'clean' : 'blocked',
    blockingOpenCount: blockingOpen.length,
  };
}

/**
 * A reviewer reads the skill version from prose and may write `"1"` where the
 * skill's own example shows `1`. The number still has to match exactly, so a
 * numeric string is read as its number and every other value is compared as-is.
 * The refusal quotes the value as JSON: the old `String(...)` form rendered a
 * string `"1"` and a number `1` identically, which made a type mismatch look
 * like "used version 1, bundled version is 1".
 */
export function skillVersionBlocker(submittedSkillVersion, bundledSkillVersion) {
  const numeric = typeof submittedSkillVersion === 'string' && /^\d+$/.test(submittedSkillVersion.trim())
    ? Number(submittedSkillVersion)
    : submittedSkillVersion;
  if (numeric === bundledSkillVersion) return undefined;
  return `findings used skill version ${JSON.stringify(submittedSkillVersion)}, bundled version is ${bundledSkillVersion}`;
}

export function findReviewReceipt(receipts, headSha) {
  const matches = receipts.filter((receipt) => receipt?.headSha === headSha && receipt?.role === 'reviewer');
  if (matches.length === 0) return undefined;
  return matches.reduce((latest, receipt) => (
    String(receipt.createdAt ?? '') >= String(latest.createdAt ?? '') ? receipt : latest
  ));
}

/**
 * Merge-time predicate. `record` already validated the document, but a receipt
 * is a file on disk: the verdict is recomputed here so an edited receipt cannot
 * claim a review that its own findings do not support.
 */
export function evaluateReviewEvidence({ receipt, capsule, headReceiptCount, corruptReceiptCount, pr, skill, fingerprint }) {
  const blockers = [];
  if (corruptReceiptCount !== undefined && corruptReceiptCount > 0) {
    blockers.push(`${corruptReceiptCount} review receipt file(s) cannot be read; inspect or remove them`);
  }
  if (headReceiptCount !== undefined && headReceiptCount > 1) {
    blockers.push(`${headReceiptCount} review receipts exist for this head; review evidence must be unique`);
  }
  if (receipt === undefined) {
    // Freezing a capsule that already exists is refused, and so is re-freezing
    // from a head with a receipt, so the advice has to match what is still
    // possible for this head: only `record` remains once a capsule is frozen.
    blockers.push(capsule === undefined
      ? `no exact-head review receipt for ${String(pr.headRefOid).slice(0, 12)}; run \`pnpm review:pr capsule --pr ${String(pr.number)}\` and record a reviewer finding set`
      : `capsule ${String(capsule.capsuleId)} is frozen for ${String(pr.headRefOid).slice(0, 12)} but no review receipt exists; hand the capsule to a reviewer and run \`pnpm review:pr record --pr ${String(pr.number)} --findings <file>\``);
    return { eligible: false, blockers };
  }

  if (receipt.role !== 'reviewer') blockers.push(`review receipt role is '${String(receipt.role)}', expected 'reviewer'`);
  if (receipt.prNumber !== pr.number) blockers.push(`review receipt is for PR #${String(receipt.prNumber)}`);
  if (receipt.headSha !== pr.headRefOid) blockers.push('review receipt was produced for a different head');
  if (receipt.baseSha !== pr.baseRefOid) blockers.push('review receipt was produced against a different base');
  if (receipt.skillId !== skill.skillId) blockers.push(`review receipt used skill '${String(receipt.skillId)}'`);
  if (receipt.skillVersion !== skill.skillVersion) {
    blockers.push(`review receipt used skill version ${String(receipt.skillVersion)}, bundled version is ${skill.skillVersion}`);
  }
  if (receipt.skillSha256 !== skill.skillSha256) {
    blockers.push('review receipt was produced with a different version of the bundled review skill');
  }

  if (!Array.isArray(receipt.findings)) {
    blockers.push('review receipt has no findings array');
    return { eligible: false, blockers };
  }

  // An authentic receipt can still be edited on disk: a status rewrite to
  // `fixed` would otherwise read as clean. The record-time shape rules apply
  // again here, without the changed-file allowlist the receipt does not store.
  blockers.push(...validateFindings({ findings: receipt.findings, changedFiles: [] }));

  const derived = reviewVerdict(receipt.findings);
  if (receipt.verdict !== 'clean') blockers.push(`review verdict is '${String(receipt.verdict)}'`);
  if (derived.verdict !== 'clean') blockers.push(`review has ${derived.blockingOpenCount} open blocking finding(s)`);
  if (receipt.blockingOpenCount !== derived.blockingOpenCount) {
    blockers.push('review receipt blocking count does not match its findings');
  }
  if (receipt.reviewedFingerprint !== fingerprint) {
    blockers.push('review receipt fingerprint does not match the current PR diff');
  }

  return { eligible: blockers.length === 0, blockers };
}

/**
 * What the profile expects of a verification receipt: the version whose step set
 * the receipt must name, and the clean-tree fingerprint for a head. The gate
 * takes both as inputs instead of importing them, so this module knows nothing
 * about the local verification profile and a caller can supply a different one
 * — the runtime merge gate keeps its own verification mode.
 */
export function createGatePolicy({ profileVersion, fingerprintFor } = {}) {
  if (!Number.isSafeInteger(profileVersion) || typeof fingerprintFor !== 'function') {
    throw new TypeError('createGatePolicy requires { profileVersion: integer, fingerprintFor: (headSha) => string }');
  }

  /**
   * A head is immutable, so one fully valid receipt is enough forever.
   * Newest-wins would let a later weaker run revoke it: running
   * `verify:targeted` for fast iteration after a merge-ready `verify:local` on
   * the same commit would make the head unacceptable and force a full
   * re-verification of an unchanged tree. So the newest receipt the gate
   * accepts is selected; when none qualifies the newest receipt is returned
   * anyway, so the blockers explain why the head is refused.
   */
  function selectVerificationReceipt(receipts, headSha) {
    const matches = receipts.filter((receipt) => receipt?.headSha === headSha);
    if (matches.length === 0) return undefined;
    const newestFirst = [...matches].sort((left, right) => (
      String(right.completedAt ?? '').localeCompare(String(left.completedAt ?? ''))
    ));
    return newestFirst.find((receipt) => verificationGateBlockers({ verification: receipt, headSha }).length === 0)
      ?? newestFirst[0];
  }

  /**
   * #142 `before_review` gate: a review is only worth starting once local
   * verification has produced a merge-ready receipt for the exact head. The merge
   * guard enforces that before integration, so a review that runs first spends a
   * reviewer on a head that cannot land, and the capsule ends up documenting a
   * verification that never happened. The blockers are reported instead of the
   * first one so one run tells an operator everything the head is missing.
   */
  function verificationGateBlockers({ verification, headSha }) {
    if (verification === undefined) {
      return [`no local verification receipt for ${headSha.slice(0, 12)}; run \`corepack pnpm@10.15.0 verify:local\` on that commit before freezing a capsule`];
    }
    const blockers = [];
    if (verification.headSha !== headSha) blockers.push('verification receipt was produced for a different head');
    if (verification.mergeReady !== true) blockers.push('verification receipt is not merge-ready; rerun `corepack pnpm@10.15.0 verify:local`');
    if (verification.dirty !== false) blockers.push('verification receipt was produced from a dirty worktree');
    if (verification.profile !== 'merge') blockers.push(`verification receipt used the '${String(verification.profile)}' profile, not 'merge'`);
    // A bumped profile version means the step set changed, so an older receipt
    // vouched for steps this profile no longer runs. The merge guard refuses it,
    // so a review started on it would only be spent on a head that cannot land.
    if (verification.profileVersion !== profileVersion) {
      blockers.push(`verification receipt used profile version ${String(verification.profileVersion)}, current is ${profileVersion}`);
    }
    // The fingerprint binds the receipt to one head on a clean tree. A receipt
    // that failed this check cannot authorize a merge, so it cannot authorize a
    // review either.
    if (verification.diffFingerprint !== fingerprintFor(headSha)) {
      blockers.push('verification receipt fingerprint does not match the head');
    }
    return blockers;
  }

  /**
   * The `integrate` gate: every blocker is reported, not just the first, so one
   * run tells the operator everything that stands between this head and a merge.
   * PR state, base and head are checked before any receipt, because no receipt
   * can make a draft, a moved base or a conflicting PR mergeable.
   */
  function evaluateMergeEligibility({ pr, receipt, review, reviewSkill, reviewFingerprint: headReviewFingerprint, headReceiptCount, corruptReviewReceipts, expectedBase }) {
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
      // One predicate for both gates: the review gate freezes a capsule only on a
      // receipt this accepts, so the merge gate refuses exactly the same heads.
      blockers.push(...verificationGateBlockers({ verification: receipt, headSha: pr.headRefOid }));
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

  return { evaluateMergeEligibility, selectVerificationReceipt, verificationGateBlockers };
}
