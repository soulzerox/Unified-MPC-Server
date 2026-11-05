import type { CanonicalRefStore } from './canonical-ref-store.js';
import { GoalOverlayStore, type GoalOverlay } from './goal-overlay-store.js';
import { attachGoalBasePin } from './goal-base-pin.js';
import { errorMessage } from './reachability-read.js';

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

/** One exact commit a Goal Workspace wants to pin its overlay base to. */
export interface GoalCanonicalPinInput {
  readonly goalWorkspaceId: string;
  readonly canonicalRef: string;
  readonly commitSha: string;
}

export type GoalBasePinOutcome =
  | { readonly status: 'pinned'; readonly baseManifestId: string }
  | {
      readonly status: 'skipped';
      readonly reason: 'no_canonical_ref' | 'commit_not_live';
      readonly detail: string;
    }
  | { readonly status: 'failed'; readonly reason: string };

/**
 * Pin a Goal overlay to the exact commit admission resolved (#210 §4).
 *
 * This is the admission policy, not a generic attach: it reads the canonical
 * ref strictly first, so a corrupt ref is reported instead of being read as
 * "never promoted" and replaced by a pin against nothing. A store that has
 * never advanced, or a Goal admitted from a historical/feature commit that is
 * not the live ref, is an explicit skip — Goal creation must keep working in
 * repositories without canonical data. Only when the live ref *is* the
 * requested commit does the overlay attach, using the state just read.
 *
 * Never throws: the worktree and registration are already durable when this
 * runs, so a write failure is an outcome for the caller to report, not a
 * reason to fail Goal creation.
 */
export async function pinGoalBaseAtCommit(
  refs: CanonicalRefStore,
  overlays: GoalOverlayStore,
  input: GoalCanonicalPinInput,
): Promise<GoalBasePinOutcome> {
  try {
    const live = await refs.read(input.canonicalRef, { strict: true });
    if (live === null) {
      return {
        status: 'skipped',
        reason: 'no_canonical_ref',
        detail: `no canonical ref at ${input.canonicalRef}`,
      };
    }
    if (live.commitSha !== input.commitSha) {
      return {
        status: 'skipped',
        reason: 'commit_not_live',
        detail: `canonical ref ${input.canonicalRef} is at ${live.commitSha.slice(0, 12)}, not ${input.commitSha.slice(0, 12)}`,
      };
    }
    const overlay = await attachGoalBasePin(refs, overlays, {
      goalWorkspaceId: input.goalWorkspaceId,
      canonicalRef: input.canonicalRef,
      expectedBase: live,
    });
    return { status: 'pinned', baseManifestId: overlay.baseManifestId };
  } catch (error) {
    return { status: 'failed', reason: errorMessage(error) };
  }
}
