import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalManifestId } from '@unified-mpc/domain';
import { errorMessage, isMissingPath } from './reachability-read.js';

export interface StoredManifestEntry {
  readonly path: string;
  readonly contentHash: string;
}

export interface StoredManifest {
  readonly manifestId: string;
  readonly repositoryId: string;
  readonly revisionId: string;
  readonly commitSha: string;
  readonly treeOid: string;
  readonly targetRef: string;
  readonly entries: readonly StoredManifestEntry[];
  readonly createdAt: string;
}

const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const MANIFEST_ID = /^man:v1:[a-f0-9]{64}$/i;

function requireObjectId(name: string, value: string): string {
  if (!OBJECT_ID.test(value)) throw new Error(`${name} must be an exact 40/64-hex Git object id`);
  return value.toLowerCase();
}

function requireTargetRef(value: string): string {
  if (value.length === 0 || !value.startsWith('refs/') || value.includes('..')) {
    throw new Error('targetRef must be an exact Git ref starting with refs/');
  }
  return value;
}

function requireManifestId(value: string): string {
  if (!MANIFEST_ID.test(value)) throw new Error(`invalid manifest id: ${value}`);
  return value.toLowerCase();
}

export interface CanonicalManifestStoreOptions {
  /**
   * Fail closed instead of skipping a record that cannot be read. A projection
   * whose counts must be exact (`index space`) refuses rather than printing a
   * smaller store; operator listings keep the tolerant default.
   */
  readonly strictReads?: boolean;
}

/**
 * Durable store for canonical revision manifests (#210 U15).
 *
 * A manifest is the frozen U2 identity (repository + revision + sorted
 * path->content-hash entries) plus the exact Git revision metadata and
 * provenance that the manifest ID deliberately excludes. `put` recomputes
 * the identity and refuses any manifest whose declared ID disagrees with
 * its entries — a tampered or drifted manifest can never be stored. One
 * JSON file per manifest under <root>/manifests/, tmp+rename durable.
 *
 * Lookups scan the per-manifest files (no side index to keep consistent);
 * add a commit index only when repositories grow large enough that the
 * scan shows up.
 *
 * Strictness is a property of the instance, so `get` and `listAll` can never
 * disagree: an operator store keeps the tolerant default, a projection that
 * must print exact counts constructs one with `strictReads`.
 */
export class CanonicalManifestStore {
  private readonly strictReads: boolean;

  public constructor(private readonly root: string, options: CanonicalManifestStoreOptions = {}) {
    this.strictReads = options.strictReads === true;
  }

  public async put(manifest: StoredManifest): Promise<void> {
    const manifestId = requireManifestId(manifest.manifestId);
    const repositoryId = manifest.repositoryId;
    const revisionId = manifest.revisionId;
    const commitSha = requireObjectId('commitSha', manifest.commitSha);
    const treeOid = requireObjectId('treeOid', manifest.treeOid);
    const targetRef = requireTargetRef(manifest.targetRef);
    const computed = canonicalManifestId({ repositoryId, revisionId, entries: manifest.entries });
    if (computed !== manifestId) {
      throw new Error(`manifest identity mismatch: declared ${manifestId} but entries hash to ${computed}`);
    }
    const normalized: StoredManifest = {
      manifestId,
      repositoryId,
      revisionId,
      commitSha,
      treeOid,
      targetRef,
      entries: manifest.entries.map((entry) => ({ path: entry.path, contentHash: entry.contentHash })),
      createdAt: manifest.createdAt,
    };
    const finalPath = this.manifestPath(manifestId);
    await mkdir(path.dirname(finalPath), { recursive: true });
    const tmpPath = `${finalPath}.tmp-${randomUUID()}`;
    await writeFile(tmpPath, JSON.stringify(normalized, null, 2), { mode: 0o600 });
    await rename(tmpPath, finalPath);
  }

