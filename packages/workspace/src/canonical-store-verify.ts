import type { CanonicalRefStore } from './canonical-ref-store.js';
import type { CanonicalManifestStore } from './canonical-manifest-store.js';
import type { GoalOverlayStore } from './goal-overlay-store.js';
import type { RevisionPinRegistry } from './revision-pin-registry.js';

export interface CanonicalStoreVerifyDeps {
  readonly refs: CanonicalRefStore;
  readonly manifests: CanonicalManifestStore;
  readonly pins: RevisionPinRegistry;
  readonly overlays: GoalOverlayStore;
}

export interface DanglingRef {
  readonly ref: string;
  readonly manifestId: string;
}

export interface ManifestAuditRow {
  readonly manifestId: string;
  readonly pinned: boolean;
  readonly reasons: readonly string[];
}

export type CanonicalStoreVerifyReport =
  | {
      readonly status: 'healthy';
      readonly danglingRefs: readonly [];
      readonly missingOverlays: readonly [];
      readonly orphanedPins: readonly [];
      readonly manifests: readonly ManifestAuditRow[];
    }
  | {
      readonly status: 'degraded';
      readonly danglingRefs: readonly DanglingRef[];
      readonly missingOverlays: readonly string[];
      readonly orphanedPins: readonly string[];
      readonly manifests: readonly ManifestAuditRow[];
    };

/**
 * Verify logical consistency across the canonical index stores (#210 U19).
 *
 * Read-only: never writes, deletes, or repairs. Reports:
 * - dangling refs — a canonical ref whose manifest is missing from the
 *   manifest store (advancement left a ref pointing at nothing);
 * - missing overlays — a Goal overlay whose pinned base manifest is gone;
 * - orphaned pins — a pin whose manifest is missing (reachability evidence
 *   that protects nothing; prune must not treat it as a live root);
 * - per-manifest pin state for audit.
 * Anything non-empty degrades the report. Repair is a separate,
 * explicitly destructive path.
 */
export async function verifyCanonicalStore(deps: CanonicalStoreVerifyDeps): Promise<CanonicalStoreVerifyReport> {
  const danglingRefs: DanglingRef[] = [];
  for (const { ref, state } of await deps.refs.list()) {
    if ((await deps.manifests.get(state.manifestId)) === null) {
      danglingRefs.push({ ref, manifestId: state.manifestId });
    }
  }

  const missingOverlays: string[] = [];
  for (const goalWorkspaceId of await deps.overlays.listIds()) {
    const overlay = await deps.overlays.read(goalWorkspaceId);
    if (overlay === null) continue;
    if ((await deps.manifests.get(overlay.baseManifestId)) === null) {
      missingOverlays.push(goalWorkspaceId);
    }
  }

  const orphanedPins: string[] = [];
  for (const manifestId of await deps.pins.pinnedManifestIds()) {
    if ((await deps.manifests.get(manifestId)) === null) {
      orphanedPins.push(manifestId);
    }
  }
  orphanedPins.sort();

  const manifestIds = new Set<string>();
  for (const { state } of await deps.refs.list()) manifestIds.add(state.manifestId);
  for (const manifestId of await deps.pins.pinnedManifestIds()) manifestIds.add(manifestId);
  for (const goalWorkspaceId of await deps.overlays.listIds()) {
    const overlay = await deps.overlays.read(goalWorkspaceId);
    if (overlay !== null) manifestIds.add(overlay.baseManifestId);
  }
  const manifests: ManifestAuditRow[] = [];
  for (const manifestId of [...manifestIds].sort()) {
    if ((await deps.manifests.get(manifestId)) === null) continue;
    const pins = await deps.pins.list(manifestId);
    manifests.push({ manifestId, pinned: pins.length > 0, reasons: pins.map((pin) => pin.reason).sort() });
  }

  if (danglingRefs.length > 0 || missingOverlays.length > 0 || orphanedPins.length > 0) {
    return { status: 'degraded', danglingRefs, missingOverlays, orphanedPins, manifests };
  }
  return { status: 'healthy', danglingRefs: [], missingOverlays: [], orphanedPins: [], manifests };
}
