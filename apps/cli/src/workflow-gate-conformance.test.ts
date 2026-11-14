import { pathToFileURL } from 'node:url';

import { evaluateMergeEvidence } from '@unified-mpc/domain';
import type {
  MergeEvidenceBlockerCode,
  MergeReviewOutcome,
  MergeVerificationReceipt,
  RepositoryMergePolicy,
} from '@unified-mpc/domain';
import { describe, expect, it } from 'vitest';

/**
 * Conformance corpus for the rule both merge gates claim to own (#142, step 2).
 *
 * Two evaluators decide whether a head may merge: the CLI policy in
 * `scripts/workflow-gate-core.mjs` over file receipts, and the runtime
 * `evaluateMergeEvidence` over SQLite receipts. They check different evidence
 * shapes, so unifying them into one function would either fabricate fields one
 * world does not have or drop checks the other enforces. What must not diverge
 * is the *decision*: evidence must exist, and it must belong to the exact
 * subject being merged.
 *
 * This suite is the single owner of that rule. It builds one scenario table and
 * runs both real evaluators over it, so a change to either side that makes them
 * disagree fails here. It is the only place allowed to import both worlds —
 * `apps/cli` is the composition root that already binds both.
 */

const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);
const BASE = 'c'.repeat(40);
const OTHER_BASE = 'd'.repeat(40);
const REPOSITORY = 'soulzerox/Unified-MPC-Server';
const PULL_REQUEST = 142;
const DIFF = 'diff --git a/README.md b/README.md\n';

interface Scenario {
  readonly name: string;
  /** Verification evidence exists for this subject. */
  readonly verification: boolean;
  /** Review evidence exists for this subject. */
  readonly review: boolean;
  readonly verificationHead: 'subject' | 'other';
  readonly reviewHead: 'subject' | 'other';
  /**
   * Evidence recorded against a different base. The two worlds store that fact
   * on different objects — the runtime receipt carries `baseSha`, the CLI keeps
   * it on the review receipt, which is the object that records the diff it was
   * reviewed against — so one field drives both adapters.
   */
  readonly base: 'subject' | 'other';
  /** Evidence names another repository or pull request. */
  readonly subjectIdentity: 'subject' | 'other';
  readonly expected: 'allowed' | 'blocked';
  /**
   * The refusal each world must report, so a row cannot pass because of an
   * unrelated blocker. `null` for the row that must be allowed.
   */
  readonly proof: { readonly cli: RegExp; readonly runtime: MergeEvidenceBlockerCode } | null;
}

/**
 * Every blocked row changes exactly one field away from the passing row, so it
 * names a rule that actually refused this head instead of a fixture that never
 * passed in the first place.
 */
