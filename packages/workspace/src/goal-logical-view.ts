import type { CanonicalRefStore } from './canonical-ref-store.js';
import type { GoalOverlayStore } from './goal-overlay-store.js';
import { verifyGoalAdmission } from './goal-admission.js';

export interface GoalLogicalViewInput {
  readonly goalWorkspaceId: string;
  readonly canonicalRef: string;
  readonly baseEntries: readonly { readonly path: string; readonly contentHash: string }[];
}

/**
 * Resolve the Goal logical view: base manifest + overlay - tombstones (#210 U14).
 *
 * Admission is verified first (U11): a drifted base or missing overlay
 * fails closed before any view is built. Overlay entries then win over
 * base entries path-by-path, with tombstones (null content hash) removing
 * the path from the view. The result maps each visible repo-relative path
 * to its exact content hash — the single source downstream query and
 * pre-edit resolution consult instead of re-deriving overlay/base order.
 */
export async function resolveGoalLogicalView(
  refs: CanonicalRefStore,
  overlays: GoalOverlayStore,
  input: GoalLogicalViewInput,
): Promise<Map<string, string>> {
  const verdict = await verifyGoalAdmission(refs, overlays, {
    goalWorkspaceId: input.goalWorkspaceId,
    canonicalRef: input.canonicalRef,
  });
  if (!verdict.admitted) {
    throw new Error(`goal not admissible: ${verdict.reason}`);
  }
  const view = new Map<string, string>();
  for (const entry of input.baseEntries) {
    view.set(entry.path, entry.contentHash);
  }
  for (const entry of verdict.overlay.entries) {
    if (entry.contentHash === null) {
      view.delete(entry.path);
    } else {
      view.set(entry.path, entry.contentHash);
    }
  }
  return view;
}
