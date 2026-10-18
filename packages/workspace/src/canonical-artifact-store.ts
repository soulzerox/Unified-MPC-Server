import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileArtifactId, semanticArtifactId } from '@unified-mpc/domain';

/**
 * Source provenance binding an artifact key to a place a specific revision
 * referenced it. Held OUTSIDE the artifact identity (#210 §8): many bindings —
 * renames, re-commits, several manifests — may point at one immutable artifact.
 */
export interface ArtifactBinding {
  readonly path: string;
  readonly gitBlobOid?: string;
  readonly revisionId?: string;
  readonly manifestId?: string;
}

export interface StoredFileArtifact {
  readonly kind: 'file';
  readonly artifactKey: string;
  readonly repositoryId: string;
  readonly sourceContentSha256: string;
  readonly language: string;
  readonly sourceKind: string;
  readonly representationVersion: string;
  readonly bindings: readonly ArtifactBinding[];
  readonly createdAt: string;
}

export interface StoredSemanticArtifact {
  readonly kind: 'chunk';
  readonly artifactKey: string;
  readonly repositoryId: string;
  readonly trustBoundaryKey: string;
  readonly chunkContentSha256: string;
  readonly embeddingProfile: string;
  readonly dimension: number;
  readonly normalizationFingerprint: string;
  readonly chunkerFingerprint: string;
  readonly representationVersion: string;
  readonly createdAt: string;
}

export type StoredArtifact = StoredFileArtifact | StoredSemanticArtifact;

const FILE_KEY = /^file:v1:[a-f0-9]{64}$/i;
const CHUNK_KEY = /^chunk:v1:[a-f0-9]{64}$/i;
const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const MANIFEST_ID = /^man:v1:[a-f0-9]{64}$/i;

function requireIdentityPart(name: string, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\u0000')) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function requireArtifactKey(kind: 'file' | 'chunk', value: unknown): string {
  const pattern = kind === 'file' ? FILE_KEY : CHUNK_KEY;
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`artifact key/kind mismatch: ${kind} artifact cannot carry key ${String(value)}`);
  }
  return value.toLowerCase();
}

function requireBinding(binding: ArtifactBinding): ArtifactBinding {
  const pathValue = requireIdentityPart('binding.path', binding.path);
  const normalized: ArtifactBinding = {
    path: pathValue,
    ...(binding.gitBlobOid === undefined ? {} : { gitBlobOid: requireObjectId('binding.gitBlobOid', binding.gitBlobOid) }),
    ...(binding.revisionId === undefined ? {} : { revisionId: requireIdentityPart('binding.revisionId', binding.revisionId) }),
    ...(binding.manifestId === undefined ? {} : { manifestId: requireManifestId(binding.manifestId) }),
  };
  return normalized;
}

function requireObjectId(name: string, value: unknown): string {
  if (typeof value !== 'string' || !OBJECT_ID.test(value)) {
    throw new Error(`${name} must be an exact 40/64-hex Git object id`);
  }
  return value.toLowerCase();
}

function requireManifestId(value: unknown): string {
  if (typeof value !== 'string' || !MANIFEST_ID.test(value)) {
    throw new Error(`binding.manifestId must be an exact man:v1 id`);
  }
  return value.toLowerCase();
}

function bindingSignature(binding: ArtifactBinding): string {
  return [binding.path, binding.gitBlobOid ?? '', binding.revisionId ?? '', binding.manifestId ?? ''].join('\u0000');
}

function mergeBindings(existing: readonly ArtifactBinding[], incoming: readonly ArtifactBinding[]): ArtifactBinding[] {
  const merged = new Map<string, ArtifactBinding>();
  for (const binding of [...existing, ...incoming]) {
    const normalized = requireBinding(binding);
    merged.set(bindingSignature(normalized), normalized);
  }
  return [...merged.values()].sort((a, b) => (bindingSignature(a) < bindingSignature(b) ? -1 : 1));
}

/**
 * Durable, repository-scoped store for canonical artifacts (#210 §1/§6).
 *
 * A record is the frozen identity inputs of `fileArtifactId` /
 * `semanticArtifactId` (frozen in #395) plus the provenance bindings those
 * identities deliberately exclude. `put` recomputes the identity from the
 * record's own inputs and refuses any declared key that disagrees, so a
 * tampered or drifted artifact can never be stored.
 *
 * Repository isolation is structural: the on-disk name digests the
 * `repositoryId`, so identical content registered in two trust boundaries is
 * two records and a repository-scoped read can never reach across a boundary.
 * Cross-boundary sharing stays a caller policy decision under the U27
 * trust-boundary contract — never a dedupe side effect of matching hashes.
 *
 * One JSON per record under <root>/artifacts/, tmp+rename durable. Listing
 * scans the directory (no side index); add an index only when scans show up.
 */
