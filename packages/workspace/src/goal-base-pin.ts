import type { CanonicalRefState } from '@unified-mpc/domain';
import type { CanonicalRefStore } from './canonical-ref-store.js';
import { GoalOverlayStore, type GoalOverlay } from './goal-overlay-store.js';

export interface GoalBasePinInput {
  readonly goalWorkspaceId: string;
  readonly canonicalRef: string;
  readonly expectedBase: CanonicalRefState;
}

/**
 * Attach a Goal overlay to a validated base pin (#210 U9).
 *
 * Reads the live canonical ref, fails closed when it is missing or has
 * moved since the expected base, and only then creates the overlay pinned
 * to the exact live state. No overlay may exist without a proven base —
 * a Goal workspace can never silently attach to a stale revision.
 */
export async function attachGoalBasePin(
  refs: CanonicalRefStore,
  overlays: GoalOverlayStore,
  input: GoalBasePinInput,
): Promise<GoalOverlay> {
  const live = await refs.read(input.canonicalRef);
  if (live === null) {
    throw new Error(`no canonical ref at ${input.canonicalRef}: cannot pin goal ${input.goalWorkspaceId}`);
  }
  const moved = live.commitSha !== input.expectedBase.commitSha
    || live.treeOid !== input.expectedBase.treeOid
    || live.manifestId !== input.expectedBase.manifestId;
  if (moved) {
    throw new Error(
      `base moved for goal ${input.goalWorkspaceId}: expected ${input.expectedBase.commitSha.slice(0, 12)} `
      + `but canonical ref ${input.canonicalRef} is at ${live.commitSha.slice(0, 12)}`,
    );
  }
  return overlays.create(input.goalWorkspaceId, {
    baseCommitSha: live.commitSha,
    baseTreeOid: live.treeOid,
    baseManifestId: live.manifestId,
  });
}
