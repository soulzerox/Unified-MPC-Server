import type { CanonicalSourceIdentity } from '@unified-mpc/workspace';
import { appError, err, ok, type Result } from '@unified-mpc/domain';

import type { SourceStructuralRecord, StructuralRecordStore } from './structural-record-store.js';

/**
 * #131 slice 8: reading a generation out of the store so the pure queries can answer.
 *
 * Slices 3 to 7 built two halves that never touched: the store writes and pages a
 * generation, and the query functions project an array of records the caller already
 * holds. Nothing loaded one into the other, so no consumer could actually ask a
 * question about a stored generation.
 *
 * This is the join, and it is deliberately only the join: it returns records, not
 * answers, because each consumer already knows which query it wants. It is bounded for
 * the same reason the store is — a model-facing surface must not pull a whole repository
 * into memory to say "symbol not found".
 */

/**
 * The most files one whole-generation read will load.
 *
 * Matches `MAX_QUERY_LIMIT` and the store's read ceiling, so a generation that fits the
 * read path always fits one answer. A larger generation is not truncated silently: the
 * caller is told to name the paths it needs, which is the bounded shape anyway.
 */
export const MAX_EVIDENCE_FILES = 2_000;

export interface LoadStructuralEvidenceInput {
  readonly store: StructuralRecordStore;
  readonly identity: CanonicalSourceIdentity;
  /**
   * Restrict the read to these repository-relative paths.
   *
   * A path-scoped read is not capped by the generation's size, which is what makes a
   * large repository answerable: the caller names the file it is asking about.
   */
  readonly paths?: readonly string[];
}

export interface StructuralEvidence {
  readonly generationId: string;
  readonly records: readonly SourceStructuralRecord[];
}

/**
 * The stored generation for exactly this identity, or an explicit refusal.
 *
 * There is no "latest generation" fallback: a query answered from a newer tree would be
 * evidence about code the caller is not looking at. Missing evidence is an error, not an
 * empty list, so a consumer cannot report "no symbols" for a repository nobody indexed.
 */
export async function loadStructuralEvidence(
  input: LoadStructuralEvidenceInput,
): Promise<Result<StructuralEvidence>> {
  const generation = await input.store.readGeneration(input.identity);
  if (!generation.ok) return generation;
  if (generation.value === undefined) {
    return err(appError(
      'INVALID_INPUT',
      'no stored structural generation for this identity: index the workspace before querying it',
    ));
  }
  const generationId = generation.value.generationId;

  if (input.paths !== undefined) {
    if (input.paths.length > MAX_EVIDENCE_FILES) {
      return err(appError(
        'INVALID_INPUT',
        `a structural evidence read accepts at most ${MAX_EVIDENCE_FILES} paths`,
      ));
    }
    if (input.paths.length === 0) return ok({ generationId, records: [] });
    const page = await input.store.readRecords({
      generationId,
      paths: input.paths,
      limit: input.paths.length,
    });
    if (!page.ok) return page;
    return ok({ generationId, records: page.value });
  }

  const first = await input.store.readRecords({ generationId, limit: MAX_EVIDENCE_FILES });
  if (!first.ok) return first;
  if (first.value.length < MAX_EVIDENCE_FILES) {
    return ok({ generationId, records: first.value });
  }

  // A full page means the generation may hold more. One keyset probe answers that
  // without reading the rest, so the ceiling is 2001 rows regardless of repository size.
  const cursor = first.value.at(-1)?.path;
  if (cursor === undefined) return ok({ generationId, records: first.value });
  const probe = await input.store.readRecords({ generationId, afterPath: cursor, limit: 1 });
  if (!probe.ok) return probe;
  if (probe.value.length > 0) {
    return err(appError(
      'INVALID_INPUT',
      `structural generation ${generationId} holds more than ${MAX_EVIDENCE_FILES} files: pass the paths you need`,
    ));
  }
  return ok({ generationId, records: first.value });
}
