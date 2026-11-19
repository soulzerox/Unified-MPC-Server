import {
  DEFAULT_MUTATE_MODE,
  describeMutateBlockers,
  evaluateMutateGate,
  type MutateBlockerCode,
  type WorkspaceWorkflowGate,
} from './mutate-gate.js';

/**
 * The read-side of the `mutate` phase (#142, criterion "the projection can
 * truthfully explain why work is blocked").
 *
 * `evaluateMutateGate` decides; this module explains. It is deliberately the
 * same decision seen from outside: the caller supplies exactly the four facts
 * the gate consumes and gets back the same blockers, each with the action that
 * clears it. A projection that re-derived the rule could disagree with the
 * gate, and a disagreement here is worse than no explanation at all — it would
 * tell an operator to do something that does not unblock the mutation.
 *
 * What this cannot do is invent a fact it was not given. A harness the runtime
 * cannot read is reported as `evaluated: false` and as the same
 * `harness_inactive` blocker the gate would raise, because that is what the
 * gate does with an absent state: refuse rather than assume.
 */

/** The blocker the gate raises, plus the action that clears it. */
export interface BlockedWorkBlocker {
  readonly code: MutateBlockerCode;
  /** The path with no preparation, for `preparation_missing`. */
  readonly detail?: string;
  /** One sentence naming the tool that clears this blocker. */
  readonly clearedBy: string;
}

export interface BlockedWorkProjection {
  readonly phase: 'mutate';
  readonly mode: WorkspaceWorkflowGate['mutate'];
  /**
   * False when a fact the decision needs could not be read. The blockers are
   * still reported — the gate refuses in that state too — but the operator is
   * told the answer is made of what the runtime could see.
   */
  readonly evaluated: boolean;
  readonly blocked: boolean;
  readonly blockers: readonly BlockedWorkBlocker[];
  /** A limit of the answer that the blocker codes do not express. */
  readonly note?: string;
}

export interface MutationBlockedWorkFacts {
  readonly gate: WorkspaceWorkflowGate;
  /** `unknown` means the runtime could not read its harness ledger. */
  readonly harness: 'active' | 'inactive' | 'stale' | 'unknown';
  /** Development artifact paths the question is about; empty asks about the phase. */
  readonly requestedPaths?: readonly string[];
  /** The subset of `requestedPaths` the ledger holds a preparation for. */
  readonly preparedPaths?: readonly string[];
}

const CLEARED_BY: Readonly<Record<MutateBlockerCode, string>> = {
  harness_inactive: 'Run workspace_bootstrap, then prepare_code_change for each path you will change',
  harness_stale: 'The workspace harness changed: run workspace_bootstrap, then prepare_code_change again',
  preparation_missing: 'Run prepare_code_change for this path against the current workspace state',
};

export function explainMutationBlockers(facts: MutationBlockedWorkFacts): BlockedWorkProjection {
  const requestedPaths = facts.requestedPaths ?? [];
  const preparedPaths = facts.preparedPaths ?? [];
  const harness = facts.harness === 'unknown' ? 'inactive' : facts.harness;

  const decision = evaluateMutateGate({
    mode: facts.gate.mutate,
    harness,
    paths: requestedPaths,
    preparedPaths,
  });

  if (decision.allowed) {
    const note = facts.gate.mutate === DEFAULT_MUTATE_MODE
      ? 'This workspace prepares evidence on demand, so the mutate phase authorizes every mutation it admits; nothing is required before writing.'
      : undefined;
    return {
      phase: 'mutate',
      mode: facts.gate.mutate,
      evaluated: facts.harness !== 'unknown',
      blocked: false,
      blockers: [],
      ...(note === undefined ? {} : { note }),
    };
  }

  return {
    phase: 'mutate',
    mode: facts.gate.mutate,
    evaluated: facts.harness !== 'unknown',
    blocked: true,
    blockers: decision.blockers.map((blocker) => ({
      code: blocker.code,
      ...(blocker.path === undefined ? {} : { detail: blocker.path }),
      clearedBy: CLEARED_BY[blocker.code],
    })),
    note: facts.harness === 'unknown'
      ? 'The runtime could not read this workspace harness state, so the mutate phase is treated as inactive — the same refusal a mutation would receive.'
      : describeMutateBlockers(decision.blockers),
  };
}