const SCENARIOS: readonly Scenario[] = [
  {
    name: 'complete evidence for the exact subject',
    verification: true,
    review: true,
    verificationHead: 'subject',
    reviewHead: 'subject',
    base: 'subject',
    subjectIdentity: 'subject',
    expected: 'allowed',
    proof: null,
  },
  {
    name: 'no verification evidence',
    verification: false,
    review: true,
    verificationHead: 'subject',
    reviewHead: 'subject',
    base: 'subject',
    subjectIdentity: 'subject',
    expected: 'blocked',
    proof: { cli: /no local verification receipt/, runtime: 'receipt_missing' },
  },
  {
    name: 'no review evidence',
    verification: true,
    review: false,
    verificationHead: 'subject',
    reviewHead: 'subject',
    base: 'subject',
    subjectIdentity: 'subject',
    expected: 'blocked',
    proof: { cli: /no exact-head review receipt/, runtime: 'review_missing' },
  },
  {
    name: 'verification produced for another head',
    verification: true,
    review: true,
    verificationHead: 'other',
    reviewHead: 'subject',
    base: 'subject',
    subjectIdentity: 'subject',
    expected: 'blocked',
    proof: { cli: /verification receipt was produced for a different head/, runtime: 'receipt_head_stale' },
  },
  {
    name: 'review produced for another head',
    verification: true,
    review: true,
    verificationHead: 'subject',
    reviewHead: 'other',
    base: 'subject',
    subjectIdentity: 'subject',
    expected: 'blocked',
    proof: { cli: /review receipt was produced for a different head/, runtime: 'review_head_stale' },
  },
  {
    name: 'evidence recorded against another base',
    verification: true,
    review: true,
    verificationHead: 'subject',
    reviewHead: 'subject',
    base: 'other',
    subjectIdentity: 'subject',
    expected: 'blocked',
    proof: { cli: /review receipt was produced against a different base/, runtime: 'receipt_base_stale' },
  },
  {
    name: 'evidence belongs to another pull request',
    verification: true,
    review: true,
    verificationHead: 'subject',
    reviewHead: 'subject',
    base: 'subject',
    subjectIdentity: 'other',
    expected: 'blocked',
    proof: { cli: /review receipt is for PR #143/, runtime: 'pull_request_mismatch' },
  },
];

interface CliVerdict {
  readonly eligible: boolean;
  readonly blockers: readonly string[];
}

interface CliModules {
  readonly createGatePolicy: (input: {
    profileVersion: number;
    fingerprintFor: (headSha: string) => string;
  }) => { evaluateMergeEligibility: (input: unknown) => CliVerdict };
  readonly reviewFingerprint: (input: { baseSha: string; headSha: string; diff: string }) => string;
}

async function loadCliModules(): Promise<CliModules> {
  // The scripts are plain ESM with no declarations, which is exactly why the
  // shared core is not packaged (see docs/WORKFLOW_GATE.md, open question 4).
  // A dynamic import keeps that boundary visible instead of hiding it behind a
  // hand-written ambient module.
  const url = pathToFileURL(new URL('../../../scripts/workflow-gate-core.mjs', import.meta.url).pathname).href;
  return await import(url) as CliModules;
}

function runtimePolicy(): RepositoryMergePolicy {
  return {
    repository: REPOSITORY,
    defaultBranch: 'main',
    verificationMode: 'local_exact_head',
    requiredGates: [{ name: 'test', source: 'local_command' }],
    reviewPolicy: { required: true, acceptedOutcomes: ['clean_llm_review'] },
  };
}

function runtimeReceipt(scenario: Scenario): MergeVerificationReceipt | undefined {
  if (!scenario.verification) return undefined;
  const head = scenario.verificationHead === 'subject' ? HEAD : OTHER_HEAD;
  const reviewHead = scenario.reviewHead === 'subject' ? HEAD : OTHER_HEAD;
  const review: MergeReviewOutcome = scenario.review ? 'clean_llm_review' : 'missing';
  return {
    repository: scenario.subjectIdentity === 'subject' ? REPOSITORY : 'someone/else',
    pullRequest: scenario.subjectIdentity === 'subject' ? PULL_REQUEST : PULL_REQUEST + 1,
    headSha: head,
    baseSha: scenario.base === 'subject' ? BASE : OTHER_BASE,
    verificationMode: 'local_exact_head',
    gates: [{ name: 'test', source: 'local_command', headSha: head, outcome: 'passed' }],
    review: {
      outcome: review,
      headSha: review === 'missing' ? HEAD : reviewHead,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function runtimeVerdict(scenario: Scenario): { allowed: boolean; codes: readonly string[] } {
  const decision = evaluateMergeEvidence(runtimePolicy(), {
    repository: REPOSITORY,
    pullRequest: PULL_REQUEST,
    headSha: HEAD,
    baseBranch: 'main',
    baseSha: BASE,
  }, runtimeReceipt(scenario));
  return {
    allowed: decision.status === 'MERGE_ALLOWED',
    codes: decision.blockers.map((blocker) => blocker.code),
  };
}

function cliVerdict(scenario: Scenario, modules: CliModules): { allowed: boolean; blockers: readonly string[] } {
  // The two profile rules are inputs to the policy by design (#821), so the
  // corpus binds them to fixed values instead of depending on this checkout's
  // working tree. Every other rule stays the real one.
  const gate = modules.createGatePolicy({ profileVersion: 0, fingerprintFor: () => 'sha256:conformance' });
  const fingerprint = modules.reviewFingerprint({ baseSha: BASE, headSha: HEAD, diff: DIFF });

  const verification = scenario.verification
    ? {
        headSha: scenario.verificationHead === 'subject' ? HEAD : OTHER_HEAD,
        mergeReady: true,
        dirty: false,
        profile: 'merge',
        profileVersion: 0,
        // The corpus varies only the subject fields both worlds share; this
        // receipt carries exactly the values the bound policy asks for.
        diffFingerprint: 'sha256:conformance',
        completedAt: '2026-01-01T00:00:00.000Z',
      }
    : undefined;

  const review = scenario.review
    ? {
        role: 'reviewer',
        prNumber: scenario.subjectIdentity === 'subject' ? PULL_REQUEST : PULL_REQUEST + 1,
        baseSha: scenario.base === 'subject' ? BASE : OTHER_BASE,
        headSha: scenario.reviewHead === 'subject' ? HEAD : OTHER_HEAD,
        skillId: 'unified-code-review',
        skillVersion: 1,
        skillSha256: 'sha256:conformance',
        reviewedFingerprint: fingerprint,
        blockingOpenCount: 0,
        verdict: 'clean',
        findings: [],
      }
    : undefined;

  const verdict = gate.evaluateMergeEligibility({
    pr: {
      number: PULL_REQUEST,
      title: 'conformance',
      body: 'Refs #142',
      state: 'OPEN',
      isDraft: false,
      baseRefName: 'main',
      baseRefOid: BASE,
      headRefOid: HEAD,
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
    },
    receipt: verification,
    review,
    reviewSkill: { skillId: 'unified-code-review', skillVersion: 1, skillSha256: 'sha256:conformance' },
    reviewFingerprint: fingerprint,
    headReceiptCount: 1,
    corruptReviewReceipts: 0,
    expectedBase: 'main',
  });
  return { allowed: verdict.eligible, blockers: verdict.blockers };
}

describe('merge evidence conformance', () => {
  it('both merge gates reach the same decision for the shared subject rule', async () => {
    const modules = await loadCliModules();
    const failures = SCENARIOS.flatMap((scenario) => {
      const runtime = runtimeVerdict(scenario);
      const cli = cliVerdict(scenario, modules);
      const problems: string[] = [];

      if (runtime.allowed !== cli.allowed) {
        problems.push(`${scenario.name}: runtime=${String(runtime.allowed)} cli=${String(cli.allowed)}`);
      }
      if ((runtime.allowed ? 'allowed' : 'blocked') !== scenario.expected) {
        problems.push(`${scenario.name}: both reported ${runtime.allowed ? 'allowed' : 'blocked'}, corpus expects ${scenario.expected}`);
      }

      // Each refusal must be the one the row names, so a row cannot be satisfied
      // by an unrelated blocker that happens to fire first.
      if (scenario.proof !== null) {
        if (!runtime.codes.includes(scenario.proof.runtime)) {
          problems.push(`${scenario.name}: runtime did not report ${scenario.proof.runtime} (got ${runtime.codes.join(', ')})`);
        }
        if (!cli.blockers.some((blocker) => scenario.proof !== null && scenario.proof.cli.test(blocker))) {
          problems.push(`${scenario.name}: cli did not report ${String(scenario.proof.cli)} (got ${cli.blockers.join(' | ')})`);
        }
      }

      return problems;
    });

    expect(failures).toEqual([]);
  });

  it('the corpus is not vacuous: one row passes and every rule has its own refusal', () => {
    // A table that only ever blocks would pass against an evaluator that refuses
    // everything, which is the failure mode a conformance suite must not have.
    const allowed = SCENARIOS.filter((scenario) => scenario.expected === 'allowed');
    const blocked = SCENARIOS.filter((scenario) => scenario.expected === 'blocked');
    expect(allowed).toHaveLength(1);
    expect(blocked).toHaveLength(6);
    expect(new Set(blocked.map((scenario) => scenario.proof?.runtime)).size).toBe(6);
  });
});