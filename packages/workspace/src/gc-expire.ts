import type { CanonicalRefStore } from './canonical-ref-store.js';
import type { CanonicalManifestStore } from './canonical-manifest-store.js';
import type { GoalOverlayStore } from './goal-overlay-store.js';
import type { RevisionPinRegistry } from './revision-pin-registry.js';
import type { ArtifactQuarantineStore } from './artifact-quarantine.js';
import type { GcLeaseStore } from './gc-lease.js';
import { assembleGcRoots } from './artifact-gc-roots.js';
import { planArtifactGc } from './artifact-gc.js';

export interface GcExpireLease {
  readonly store: GcLeaseStore;
  readonly ownerId: string;
  readonly ttlMs: number;
}

export interface GcExpireInput {
  readonly indexJobManifestIds: readonly string[];
  readonly now: Date;
  readonly graceMs: number;
  readonly dryRun: boolean;
  /** Physical delete of one released artifact; omitted in dry-run. */
  readonly deleteArtifact?: (hash: string) => Promise<void>;
  /**
   * Single-owner guard for the destructive pass (#210 §12). Required in
   * practice for any non-dry-run caller; dry runs never take it.
   */
  readonly lease?: GcExpireLease;
}

export type GcExpireReport =
  | { readonly status: 'planned'; readonly expired: readonly string[]; readonly deleted: readonly string[]; readonly retained: readonly string[] }
  | { readonly status: 'refused'; readonly reason: string };

export interface GcExpireStores {
  readonly refs: CanonicalRefStore;
  readonly manifests: CanonicalManifestStore;
  readonly pins: RevisionPinRegistry;
  readonly overlays: GoalOverlayStore;
  readonly quarantine: ArtifactQuarantineStore;
}

/**
 * Expire quarantined artifacts after grace with a live reachability re-check (#210 U23).
 *
 * Final step of the deletion flow: re-assemble reachability roots now,
 * treat every quarantined hash as a candidate, and release only entries
 * whose grace deadline has passed *and* that are still unreachable in
 * this re-check. A hash that became reachable again is retained in the
 * ledger for operator review — never deleted. Dry-run reports the same
 * sets without releasing rows or calling the delete callback. The
 * callback owns the actual storage deletion, so this module never needs
 * to know the artifact backend.
 *
 * With a `lease` supplied the whole deletion pass runs under the U28
 * single-owner fence: a held or unreadable lease refuses the run before
 * anything is deleted, and the lease is released afterwards even when
 * the run refuses on unassemblable roots. Dry runs are read-only and
 * deliberately do not take the lease.
 */
export async function expireGcQuarantine(
  stores: GcExpireStores,
  input: GcExpireInput,
): Promise<GcExpireReport> {
  const lease = input.dryRun ? undefined : input.lease;
  let granted: { readonly generation: number } | undefined;
  if (lease !== undefined) {
    const acquired = await lease.store.acquire({ ownerId: lease.ownerId, now: input.now, ttlMs: lease.ttlMs });
    if (acquired.status === 'denied') {
      return {
        status: 'refused',
        reason: acquired.reason === 'held'
          ? `gc lease held by ${acquired.holder} until ${acquired.expiresAt}`
          : 'gc lease fence unreadable: refusing to start a destructive pass',
      };
    }
    granted = { generation: acquired.generation };
  }
  try {
    return await runPass(stores, input);
  } finally {
    if (lease !== undefined && granted !== undefined) {
      await lease.store.release({ ownerId: lease.ownerId, generation: granted.generation });
    }
  }
}

async function runPass(stores: GcExpireStores, input: GcExpireInput): Promise<GcExpireReport> {
  let roots;
  try {
    roots = await assembleGcRoots({
      manifests: stores.manifests,
      refs: stores.refs,
      pins: stores.pins,
      overlays: stores.overlays,
      indexJobManifestIds: input.indexJobManifestIds,
    });
  } catch (error) {
    return { status: 'refused', reason: error instanceof Error ? error.message : String(error) };
  }

  const entries = await stores.quarantine.list();
  const plan = planArtifactGc({ roots, candidates: entries.map((entry) => entry.hash) });
  if (plan.status !== 'planned') {
    // A refused plan (no roots) means reachability could not be proven; with
    // nothing proven reachable a delete pass would treat every quarantined
    // artifact as garbage. Refuse instead.
    return { status: 'refused', reason: plan.reason };
  }
  const reachable = new Set(plan.reachable);

  const expired: string[] = [];
  const retained: string[] = [];
  for (const entry of entries) {
    const expiresAt = Date.parse(entry.quarantinedAt) + entry.graceMs;
    const due = Number.isFinite(expiresAt) && input.now.getTime() >= expiresAt;
    if (due && !reachable.has(entry.hash)) expired.push(entry.hash);
    else retained.push(entry.hash);
  }
  expired.sort();
  retained.sort();

  const deleted: string[] = [];
  if (!input.dryRun && expired.length > 0) {
    for (const hash of expired) {
      if (input.deleteArtifact !== undefined) await input.deleteArtifact(hash);
      deleted.push(hash);
    }
    await stores.quarantine.release(expired);
  }
  return { status: 'planned', expired, deleted: input.dryRun ? [] : deleted, retained };
}
