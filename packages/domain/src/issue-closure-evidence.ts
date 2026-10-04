import type {
  MergeEvidenceBlocker,
  MergeEvidenceDecision,
} from './merge-verification.js';

export type IssueClosureIntent = 'explicit_close' | 'reference_only' | 'none';

export type IssueClosureScopeSourceKind =
  | 'issue_body'
  | 'issue_comment'
  | 'scope_change'
  | 'other';

export interface IssueClosureScopeSource {
  readonly kind: IssueClosureScopeSourceKind;
  readonly ref: string;
}

export type IssueClosureSuccessorOwnerState = 'open' | 'closed' | 'unknown';

export type IssueClosureCriterionDisposition =
  | {
    readonly kind: 'satisfied';
    readonly evidence: readonly string[];
  }
  | {
    readonly kind: 'successor';
    readonly ownerIssue: string;
    readonly ownerState: IssueClosureSuccessorOwnerState;
    readonly linkEvidence: readonly string[];
  }
  | {
    readonly kind: 'removed';
    readonly approvalEvidence: readonly string[];
  }
  | {
    readonly kind: 'unresolved';
  };

export interface IssueClosureCriterion {
  readonly criterion: string;
  readonly source: IssueClosureScopeSource;
  readonly disposition: IssueClosureCriterionDisposition;
}

export interface IssueClosureMergeVerification {
  readonly implementationPR: string;
  readonly decision: MergeEvidenceDecision;
  readonly receiptRef: string;
}

export interface IssueClosureEvidenceInput {
  readonly issue: string;
  readonly implementationPRs: readonly string[];
  readonly closeIntent: IssueClosureIntent;
  readonly antiCloseMarkers: readonly string[];
  readonly criteria: readonly IssueClosureCriterion[];
  readonly mergeVerifications: readonly IssueClosureMergeVerification[];
}

export type IssueClosureBlockerCode =
  | 'explicit_close_intent_missing'
  | 'anti_close_fence'
  | 'unresolved_criterion'
  | 'satisfied_criterion_evidence_missing'
  | 'successor_owner_missing'
  | 'successor_owner_not_open'
  | 'successor_link_evidence_missing'
  | 'scope_removal_approval_missing'
  | 'implementation_pr_duplicate'
  | 'merge_verification_missing'
  | 'merge_verification_ambiguous'
  | 'merge_verification_unexpected'
  | 'merge_verification_blocked'
  | 'merge_verification_reference_missing';

export interface IssueClosureBlocker {
  readonly code: IssueClosureBlockerCode;
  readonly criterion?: string;
  readonly sourceRef?: string;
  readonly evidence?: string;
  readonly implementationPR?: string;
  readonly ownerState?: IssueClosureSuccessorOwnerState;
  readonly mergeBlockers?: readonly MergeEvidenceBlocker[];
}

export interface SatisfiedIssueClosureCriterion {
  readonly criterion: string;
  readonly source: IssueClosureScopeSource;
  readonly evidence: readonly string[];
}

export interface IssueClosureSuccessorScope {
  readonly scope: string;
  readonly source: IssueClosureScopeSource;
  readonly ownerIssue: string;
  readonly ownerState: 'open';
  readonly evidence: readonly string[];
}

export interface RemovedIssueClosureScope {
  readonly scope: string;
  readonly source: IssueClosureScopeSource;
  readonly approvalEvidence: readonly string[];
}

export interface UnresolvedIssueClosureCriterion {
  readonly criterion: string;
  readonly source: IssueClosureScopeSource;
}

export interface IssueClosureMergeVerificationRef {
  readonly implementationPR: string;
  readonly receiptRef: string;
}

export interface IssueClosureReceipt {
  readonly issue: string;
  readonly implementationPRs: readonly string[];
  readonly satisfiedCriteria: readonly SatisfiedIssueClosureCriterion[];
  readonly successorScope: readonly IssueClosureSuccessorScope[];
  readonly removedScope: readonly RemovedIssueClosureScope[];
  readonly unresolvedCriteria: readonly UnresolvedIssueClosureCriterion[];
  readonly mergeVerificationRefs: readonly IssueClosureMergeVerificationRef[];
  readonly closeAllowed: boolean;
  readonly reason: string;
  readonly blockers: readonly IssueClosureBlocker[];
}

export function evaluateIssueClosureEvidence(
  input: IssueClosureEvidenceInput,
): IssueClosureReceipt {
  const blockers: IssueClosureBlocker[] = [];
  const satisfiedCriteria: SatisfiedIssueClosureCriterion[] = [];
  const successorScope: IssueClosureSuccessorScope[] = [];
  const removedScope: RemovedIssueClosureScope[] = [];
  const unresolvedCriteria: UnresolvedIssueClosureCriterion[] = [];

  if (input.closeIntent !== 'explicit_close') {
    blockers.push({ code: 'explicit_close_intent_missing' });
  }

  for (const marker of input.antiCloseMarkers) {
    const normalized = marker.trim();
    if (normalized.length === 0) continue;
    blockers.push({
      code: 'anti_close_fence',
      evidence: normalized,
    });
  }

  for (const criterion of input.criteria) {
    evaluateCriterion(
      criterion,
      blockers,
      satisfiedCriteria,
      successorScope,
      removedScope,
      unresolvedCriteria,
    );
  }

  const mergeVerificationRefs = evaluateMergeVerifications(
    input.implementationPRs,
    input.mergeVerifications,
    blockers,
  );

  const closeAllowed = blockers.length === 0;

  return {
    issue: input.issue,
    implementationPRs: input.implementationPRs,
    satisfiedCriteria,
    successorScope,
    removedScope,
    unresolvedCriteria,
    mergeVerificationRefs,
    closeAllowed,
    reason: closeAllowed ? 'closure_evidence_complete' : blockers[0]!.code,
    blockers,
  };
}

