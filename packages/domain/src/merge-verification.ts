import type { CommandSpec } from './command.js';

export type VerificationMode = 'github_ci' | 'local_exact_head' | 'hybrid';

export type MergeEvidenceSource = 'github_check' | 'local_command' | 'external_verifier';

export type MergeGateOutcome = 'passed' | 'failed' | 'unavailable';

export type MergeReviewOutcome =
  | 'github_approved'
  | 'clean_llm_review'
  | 'user_override'
  | 'rejected'
  | 'missing';

export type AcceptedMergeReviewOutcome = Exclude<MergeReviewOutcome, 'rejected' | 'missing'>;

export interface RequiredMergeGate {
  readonly name: string;
  readonly source: MergeEvidenceSource;
  /** Host-owned argv executed for local_exact_head/hybrid local_command gates. Never supplied by merge callers. */
  readonly command?: CommandSpec;
}

export interface MergeReviewPolicy {
  readonly required: boolean;
  readonly acceptedOutcomes: readonly AcceptedMergeReviewOutcome[];
}

export interface RepositoryMergePolicy {
  readonly repository: string;
  readonly defaultBranch: string;
  readonly verificationMode: VerificationMode;
  readonly requiredGates: readonly RequiredMergeGate[];
  readonly reviewPolicy: MergeReviewPolicy;
}

export interface MergeGateReceipt {
  readonly name: string;
  readonly source: MergeEvidenceSource;
  readonly headSha: string;
  readonly outcome: MergeGateOutcome;
  readonly evidence?: string;
}

export interface MergeReviewReceipt {
  readonly outcome: MergeReviewOutcome;
  readonly headSha: string;
  readonly evidence?: string;
}

export interface MergeVerificationReceipt {
  readonly repository: string;
  readonly pullRequest: number;
  readonly headSha: string;
  readonly baseSha?: string;
  readonly verificationMode: VerificationMode;
  readonly gates: readonly MergeGateReceipt[];
  readonly review: MergeReviewReceipt;
  readonly createdAt: string;
}

export interface MergeEvidenceSubject {
  readonly repository: string;
  readonly pullRequest: number;
  readonly headSha: string;
  readonly baseBranch: string;
  readonly baseSha?: string;
}

export type MergeEvidenceBlockerCode =
  | 'repository_mismatch'
  | 'pull_request_mismatch'
  | 'base_branch_mismatch'
  | 'verification_mode_mismatch'
  | 'receipt_missing'
  | 'receipt_head_stale'
  | 'receipt_base_stale'
  | 'policy_gate_source_incompatible'
  | 'required_gate_missing'
  | 'required_gate_ambiguous'
  | 'required_gate_source_mismatch'
  | 'required_gate_head_stale'
  | 'required_gate_not_passed'
  | 'review_missing'
  | 'review_rejected'
  | 'review_outcome_not_allowed'
  | 'review_head_stale';

export interface MergeEvidenceBlocker {
  readonly code: MergeEvidenceBlockerCode;
  readonly gate?: string;
  readonly expected?: string;
  readonly observed?: string;
}

export type MergeEvidenceDecision =
  | { readonly status: 'MERGE_ALLOWED'; readonly blockers: readonly [] }
  | { readonly status: 'MERGE_BLOCKED'; readonly blockers: readonly MergeEvidenceBlocker[] };

