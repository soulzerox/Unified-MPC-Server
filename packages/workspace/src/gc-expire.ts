import type { CanonicalRefStore } from './canonical-ref-store.js';
import type { CanonicalManifestStore } from './canonical-manifest-store.js';
import type { GoalOverlayStore } from './goal-overlay-store.js';
import type { RevisionPinRegistry } from './revision-pin-registry.js';
import type {
  ArtifactKeyQuarantineEntry,
  ArtifactQuarantineStore,
  ContentHashQuarantineEntry,
  QuarantineEntry,
  QuarantineTarget,
} from './artifact-quarantine.js';
import { quarantineEntryTarget } from './artifact-quarantine.js';
import type { CanonicalArtifactStore } from './canonical-artifact-store.js';
import { collectRetainedManifestIds, planRepositoryArtifactGc } from './artifact-key-gc.js';
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
  /** Physical delete of one released content-hash artifact; omitted in dry-run. */
  readonly deleteArtifact?: (hash: string) => Promise<void>;
  /**
   * Physical delete of one released canonical artifact (#210 §1). The row
   * carries its owning repository precisely so this callback can resolve the
   * record; `CanonicalArtifactStore.delete` is the natural implementation.
   */
  readonly deleteStoredArtifact?: (repositoryId: string, artifactKey: string) => Promise<void>;
  /**
   * Single-owner guard for the destructive pass (#210 §12). Required in
   * practice for any non-dry-run caller; dry runs never take it.
   */
  readonly lease?: GcExpireLease;
}

export type GcExpireReport =
  | {
    readonly status: 'planned';
    readonly expired: readonly QuarantineTarget[];
    readonly deleted: readonly QuarantineTarget[];
    readonly retained: readonly QuarantineTarget[];
  }
  | { readonly status: 'refused'; readonly reason: string };

export interface GcExpireStores {
  readonly refs: CanonicalRefStore;
  readonly manifests: CanonicalManifestStore;
  readonly pins: RevisionPinRegistry;
  readonly overlays: GoalOverlayStore;
  readonly quarantine: ArtifactQuarantineStore;
  /** Required as soon as artifact-key rows exist in the ledger. */
  readonly artifacts?: CanonicalArtifactStore;
}

/**
 * Expire quarantined artifacts after grace with a live reachability re-check (#210 U23).
 *
 * Final step of the deletion flow: re-assemble reachability roots now,
 * treat every quarantined entry as a candidate, and release only entries
 * whose grace deadline has passed *and* that are still unreachable in
 * this re-check. Anything that became reachable again is retained in the
 * ledger for operator review — never deleted. Dry-run reports the same
 * sets without releasing rows or calling the delete callbacks. The
 * callbacks own the actual storage deletion, so this module never needs
 * to know the artifact backend.
 *
 * Both ledger id spaces are handled: content hashes against the
 * assembled root set (U17), and canonical-artifact rows against the
 * repository-scoped artifact-key planner (#397), so a key that is still
 * referenced by any retained manifest in *its own* trust boundary — and
 * no binding anywhere else — stays alive. Artifact rows without a wired
 * artifact store, or a refused artifact plan, refuse the whole pass
 * rather than treating unproven reachability as garbage.
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
  const hashEntries = entries.filter(isContentHashEntry);
  const artifactEntries = entries.filter(isArtifactKeyEntry);

  const plan = planArtifactGc({ roots, candidates: hashEntries.map((entry) => entry.hash) });
  if (plan.status !== 'planned') {
    // A refused plan (no roots) means reachability could not be proven; with
    // nothing proven reachable a delete pass would treat every quarantined
    // artifact as garbage. Refuse instead.
    return { status: 'refused', reason: plan.reason };
  }
  const reachableHashes = new Set(plan.reachable);

  const reachableArtifacts = new Set<string>();
  if (artifactEntries.length > 0) {
    const artifacts = stores.artifacts;
    if (artifacts === undefined) {
      return {
        status: 'refused',
        reason: 'artifact-key quarantine rows present but no artifact store is wired: refusing the destructive pass',
      };
    }
    const retainedManifestIds = await collectRetainedManifestIds({
      refs: stores.refs,
      pins: stores.pins,
      overlays: stores.overlays,
      indexJobManifestIds: input.indexJobManifestIds,
    });
    for (const [repositoryId, keys] of groupByRepository(artifactEntries)) {
      const artifactPlan = await planRepositoryArtifactGc({ store: artifacts, repositoryId, retainedManifestIds, candidates: keys });
      if (artifactPlan.status !== 'planned') {
        return { status: 'refused', reason: artifactPlan.reason };
      }
      for (const artifactKey of artifactPlan.reachable) reachableArtifacts.add(artifactIdentity(repositoryId, artifactKey));
    }
  }

  const due: QuarantineEntry[] = [];
  const kept: QuarantineEntry[] = [];
  for (const entry of entries) {
    const expiresAt = Date.parse(entry.quarantinedAt) + entry.graceMs;
    const expired = Number.isFinite(expiresAt) && input.now.getTime() >= expiresAt;
    const reachable = entry.kind === 'content-hash'
      ? reachableHashes.has(entry.hash)
      : reachableArtifacts.has(artifactIdentity(entry.repositoryId, entry.artifactKey));
    (expired && !reachable ? due : kept).push(entry);
  }
  due.sort(compareEntries);
  kept.sort(compareEntries);

  const expired = due.map(quarantineEntryTarget);
  const retained = kept.map(quarantineEntryTarget);

  const deleted: QuarantineTarget[] = [];
  if (!input.dryRun && due.length > 0) {
    for (const entry of due) {
      if (entry.kind === 'content-hash') {
        if (input.deleteArtifact !== undefined) await input.deleteArtifact(entry.hash);
      } else if (input.deleteStoredArtifact !== undefined) {
        await input.deleteStoredArtifact(entry.repositoryId, entry.artifactKey);
      }
      deleted.push(quarantineEntryTarget(entry));
    }
    await stores.quarantine.release(due.map(quarantineEntryTarget));
  }
  return { status: 'planned', expired, deleted: input.dryRun ? [] : deleted, retained };
}

function isContentHashEntry(entry: QuarantineEntry): entry is ContentHashQuarantineEntry {
  return entry.kind === 'content-hash';
}

function isArtifactKeyEntry(entry: QuarantineEntry): entry is ArtifactKeyQuarantineEntry {
  return entry.kind === 'artifact-key';
}

function artifactIdentity(repositoryId: string, artifactKey: string): string {
  return `${repositoryId}\u0000${artifactKey}`;
}

function groupByRepository(entries: readonly ArtifactKeyQuarantineEntry[]): Map<string, string[]> {
  const byRepository = new Map<string, string[]>();
  for (const entry of entries) {
    const keys = byRepository.get(entry.repositoryId);
    if (keys === undefined) byRepository.set(entry.repositoryId, [entry.artifactKey]);
    else keys.push(entry.artifactKey);
  }
  return byRepository;
}

function compareEntries(a: QuarantineEntry, b: QuarantineEntry): number {
  const left = entryOrderKey(a);
  const right = entryOrderKey(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

function entryOrderKey(entry: QuarantineEntry): string {
  return entry.kind === 'content-hash' ? entry.hash : artifactIdentity(entry.repositoryId, entry.artifactKey);
}
