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
 * subject being merged, with a review that is not a rejection.
 *
 * This suite is the single owner of that rule. It builds one scenario table and
 * runs both real evaluators over it, so a change to either side that makes them
 * disagree fails here. It is the only place allowed to import both worlds —
 * `apps/cli` is the composition root that already binds both.
 *
 * A row is either `shared` (both worlds carry the field, and both must reach the
 * same decision) or `runtime-only` (only the runtime receipt records it, so the
 * corpus pins the runtime's refusal and records that the CLI cannot express the
 * clause). Marking a clause shared when one side has no field for it would let
 * the corpus claim coverage it does not have.
 *
 * It imports `@unified-mpc/domain`, whose `exports` maps the `development`
 * condition to its source and `default` to its `dist`. Under the merge profile's
 * vitest run (`NODE_ENV` unset) that is the source, so this file needs no build;
 * it still runs in `test:cli`, after `build`, rather than in the pre-build
 * `.mjs` gate step.
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
  readonly scope: 'shared' | 'runtime-only';
  /** Verification evidence exists for this subject. */
  readonly verification: boolean;
  /** Review evidence exists for this subject. */
  readonly review: boolean;
  /** The review rejected the head instead of accepting it. */
  readonly reviewRejected?: boolean;
  readonly verificationHead: 'subject' | 'other';
  readonly reviewHead: 'subject' | 'other';
  /**
   * Evidence recorded against a different base. The two worlds store that fact
   * on different objects — the runtime receipt carries `baseSha`, the CLI keeps
   * it on the review receipt, which is the object that records the diff it was
   * reviewed against — so one field drives both adapters.
   */
  readonly base: 'subject' | 'other';
  /** Evidence names another pull request. Both worlds record the number. */
  readonly pullRequest: 'subject' | 'other';
  /** The subject targets another base branch. Both worlds compare it. */
  readonly baseBranch?: 'subject' | 'other';
  /** Evidence names another repository. Only the runtime receipt records it. */
  readonly repository?: 'subject' | 'other';
  readonly expected: 'allowed' | 'blocked';
  /**
   * The refusal each world must report, so a row cannot pass because of an
   * unrelated blocker. `cli: null` means the CLI receipt has no field for this
   * clause. `proof` is `null` for the row that must be allowed.
   */
  readonly proof: { readonly cli: RegExp | null; readonly runtime: MergeEvidenceBlockerCode } | null;
}

const PASSING_ROW = {
  name: 'complete evidence for the exact subject',
  scope: 'shared',
  verification: true,
  review: true,
  verificationHead: 'subject',
  reviewHead: 'subject',
  base: 'subject',
  pullRequest: 'subject',
  repository: 'subject',
  expected: 'allowed',
  proof: null,
} as const satisfies Scenario;

/**
 * Every blocked row changes exactly one field away from the passing row, so it
 * names a rule that actually refused this head instead of a fixture that never
 * passed in the first place.
 */
