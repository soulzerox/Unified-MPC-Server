import type { CanonicalSourceIdentity } from '@unified-mpc/workspace';
import { appError, err, type Result } from '@unified-mpc/domain';

import { extractStructuralRecords } from './structural-extractor.js';
import type { StructuralGeneration, StructuralRecordStore } from './structural-record-store.js';

/**
 * #131 slice 6: the one call that turns a checked-out tree into a stored generation.
 *
 * Slices 1 and 2 were tested separately — the extractor as a pure function, the store
 * with synthetic records — so nothing proved they compose, and nothing in the repo
 * could produce the generation every consumer needs. This is only the glue: extract the
 * admitted files, then write them under one canonical identity, which is the durable
 * unit the store already defines.
 *
 * It is deliberately not a filesystem walker: `files` is the caller's discovery result,
 * so this stays free of ignore rules, `.gitignore` semantics and worktree policy. It is
 * not incremental either — the store is identity-addressed and immutable, so one
 * generation is one full extraction, and a partial update would need a new identity,
 * not a merge.
 */
export interface BuildStructuralGenerationInput {
  readonly store: StructuralRecordStore;
  readonly identity: CanonicalSourceIdentity;
  /** Repository root the repo-relative `files` are read from. */
  readonly repositoryRoot: string;
  /** Repo-relative paths; the caller owns discovery and ordering. */
  readonly files: readonly string[];
}

export async function buildStructuralGeneration(
  input: BuildStructuralGenerationInput,
): Promise<Result<StructuralGeneration>> {
  if (!Array.isArray(input.files)) {
    return err(appError('INVALID_INPUT', 'a structural generation needs a list of files'));
  }
  // An empty generation would state "this tree has no code" as evidence, and the store
  // could never correct it: the identity is immutable and a rewrite is refused.
  if (input.files.length === 0) {
    return err(appError('INVALID_INPUT', 'a structural generation needs at least one file'));
  }
  const duplicates = duplicatedPaths(input.files);
  if (duplicates.length > 0) {
    return err(appError('INVALID_INPUT', `structural generation has duplicate paths: ${duplicates.join(', ')}`));
  }

  const records = await extractStructuralRecords({
    repositoryRoot: input.repositoryRoot,
    identity: input.identity,
    files: input.files,
  });
  if (!records.ok) return records;
  return input.store.writeGeneration({ identity: input.identity, records: records.value });
}

function duplicatedPaths(files: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const file of files) {
    if (typeof file !== 'string') continue;
    if (seen.has(file)) duplicates.add(file);
    seen.add(file);
  }
  return [...duplicates].sort((left, right) => (left === right ? 0 : left < right ? -1 : 1));
}
