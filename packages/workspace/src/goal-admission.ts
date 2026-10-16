import type { CanonicalRefStore } from './canonical-ref-store.js';
import { GoalOverlayStore, type GoalOverlay } from './goal-overlay-store.js';

export interface GoalAdmissionInput {
  readonly goalWorkspaceId: string;
  readonly canonicalRef: string;
}

export type GoalAdmissionVerdict =
  | { readonly admitted: true; readonly overlay: GoalOverlay; readonly baseManifestId: string }
  | { readonly admitted: false; readonly reason: string };

/**
 * Verify Goal admission against the live canonical ref (#210 U11).
 *
 * A Goal workspace is admissible only while its overlay base still matches
 * the live canonical ref state. When main advanced past the pinned base,
 * admission fails closed with a drift reason — the Goal must rebase its
 * pin (re-attach) rather than silently work against a stale revision.
 * A missing overlay is a separate fail-closed reason, never an implicit
 * empty-overlay admission.
 */
export async function verifyGoalAdmission(
  refs: CanonicalRefStore,
  overlays: GoalOverlayStore,
  input: GoalAdmissionInput,
): Promise<GoalAdmissionVerdict> {
  const overlay = await overlays.read(input.goalWorkspaceId);
  if (overlay === null) {
    return { admitted: false, reason: `no overlay for goal ${input.goalWorkspaceId}` };
  }
  const live = await refs.read(input.canonicalRef);
  if (live === null) {
    return { admitted: false, reason: `no canonical ref at ${input.canonicalRef}` };
  }
  const drifted = live.commitSha !== overlay.baseCommitSha
    || live.treeOid !== overlay.baseTreeOid
    || live.manifestId !== overlay.baseManifestId;
  if (drifted) {
    return {
      admitted: false,
      reason: `base drift for goal ${input.goalWorkspaceId}: pinned ${overlay.baseCommitSha.slice(0, 12)} `
        + `but canonical ref ${input.canonicalRef} is at ${live.commitSha.slice(0, 12)}`,
    };
  }
  return { admitted: true, overlay, baseManifestId: overlay.baseManifestId };
}

export { GoalOverlayStore };