  public async get(manifestId: string): Promise<StoredManifest | null> {
    let id: string;
    try {
      id = requireManifestId(manifestId);
    } catch (error) {
      // The tolerant lookup treats an unusable id as an absent row (its
      // documented `null`); a strict read refuses it like any other record it
      // cannot read.
      if (this.strictReads) throw error;
      return null;
    }
    let raw: string;
    try {
      raw = await readFile(this.manifestPath(id), 'utf8');
    } catch (error) {
      if (this.strictReads && !isMissingPath(error)) {
        throw new Error(`cannot read canonical manifest ${id}: ${errorMessage(error)}`);
      }
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      if (this.strictReads) throw new Error(`cannot read canonical manifest ${id}: ${errorMessage(error)}`);
      return null;
    }
    if (isManifest(parsed)) return parsed;
    if (this.strictReads) throw new Error(`cannot read canonical manifest ${id}: not a canonical manifest record`);
    return null;
  }

  public async listAll(): Promise<StoredManifest[]> {
    const manifestsDir = path.join(this.root, 'manifests');
    let files: string[];
    try {
      files = (await readdir(manifestsDir, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => entry.name);
    } catch (error) {
      if (this.strictReads && !isMissingPath(error)) {
        throw new Error(`cannot read the canonical manifests directory: ${errorMessage(error)}`);
      }
      return [];
    }
    const manifests: StoredManifest[] = [];
    for (const file of files) {
      try {
        const parsed: unknown = JSON.parse(await readFile(path.join(manifestsDir, file), 'utf8'));
        if (!isManifest(parsed)) throw new Error('not a canonical manifest record');
        manifests.push(parsed);
      } catch (error) {
        // Tolerant listings skip unreadable/corrupted records; a count that must
        // be exact refuses instead, because a skipped record undercounts.
        if (this.strictReads) throw new Error(`cannot read canonical manifest ${file}: ${errorMessage(error)}`);
      }
    }
    return manifests.sort((a, b) => a.manifestId.localeCompare(b.manifestId));
  }

  public async getByCommit(repositoryId: string, commitSha: string): Promise<StoredManifest | null> {
    const sha = requireObjectId('commitSha', commitSha);
    const manifests = await this.listRepository(repositoryId);
    return manifests.find((manifest) => manifest.commitSha === sha) ?? null;
  }

  public async listRepository(repositoryId: string): Promise<StoredManifest[]> {
    const manifestsDir = path.join(this.root, 'manifests');
    let files: string[];
    try {
      files = (await readdir(manifestsDir, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => entry.name);
    } catch {
      return [];
    }
    const manifests: StoredManifest[] = [];
    for (const file of files) {
      try {
        const parsed: unknown = JSON.parse(await readFile(path.join(manifestsDir, file), 'utf8'));
        if (isManifest(parsed) && parsed.repositoryId === repositoryId) manifests.push(parsed);
      } catch {
        // Skip unreadable/corrupted manifest files rather than failing the listing.
      }
    }
    return manifests.sort((a, b) => a.manifestId.localeCompare(b.manifestId));
  }

  /**
   * Delete one manifest row.
   *
   * `false` means the row was already absent. Any other failure is rethrown:
   * a caller such as `index revision prune --apply` must fail the pass and name
   * the path, not report a still-present row as removed.
   */
  public async delete(manifestId: string): Promise<boolean> {
    try {
      await rm(this.manifestPath(requireManifestId(manifestId)), { force: false });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  private manifestPath(manifestId: string): string {
    return path.join(this.root, 'manifests', `${manifestId}.json`);
  }
}

function isManifest(value: unknown): value is StoredManifest {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.manifestId === 'string'
    && typeof record.repositoryId === 'string'
    && typeof record.revisionId === 'string'
    && typeof record.commitSha === 'string'
    && typeof record.treeOid === 'string'
    && typeof record.targetRef === 'string'
    && typeof record.createdAt === 'string'
    && Array.isArray(record.entries);
}
