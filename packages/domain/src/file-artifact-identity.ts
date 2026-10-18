import { createHash } from 'node:crypto';

export const FILE_ARTIFACT_IDENTITY_VERSION = 1 as const;

export interface FileArtifactIdentityInput {
  readonly sourceContentSha256: string;
  readonly language: string;
  readonly sourceKind: string;
  readonly representationVersion: string;
}

/**
 * Source provenance that binds an artifact key to a location of a specific Git
 * revision. Deliberately held OUTSIDE the artifact identity (#210 §1/§8): many
 * bindings — different paths (renames), different blob oids, different
 * revisions — may point at one immutable content-addressed artifact.
 */
export interface FileArtifactBinding {
  readonly artifactKey: string;
  readonly path: string;
  readonly gitBlobOid?: string;
  readonly revisionId?: string;
}

const NUL = String.fromCharCode(0);

function requireIdentityPart(name: string, value: string): string {
  if (value.length === 0 || value.includes(NUL)) {
    throw new TypeError(`${name} must be non-empty and must not contain NUL`);
  }
  return value;
}

function requireContentHash(value: string): string {
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new TypeError('sourceContentSha256 must be an exact 64-hex SHA-256');
  }
  return value.toLowerCase();
}

function digest(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join(NUL), 'utf8').digest('hex');
}

/**
 * Stable v1 identity for a source file artifact (#210 §1).
 *
 * The key binds content hash + language + source-kind + representation schema
 * version only. Path, blob oid and commit provenance live in the binding
 * record, so a rename with identical content reuses the artifact and a
 * re-committed file never invalidates it (#210 §8/§16).
 */
export function fileArtifactId(input: FileArtifactIdentityInput): string {
  return `file:v1:${digest([
    'file-artifact',
    'v1',
    requireContentHash(input.sourceContentSha256),
    requireIdentityPart('language', input.language),
    requireIdentityPart('sourceKind', input.sourceKind),
    requireIdentityPart('representationVersion', input.representationVersion),
  ])}`;
}