export function evaluateMergeEvidence(
  policy: RepositoryMergePolicy,
  subject: MergeEvidenceSubject,
  receipt: MergeVerificationReceipt | undefined,
): MergeEvidenceDecision {
  const blockers: MergeEvidenceBlocker[] = [];

  if (subject.repository !== policy.repository) {
    blockers.push({
      code: 'repository_mismatch',
      expected: policy.repository,
      observed: subject.repository,
    });
  }

  if (subject.baseBranch !== policy.defaultBranch) {
    blockers.push({
      code: 'base_branch_mismatch',
      expected: policy.defaultBranch,
      observed: subject.baseBranch,
    });
  }

  if (receipt === undefined) {
    blockers.push({ code: 'receipt_missing' });
    return { status: 'MERGE_BLOCKED', blockers };
  }

  if (subject.repository === policy.repository && receipt.repository !== subject.repository) {
    blockers.push({
      code: 'repository_mismatch',
      expected: subject.repository,
      observed: receipt.repository,
    });
  }

  if (receipt.pullRequest !== subject.pullRequest) {
    blockers.push({
      code: 'pull_request_mismatch',
      expected: String(subject.pullRequest),
      observed: String(receipt.pullRequest),
    });
  }

  if (receipt.verificationMode !== policy.verificationMode) {
    blockers.push({
      code: 'verification_mode_mismatch',
      expected: policy.verificationMode,
      observed: receipt.verificationMode,
    });
  }

  if (receipt.headSha !== subject.headSha) {
    blockers.push({
      code: 'receipt_head_stale',
      expected: subject.headSha,
      observed: receipt.headSha,
    });
  }

  if (subject.baseSha !== undefined
    && receipt.baseSha !== undefined
    && receipt.baseSha !== subject.baseSha) {
    blockers.push({
      code: 'receipt_base_stale',
      expected: subject.baseSha,
      observed: receipt.baseSha,
    });
  }

  for (const requiredGate of policy.requiredGates) {
    if (!isSourceCompatibleWithMode(policy.verificationMode, requiredGate.source)) {
      blockers.push({
        code: 'policy_gate_source_incompatible',
        gate: requiredGate.name,
        expected: expectedSourceDescription(policy.verificationMode),
        observed: requiredGate.source,
      });
    }

    const evidence = receipt.gates.filter((gate) => gate.name === requiredGate.name);
    if (evidence.length === 0) {
      blockers.push({
        code: 'required_gate_missing',
        gate: requiredGate.name,
        expected: requiredGate.source,
      });
      continue;
    }
    if (evidence.length > 1) {
      blockers.push({
        code: 'required_gate_ambiguous',
        gate: requiredGate.name,
        expected: 'one exact gate receipt',
        observed: String(evidence.length),
      });
      continue;
    }

    const gate = evidence[0]!;
    if (gate.source !== requiredGate.source) {
      blockers.push({
        code: 'required_gate_source_mismatch',
        gate: requiredGate.name,
        expected: requiredGate.source,
        observed: gate.source,
      });
    }
    if (gate.headSha !== subject.headSha) {
      blockers.push({
        code: 'required_gate_head_stale',
        gate: requiredGate.name,
        expected: subject.headSha,
        observed: gate.headSha,
      });
    }
    if (gate.outcome !== 'passed') {
      blockers.push({
        code: 'required_gate_not_passed',
        gate: requiredGate.name,
        expected: 'passed',
        observed: gate.outcome,
      });
    }
  }

  evaluateReview(policy.reviewPolicy, subject.headSha, receipt.review, blockers);

  return blockers.length === 0
    ? { status: 'MERGE_ALLOWED', blockers: [] }
    : { status: 'MERGE_BLOCKED', blockers };
}

function evaluateReview(
  policy: MergeReviewPolicy,
  currentHeadSha: string,
  review: MergeReviewReceipt,
  blockers: MergeEvidenceBlocker[],
): void {
  if (!policy.required) return;

  if (review.headSha !== currentHeadSha) {
    blockers.push({
      code: 'review_head_stale',
      expected: currentHeadSha,
      observed: review.headSha,
    });
  }

  if (review.outcome === 'rejected') {
    blockers.push({
      code: 'review_rejected',
      observed: review.outcome,
    });
    return;
  }

  if (review.outcome === 'missing') {
    blockers.push({ code: 'review_missing' });
    return;
  }

  if (!policy.acceptedOutcomes.includes(review.outcome)) {
    blockers.push({
      code: 'review_outcome_not_allowed',
      expected: policy.acceptedOutcomes.join(','),
      observed: review.outcome,
    });
  }
}

function isSourceCompatibleWithMode(
  mode: VerificationMode,
  source: MergeEvidenceSource,
): boolean {
  if (mode === 'hybrid') return true;
  if (mode === 'github_ci') return source === 'github_check';
  return source === 'local_command';
}

function expectedSourceDescription(mode: VerificationMode): string {
  if (mode === 'github_ci') return 'github_check';
  if (mode === 'local_exact_head') return 'local_command';
  return 'github_check|local_command|external_verifier';
}
