import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { errorMessage, isMissingPath, isStrictRead, type ReachabilityReadOptions } from './reachability-read.js';

const WORKSPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MANIFEST_ID = /^man:v1:[a-f0-9]{64}$/i;
const MAX_FIELD_LENGTH = 512;

/**
 * The provider generation that currently answers for one workspace (#210 §13).
 *
 * `manifestId` is Unified's canonical revision manifest, not the provider's
 * generation id: the generation id is evidence that the provider row is the
 * live one, while the manifest is the reachability root. A generation built
 * from bytes no manifest describes (absent/dirty/unsupported binding) has no
 * row here, because retaining a manifest it does not reference would only
 * postpone ordinary revision GC.
 */
export interface ProviderGenerationRecord {
  readonly workspaceId: string;
  readonly generationId: string;
  readonly manifestId: string;
  readonly repositoryId: string;
  readonly recordedAt: string;
}

export interface ProviderGenerationRecordInput {
  readonly workspaceId: string;
  readonly generationId: string;
  readonly manifestId: string;
  readonly repositoryId: string;
}

interface StoredProviderGeneration {
  readonly schemaVersion: 1;
  readonly workspaceId: string;
  readonly generationId: string;
  readonly manifestId: string;
  readonly repositoryId: string;
  readonly recordedAt: string;
}

function requireWorkspaceId(value: string): string {
  if (!WORKSPACE_ID.test(value)) throw new Error(`invalid workspace id: ${value}`);
  return value;
}

function requireManifestId(value: string): string {
  if (!MANIFEST_ID.test(value)) throw new Error(`invalid manifest id: ${value}`);
  return value.toLowerCase();
}

function requireBoundedText(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value !== value.trim() || value.length > MAX_FIELD_LENGTH) {
    throw new Error(`invalid ${field}`);
  }
  return value;
}

/**
 * Durable binding of a workspace's active Thai-RAG generation to the canonical
 * manifest it was built from (#210 bullet 4).
 *
 * `assembleGcRoots`, the artifact-key planner and revision prune only retain
 * what their roots name. Refs, pins, Goal overlay bases and index-job manifests
 * cover Unified's own lifecycle, but a completed provider generation is not an
 * index job any more: without this ledger, pruning the revision it was built
 * from would strand the live generation even though nothing in Unified still
 * referenced it. One JSON file per workspace keeps a write scoped to one
 * generation; tmp+rename makes each row readable or absent, never partial.
 *
 * Reads are strict for GC: an unreadable or malformed row must refuse the
 * destructive pass instead of looking like "no provider generation", which
 * would make the manifest it retains look unreachable.
 */
export class ProviderGenerationLedger {
  private readonly directory: string;
  private readonly now: () => Date;

  public constructor(root: string, options: { readonly now?: () => Date } = {}) {
    this.directory = path.join(root, 'provider-generations');
    this.now = options.now ?? ((): Date => new Date());
  }