export class CanonicalArtifactStore {
  public constructor(private readonly root: string) {}

  public async put(artifact: StoredArtifact): Promise<void> {
    const normalized = this.verify(artifact);
    const existing = await this.get(artifact.repositoryId, normalized.artifactKey);
    const record = existing === null
      ? normalized
      : this.withMergedBindings(existing, normalized);
    const finalPath = this.artifactPath(record.repositoryId, record.artifactKey);
    await mkdir(path.dirname(finalPath), { recursive: true });
    const tmpPath = `${finalPath}.tmp-${randomUUID()}`;
    await writeFile(tmpPath, JSON.stringify(record, null, 2), { mode: 0o600 });
    await rename(tmpPath, finalPath);
  }

  public async addBinding(repositoryId: string, artifactKey: string, binding: ArtifactBinding): Promise<void> {
    const existing = await this.get(repositoryId, artifactKey);
    if (existing === null) {
      throw new Error(`unknown artifact: ${artifactKey} in repository ${repositoryId}`);
    }
    if (existing.kind !== 'file') {
      throw new Error(`semantic artifacts carry no path bindings: ${artifactKey}`);
    }
    await this.put({ ...existing, bindings: [...existing.bindings, binding] });
  }

  public async get(repositoryId: string, artifactKey: string): Promise<StoredArtifact | null> {
    const key = artifactKey.trim().toLowerCase();
    if (!FILE_KEY.test(key) && !CHUNK_KEY.test(key)) {
      throw new Error(`invalid artifact key: ${artifactKey}`);
    }
    try {
      const parsed: unknown = JSON.parse(await readFile(this.artifactPath(repositoryId, key), 'utf8'));
      if (!isArtifact(parsed)) return null;
      return parsed.repositoryId === repositoryId && parsed.artifactKey === key ? parsed : null;
    } catch {
      return null;
    }
  }

  public async has(repositoryId: string, artifactKey: string): Promise<boolean> {
    return (await this.get(repositoryId, artifactKey)) !== null;
  }

  public async listRepository(repositoryId: string): Promise<StoredArtifact[]> {
    return (await this.listAll()).filter((artifact) => artifact.repositoryId === repositoryId);
  }

  /**
   * Artifact keys referenced by any of the given manifests — the projection a
   * reachability pass consumes to keep artifacts alive while their manifests
   * are retained (#210 §7).
   */
  public async artifactKeysReferencedBy(manifestIds: readonly string[]): Promise<string[]> {
    const wanted = new Set(manifestIds.map((manifestId) => requireManifestId(manifestId)));
    const keys = new Set<string>();
    for (const artifact of await this.listAll()) {
      if (artifact.kind !== 'file') continue;
      if (artifact.bindings.some((binding) => binding.manifestId !== undefined && wanted.has(binding.manifestId))) {
        keys.add(artifact.artifactKey);
      }
    }
    return [...keys].sort();
  }

  public async delete(repositoryId: string, artifactKey: string): Promise<boolean> {
    try {
      await rm(this.artifactPath(repositoryId, artifactKey.trim().toLowerCase()), { force: false });
      return true;
    } catch {
      return false;
    }
  }

