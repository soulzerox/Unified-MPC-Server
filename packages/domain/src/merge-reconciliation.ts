import {
  evaluateMergeEvidence,
  type MergeEvidenceBlocker,
  type MergeVerificationReceipt,
  type RepositoryMergePolicy,
} from './merge-verification.js';

const SHA_PATTERN = /^[0-9a-f]{40,64}$/i;

export type MergeMethod = 'merge' | 'squash' | 'rebase';

export interface MergeObservation {
  readonly repository: string;
  readonly pullRequest: number;
  readonly headSha: string;
  readonly baseBranch: string;
  readonly baseSha?: string;
  readonly merged: boolean;
  readonly mergeMethod?: MergeMethod;
  readonly mergeSha?: string;
  readonly observedAt: string;
}

export type MergeReconciliationStatus = 'RECONCILED' | 'POLICY_BREACH' | 'INSPECT_REQUIRED';

export type MergeReconciliationAction = 'none' | 'surface_policy_breach' | 'inspect_required';

export type MergeReconciliationReason =
  | 'merge_reconciled'
  | 'merge_not_observed'
  | 'verification_receipt_missing'
  | 'verification_policy_breach'
  | 'merge_method_missing'
  | 'merge_method_mismatch'
  | 'merge_sha_missing'
  | 'merge_sha_invalid'
  | 'observation_timestamp_invalid';

export interface MergeReconciliationDecision {
  readonly status: MergeReconciliationStatus;
  readonly action: MergeReconciliationAction;
  readonly reason: MergeReconciliationReason;
  readonly expectedMergeMethod: MergeMethod;
  readonly observedMergeMethod?: MergeMethod;
  readonly mergeSha?: string;
  readonly blockers: readonly MergeEvidenceBlocker[];
}

export interface MergeReconciliationRecord {
  readonly reconciliationRef: string;
  readonly receiptRef?: string;
  readonly receipt?: MergeVerificationReceipt;
  readonly policy: RepositoryMergePolicy;
  readonly expectedMergeMethod: MergeMethod;
  readonly observation: MergeObservation;
  readonly decision: MergeReconciliationDecision;
  readonly recordedAt: string;
}

export function reconcileMergeEvidence(
  policy: RepositoryMergePolicy,
  observation: MergeObservation,
  receipt: MergeVerificationReceipt | undefined,
  expectedMergeMethod: MergeMethod,
): MergeReconciliationDecision {
  if (!Number.isFinite(Date.parse(observation.observedAt))) {
    return inspectDecision('observation_timestamp_invalid', expectedMergeMethod, observation);
  }

  if (!observation.merged) {
    return inspectDecision('merge_not_observed', expectedMergeMethod, observation);
  }

  const evidence = evaluateMergeEvidence(policy, {
    repository: observation.repository,
    pullRequest: observation.pullRequest,
    headSha: observation.headSha,
    baseBranch: observation.baseBranch,
    ...(observation.baseSha === undefined ? {} : { baseSha: observation.baseSha }),
  }, receipt);

  if (evidence.status === 'MERGE_BLOCKED') {
    return {
      status: 'POLICY_BREACH',
      action: 'surface_policy_breach',
      reason: receipt === undefined ? 'verification_receipt_missing' : 'verification_policy_breach',
      expectedMergeMethod,
      ...(observation.mergeMethod === undefined ? {} : { observedMergeMethod: observation.mergeMethod }),
      ...(observation.mergeSha === undefined ? {} : { mergeSha: observation.mergeSha }),
      blockers: evidence.blockers,
    };
  }

  if (observation.mergeMethod === undefined) {
    return inspectDecision('merge_method_missing', expectedMergeMethod, observation);
  }

  if (observation.mergeMethod !== expectedMergeMethod) {
    return {
      status: 'POLICY_BREACH',
      action: 'surface_policy_breach',
      reason: 'merge_method_mismatch',
      expectedMergeMethod,
      observedMergeMethod: observation.mergeMethod,
      ...(observation.mergeSha === undefined ? {} : { mergeSha: observation.mergeSha }),
      blockers: [],
    };
  }

  if (observation.mergeSha === undefined) {
    return inspectDecision('merge_sha_missing', expectedMergeMethod, observation);
  }
  if (!SHA_PATTERN.test(observation.mergeSha)) {
    return inspectDecision('merge_sha_invalid', expectedMergeMethod, observation);
  }

  return {
    status: 'RECONCILED',
    action: 'none',
    reason: 'merge_reconciled',
    expectedMergeMethod,
    observedMergeMethod: observation.mergeMethod,
    mergeSha: observation.mergeSha,
    blockers: [],
  };
}

function inspectDecision(
  reason: Extract<
    MergeReconciliationReason,
    'merge_not_observed' | 'merge_method_missing' | 'merge_sha_missing' | 'merge_sha_invalid' | 'observation_timestamp_invalid'
  >,
  expectedMergeMethod: MergeMethod,
  observation: MergeObservation,
): MergeReconciliationDecision {
  return {
    status: 'INSPECT_REQUIRED',
    action: 'inspect_required',
    reason,
    expectedMergeMethod,
    ...(observation.mergeMethod === undefined ? {} : { observedMergeMethod: observation.mergeMethod }),
    ...(observation.mergeSha === undefined ? {} : { mergeSha: observation.mergeSha }),
    blockers: [],
  };
}
