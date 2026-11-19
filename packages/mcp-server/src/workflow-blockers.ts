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
 * gate does with an absent state: refuse rather than assume. A preparation the
 * seam would have wiped, because the admitted workspace source moved, is not
 * reported as evidence either.
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

/** Why the harness could not be read, so the answer names the fact that is missing. */
export type UnreadableHarnessFact = 'no_activation' | 'agents_md' | 'source_identity';

export interface MutationBlockedWorkFacts {
  readonly gate: WorkspaceWorkflowGate;
  /** `unknown` means the runtime could not read its harness ledger. */
  readonly harness: 'active' | 'inactive' | 'stale' | 'unknown';
  /** Present when `harness` is `unknown`; both are the seam's refusal, for two reasons. */
  readonly unreadable?: UnreadableHarnessFact;
  /** Development artifact paths the question is about; empty asks about the phase. */
  readonly requestedPaths?: readonly string[];
  /** The subset of `requestedPaths` the ledger holds a preparation for. */
  readonly preparedPaths?: readonly string[];
  /**
   * True when the admitted workspace source moved since those preparations were
   * made. The seam wipes them in that case, so they are not evidence here either.
   */
  readonly sourceMoved?: boolean;
}

const CLEARED_BY: Readonly<Record<MutateBlockerCode, string>> = {
  harness_inactive: 'Run workspace_bootstrap, then prepare_code_change for each path you will change',
  harness_stale: 'The workspace harness changed: run workspace_bootstrap, then prepare_code_change again',
  preparation_missing: 'Run prepare_code_change for this path against the current workspace state',
};

const UNREADABLE_NOTE: Readonly<Record<UnreadableHarnessFact, string>> = {
  no_activation: 'No harness is active for this session, so the mutate phase is treated as inactive — the same refusal a mutation from here would receive.',
  agents_md: 'The harness could not be read (AGENTS.md), so the mutate phase is treated as inactive — a mutation from here would fail on that read before it reached the preparation check.',
  source_identity: 'The workspace source could not be read (git identity), so no preparation can be shown to still apply — a mutation from here fails on that read before the preparation check.',
};

export function explainMutationBlockers(facts: MutationBlockedWorkFacts): BlockedWorkProjection {
  const requestedPaths = facts.requestedPaths ?? [];
  // A moved workspace source voids every preparation the ledger still holds, exactly
  // as the seam's `synchronizeSource` does.
  const preparedPaths = facts.sourceMoved === true ? [] : facts.preparedPaths ?? [];
  const harness = facts.harness === 'unknown' ? 'inactive' : facts.harness;
  // `auto_prepare` never reads the harness, so an unreadable one is not a missing fact
  // for that posture.
  const evaluated = facts.harness !== 'unknown' || facts.gate.mutate === DEFAULT_MUTATE_MODE;

  const decision = evaluateMutateGate({
    mode: facts.gate.mutate,
    harness,
    paths: requestedPaths,
    preparedPaths,
  });

  // A mutation that names no path is decided by the opaque policy instead of this one,
  // so a workspace that refuses those is not "nothing required": say which half of the
  // phase this answer is about rather than letting the reader assume it covers both.
  const opaqueNote = facts.gate.mutate !== DEFAULT_MUTATE_MODE && facts.gate.mutateOpaque === 'refuse'
    ? 'This workspace also refuses mutations that name no path (workflowGate.mutateOpaque: refuse); that half of the phase is decided from the mutation, not from a preparation.'
    : undefined;

  if (decision.allowed) {
    const notes = [
      facts.gate.mutate === DEFAULT_MUTATE_MODE
        ? 'This workspace prepares evidence on demand, so the mutate phase authorizes every mutation it admits; nothing is required for a path-named write.'
        : undefined,
      facts.sourceMoved === true
        ? 'The workspace source moved since those preparations were made, so they no longer apply.'
        : undefined,
      opaqueNote,
    ].filter((note): note is string => note !== undefined);
    return {
      phase: 'mutate',
      mode: facts.gate.mutate,
      evaluated,
      blocked: false,
      blockers: [],
      ...(notes.length === 0 ? {} : { note: notes.join(' ') }),
    };
  }

  const notes = [
    facts.harness === 'unknown' ? UNREADABLE_NOTE[facts.unreadable ?? 'no_activation'] : describeMutateBlockers(decision.blockers),
    facts.sourceMoved === true
      ? 'The workspace source moved since those preparations were made, so they no longer apply.'
      : undefined,
    opaqueNote,
  ].filter((note): note is string => note !== undefined);
  return {
    phase: 'mutate',
    mode: facts.gate.mutate,
    evaluated,
    blocked: true,
    blockers: decision.blockers.map((blocker) => ({
      code: blocker.code,
      ...(blocker.path === undefined ? {} : { detail: blocker.path }),
      clearedBy: CLEARED_BY[blocker.code],
    })),
    note: notes.join(' '),
  };
}
