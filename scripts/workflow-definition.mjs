#!/usr/bin/env node
import { createHash } from 'node:crypto';

/**
 * The workflow definition itself (#142, criterion 1).
 *
 * Every gate script used to carry its own version literal — the verification
 * profile, the review gate and the close receipt each named a number that only
 * described that script. A receipt could say which profile or capsule format it
 * used, but none of them said which *workflow* authorized the decision, so an
 * edit to a phase or gate name was invisible to evidence already on disk.
 *
 * The definition is code-owned, not configuration: the phases and the gate that
 * decides each one are the contract, so they live here and are versioned like
 * code. Every receipt writes `workflowStamp(phase)`, which names this definition
 * and its fingerprint. A change is append-only — a new phase, gate or version
 * gets a new `WORKFLOW_VERSION` and a new recorded fingerprint, never an edited
 * table entry — and the fingerprint makes a silent edit fail every receipt that
 * was decided under the old definition instead of quietly re-describing it.
 */

export const WORKFLOW_ID = 'unified-mpc.workflow-gate';
export const WORKFLOW_VERSION = 1;
export const WORKFLOW_PHASES = Object.freeze([
  'intake',
  'discover',
  'prepare',
  'mutate',
  'verify',
  'review',
  'integrate',
  'close',
]);
/** The phases that are actually enforced, and the gate that owns each one. */
export const WORKFLOW_GATES = Object.freeze({
  mutate: 'mutation_preparation',
  verify: 'verification_evidence',
  review: 'exact_head_review',
  integrate: 'merge_evidence',
  close: 'retention_clear',
});

/** Key order is fixed by construction, so the digest is stable across runs. */
export const WORKFLOW_FINGERPRINT = `sha256:${createHash('sha256')
  .update(JSON.stringify({
    id: WORKFLOW_ID,
    version: WORKFLOW_VERSION,
    phases: WORKFLOW_PHASES,
    gates: WORKFLOW_GATES,
  }))
  .digest('hex')}`;

/** The block every receipt carries: which definition decided this phase. */
export function workflowStamp(phase) {
  if (!WORKFLOW_PHASES.includes(phase)) {
    throw new RangeError(`unknown workflow phase '${String(phase)}'`);
  }
  return {
    id: WORKFLOW_ID,
    version: WORKFLOW_VERSION,
    phase,
    gate: WORKFLOW_GATES[phase],
    definitionFingerprint: WORKFLOW_FINGERPRINT,
  };
}

/**
 * Refusals for a receipt's `workflow` block, empty when it is valid. A receipt
 * that names no definition is refused rather than assumed: it was written before
 * the definition existed, so nothing on disk says which contract it satisfied.
 */
export function workflowStampBlockers(stamp, expectedPhase) {
  if (stamp === undefined) return ['receipt names no workflow definition'];
  if (stamp === null || typeof stamp !== 'object' || Array.isArray(stamp)) {
    return ['workflow block must be an object'];
  }
  const blockers = [];
  if (stamp.id !== WORKFLOW_ID) {
    blockers.push(`workflow block names definition '${String(stamp.id)}', expected '${WORKFLOW_ID}'`);
  }
  if (stamp.version !== WORKFLOW_VERSION) {
    blockers.push(`workflow block used version ${String(stamp.version)}, current is ${WORKFLOW_VERSION}`);
  }
  if (!WORKFLOW_PHASES.includes(stamp.phase)) {
    blockers.push(`workflow block names unknown phase '${String(stamp.phase)}'`);
  } else {
    if (stamp.gate !== WORKFLOW_GATES[stamp.phase]) {
      blockers.push(`workflow block gate '${String(stamp.gate)}' is not '${String(WORKFLOW_GATES[stamp.phase])}' for phase '${stamp.phase}'`);
    }
    if (expectedPhase !== undefined && stamp.phase !== expectedPhase) {
      blockers.push(`workflow block names phase '${stamp.phase}', expected '${expectedPhase}'`);
    }
  }
  if (stamp.definitionFingerprint !== WORKFLOW_FINGERPRINT) {
    blockers.push('workflow block names a different definition fingerprint');
  }
  return blockers;
}
