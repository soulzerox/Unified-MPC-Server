import { createHash } from 'node:crypto';

export interface CanonicalRefState {
  readonly commitSha: string;
  readonly treeOid: string;
  readonly manifestId: string;
}

export type AdvancementDecision =
  | { readonly action: 'promote'; readonly target: CanonicalRefState }
  | { readonly action: 'noop'; readonly target: CanonicalRefState }
  | { readonly action: 'conflict'; readonly current: CanonicalRefState }
  | { readonly action: 'reject_unverified'; readonly target: CanonicalRefState };

function sameState(a: CanonicalRefState, b: CanonicalRefState): boolean {
  return a.commitSha === b.commitSha
    && a.treeOid === b.treeOid
    && a.manifestId === b.manifestId;
}

/**
 * Canonical Revision Advancement Gate (#210 U6).
 *
 * CAS on the active ref: promotion requires the caller's expected-current
 * state to match the actual current state, so a merge arriving while C101 is
 * still building can never make readers see a half-built view, and two
 * concurrent promoters cannot both win. Unverified targets are never
 * promoted — classification (U5) must have proven the delta first.
 */
export function decideCanonicalAdvancement(input: {
  readonly expectedCurrent: CanonicalRefState;
  readonly current: CanonicalRefState;
  readonly target: CanonicalRefState;
  readonly targetVerified: boolean;
}): AdvancementDecision {
  const { expectedCurrent, current, target, targetVerified } = input;
  if (sameState(expectedCurrent, current) && sameState(current, target)) {
    return { action: 'noop', target };
  }
  if (!sameState(expectedCurrent, current)) {
    return { action: 'conflict', current };
  }
  if (!targetVerified) {
    return { action: 'reject_unverified', target };
  }
  return { action: 'promote', target };
}

/**
 * Compute the tree OID for a manifest's sorted path->content-hash entries.
 * Deterministic and independent of commit metadata: two trees with identical
 * entries yield the same OID, so unchanged files across commits share one
 * identity.
 */
export function computeTreeOid(
  entries: readonly { readonly path: string; readonly contentHash: string }[],
): string {
  const canonical = [...entries]
    .map((entry) => `${entry.path}\0${entry.contentHash.toLowerCase()}`)
    .sort()
    .join('\0');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