  private verify(artifact: StoredArtifact): StoredArtifact {
    const repositoryId = requireIdentityPart('repositoryId', artifact.repositoryId);
    const createdAt = requireIdentityPart('createdAt', artifact.createdAt);
    if (artifact.kind === 'file') {
      const artifactKey = requireArtifactKey('file', artifact.artifactKey);
      const sourceContentSha256 = requireObjectId('sourceContentSha256', artifact.sourceContentSha256);
      const language = requireIdentityPart('language', artifact.language);
      const sourceKind = requireIdentityPart('sourceKind', artifact.sourceKind);
      const representationVersion = requireIdentityPart('representationVersion', artifact.representationVersion);
      const computed = fileArtifactId({ sourceContentSha256, language, sourceKind, representationVersion });
      if (computed !== artifactKey) {
        throw new Error(`artifact identity mismatch: declared ${artifactKey} but inputs hash to ${computed}`);
      }
      return {
        kind: 'file',
        artifactKey,
        repositoryId,
        sourceContentSha256,
        language,
        sourceKind,
        representationVersion,
        bindings: mergeBindings([], artifact.bindings),
        createdAt,
      };
    }
    if (artifact.kind === 'chunk') {
      const artifactKey = requireArtifactKey('chunk', artifact.artifactKey);
      const trustBoundaryKey = requireIdentityPart('trustBoundaryKey', artifact.trustBoundaryKey);
      const chunkContentSha256 = requireObjectId('chunkContentSha256', artifact.chunkContentSha256);
      const embeddingProfile = requireIdentityPart('embeddingProfile', artifact.embeddingProfile);
      const normalizationFingerprint = requireIdentityPart('normalizationFingerprint', artifact.normalizationFingerprint);
      const chunkerFingerprint = requireIdentityPart('chunkerFingerprint', artifact.chunkerFingerprint);
      const representationVersion = requireIdentityPart('representationVersion', artifact.representationVersion);
      if (!Number.isInteger(artifact.dimension) || artifact.dimension <= 0) {
        throw new Error('dimension must be a positive integer');
      }
      const computed = semanticArtifactId({
        trustBoundaryKey,
        chunkContentSha256,
        embeddingProfile,
        dimension: artifact.dimension,
        normalizationFingerprint,
        chunkerFingerprint,
        representationVersion,
      });
      if (computed !== artifactKey) {
        throw new Error(`artifact identity mismatch: declared ${artifactKey} but inputs hash to ${computed}`);
      }
      return {
        kind: 'chunk',
        artifactKey,
        repositoryId,
        trustBoundaryKey,
        chunkContentSha256,
        embeddingProfile,
        dimension: artifact.dimension,
        normalizationFingerprint,
        chunkerFingerprint,
        representationVersion,
        createdAt,
      };
    }
    throw new Error(`unsupported artifact kind: ${String((artifact as { kind?: unknown }).kind)}`);
  }

  private withMergedBindings(existing: StoredArtifact, incoming: StoredArtifact): StoredArtifact {
    if (existing.kind !== 'file' || incoming.kind !== 'file') return existing;
    return { ...existing, bindings: mergeBindings(existing.bindings, incoming.bindings) };
  }

  private async listAll(): Promise<StoredArtifact[]> {
    const artifactsDir = path.join(this.root, 'artifacts');
    let files: string[];
    try {
      files = (await readdir(artifactsDir, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => entry.name);
    } catch {
      return [];
    }
    const artifacts: StoredArtifact[] = [];
    for (const file of files) {
      try {
        const parsed: unknown = JSON.parse(await readFile(path.join(artifactsDir, file), 'utf8'));
        if (isArtifact(parsed)) artifacts.push(parsed);
      } catch {
        // Skip unreadable/corrupted records rather than failing the listing.
      }
    }
    return artifacts.sort((a, b) => a.artifactKey.localeCompare(b.artifactKey));
  }

  private artifactPath(repositoryId: string, artifactKey: string): string {
    const digest = createHash('sha256').update(requireIdentityPart('repositoryId', repositoryId), 'utf8').digest('hex');
    return path.join(this.root, 'artifacts', `${digest}.${artifactKey}.json`);
  }
}

function isArtifact(value: unknown): value is StoredArtifact {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.artifactKey !== 'string' || typeof record.repositoryId !== 'string') return false;
  if (typeof record.createdAt !== 'string') return false;
  if (record.kind === 'file') {
    return FILE_KEY.test(record.artifactKey)
      && typeof record.sourceContentSha256 === 'string'
      && typeof record.language === 'string'
      && typeof record.sourceKind === 'string'
      && typeof record.representationVersion === 'string'
      && Array.isArray(record.bindings);
  }
  if (record.kind === 'chunk') {
    return CHUNK_KEY.test(record.artifactKey)
      && typeof record.trustBoundaryKey === 'string'
      && typeof record.chunkContentSha256 === 'string'
      && typeof record.embeddingProfile === 'string'
      && typeof record.dimension === 'number'
      && typeof record.normalizationFingerprint === 'string'
      && typeof record.chunkerFingerprint === 'string'
      && typeof record.representationVersion === 'string';
  }
  return false;
}
