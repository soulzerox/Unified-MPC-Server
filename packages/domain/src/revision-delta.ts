export const REVISION_DELTA_VERSION = 1 as const;

export type RevisionDeltaClassification =
  | 'UNCHANGED'
  | 'CHANGED'
  | 'ADDED'
  | 'DELETED'
  | 'RENAMED_SAME_CONTENT'
  | 'RENAMED_CHANGED'
  | 'UNVERIFIABLE';
// NOTE: this pure content-hash layer emits every variant except
// RENAMED_CHANGED, which needs Git similarity input arriving as explicit
// data in a later slice. The variant stays in the type so the advancement
// gate can already match on the full #210 vocabulary.

export interface RevisionDeltaEntry {
  readonly path: string;
  readonly contentHash: string;
}

export interface RevisionDelta {
  readonly path: string;
  readonly classification: RevisionDeltaClassification;
  readonly contentHash: string;
  readonly oldPath?: string;
}

const HEX64 = /^[a-f0-9]{64}$/i;

function isVerifiable(hash: string): boolean {
  return HEX64.test(hash);
}

/**
 * Classify the logical delta between two revision manifests (#210 U5).
 *
 * Pure function over path->content-hash entries: no Git access, no I/O.
 * Content hash decides reuse; rename-same-content reuses artifacts without
 * re-embedding. Anything unresolvable is UNVERIFIABLE — never guessed —
 * so the advancement gate can demand explicit handling instead of silently
 * rebuilding or, worse, silently reusing.
 */
export function classifyRevisionDelta(
  base: readonly RevisionDeltaEntry[],
  target: readonly RevisionDeltaEntry[],
): RevisionDelta[] {
  const baseByPath = new Map<string, string>();
  for (const entry of base) baseByPath.set(entry.path, entry.contentHash);
  const targetByPath = new Map<string, string>();
  for (const entry of target) targetByPath.set(entry.path, entry.contentHash);

  // Content -> base paths, for rename detection (first claimant wins,
  // deterministic by sorted path order).
  const baseByHash = new Map<string, string[]>();
  for (const entry of base) {
    const list = baseByHash.get(entry.contentHash.toLowerCase());
    if (list === undefined) baseByHash.set(entry.contentHash.toLowerCase(), [entry.path]);
    else list.push(entry.path);
  }

  const claimedBase = new Set<string>();
  const out: RevisionDelta[] = [];

  for (const entry of [...target].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const baseHash = baseByPath.get(entry.path);
    if (baseHash !== undefined) {
      if (!isVerifiable(entry.contentHash) || !isVerifiable(baseHash)) {
        out.push({ path: entry.path, classification: 'UNVERIFIABLE', contentHash: entry.contentHash });
      } else if (baseHash.toLowerCase() === entry.contentHash.toLowerCase()) {
        claimedBase.add(entry.path);
        out.push({ path: entry.path, classification: 'UNCHANGED', contentHash: entry.contentHash });
      } else {
        claimedBase.add(entry.path);
        out.push({ path: entry.path, classification: 'CHANGED', contentHash: entry.contentHash });
      }
      continue;
    }
    // New path: same content elsewhere in base => rename family.
    const candidates = (baseByHash.get(entry.contentHash.toLowerCase()) ?? [])
      .filter((p) => !claimedBase.has(p) && !targetByPath.has(p))
      .sort();
    const oldPath = candidates[0];
    if (oldPath !== undefined && isVerifiable(entry.contentHash)) {
      claimedBase.add(oldPath);
      // Same content required: a rename with changed content is
      // indistinguishable from ADDED + DELETED at this layer. Git
      // similarity hints arrive as explicit input in a later slice.
      out.push({
        path: entry.path,
        classification: 'RENAMED_SAME_CONTENT',
        contentHash: entry.contentHash,
        oldPath,
      });
      continue;
    }
    if (!isVerifiable(entry.contentHash)) {
      out.push({ path: entry.path, classification: 'UNVERIFIABLE', contentHash: entry.contentHash });
      continue;
    }
    out.push({ path: entry.path, classification: 'ADDED', contentHash: entry.contentHash });
  }

  for (const entry of [...base].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    if (targetByPath.has(entry.path) || claimedBase.has(entry.path)) continue;
    out.push({ path: entry.path, classification: 'DELETED', contentHash: entry.contentHash });
  }

  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
