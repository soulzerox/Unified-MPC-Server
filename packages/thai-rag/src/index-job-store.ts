import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createPosixProcessIdentityProbe, type PosixProcessIdentityProbe } from '@unified-mpc/process';
import { parseCanonicalWorkspaceId, resolveThaiRagProviderRoot } from './canonical-workspace.js';

export type ThaiRagIndexJobStatus = 'running' | 'cancelling' | 'cancelled' | 'completed' | 'failed' | 'interrupted' | 'legacy-unavailable';

const ACTIVE_JOB_STATUSES = new Set<ThaiRagIndexJobStatus>(['running', 'cancelling']);

export interface ThaiRagIndexJob {
  readonly jobId: string;
  readonly workspaceId: string;
  readonly ownerId?: string;
  readonly ownerProcessIdentity?: string;
  readonly providerJobId?: string;
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

export interface ThaiRagIndexJobStoreOptions {
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly processIdentityProbe?: PosixProcessIdentityProbe;
  readonly platform?: NodeJS.Platform;
}

export class ThaiRagIndexJobStore {
  private readonly filePath: string;
  private jobs = new Map<string, ThaiRagIndexJob>();
  private initialized = false;
  private migrated = false;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly processIdentityProbe: PosixProcessIdentityProbe;

  public constructor(
    dataRoot: string,
    private readonly now: () => Date = () => new Date(),
    options: ThaiRagIndexJobStoreOptions = {},
  ) {
    const root = resolveThaiRagProviderRoot(dataRoot);
    if (!root.ok) throw new Error(root.error.message);
    this.filePath = path.join(root.value, 'index-jobs.json');
    this.isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
    this.processIdentityProbe = options.processIdentityProbe ?? defaultProcessIdentityProbe(options.platform ?? process.platform);
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
      if (!ACTIVE_JOB_STATUSES.has(job.status) || ownerId === undefined) continue;
      const sameOwner = job.ownerId === ownerId;
      if (!sameOwner && !await this.isProvablyDeadRuntimeOwner(job)) continue;
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
    const ownerProcessIdentity = await this.readOwnerProcessIdentity(ownerId);
    const job: ThaiRagIndexJob = {
      jobId: `idx_umcp_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
      workspaceId: parsedWorkspaceId.value,
      ownerId,
      ...(ownerProcessIdentity === null ? {} : { ownerProcessIdentity }),
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

  public async bindProviderJob(jobId: string, providerJobId: string, ownerId: string): Promise<ThaiRagIndexJob | null> {
    if (providerJobId.trim().length === 0) throw new Error('Thai-RAG provider job ID is required');
    await this.initialize();
    const current = this.jobs.get(jobId);
    if (current === undefined || current.ownerId !== ownerId) return null;
    if (!ACTIVE_JOB_STATUSES.has(current.status)) return current;
    const next: ThaiRagIndexJob = { ...current, providerJobId };
    this.jobs.set(jobId, next);
    await this.persist();
    return next;
  }

  public async requestCancellation(jobId: string, ownerId: string): Promise<ThaiRagIndexJob | null> {
    await this.initialize();
    const current = this.jobs.get(jobId);
    if (current === undefined || current.ownerId !== ownerId) return null;
    if (!ACTIVE_JOB_STATUSES.has(current.status)) return current;
    if (current.status === 'cancelling') return current;
    const next: ThaiRagIndexJob = { ...current, status: 'cancelling' };
    this.jobs.set(jobId, next);
    await this.persist();
    return next;
  }

  public async cancel(jobId: string, result: unknown, ownerId: string): Promise<ThaiRagIndexJob | null> {
    return this.finish(jobId, 'cancelled', { result }, ownerId);
  }

  public async fail(jobId: string, error: string, ownerId: string): Promise<ThaiRagIndexJob | null> {
    return this.finish(jobId, 'failed', { error }, ownerId);
  }

  public async interruptRunning(ownerId: string, reason = 'Provider stopped before the indexing job completed'): Promise<void> {
    await this.initialize();
    const finishedAt = this.now().toISOString();
    let changed = false;
    for (const [id, job] of this.jobs) {
      if (!ACTIVE_JOB_STATUSES.has(job.status) || job.ownerId !== ownerId) continue;
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
      && job.workspaceId === workspaceId
      && (job.ownerId === ownerId || !ACTIVE_JOB_STATUSES.has(job.status))
      ? job
      : null;
  }

  public async active(ownerId: string): Promise<readonly ThaiRagIndexJob[]> {
    await this.initialize();
    return [...this.jobs.values()].filter((job) => ACTIVE_JOB_STATUSES.has(job.status) && job.ownerId === ownerId);
  }

  private async isProvablyDeadRuntimeOwner(job: ThaiRagIndexJob): Promise<boolean> {
    const pid = parseUnifiedRuntimeOwnerPid(job.ownerId);
    if (pid === null) return false;
    let alive: boolean;
    try {
      alive = this.isProcessAlive(pid);
    } catch {
      return false;
    }
    if (!alive) return true;
    if (job.ownerProcessIdentity === undefined) return false;
    let observedIdentity: string | null;
    try {
      observedIdentity = await this.processIdentityProbe(pid);
    } catch {
      return false;
    }
    if (observedIdentity !== null) return observedIdentity !== job.ownerProcessIdentity;
    try {
      return !this.isProcessAlive(pid);
    } catch {
      return false;
    }
  }

  private async readOwnerProcessIdentity(ownerId: string): Promise<string | null> {
    const pid = parseUnifiedRuntimeOwnerPid(ownerId);
    if (pid === null) return null;
    try {
      return await this.processIdentityProbe(pid);
    } catch {
      return null;
    }
  }

  private async finish(
    jobId: string,
    status: 'completed' | 'failed' | 'cancelled',
    detail: { readonly result?: unknown; readonly error?: string },
    ownerId: string,
  ): Promise<ThaiRagIndexJob | null> {
    await this.initialize();
    const current = this.jobs.get(jobId);
    if (current === undefined || current.ownerId !== ownerId) return null;
    if (!ACTIVE_JOB_STATUSES.has(current.status)) return current;
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
  const validStatus = value.status === 'running' || value.status === 'cancelling' || value.status === 'cancelled'
    || value.status === 'completed' || value.status === 'failed' || value.status === 'interrupted' || value.status === 'legacy-unavailable';
  const legacy = ownerId === undefined || !parseCanonicalWorkspaceId(workspaceId).ok || !validStatus;
  const status: ThaiRagIndexJobStatus = legacy ? 'legacy-unavailable' : value.status as ThaiRagIndexJobStatus;
  return {
    migrated: legacy,
    job: {
      jobId: value.jobId,
      workspaceId,
      ...(ownerId === undefined ? {} : { ownerId }),
      ...(typeof value.ownerProcessIdentity === 'string' && value.ownerProcessIdentity.trim().length > 0 ? { ownerProcessIdentity: value.ownerProcessIdentity } : {}),
      ...(typeof value.providerJobId === 'string' && value.providerJobId.trim().length > 0 ? { providerJobId: value.providerJobId } : {}),
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

function parseUnifiedRuntimeOwnerPid(ownerId: string | undefined): number | null {
  if (ownerId === undefined) return null;
  const match = /^unified-mpc:(\d+)$/.exec(ownerId);
  if (match === null) return null;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 && pid <= 2_147_483_647 ? pid : null;
}

function defaultProcessIdentityProbe(platform: NodeJS.Platform): PosixProcessIdentityProbe {
  if (platform === 'darwin' || platform === 'linux') return createPosixProcessIdentityProbe(platform);
  return async (): Promise<null> => null;
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return !isNodeError(error) || error.code !== 'ESRCH';
  }
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
