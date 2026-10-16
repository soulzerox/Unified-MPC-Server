import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export type IndexJobStatus = 'pending' | 'active';

export interface IndexJobRecord {
  readonly operationId: string;
  readonly manifestId: string;
  readonly status: IndexJobStatus;
  readonly openedAt: string;
  readonly updatedAt: string;
}

const MANIFEST_ID = /^man:v1:[a-f0-9]{64}$/i;

function requireManifestId(value: string): string {
  if (!MANIFEST_ID.test(value)) throw new Error(`invalid manifest id: ${value}`);
  return value;
}

function requireOperationId(value: string): string {
  if (!value) throw new Error('operationId must not be empty');
  return value;
}

function isRecord(value: unknown): value is IndexJobRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.operationId === 'string'
    && record.operationId.length > 0
    && typeof record.manifestId === 'string'
    && MANIFEST_ID.test(record.manifestId)
    && (record.status === 'pending' || record.status === 'active')
    && typeof record.openedAt === 'string'
    && typeof record.updatedAt === 'string';
}

/**
 * Index-job manifest ledger (#210 U25).
 *
 * The missing producer for the U18 index-job roots: an index job pins
 * the manifest it is rebuilding, so GC must treat that manifest's
 * artifacts as live until the job settles. `open` records a queued job,
 * `markActive` records its start, `settle` removes it when it finishes
 * or fails. `liveManifestIds` returns the deduped set feeding U18 —
 * a manifest stays live while any job still references it. Re-opening
 * an existing operation retargets it (a requeued job points at a fresh
 * manifest, not the stale one). One JSON file under
 * <root>/index-jobs/, tmp+rename durable, sorted output.
 *
 * Consumers must refuse the write side as guards: this module owns the
 * ledger only, never the admission decision of whether a job runs.
 */
export class IndexJobLedger {
  public constructor(private readonly root: string) {}

  public async open(operationId: string, manifestId: string, now: Date): Promise<IndexJobRecord> {
    requireOperationId(operationId);
    requireManifestId(manifestId);
    const stamp = now.toISOString();
    const jobs = await this.readAll();
    const existing = jobs.get(operationId);
    const record: IndexJobRecord = {
      operationId,
      manifestId,
      status: 'pending',
      openedAt: existing?.openedAt ?? stamp,
      updatedAt: stamp,
    };
    jobs.set(operationId, record);
    await this.write(jobs);
    return record;
  }

  public async markActive(operationId: string, now: Date): Promise<boolean> {
    requireOperationId(operationId);
    const jobs = await this.readAll();
    const existing = jobs.get(operationId);
    if (existing === undefined) return false;
    jobs.set(operationId, { ...existing, status: 'active', updatedAt: now.toISOString() });
    await this.write(jobs);
    return true;
  }

  public async settle(operationId: string): Promise<boolean> {
    requireOperationId(operationId);
    const jobs = await this.readAll();
    if (!jobs.has(operationId)) return false;
    jobs.delete(operationId);
    await this.write(jobs);
    return true;
  }

  public async list(): Promise<IndexJobRecord[]> {
    return [...(await this.readAll()).values()].sort((a, b) => (a.operationId < b.operationId ? -1 : a.operationId > b.operationId ? 1 : 0));
  }

  public async liveManifestIds(): Promise<string[]> {
    const live = new Set<string>();
    for (const record of (await this.readAll()).values()) {
      live.add(record.manifestId);
    }
    return [...live].sort();
  }

  private ledgerPath(): string {
    return path.join(this.root, 'index-jobs', 'jobs.json');
  }

  private async readAll(): Promise<Map<string, IndexJobRecord>> {
    try {
      const raw = await readFile(this.ledgerPath(), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return new Map();
      const jobs = new Map<string, IndexJobRecord>();
      for (const value of parsed) {
        if (isRecord(value)) jobs.set(value.operationId, value);
      }
      return jobs;
    } catch {
      return new Map();
    }
  }

  private async write(jobs: ReadonlyMap<string, IndexJobRecord>): Promise<void> {
    const finalPath = this.ledgerPath();
    await mkdir(path.dirname(finalPath), { recursive: true });
    const ordered = [...jobs.values()].sort((a, b) => (a.operationId < b.operationId ? -1 : a.operationId > b.operationId ? 1 : 0));
    const tmpPath = `${finalPath}.tmp-${randomUUID()}`;
    await writeFile(tmpPath, JSON.stringify(ordered, null, 2), { mode: 0o600 });
    await rename(tmpPath, finalPath);
  }
}
