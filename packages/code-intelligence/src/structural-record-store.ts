import { createHash } from 'node:crypto';

import type { Result } from '@unified-mpc/domain';
import type { CanonicalSourceIdentity } from '@unified-mpc/workspace';

import type { SourceStructuralRecord } from './structural-extractor.js';

/**
 * Slice 2 of the Code Intelligence subsystem (#131): the durable half.
 *
 * The port lives here and the SQLite adapter lives in `@unified-mpc/storage`, so
 * this package never depends on `node:sqlite` and the extractor stays a pure
 * function. See `docs/superpowers/specs/2026-11-28-code-intelligence-slice-2-store-design.md`.
 *
 * The durable unit is the **generation**: one canonical identity, one extraction.
 * Its id is derived from the six identity fields, so a consumer that pins a
 * generation keeps reading the same bytes after the ref moves, and an identity
 * has exactly one stored generation — a second write is refused rather than
 * merged, because the store cannot tell a retry from a disagreeing re-extraction.
 */

export type { SourceStructuralRecord } from './structural-extractor.js';

export const STRUCTURAL_RECORD_SCHEMA_VERSION = 1;

export interface StructuralGeneration {
  readonly identity: CanonicalSourceIdentity;
  readonly generationId: string;
  readonly schemaVersion: number;
  readonly writtenAt: string;
  readonly fileCount: number;
}

export interface StructuralFingerprint {
  readonly path: string;
  readonly fingerprint: string;
}

export interface WriteStructuralGenerationInput {
  readonly identity: CanonicalSourceIdentity;
  readonly records: readonly SourceStructuralRecord[];
}

export interface ReadStructuralRecordsInput {
  readonly generationId: string;
  readonly paths?: readonly string[];
  /**
   * Exclusive keyset cursor: only records whose path sorts after this one.
   *
   * A generation may hold more records than one `limit` allows, so paging is how a
   * caller reads all of them — an offset would re-read shifting rows, and the order
   * is immutable here, so "after this path" is the whole cursor.
   */
  readonly afterPath?: string;
  /** Required, and bounded: a caller pages instead of pulling a whole repository. */
  readonly limit: number;
}

export interface StructuralRecordStore {
  // ponytail: no deletion method at all until #131's reference-aware cleanup
  // exists. `ON DELETE CASCADE` in the migration is for the slice that can check
  // the reference graph, not a capability this port exposes; adding one here
  // would ship a way to delete evidence a Project or Goal may still be reading.

  /** Writes a whole generation in one transaction; a re-write of the same identity is refused. */
  writeGeneration(input: WriteStructuralGenerationInput): Promise<Result<StructuralGeneration>>;

  /** The generation for this exact identity, or `undefined`. Never "the latest". */
  readGeneration(identity: CanonicalSourceIdentity): Promise<Result<StructuralGeneration | undefined>>;

  /** Records of one generation, ordered by path. */
  readRecords(input: ReadStructuralRecordsInput): Promise<Result<readonly SourceStructuralRecord[]>>;

  /** The same page as `readRecords`, without payloads. */
  readFingerprints(input: ReadStructuralRecordsInput): Promise<Result<readonly StructuralFingerprint[]>>;
}

/** The identity fields, in the one order the id is derived from. */
const IDENTITY_FIELDS = ['repository_id', 'manifest_id', 'revision_id', 'commit_sha', 'tree_oid', 'ref'] as const;

/** `sha256:<hex>` over the six identity fields. Identity-addressed, not content-addressed. */
export function structuralGenerationId(identity: CanonicalSourceIdentity): string {
  const material = IDENTITY_FIELDS.map((field) => identity[field]).join('\0');
  return `sha256:${createHash('sha256').update(material, 'utf8').digest('hex')}`;
}

export function isStructuralFingerprint(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

/** True when both identities name the same tree, field by field. */
export function sameStructuralIdentity(left: CanonicalSourceIdentity, right: CanonicalSourceIdentity): boolean {
  return IDENTITY_FIELDS.every((field) => left[field] === right[field]);
}
