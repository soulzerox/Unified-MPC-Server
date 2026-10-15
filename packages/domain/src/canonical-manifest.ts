import { createHash } from 'node:crypto';

export const CANONICAL_MANIFEST_IDENTITY_VERSION = 1 as const;

export interface CanonicalManifestEntryInput {
  readonly path: string;
  readonly contentHash: string;
}

export interface CanonicalManifestIdentityInput {
  readonly repositoryId: string;
  readonly revisionId: string;
  readonly entries: readonly CanonicalManifestEntryInput[];
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
    throw new TypeError('contentHash must be an exact 64-hex SHA-256');
  }
  return value.toLowerCase();
}

function requireRepoRelativePath(value: string): string {
  if (value.length === 0
    || value.includes(NUL)
    || value.includes('..')
    || value.startsWith('/')) {
    throw new TypeError('path must be a non-empty repo-relative path');
  }
  return value;
}

function digest(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join(NUL), 'utf8').digest('hex');
}

/**
 * Stable v1 identity for a source manifest (#210 U2).
 *
 * Manifest ID binds exact revision identity to sorted path->content-hash
 * entries. Commit-only metadata never enters: unchanged content across
 * commits yields identical entry bindings, so artifact reuse is provable.
 * Duplicate paths are rejected — a manifest maps each path exactly once.
 */
export function canonicalManifestId(input: CanonicalManifestIdentityInput): string {
  const seen = new Set<string>();
  const sorted = [...input.entries]
    .map((entry) => ({
      path: requireRepoRelativePath(entry.path),
      contentHash: requireContentHash(entry.contentHash),
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const entry of sorted) {
    if (seen.has(entry.path)) {
      throw new TypeError(`duplicate manifest path: ${entry.path}`);
    }
    seen.add(entry.path);
  }
  return `man:v1:${digest([
    'canonical-manifest',
    'v1',
    requireIdentityPart('repositoryId', input.repositoryId),
    requireIdentityPart('revisionId', input.revisionId),
    ...sorted.flatMap((entry) => [entry.path, entry.contentHash]),
  ])}`;
}
