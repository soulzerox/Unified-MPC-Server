export type RepositoryProvenanceKind = 'git-remote' | 'git-local';

export interface RepositoryProvenance {
  readonly kind: RepositoryProvenanceKind;
  /** Remote URL or absolute local path the repository was observed at. */
  readonly locator: string;
}

export interface RepositoryIdentityInput {
  readonly repositoryId: string;
  readonly provenance: RepositoryProvenance;
  /** Explicit trust boundary the repository is admitted to. */
  readonly trustScope: string;
}

export interface RepositoryIdentity {
  readonly repositoryId: string;
  readonly provenance: RepositoryProvenance;
  readonly trustScope: string;
}

const NUL = String.fromCharCode(0);
const SEP = String.fromCharCode(0);

function requirePart(name: string, value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes(NUL)) {
    throw new TypeError(`${name} must be non-empty and must not contain NUL`);
  }
  return value.trim();
}

function normalizeLocator(provenance: RepositoryProvenance): string {
  if (provenance.kind !== 'git-remote' && provenance.kind !== 'git-local') {
    throw new TypeError(`unsupported repository provenance kind: ${String(provenance.kind)}`);
  }
  const locator = requirePart('provenance.locator', provenance.locator);
  // Remote locators are case-insensitive hosting paths; a trailing `.git`
  // is the same repository. Local paths stay verbatim (case-sensitive fs).
  return provenance.kind === 'git-remote'
    ? locator.toLowerCase().replace(/\.git$/, '')
    : locator;
}

/**
 * Repository provenance and trust boundary (#210 U27, §1).
 *
 * Every canonical record lives under an explicit repository/trust
 * boundary: repository_id, repository_provenance and trust_scope.
 * Cross-repository authorization is never inferred from a content hash
 * or from a matching repository id alone — two identities share a
 * boundary only when the id, the trust scope *and* the observed
 * provenance locator all agree. `trustBoundaryKey` is the partitioning
 * key stores and quarantines should use instead of a bare repository id.
 *
 * ponytail: this module owns the contract and its validation only; the
 * enforcement ceiling is that each consuming store must call
 * `requireSameTrustBoundary` on every cross-boundary read. Wire that
 * when a store ever accepts a foreign-boundary lookup (today the
 * canonical stores are per-root and single-boundary).
 */
export function defineRepositoryIdentity(input: RepositoryIdentityInput): RepositoryIdentity {
  return Object.freeze({
    repositoryId: requirePart('repositoryId', input.repositoryId),
    provenance: Object.freeze({
      kind: input.provenance.kind,
      locator: normalizeLocator(input.provenance),
    }),
    trustScope: requirePart('trustScope', input.trustScope),
  });
}

/** Partitioning key for stores: repository id plus trust scope, never content. */
export function trustBoundaryKey(identity: RepositoryIdentity): string {
  return `${identity.repositoryId}${SEP}${identity.trustScope}`;
}

/** True only when id, trust scope and observed provenance all agree. */
export function sameTrustBoundary(a: RepositoryIdentity, b: RepositoryIdentity): boolean {
  return a.repositoryId === b.repositoryId
    && a.trustScope === b.trustScope
    && a.provenance.kind === b.provenance.kind
    && normalizeLocator(a.provenance) === normalizeLocator(b.provenance);
}

/**
 * Fail-closed authorization guard for any cross-boundary read or reuse.
 *
 * Throws with the precise disagreement (repository, trust scope, or
 * provenance) so a caller can never silently treat another boundary's
 * artifacts as its own.
 */
export function requireSameTrustBoundary(a: RepositoryIdentity, b: RepositoryIdentity): void {
  if (a.repositoryId !== b.repositoryId) {
    throw new TypeError(`refusing cross-repository access: ${a.repositoryId} vs ${b.repositoryId}`);
  }
  if (a.trustScope !== b.trustScope) {
    throw new TypeError(
      `refusing cross-boundary access: trust scope ${a.trustScope} vs ${b.trustScope} for ${a.repositoryId}`,
    );
  }
  const left = normalizeLocator(a.provenance);
  const right = normalizeLocator(b.provenance);
  if (a.provenance.kind !== b.provenance.kind || left !== right) {
    throw new TypeError(
      `refusing access across provenance mismatch for ${a.repositoryId}: ${a.provenance.kind}:${left} vs ${b.provenance.kind}:${right}`,
    );
  }
}
