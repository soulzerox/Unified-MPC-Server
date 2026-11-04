import type { CanonicalManifestStore } from './canonical-manifest-store.js';
import type { RevisionPin, RevisionPinReason, RevisionPinRegistry } from './revision-pin-registry.js';

export interface CanonicalRevisionPinDeps {
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
 */
export async function pinCanonicalRevision(
  deps: CanonicalRevisionPinDeps,
  input: CanonicalRevisionPinInput,
): Promise<CanonicalRevisionPinReport> {
  const manifest = await deps.manifests.get(requireManifestId(input.manifestId));
  if (manifest === null) throw new Error(`unknown revision manifest: ${input.manifestId}`);
  const pins = await deps.pins.pin(manifest.manifestId, OPERATOR_PIN_REASON, input.note ?? '');
  return { manifestId: manifest.manifestId, action: 'pinned', pins: reasons(pins) };
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
  deps: CanonicalRevisionPinDeps,
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