  public async record(input: ProviderGenerationRecordInput): Promise<ProviderGenerationRecord> {
    const stored: StoredProviderGeneration = {
      schemaVersion: 1,
      workspaceId: requireWorkspaceId(input.workspaceId),
      generationId: requireBoundedText(input.generationId, 'provider generation id'),
      manifestId: requireManifestId(input.manifestId),
      repositoryId: requireBoundedText(input.repositoryId, 'provider generation repository id'),
      recordedAt: this.now().toISOString(),
    };
    const finalPath = this.pathFor(stored.workspaceId);
    await mkdir(this.directory, { recursive: true });
    const temporaryPath = `${finalPath}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(temporaryPath, `${JSON.stringify(stored, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryPath, finalPath);
    return withWorkspaceId(stored);
  }

  /** Drop the row for a workspace whose new generation is not manifest-bound. */
  public async release(workspaceId: string): Promise<boolean> {
    const id = requireWorkspaceId(workspaceId);
    try {
      // Never read the row first: a corrupt row still names a manifest that
      // must stop being a GC root once the generation is unbound, and refusing
      // here would leave the store unprunable until an operator intervened.
      await rm(this.pathFor(id));
      return true;
    } catch (error) {
      if (isMissingPath(error)) return false;
      throw new Error(`cannot release provider generation row ${id}: ${errorMessage(error)}`);
    }
  }

  public async get(workspaceId: string, options?: ReachabilityReadOptions): Promise<ProviderGenerationRecord | null> {
    const id = requireWorkspaceId(workspaceId);
    return this.readFile(this.pathFor(id), id, isStrictRead(options));
  }

  public async list(options?: ReachabilityReadOptions): Promise<ProviderGenerationRecord[]> {
    const strict = isStrictRead(options);
    let entries: string[];
    try {
      entries = await readdir(this.directory);
    } catch (error) {
      if (isMissingPath(error)) return [];
      throw new Error(`cannot read the provider generation ledger: ${errorMessage(error)}`);
    }
    const rows: ProviderGenerationRecord[] = [];
    for (const entry of entries.filter((name) => name.endsWith('.json')).sort()) {
      const workspaceId = entry.slice(0, -'.json'.length);
      const row = await this.readFile(path.join(this.directory, entry), workspaceId, strict);
      if (row !== null) rows.push(row);
    }
    return rows.sort((left, right) => (left.workspaceId < right.workspaceId ? -1 : left.workspaceId > right.workspaceId ? 1 : 0));
  }

  public async liveManifestIds(options?: ReachabilityReadOptions): Promise<string[]> {
    return [...new Set((await this.list(options)).map((row) => row.manifestId))].sort();
  }

  private pathFor(workspaceId: string): string {
    return path.join(this.directory, `${workspaceId}.json`);
  }

  private async readFile(filePath: string, expectedWorkspaceId: string, strict: boolean): Promise<ProviderGenerationRecord | null> {
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch (error) {
      if (isMissingPath(error)) return null;
      if (strict) throw new Error(`cannot read provider generation row ${filePath}: ${errorMessage(error)}`);
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      if (strict) throw new Error(`provider generation row ${filePath} is not valid JSON: ${errorMessage(error)}`);
      return null;
    }
    const stored = parseStoredGeneration(parsed, expectedWorkspaceId);
    if (stored === null) {
      // A malformed row can name the one manifest that keeps a live generation
      // alive, so a GC planning read refuses instead of silently dropping it.
      if (strict) throw new Error(`provider generation row ${filePath} is malformed or names another workspace`);
      return null;
    }
    return withWorkspaceId(stored);
  }
}

function parseStoredGeneration(value: unknown, expectedWorkspaceId: string): StoredProviderGeneration | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1
    || record.workspaceId !== expectedWorkspaceId
    || !WORKSPACE_ID.test(expectedWorkspaceId)
    || typeof record.generationId !== 'string'
    || record.generationId.trim().length === 0
    || record.generationId !== record.generationId.trim()
    || record.generationId.length > MAX_FIELD_LENGTH
    || typeof record.manifestId !== 'string'
    || !MANIFEST_ID.test(record.manifestId)
    || typeof record.repositoryId !== 'string'
    || record.repositoryId.trim().length === 0
    || record.repositoryId !== record.repositoryId.trim()
    || record.repositoryId.length > MAX_FIELD_LENGTH
    || typeof record.recordedAt !== 'string') return null;
  return {
    schemaVersion: 1,
    workspaceId: expectedWorkspaceId,
    generationId: record.generationId,
    manifestId: record.manifestId.toLowerCase(),
    repositoryId: record.repositoryId,
    recordedAt: record.recordedAt,
  };
}

function withWorkspaceId(stored: StoredProviderGeneration): ProviderGenerationRecord {
  return {
    workspaceId: stored.workspaceId,
    generationId: stored.generationId,
    manifestId: stored.manifestId,
    repositoryId: stored.repositoryId,
    recordedAt: stored.recordedAt,
  };
}
