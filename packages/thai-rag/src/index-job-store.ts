import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseCanonicalWorkspaceId, resolveThaiRagProviderRoot } from './canonical-workspace.js';

export type ThaiRagIndexJobStatus = 'running' | 'completed' | 'failed' | 'interrupted' | 'legacy-unavailable';

export interface ThaiRagIndexJob {
  readonly jobId: string;
  readonly workspaceId: string;
  readonly ownerId?: string;
  readonly status: ThaiRagIndexJobStatus;
  readonly force: boolean;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly result?: unknown;
  readonly error?: string;
  readonly legacyData?: Readonly<Record<string, unknown>>;
}

interface JobFile {
  readonly schemaVersion: 2;
  readonly jobs: readonly ThaiRagIndexJob[];
}

export class ThaiRagIndexJobStore {
  private readonly filePath: string;
  private jobs = new Map<string, ThaiRagIndexJob>();
  private initialized = false;
  private migrated = false;

  public constructor(dataRoot: string, private readonly now: () => Date = () => new Date()) {
    const root = resolveThaiRagProviderRoot(dataRoot);
    if (!root.ok) throw new Error(root.error.message);
    this.filePath = path.join(root.value, 'index-jobs.json');
  }

  public async initialize(ownerId?: string): Promise<void> {
    if (this.initialized) return;
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, 'utf8'));
      if (isRecord(parsed) && (parsed.schemaVersion === 1 || parsed.schemaVersion === 2) && Array.isArray(parsed.jobs)) {
        this.migrated = parsed.schemaVersion === 1;
        for (const value of parsed.jobs) {
          const parsedJob = parseJob(value, this.now);
          if (parsedJob !== null) {
            this.jobs.set(parsedJob.job.jobId, parsedJob.job);
            this.migrated ||= parsedJob.migrated;
          }
        }
        if (this.migrated) await this.persist();
      }
    } catch (error: unknown) {
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
    }

    const finishedAt = this.now().toISOString();
    let changed = false;
    for (const [id, job] of this.jobs) {
      if (job.status !== 'running' || job.ownerId !== ownerId) continue;
      this.jobs.set(id, { ...job, status: 'interrupted', finishedAt, error: 'Provider restarted before the indexing job completed' });
      changed = true;
    }
    this.initialized = true;
    if (changed) await this.persist();
  }

  public async create(workspaceId: string, force: boolean, ownerId: string): Promise<ThaiRagIndexJob> {
    const parsedWorkspaceId = parseCanonicalWorkspaceId(workspaceId);
    if (!parsedWorkspaceId.ok) throw new Error(parsedWorkspaceId.error.message);
    if (ownerId.trim().length === 0) throw new Error('Thai-RAG index job owner is required');
    await this.initialize();
    const job: ThaiRagIndexJob = {
      jobId: `idx_umcp_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
      workspaceId: parsedWorkspaceId.value,
      ownerId,
      status: 'running',
      force,
      startedAt: this.now().toISOString(),
    };
    this.jobs.set(job.jobId, job);
    await this.persist();
    return job;
  }

  public async complete(jobId: string, result: unknown, ownerId: string): Promise<ThaiRagIndexJob | null> {
    return this.finish(jobId, 'completed', { result }, ownerId);
  }

  public async fail(jobId: string, error: string, ownerId: string): Promise<ThaiRagIndexJob | null> {
    return this.finish(jobId, 'failed', { error }, ownerId);
  }

  public async interruptRunning(ownerId: string, reason = 'Provider stopped before the indexing job completed'): Promise<void> {
    await this.initialize();
    const finishedAt = this.now().toISOString();
    let changed = false;
    for (const [id, job] of this.jobs) {
      if (job.status !== 'running' || job.ownerId !== ownerId) continue;
      this.jobs.set(id, { ...job, status: 'interrupted', finishedAt, error: reason });
      changed = true;
    }
    if (changed) await this.persist();
  }

  public async get(jobId: string, ownerId: string, workspaceId: string): Promise<ThaiRagIndexJob | null> {
    if (typeof jobId !== 'string' || typeof ownerId !== 'string' || typeof workspaceId !== 'string'
      || jobId.trim().length === 0 || ownerId.trim().length === 0 || workspaceId.trim().length === 0) return null;
    await this.initialize();
    const job = this.jobs.get(jobId);
    return job !== undefined
      && job.status !== 'legacy-unavailable'
      && job.ownerId === ownerId
      && job.workspaceId === workspaceId
      ? job
      : null;
  }

  public async active(ownerId: string): Promise<readonly ThaiRagIndexJob[]> {
    await this.initialize();
    return [...this.jobs.values()].filter((job) => job.status === 'running' && job.ownerId === ownerId);
  }

  private async finish(
    jobId: string,
    status: 'completed' | 'failed',
    detail: { readonly result?: unknown; readonly error?: string },
    ownerId: string,
  ): Promise<ThaiRagIndexJob | null> {
    await this.initialize();
    const current = this.jobs.get(jobId);
    if (current === undefined || current.ownerId !== ownerId) return null;
    const next: ThaiRagIndexJob = {
      ...current,
      status,
      finishedAt: this.now().toISOString(),
      ...(detail.result === undefined ? {} : { result: detail.result }),
      ...(detail.error === undefined ? {} : { error: detail.error }),
    };
    this.jobs.set(jobId, next);
    await this.persist();
    return next;
  }

  private async persist(): Promise<void> {
    const payload: JobFile = { schemaVersion: 2, jobs: [...this.jobs.values()] };
    const temporary = `${this.filePath}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.filePath);
  }
}

function parseJob(value: unknown, now: () => Date): { readonly job: ThaiRagIndexJob; readonly migrated: boolean } | null {
  if (!isRecord(value) || typeof value.jobId !== 'string' || value.jobId.trim().length === 0) return null;
  if (value.status === 'legacy-unavailable' && isRecord(value.legacyData)) {
    return { job: value as unknown as ThaiRagIndexJob, migrated: false };
  }
  const workspaceId = typeof value.workspaceId === 'string' && value.workspaceId.trim().length > 0
    ? value.workspaceId
    : 'legacy-unavailable';
  const ownerId = typeof value.ownerId === 'string' && value.ownerId.trim().length > 0 ? value.ownerId : undefined;
  const validStatus = value.status === 'running' || value.status === 'completed' || value.status === 'failed' || value.status === 'interrupted' || value.status === 'legacy-unavailable';
  const legacy = ownerId === undefined || !parseCanonicalWorkspaceId(workspaceId).ok || !validStatus;
  const status: ThaiRagIndexJobStatus = legacy ? 'legacy-unavailable' : value.status as ThaiRagIndexJobStatus;
  return {
    migrated: legacy,
    job: {
      jobId: value.jobId,
      workspaceId,
      ...(ownerId === undefined ? {} : { ownerId }),
      status,
      force: typeof value.force === 'boolean' ? value.force : false,
      startedAt: typeof value.startedAt === 'string' ? value.startedAt : now().toISOString(),
      ...(legacy ? { finishedAt: typeof value.finishedAt === 'string' ? value.finishedAt : now().toISOString(), error: 'Legacy index job is unavailable', legacyData: value } : {}),
      ...(typeof value.finishedAt === 'string' ? { finishedAt: value.finishedAt } : {}),
      ...(Object.hasOwn(value, 'result') ? { result: value.result } : {}),
      ...(typeof value.error === 'string' ? { error: value.error } : {}),
    },
  };
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
