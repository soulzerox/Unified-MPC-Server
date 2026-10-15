import { createHash } from 'node:crypto';

export const CANONICAL_REVISION_IDENTITY_VERSION = 1 as const;

export interface CanonicalRevisionIdentityInput {
  readonly repositoryId: string;
  readonly commitSha: string;
  readonly treeOid: string;
  readonly targetRef: string;
  readonly parents: readonly string[];
}

function requireIdentityPart(name: string, value: string): string {
  if (value.length === 0 || value.includes('\u0000')) {
    throw new TypeError(`${name} must be non-empty and must not contain NUL`);
  }
  return value;
}

function requireObjectId(name: string, value: string): string {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value)) {
    throw new TypeError(`${name} must be an exact 40/64-hex Git object ID`);
  }
  return value.toLowerCase();
}

function requireTargetRef(value: string): string {
  if (value.length === 0
    || value.includes('\u0000')
    || value.includes('..')
    || !value.startsWith('refs/')) {
    throw new TypeError('targetRef must be an exact Git ref starting with refs/');
  }
  return value;
}

function digest(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\u0000'), 'utf8').digest('hex');
}

/**
 * Stable v1 identity for an exact Git revision (#210 U1).
 *
 * Commit/tree/ref are revision identity only — never the physical artifact
 * cache key. Content hashes decide artifact reuse; this ID decides which
 * source version is authoritative.
 */
export function canonicalRevisionId(input: CanonicalRevisionIdentityInput): string {
  const parents = input.parents.map((parent) => requireObjectId('parents[]', parent));
  return `rev:v1:${digest([
    'canonical-revision',
    'v1',
    requireIdentityPart('repositoryId', input.repositoryId),
    requireObjectId('commitSha', input.commitSha),
    requireObjectId('treeOid', input.treeOid),
    requireTargetRef(input.targetRef),
    ...parents,
  ])}`;
}