function evaluateCriterion(
  criterion: IssueClosureCriterion,
  blockers: IssueClosureBlocker[],
  satisfiedCriteria: SatisfiedIssueClosureCriterion[],
  successorScope: IssueClosureSuccessorScope[],
  removedScope: RemovedIssueClosureScope[],
  unresolvedCriteria: UnresolvedIssueClosureCriterion[],
): void {
  const unresolved = (): void => {
    unresolvedCriteria.push({
      criterion: criterion.criterion,
      source: criterion.source,
    });
  };

  switch (criterion.disposition.kind) {
    case 'satisfied': {
      const evidence = nonEmptyValues(criterion.disposition.evidence);
      if (evidence.length === 0) {
        unresolved();
        blockers.push({
          code: 'satisfied_criterion_evidence_missing',
          criterion: criterion.criterion,
          sourceRef: criterion.source.ref,
        });
        return;
      }
      satisfiedCriteria.push({
        criterion: criterion.criterion,
        source: criterion.source,
        evidence,
      });
      return;
    }

    case 'successor': {
      const ownerIssue = criterion.disposition.ownerIssue.trim();
      const evidence = nonEmptyValues(criterion.disposition.linkEvidence);
      let invalid = false;

      if (ownerIssue.length === 0) {
        invalid = true;
        blockers.push({
          code: 'successor_owner_missing',
          criterion: criterion.criterion,
          sourceRef: criterion.source.ref,
        });
      }
      if (criterion.disposition.ownerState !== 'open') {
        invalid = true;
        blockers.push({
          code: 'successor_owner_not_open',
          criterion: criterion.criterion,
          sourceRef: criterion.source.ref,
          ownerState: criterion.disposition.ownerState,
        });
      }
      if (evidence.length === 0) {
        invalid = true;
        blockers.push({
          code: 'successor_link_evidence_missing',
          criterion: criterion.criterion,
          sourceRef: criterion.source.ref,
        });
      }

      if (invalid) {
        unresolved();
        return;
      }

      successorScope.push({
        scope: criterion.criterion,
        source: criterion.source,
        ownerIssue,
        ownerState: 'open',
        evidence,
      });
      return;
    }

    case 'removed': {
      const approvalEvidence = nonEmptyValues(criterion.disposition.approvalEvidence);
      if (approvalEvidence.length === 0) {
        unresolved();
        blockers.push({
          code: 'scope_removal_approval_missing',
          criterion: criterion.criterion,
          sourceRef: criterion.source.ref,
        });
        return;
      }
      removedScope.push({
        scope: criterion.criterion,
        source: criterion.source,
        approvalEvidence,
      });
      return;
    }

    case 'unresolved':
      unresolved();
      blockers.push({
        code: 'unresolved_criterion',
        criterion: criterion.criterion,
        sourceRef: criterion.source.ref,
      });
  }
}

function evaluateMergeVerifications(
  implementationPRs: readonly string[],
  verifications: readonly IssueClosureMergeVerification[],
  blockers: IssueClosureBlocker[],
): IssueClosureMergeVerificationRef[] {
  const refs: IssueClosureMergeVerificationRef[] = [];
  const implementationPRSet = new Set<string>();
  const uniqueImplementationPRs: string[] = [];

  for (const implementationPR of implementationPRs) {
    if (implementationPRSet.has(implementationPR)) {
      blockers.push({
        code: 'implementation_pr_duplicate',
        implementationPR,
      });
      continue;
    }
    implementationPRSet.add(implementationPR);
    uniqueImplementationPRs.push(implementationPR);
  }

  for (const verification of verifications) {
    if (!implementationPRSet.has(verification.implementationPR)) {
      blockers.push({
        code: 'merge_verification_unexpected',
        implementationPR: verification.implementationPR,
      });
    }
  }

  for (const implementationPR of uniqueImplementationPRs) {
    const matches = verifications.filter(
      (verification) => verification.implementationPR === implementationPR,
    );

    if (matches.length === 0) {
      blockers.push({
        code: 'merge_verification_missing',
        implementationPR,
      });
      continue;
    }

    if (matches.length > 1) {
      blockers.push({
        code: 'merge_verification_ambiguous',
        implementationPR,
      });
      continue;
    }

    const verification = matches[0]!;
    if (verification.decision.status === 'MERGE_BLOCKED') {
      blockers.push({
        code: 'merge_verification_blocked',
        implementationPR,
        mergeBlockers: verification.decision.blockers,
      });
      continue;
    }

    const receiptRef = verification.receiptRef.trim();
    if (receiptRef.length === 0) {
      blockers.push({
        code: 'merge_verification_reference_missing',
        implementationPR,
      });
      continue;
    }

    refs.push({
      implementationPR,
      receiptRef,
    });
  }

  return refs;
}

function nonEmptyValues(values: readonly string[]): string[] {
  return values
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}