const SCENARIOS: readonly Scenario[] = [
  PASSING_ROW,
  {
    ...PASSING_ROW,
    name: 'no verification evidence',
    verification: false,
    expected: 'blocked',
    proof: { cli: /no local verification receipt/, runtime: 'receipt_missing' },
  },
  {
    ...PASSING_ROW,
    name: 'no review evidence',
    review: false,
    expected: 'blocked',
    proof: { cli: /no exact-head review receipt/, runtime: 'review_missing' },
  },
  {
    ...PASSING_ROW,
    name: 'the review rejected the head',
    reviewRejected: true,
    expected: 'blocked',
    proof: { cli: /review verdict is 'blocked'/, runtime: 'review_rejected' },
  },
  {
    ...PASSING_ROW,
    name: 'verification produced for another head',
    verificationHead: 'other',
    expected: 'blocked',
    proof: { cli: /verification receipt was produced for a different head/, runtime: 'receipt_head_stale' },
  },
  {
    ...PASSING_ROW,
    name: 'review produced for another head',
    reviewHead: 'other',
    expected: 'blocked',
    proof: { cli: /review receipt was produced for a different head/, runtime: 'review_head_stale' },
  },
  {
    ...PASSING_ROW,
    name: 'evidence recorded against another base',
    base: 'other',
    expected: 'blocked',
    proof: { cli: /review receipt was produced against a different base/, runtime: 'receipt_base_stale' },
  },
  {
    ...PASSING_ROW,
    name: 'the subject targets another base branch',
    baseBranch: 'other',
    expected: 'blocked',
    proof: { cli: /base is 'develop', expected 'main'/, runtime: 'base_branch_mismatch' },
  },
  {
    ...PASSING_ROW,
    name: 'evidence belongs to another pull request',
    pullRequest: 'other',
    expected: 'blocked',
    proof: { cli: /review receipt is for PR #143/, runtime: 'pull_request_mismatch' },
  },
  {
    ...PASSING_ROW,
    name: 'runtime evidence belongs to another repository',
    scope: 'runtime-only',
    repository: 'other',
    expected: 'blocked',
    // The CLI profile receipt has no repository field: its identity is the PR
    // number plus the head and base it named.
    proof: { cli: null, runtime: 'repository_mismatch' },
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
  // hand-written ambient module. `import.meta.url` is already a file URL, so its
  // `href` is the specifier — round-tripping it through a path would re-encode
  // any `%` and break a checkout whose directory name contains a space.
  const specifier = new URL('../../../scripts/workflow-gate-core.mjs', import.meta.url).href;
  return await import(specifier) as CliModules;
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
  const review: MergeReviewOutcome = scenario.reviewRejected === true
    ? 'rejected'
    : scenario.review
      ? 'clean_llm_review'
      : 'missing';
  return {
    repository: scenario.repository === 'other' ? 'someone/else' : REPOSITORY,
    pullRequest: scenario.pullRequest === 'other' ? PULL_REQUEST + 1 : PULL_REQUEST,
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
    baseBranch: scenario.baseBranch === 'other' ? 'develop' : 'main',
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
        prNumber: scenario.pullRequest === 'other' ? PULL_REQUEST + 1 : PULL_REQUEST,
        baseSha: scenario.base === 'subject' ? BASE : OTHER_BASE,
        headSha: scenario.reviewHead === 'subject' ? HEAD : OTHER_HEAD,
        skillId: 'unified-code-review',
        skillVersion: 1,
        skillSha256: 'sha256:conformance',
        reviewedFingerprint: fingerprint,
        blockingOpenCount: scenario.reviewRejected === true ? 1 : 0,
        verdict: scenario.reviewRejected === true ? 'blocked' : 'clean',
        findings: scenario.reviewRejected === true
          ? [{
              severity: 'blocking',
              category: 'correctness',
              file: 'src/index.ts',
              line: 1,
              claim: 'the corpus rejected this head on purpose',
              evidence_refs: ['src/index.ts:1'],
              required_fix: true,
              status: 'open',
            }]
          : [],
      }
    : undefined;

  const verdict = gate.evaluateMergeEligibility({
    pr: {
      number: PULL_REQUEST,
      title: 'conformance',
      body: 'Refs #142',
      state: 'OPEN',
      isDraft: false,
      baseRefName: scenario.baseBranch === 'other' ? 'develop' : 'main',
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
  it('shared rows: both merge gates reach the same, expected decision', async () => {
    const modules = await loadCliModules();
    const failures = SCENARIOS.filter((scenario) => scenario.scope === 'shared').flatMap((scenario) => {
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
        const cliProof = scenario.proof.cli;
        if (cliProof !== null && !cli.blockers.some((blocker) => cliProof.test(blocker))) {
          problems.push(`${scenario.name}: cli did not report ${String(cliProof)} (got ${cli.blockers.join(' | ')})`);
        }
      }

      return problems;
    });

    expect(failures).toEqual([]);
  });

  it('runtime-only rows: the runtime refuses and the row claims no CLI proof', () => {
    const failures = SCENARIOS.filter((scenario) => scenario.scope === 'runtime-only').flatMap((scenario) => {
      const runtime = runtimeVerdict(scenario);
      const problems: string[] = [];
      if (runtime.allowed) problems.push(`${scenario.name}: runtime allowed the head`);
      if (scenario.proof !== null) {
        if (!runtime.codes.includes(scenario.proof.runtime)) {
          problems.push(`${scenario.name}: runtime did not report ${scenario.proof.runtime} (got ${runtime.codes.join(', ')})`);
        }
        // Nothing to assert on the CLI side: its profile receipt has no
        // repository field, so this adapter cannot vary it and no assertion here
        // could detect the CLI gaining one. The row records the asymmetry rather
        // than pretending to test it; a future CLI receipt that carries a
        // repository needs a new shared row, not a tightened check in this one.
        if (scenario.proof.cli !== null) {
          problems.push(`${scenario.name}: a runtime-only row must not claim a CLI proof`);
        }
      }
      return problems;
    });

    expect(failures).toEqual([]);
  });

  it('the corpus is not vacuous: one passing row, and every shared rule has its own refusal', () => {
    // A table that only ever blocks would pass against an evaluator that refuses
    // everything, which is the failure mode a conformance suite must not have.
    const allowed = SCENARIOS.filter((scenario) => scenario.expected === 'allowed');
    expect(allowed).toHaveLength(1);

    const shared = SCENARIOS.filter((scenario) => scenario.scope === 'shared' && scenario.expected === 'blocked');
    expect(shared).toHaveLength(8);
    expect(new Set(shared.map((scenario) => scenario.proof?.runtime)).size).toBe(8);
    expect(shared.every((scenario) => scenario.proof?.cli !== null && scenario.proof?.cli !== undefined)).toBe(true);

    const runtimeOnly = SCENARIOS.filter((scenario) => scenario.scope === 'runtime-only');
    expect(runtimeOnly.length).toBeGreaterThanOrEqual(1);
  });
});