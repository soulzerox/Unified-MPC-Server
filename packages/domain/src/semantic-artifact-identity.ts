import { createHash } from 'node:crypto';

export const SEMANTIC_ARTIFACT_IDENTITY_VERSION = 1 as const;

export interface SemanticArtifactIdentityInput {
  /** Trust boundary key from the frozen repository provenance contract (U27). */
  readonly trustBoundaryKey: string;
  readonly chunkContentSha256: string;
  /** Combined embedding model/profile fingerprint, e.g. "model/embed-v1". */
  readonly embeddingProfile: string;
  /** Exact embedding dimension — an identity change, not a runtime guess. */
  readonly dimension: number;
  /** Normalization/preprocessing fingerprint (#210 §1). */
  readonly normalizationFingerprint: string;
  /** Chunker fingerprint — chunker upgrades change identity, not silently reuse. */
  readonly chunkerFingerprint: string;
  readonly representationVersion: string;
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
    throw new TypeError('chunkContentSha256 must be an exact 64-hex SHA-256');
  }
  return value.toLowerCase();
}

function requireDimension(value: number): string {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError('dimension must be a positive integer');
  }
  return String(value);
}

function digest(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join(NUL), 'utf8').digest('hex');
}

/**
 * Stable v1 identity for a chunk/semantic artifact (#210 §1).
 *
 * Reuse goes below file level: chunk content + embedding profile + dimension
 * + preprocessing/chunker fingerprints + representation version, scoped to one
 * trust boundary (never inferred from content hash alone — U27). Cross-boundary
 * reuse is denied even when content matches, so semantic artifacts are only
 * shared where authorization is provable.
 */
export function semanticArtifactId(input: SemanticArtifactIdentityInput): string {
  return `chunk:v1:${digest([
    'chunk-artifact',
    'v1',
    requireIdentityPart('trustBoundaryKey', input.trustBoundaryKey),
    requireContentHash(input.chunkContentSha256),
    requireIdentityPart('embeddingProfile', input.embeddingProfile),
    requireDimension(input.dimension),
    requireIdentityPart('normalizationFingerprint', input.normalizationFingerprint),
    requireIdentityPart('chunkerFingerprint', input.chunkerFingerprint),
    requireIdentityPart('representationVersion', input.representationVersion),
  ])}`;
}
