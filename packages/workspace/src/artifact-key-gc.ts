import type { CanonicalArtifactStore } from './canonical-artifact-store.js';
import type { CanonicalRefStore } from './canonical-ref-store.js';
import type { GoalOverlayStore } from './goal-overlay-store.js';
import { errorMessage } from './reachability-read.js';
import type { RevisionPinRegistry } from './revision-pin-registry.js';

export type ArtifactKeyPlan =
  | { readonly status: 'planned'; readonly reachable: readonly string[]; readonly unreachable: readonly string[] }
  | { readonly status: 'refused'; readonly reason: string };

const ARTIFACT_KEY = /^(?:file|chunk):v1:[a-f0-9]{64}$/i;

function requireArtifactKey(value: string): string {
  if (!ARTIFACT_KEY.test(value)) throw new Error(`invalid artifact key: ${value}`);
  return value.toLowerCase();
}

/**
 * Plan artifact-key GC reachability (#210 §7).
 *
 * Pure counterpart of U17's content-hash planner for the artifact keys frozen
 * in #395: a candidate key is retained when any *retained* manifest references
 * it, so pruning an old revision can never delete an artifact another
 * revision/Goal/pin still needs.
 *
 * Refuses in the two shapes that would silently garbage-collect live state:
 * with no retained manifests at all (the same trap as U17's zero-roots
 * refusal), and with candidates but no reachability evidence whatsoever — an
 * empty referenced set is either a broken store query or a policy mistake, and
 * neither justifies calling every artifact unreachable.
 */
export function planArtifactKeyGc(input: {
  readonly retainedManifestIds: readonly string[];
  readonly referencedKeys: readonly string[];
  readonly candidates: readonly string[];
}): ArtifactKeyPlan {
  if (input.retainedManifestIds.length === 0) {
    return { status: 'refused', reason: 'no retained manifests supplied; refusing to plan artifact-key GC' };
  }
  const referenced = new Set(input.referencedKeys.map(requireArtifactKey));
  const candidates = [...new Set(input.candidates.map(requireArtifactKey))];
  if (candidates.length > 0 && referenced.size === 0) {
    return { status: 'refused', reason: 'no artifact reachability evidence; refusing to plan artifact-key GC' };
  }
  const reachable: string[] = [];
  const unreachable: string[] = [];
  for (const key of candidates) {
    (referenced.has(key) ? reachable : unreachable).push(key);
  }
  return { status: 'planned', reachable: reachable.sort(), unreachable: unreachable.sort() };
}

export interface RetainedManifestDeps {
  readonly refs: CanonicalRefStore;
  readonly pins: RevisionPinRegistry;
  readonly overlays: GoalOverlayStore;
  /** Manifests referenced by active/pending index jobs; caller owns that ledger. */
  readonly indexJobManifestIds: readonly string[];
  /**
   * Manifests an active Thai-RAG provider generation was built from (#210
   * bullet 4); caller owns that ledger. Omitted means no provider-generation
   * retention is wired, not that none exists.
   */
  readonly providerGenerationManifestIds?: readonly string[];
}

/**
 * Manifest ids that currently keep artifacts reachable (#210 §7) — the
 * id-level counterpart of U18's entry-level assembler. Callers that need the
 * missing-manifest fail-closed guarantee still run `assembleGcRoots`; this
 * only resolves *which* manifests are roots, so it reads the root stores in
 * strict mode too: an unreadable ref/pin/overlay must not look absent.
 */
export async function collectRetainedManifestIds(deps: RetainedManifestDeps): Promise<string[]> {
  const ids = new Set<string>();
  for (const { state } of await deps.refs.list({ strict: true })) ids.add(state.manifestId);
  for (const manifestId of await deps.pins.pinnedManifestIds({ strict: true })) ids.add(manifestId);
  for (const goalWorkspaceId of await deps.overlays.listIds({ strict: true })) {
    const overlay = await deps.overlays.read(goalWorkspaceId, { strict: true });
    if (overlay !== null) ids.add(overlay.baseManifestId);
  }
  for (const manifestId of deps.indexJobManifestIds) ids.add(manifestId);
  for (const manifestId of deps.providerGenerationManifestIds ?? []) ids.add(manifestId);
  return [...ids].sort();
}

/**
 * Store-backed artifact-key plan for one repository.
 *
 * Candidates default to every artifact registered in that repository;
 * reachability evidence is scoped to the same repository so an identical key
 * held in another trust boundary can never make this boundary's copy look
 * reachable. Which manifests are roots stays caller policy (#145 scheduling).
 *
 * Every store read is strict. The tolerant listing skips a record it cannot
 * read, and a skipped record loses its bindings: the key then looks
 * unreachable and the destructive pass would delete a live artifact (or hide a
 * candidate from the plan). A read failure is a `refused` verdict, never a
 * smaller reachability set.
 */
export async function planRepositoryArtifactGc(input: {
  readonly store: CanonicalArtifactStore;
  readonly repositoryId: string;
  readonly retainedManifestIds: readonly string[];
  readonly candidates?: readonly string[];
}): Promise<ArtifactKeyPlan> {
  try {
    const candidates = input.candidates
      ?? (await input.store.listRepository(input.repositoryId, { strict: true })).map((artifact) => artifact.artifactKey);
    const referencedKeys = await input.store.artifactKeysReferencedBy(
      input.retainedManifestIds,
      input.repositoryId,
      { strict: true },
    );
    return planArtifactKeyGc({
      retainedManifestIds: input.retainedManifestIds,
      referencedKeys,
      candidates,
    });
  } catch (error) {
    return { status: 'refused', reason: errorMessage(error) };
  }
}
