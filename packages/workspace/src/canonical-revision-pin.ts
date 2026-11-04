import type { CanonicalManifestStore } from './canonical-manifest-store.js';
import type { GcLeaseStore } from './gc-lease.js';
import type { RevisionPin, RevisionPinReason, RevisionPinRegistry } from './revision-pin-registry.js';

/**
 * The same single-owner fence revision prune takes. A pin that holds it cannot
 * interleave with a prune's pin snapshot, and a prune that holds it makes the
 * pin refuse instead of writing evidence the prune has already passed.
 */
export interface CanonicalRevisionPinLease {
  readonly store: GcLeaseStore;
  readonly ownerId: string;
  readonly ttlMs: number;
}

export interface CanonicalRevisionPinDeps {
  readonly manifests: CanonicalManifestStore;
  readonly pins: RevisionPinRegistry;
  /** Required: the CLI always supplies the shared GC lease. */
  readonly lease: CanonicalRevisionPinLease;
}

export interface CanonicalRevisionUnpinDeps {
  readonly manifests: CanonicalManifestStore;
  readonly pins: RevisionPinRegistry;
}

export interface CanonicalRevisionPinInput {
  readonly manifestId: string;
  /** Free-form note stored with the pin; only meaningful when pinning. */
  readonly note?: string;
}

/**
 * The only pin reason an operator command may manage. Every other reason is
 * written by the store that owns the dependency — a canonical ref, a Goal base
 * or overlay, an unsettled index job, a rollback marker. Letting a CLI verb
 * remove those would delete reachability evidence while the owner still
 * depends on the revision, which is exactly the failure prune must prevent.
 */
export const OPERATOR_PIN_REASON: RevisionPinReason = 'user-pin';

export type CanonicalRevisionPinAction = 'pinned' | 'unpinned' | 'not-pinned';

const MANIFEST_ID = /^man:v1:[a-f0-9]{64}$/i;

function requireManifestId(value: string): string {
  if (!MANIFEST_ID.test(value)) throw new Error(`invalid manifest id: ${value}`);
  return value.toLowerCase();
}

export interface CanonicalRevisionPinReport {
  readonly manifestId: string;
  readonly action: CanonicalRevisionPinAction;
  /** Every pin reason still on the revision after the command, sorted. */
  readonly pins: readonly RevisionPinReason[];
}

function reasons(pins: readonly RevisionPin[]): RevisionPinReason[] {
  return [...new Set(pins.map((pin) => pin.reason))].sort();
}

/**
 * Operator pin for one stored revision (#210 §7).
 *
 * A pin is reachability evidence, not a deletion: `pruneRevisionManifests`
 * refuses a pinned manifest and reports the blocking reasons. The pin is only
 * written when the manifest actually exists, because a pin whose manifest is
 * gone is an orphan the store verify path reports as degraded — the command
 * must not be able to create that state.
 *
 * Pinning is idempotent: re-pinning the same revision refreshes the operator
 * note and timestamp without duplicating the reason, and system-owned reasons
 * on the same manifest are never touched.
 *
 * The pin and the manifest read happen under the shared GC lease, so a
 * concurrent `index revision prune` cannot snapshot the pins before this write
 * and then delete the manifest anyway: prune refuses while this command holds
 * the fence, and this command refuses while prune holds it. The manifest is
 * re-read inside the fence, so a revision pruned before the pin is refused
 * rather than pinned as an orphan.
 */
export async function pinCanonicalRevision(
  deps: CanonicalRevisionPinDeps,
  input: CanonicalRevisionPinInput,
): Promise<CanonicalRevisionPinReport> {
  const manifestId = requireManifestId(input.manifestId);
  const acquired = await deps.lease.store.acquire({
    ownerId: deps.lease.ownerId,
    now: new Date(),
    ttlMs: deps.lease.ttlMs,
  });
  if (acquired.status === 'denied') {
    throw new Error(acquired.reason === 'held'
      ? `gc lease held by ${acquired.holder} until ${acquired.expiresAt}: refusing to pin while a destructive pass runs`
      : 'gc lease fence unreadable: refusing to pin a revision');
  }
  try {
    const manifest = await deps.manifests.get(manifestId);
    if (manifest === null) throw new Error(`unknown revision manifest: ${input.manifestId}`);
    const pins = await deps.pins.pin(manifest.manifestId, OPERATOR_PIN_REASON, input.note ?? '');
    return { manifestId: manifest.manifestId, action: 'pinned', pins: reasons(pins) };
  } finally {
    await deps.lease.store.release({ ownerId: deps.lease.ownerId, generation: acquired.generation });
  }
}

/**
 * Operator unpin for one revision (#210 §7).
 *
 * Only the operator reason is removed. The manifest does not have to exist:
 * unpinning a revision whose manifest was already deleted is how an orphan pin
 * created by an older build gets cleaned up, and refusing that would leave the
 * store verify path degraded with no supported repair.
 *
 * Unpinning is idempotent: a revision with no operator pin reports
 * `not-pinned` and still lists whatever system-owned reasons remain.
 */
export async function unpinCanonicalRevision(
  deps: CanonicalRevisionUnpinDeps,
  input: CanonicalRevisionPinInput,
): Promise<CanonicalRevisionPinReport> {
  const removed = await deps.pins.unpin(requireManifestId(input.manifestId), OPERATOR_PIN_REASON);
  const remaining = await deps.pins.list(input.manifestId);
  return {
    manifestId: input.manifestId.toLowerCase(),
    action: removed ? 'unpinned' : 'not-pinned',
    pins: reasons(remaining),
  };
}
