import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createPosixProcessIdentityProbe, type PosixProcessIdentityProbe } from '@unified-mpc/process';
import { parseCanonicalWorkspaceId, resolveThaiRagProviderRoot } from './canonical-workspace.js';

export type ThaiRagIndexJobStatus = 'running' | 'cancelling' | 'cancelled' | 'completed' | 'failed' | 'interrupted' | 'legacy-unavailable';
export type ThaiRagReindexReason =
  | 'startup_verification'
  | 'alias_created_or_repaired'
  | 'workspace_relinked'
  | 'explicit_request'
  | 'explicit_force_reindex';

const ACTIVE_JOB_STATUSES = new Set<ThaiRagIndexJobStatus>(['running', 'cancelling']);
// Terminal rows are diagnostics, not history. The file is rewritten in full on
// every heartbeat, so an unbounded list turns each one-second progress write
// into a megabyte-scale serialisation. Active rows are never pruned.
const TERMINAL_JOB_RETENTION = 200;
const REINDEX_REASONS = new Set<ThaiRagReindexReason>([
  'startup_verification',
  'alias_created_or_repaired',
  'workspace_relinked',
  'explicit_request',
  'explicit_force_reindex',
]);

export interface ThaiRagIndexJob {
  readonly jobId: string;
  readonly workspaceId: string;
  readonly ownerId?: string;
  readonly ownerProcessIdentity?: string;
  readonly providerJobId?: string;
  /** Last owner-verified provider progress, persisted across reads/restarts. */
  readonly indexedFiles?: number;
  readonly skippedFiles?: number;
  readonly totalFiles?: number;
  readonly cacheHitFiles?: number;
  readonly cacheHitChunks?: number;
  readonly cacheMissFiles?: number;
  readonly cacheMissChunks?: number;
  readonly newEmbeddedFiles?: number;
  readonly newEmbeddedChunks?: number;
  readonly cacheMissReasons?: Readonly<Record<string, number>>;
  readonly status: ThaiRagIndexJobStatus;
  readonly force: boolean;
  readonly reindexReason?: ThaiRagReindexReason;
  readonly startedAt: string;
  /** Last owner-verified provider progress timestamp; absent on legacy records. */
  readonly progressAt?: string;
  readonly finishedAt?: string;
  readonly result?: unknown;
  readonly error?: string;
  readonly legacyData?: Readonly<Record<string, unknown>>;
}

interface JobFile {
  readonly schemaVersion: 3;
  readonly jobs: readonly ThaiRagIndexJob[];
}

export interface ThaiRagIndexJobProgress {
  readonly indexedFiles: number;
  readonly skippedFiles: number;
  readonly totalFiles: number;
  readonly cacheHitFiles?: number;
  readonly cacheHitChunks?: number;
  readonly cacheMissFiles?: number;
  readonly cacheMissChunks?: number;
  readonly newEmbeddedFiles?: number;
  readonly newEmbeddedChunks?: number;
  readonly cacheMissReasons?: Readonly<Record<string, number>>;
}

export interface ThaiRagIndexJobListingOptions {
  /** Restrict the listing to rows recorded for one canonical workspace UUID. */
  readonly workspaceId?: string;
  /**
   * Maximum number of terminal rows to include. Active rows are always
   * included because a running job is current state, not history. Defaults to
   * 20 and is clamped to `1..200`.
   */
  readonly limit?: number;
}

/**
 * Read-only operator view of the durable index-job ledger.
 *
 * `jobs` is bounded: every active row, then the newest terminal rows up to the
 * limit. `matchingRowCount` is the number of attributable rows the filter
 * matched before that bound, so a caller can tell a short history apart from a
 * truncated one. `legacyRowCount` counts rows written before the canonical
 * contract: they carry no owner, workspace or counters and are never described
 * as if they did.
 */
export interface ThaiRagIndexJobListing {
  readonly jobs: readonly ThaiRagIndexJob[];
  readonly totalRowCount: number;
  readonly matchingRowCount: number;
  readonly legacyRowCount: number;
}

export interface ThaiRagIndexJobStoreOptions {
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly processIdentityProbe?: PosixProcessIdentityProbe;
  readonly platform?: NodeJS.Platform;
  /**
   * How long an active job may go without owner-verified provider progress
   * before the owner is presumed wedged and the job is reaped. Must be > 0;
   * defaults to 10 minutes.
   */
  readonly stuckJobTimeoutMs?: number;
}

export const DEFAULT_STUCK_INDEX_JOB_TIMEOUT_MS = 10 * 60_000;
/** Default bound on terminal rows in one operator listing. */
export const DEFAULT_OPERATOR_INDEX_JOB_LIMIT = 20;
/** Hard bound on terminal rows in one operator listing. */
export const MAX_OPERATOR_INDEX_JOB_LIMIT = TERMINAL_JOB_RETENTION;

export class ThaiRagIndexJobStore {
  private readonly filePath: string;
  private jobs = new Map<string, ThaiRagIndexJob>();
  private loaded = false;
  private initialized = false;
  private migrated = false;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly processIdentityProbe: PosixProcessIdentityProbe;
  private readonly stuckJobTimeoutMs: number;

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
    const stuckJobTimeoutMs = options.stuckJobTimeoutMs ?? DEFAULT_STUCK_INDEX_JOB_TIMEOUT_MS;
    if (!Number.isFinite(stuckJobTimeoutMs) || stuckJobTimeoutMs <= 0) {
      throw new Error('Thai-RAG stuck index job timeout must be a positive number of milliseconds');
    }
    this.stuckJobTimeoutMs = stuckJobTimeoutMs;
  }

  public async initialize(ownerId?: string): Promise<void> {
    if (this.initialized) return;
    // A mutating/admission path must own the directory before it can persist.
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await this.load();
    if (this.migrated) await this.persist();

    const finishedAt = this.now().toISOString();
    let changed = false;
    for (const [id, job] of this.jobs) {
      if (!ACTIVE_JOB_STATUSES.has(job.status) || ownerId === undefined) continue;
      const sameOwner = job.ownerId === ownerId;
      if (!sameOwner && !await this.isProvablyDeadRuntimeOwner(job)) continue;
      this.jobs.set(id, { ...job, status: 'interrupted', finishedAt, error: 'Provider restarted before the indexing job completed (owner-lost-restarted)' });
      changed = true;
    }
    this.initialized = true;
    if (await this.reapStuckJobs()) changed = true;
    if (changed) await this.persist();
  }

  /**
   * Hydrate the ledger from disk without creating, migrating or rewriting it.
   *
   * The operator listing runs in a different process from the runtime owner, so
   * it must never persist: a snapshot written by a short-lived reader would
   * clobber progress the live owner recorded after that snapshot was read.
   * Only `initialize` (the write/admission path) may migrate or reap.
   */
  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, 'utf8'));
      if (!isRecord(parsed)
        || (parsed.schemaVersion !== 1 && parsed.schemaVersion !== 2 && parsed.schemaVersion !== 3)
        || !Array.isArray(parsed.jobs)) {
        // A ledger written by a newer runtime or damaged on disk must fail
        // closed. Treating it as empty would let the next write replace real
        // job history with a fresh file this process cannot fully understand.
        throw new Error(`Thai-RAG index job ledger ${this.filePath} is not a recognized schema; refusing to read or rewrite it`);
      }
      const rows: Array<{ readonly job: ThaiRagIndexJob; readonly migrated: boolean }> = [];
      for (const value of parsed.jobs) {
        const parsedJob = parseJob(value, this.now);
        if (parsedJob === null) {
          throw new Error(`Thai-RAG index job ledger ${this.filePath} contains an unparseable job row; refusing to read or rewrite it`);
        }
        rows.push(parsedJob);
      }
      // Commit only after the whole document parsed, so a failure cannot leave
      // a partially loaded ledger behind for the next caller.
      this.migrated = parsed.schemaVersion !== 3;
      for (const { job, migrated } of rows) {
        this.jobs.set(job.jobId, job);
        this.migrated ||= migrated;
      }
    } catch (error: unknown) {
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
    }
    this.loaded = true;
  }

  public async create(
    workspaceId: string,
    force: boolean,
    ownerId: string,
    reindexReason: ThaiRagReindexReason = force ? 'explicit_force_reindex' : 'explicit_request',
  ): Promise<ThaiRagIndexJob> {
    const parsedWorkspaceId = parseCanonicalWorkspaceId(workspaceId);
    if (!parsedWorkspaceId.ok) throw new Error(parsedWorkspaceId.error.message);
    if (ownerId.trim().length === 0) throw new Error('Thai-RAG index job owner is required');
    if (!REINDEX_REASONS.has(reindexReason)) throw new Error('Thai-RAG index reindex reason is invalid');
    await this.initialize();
    const ownerProcessIdentity = await this.readOwnerProcessIdentity(ownerId);
    const startedAt = this.now().toISOString();
    const job: ThaiRagIndexJob = {
      jobId: `idx_umcp_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
      workspaceId: parsedWorkspaceId.value,
      ownerId,
      ...(ownerProcessIdentity === null ? {} : { ownerProcessIdentity }),
      status: 'running',
      force,
      reindexReason,
      startedAt,
      progressAt: startedAt,
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

  public async recordProgress(
    jobId: string,
    progress: ThaiRagIndexJobProgress,
    ownerId: string,
  ): Promise<ThaiRagIndexJob | null> {
    await this.initialize();
    const current = this.jobs.get(jobId);
    if (current === undefined || current.ownerId !== ownerId || !ACTIVE_JOB_STATUSES.has(current.status)) return null;
    const counters = [progress.indexedFiles, progress.skippedFiles, progress.totalFiles];
    if (counters.some((value) => !validCounter(value))
      || progress.indexedFiles + progress.skippedFiles > progress.totalFiles) return null;
    // Poll responses can arrive out of order: never move an already published
    // counter backwards and never let the numerator exceed the persisted total.
    const indexedFiles = Math.max(current.indexedFiles ?? 0, progress.indexedFiles);
    const skippedFiles = Math.max(current.skippedFiles ?? 0, progress.skippedFiles);
    const totalFiles = Math.max(current.totalFiles ?? 0, progress.totalFiles, indexedFiles + skippedFiles);
    const cache = normalizeCacheProgress(progress, totalFiles);
    const mergedCache = cache === null ? {} : {
      cacheHitFiles: Math.max(current.cacheHitFiles ?? 0, cache.cacheHitFiles),
      cacheHitChunks: Math.max(current.cacheHitChunks ?? 0, cache.cacheHitChunks),
      cacheMissFiles: Math.max(current.cacheMissFiles ?? 0, cache.cacheMissFiles),
      cacheMissChunks: Math.max(current.cacheMissChunks ?? 0, cache.cacheMissChunks),
      newEmbeddedFiles: Math.max(current.newEmbeddedFiles ?? 0, cache.newEmbeddedFiles),
      newEmbeddedChunks: Math.max(current.newEmbeddedChunks ?? 0, cache.newEmbeddedChunks),
      cacheMissReasons: mergeReasonCounters(current.cacheMissReasons, cache.cacheMissReasons),
    };
    const next: ThaiRagIndexJob = {
      ...current,
      indexedFiles,
      skippedFiles,
      totalFiles,
      ...mergedCache,
      // Progress that actually advanced proves the owner is alive and talking
      // to the provider, so it resets the stuck-job clock.
      progressAt: this.now().toISOString(),
    };
    if (jobsEqualProgress(current, next)) return current;
    this.jobs.set(jobId, next);
    await this.persist();
    return next;
  }

  /**
   * Issue #445: a successful provider poll proves the owner process is alive
   * even when the counters have not moved. A semantic build spends most of its
   * wall-clock time in the embedding phase, which emits no file progress, so the
   * stuck-job reaper used to kill healthy builds. Refresh the stuck-job clock
   * without touching counters or cache metrics.
   */
  public async recordHeartbeat(jobId: string, ownerId: string): Promise<ThaiRagIndexJob | null> {
    await this.initialize();
    const current = this.jobs.get(jobId);
    if (current === undefined || current.ownerId !== ownerId || !ACTIVE_JOB_STATUSES.has(current.status)) return null;
    const now = this.now();
    const last = parseTimestamp(current.progressAt) ?? parseTimestamp(current.startedAt);
    // Keep the durable write rate bounded: the monitor polls far faster than
    // the reaper window, so only persist once the clock moved by a second.
    if (last !== null && now.getTime() - last < 1_000) return current;
    const next: ThaiRagIndexJob = { ...current, progressAt: now.toISOString() };
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

  public async interruptRunning(ownerId: string, reason = 'Provider stopped before the indexing job completed (owner-lost-stopped)'): Promise<void> {
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
    // Reap wedged-but-alive owners on every admission check so a stuck job
    // cannot block the workspace until the provider process restarts.
    if (await this.reapStuckJobs()) await this.persist();
    return [...this.jobs.values()].filter((job) => ACTIVE_JOB_STATUSES.has(job.status) && job.ownerId === ownerId);
  }

  /**
   * Read-only, owner-agnostic listing for an operator surface (#210 §11).
   *
   * This is deliberately not an ownership bypass: job execution and workspace
   * admission keep using `active(ownerId)` / `get(jobId, ownerId, workspaceId)`,
   * which refuse a foreign owner's live row. An operator reading the same data
   * root is describing the ledger, not acting as its owner, and a read must not
   * migrate, reap or persist anything.
   */
  public async listForOperator(options: ThaiRagIndexJobListingOptions = {}): Promise<ThaiRagIndexJobListing> {
    await this.load();
    const limit = normalizeOperatorJobLimit(options.limit);
    const rows = [...this.jobs.values()];
    const legacyRowCount = rows.filter((job) => job.status === 'legacy-unavailable').length;
    const matching = rows.filter((job) => job.status !== 'legacy-unavailable'
      && (options.workspaceId === undefined || job.workspaceId === options.workspaceId));
    const active = matching
      .filter((job) => ACTIVE_JOB_STATUSES.has(job.status))
      .sort(compareJobsByStartedDesc);
    const terminal = matching
      .filter((job) => !ACTIVE_JOB_STATUSES.has(job.status))
      .sort(compareJobsByFinishedDesc)
      .slice(0, limit);
    return {
      jobs: [...active, ...terminal],
      totalRowCount: rows.length,
      matchingRowCount: matching.length,
      legacyRowCount,
    };
  }

  private async reapStuckJobs(): Promise<boolean> {
    const now = this.now().getTime();
    let changed = false;
    for (const [id, job] of this.jobs) {
      if (!ACTIVE_JOB_STATUSES.has(job.status)) continue;
      const lastProgressAt = parseTimestamp(job.progressAt) ?? parseTimestamp(job.startedAt);
      if (lastProgressAt === null) continue;
      if (now - lastProgressAt <= this.stuckJobTimeoutMs) continue;
      this.jobs.set(id, {
        ...job,
        status: 'interrupted',
        finishedAt: this.now().toISOString(),
        error: `Indexing job produced no owner-verified progress within ${Math.round(this.stuckJobTimeoutMs / 1000)}s; the owning process is presumed stuck (owner-stuck-no-progress)`,
      });
      changed = true;
    }
    return changed;
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

  private pruneTerminalJobs(): void {
    const terminal = [...this.jobs.values()].filter((job) => !ACTIVE_JOB_STATUSES.has(job.status));
    if (terminal.length <= TERMINAL_JOB_RETENTION) return;
    // Newest completion first: the receipt an operator just received must
    // survive the write that recorded it, even when the job started hours ago.
    terminal.sort((left, right) => terminalOrder(right).localeCompare(terminalOrder(left)));
    for (const job of terminal.slice(TERMINAL_JOB_RETENTION)) this.jobs.delete(job.jobId);
  }

  private async persist(): Promise<void> {
    this.pruneTerminalJobs();
    const payload: JobFile = { schemaVersion: 3, jobs: [...this.jobs.values()] };
    const temporary = `${this.filePath}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.filePath);
  }
}

function terminalOrder(job: ThaiRagIndexJob): string {
  return job.finishedAt ?? job.startedAt;
}

function compareJobsByStartedDesc(left: ThaiRagIndexJob, right: ThaiRagIndexJob): number {
  const order = right.startedAt.localeCompare(left.startedAt);
  return order !== 0 ? order : right.jobId.localeCompare(left.jobId);
}

function compareJobsByFinishedDesc(left: ThaiRagIndexJob, right: ThaiRagIndexJob): number {
  const order = terminalOrder(right).localeCompare(terminalOrder(left));
  return order !== 0 ? order : right.jobId.localeCompare(left.jobId);
}

function normalizeOperatorJobLimit(value: number | undefined): number {
  if (value === undefined || !Number.isSafeInteger(value) || value <= 0) return DEFAULT_OPERATOR_INDEX_JOB_LIMIT;
  return Math.min(value, MAX_OPERATOR_INDEX_JOB_LIMIT);
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
      ...(validCounter(value.indexedFiles) ? { indexedFiles: value.indexedFiles } : {}),
      ...(validCounter(value.skippedFiles) ? { skippedFiles: value.skippedFiles } : {}),
      ...(validCounter(value.totalFiles) ? { totalFiles: value.totalFiles } : {}),
      ...(validCounter(value.cacheHitFiles) ? { cacheHitFiles: value.cacheHitFiles } : {}),
      ...(validCounter(value.cacheHitChunks) ? { cacheHitChunks: value.cacheHitChunks } : {}),
      ...(validCounter(value.cacheMissFiles) ? { cacheMissFiles: value.cacheMissFiles } : {}),
      ...(validCounter(value.cacheMissChunks) ? { cacheMissChunks: value.cacheMissChunks } : {}),
      ...(validCounter(value.newEmbeddedFiles) ? { newEmbeddedFiles: value.newEmbeddedFiles } : {}),
      ...(validCounter(value.newEmbeddedChunks) ? { newEmbeddedChunks: value.newEmbeddedChunks } : {}),
      ...(validReasonCounters(value.cacheMissReasons) === null ? {} : { cacheMissReasons: validReasonCounters(value.cacheMissReasons)! }),
      status,
      force: typeof value.force === 'boolean' ? value.force : false,
      ...(validReindexReason(value.reindexReason) ? { reindexReason: value.reindexReason } : {}),
      startedAt: typeof value.startedAt === 'string' ? value.startedAt : now().toISOString(),
      ...(typeof value.progressAt === 'string' && parseTimestamp(value.progressAt) !== null ? { progressAt: value.progressAt } : {}),
      ...(legacy ? { finishedAt: typeof value.finishedAt === 'string' ? value.finishedAt : now().toISOString(), error: 'Legacy index job is unavailable', legacyData: value } : {}),
      ...(typeof value.finishedAt === 'string' ? { finishedAt: value.finishedAt } : {}),
      ...(Object.hasOwn(value, 'result') ? { result: value.result } : {}),
      ...(typeof value.error === 'string' ? { error: value.error } : {}),
    },
  };
}

interface NormalizedCacheProgress {
  readonly cacheHitFiles: number;
  readonly cacheHitChunks: number;
  readonly cacheMissFiles: number;
  readonly cacheMissChunks: number;
  readonly newEmbeddedFiles: number;
  readonly newEmbeddedChunks: number;
  readonly cacheMissReasons: Readonly<Record<string, number>>;
}

function normalizeCacheProgress(progress: ThaiRagIndexJobProgress, totalFiles: number): NormalizedCacheProgress | null {
  const hasAny = progress.cacheHitFiles !== undefined
    || progress.cacheHitChunks !== undefined
    || progress.cacheMissFiles !== undefined
    || progress.cacheMissChunks !== undefined
    || progress.newEmbeddedFiles !== undefined
    || progress.newEmbeddedChunks !== undefined
    || progress.cacheMissReasons !== undefined;
  if (!hasAny) return null;

  const cacheHitFiles = progress.cacheHitFiles;
  const cacheHitChunks = progress.cacheHitChunks;
  const cacheMissFiles = progress.cacheMissFiles;
  const cacheMissChunks = progress.cacheMissChunks;
  const newEmbeddedFiles = progress.newEmbeddedFiles;
  const newEmbeddedChunks = progress.newEmbeddedChunks;
  if (!validCounter(cacheHitFiles)
    || !validCounter(cacheHitChunks)
    || !validCounter(cacheMissFiles)
    || !validCounter(cacheMissChunks)
    || !validCounter(newEmbeddedFiles)
    || !validCounter(newEmbeddedChunks)) return null;

  const cacheMissReasons = validReasonCounters(progress.cacheMissReasons);
  if (cacheMissReasons === null
    || cacheHitFiles + cacheMissFiles > totalFiles
    || newEmbeddedFiles > cacheMissFiles
    || newEmbeddedChunks > cacheMissChunks) return null;
  return {
    cacheHitFiles,
    cacheHitChunks,
    cacheMissFiles,
    cacheMissChunks,
    newEmbeddedFiles,
    newEmbeddedChunks,
    cacheMissReasons,
  };
}

function validReasonCounters(value: unknown): Readonly<Record<string, number>> | null {
  if (!isRecord(value)) return null;
  const normalized: Record<string, number> = {};
  for (const [reason, count] of Object.entries(value)) {
    if (reason.trim().length === 0 || !validCounter(count)) return null;
    normalized[reason] = count;
  }
  return normalized;
}

function mergeReasonCounters(
  current: Readonly<Record<string, number>> | undefined,
  incoming: Readonly<Record<string, number>>,
): Readonly<Record<string, number>> {
  const merged: Record<string, number> = { ...(current ?? {}) };
  for (const [reason, count] of Object.entries(incoming)) {
    merged[reason] = Math.max(merged[reason] ?? 0, count);
  }
  return merged;
}

function jobsEqualProgress(left: ThaiRagIndexJob, right: ThaiRagIndexJob): boolean {
  return left.indexedFiles === right.indexedFiles
    && left.skippedFiles === right.skippedFiles
    && left.totalFiles === right.totalFiles
    && left.cacheHitFiles === right.cacheHitFiles
    && left.cacheHitChunks === right.cacheHitChunks
    && left.cacheMissFiles === right.cacheMissFiles
    && left.cacheMissChunks === right.cacheMissChunks
    && left.newEmbeddedFiles === right.newEmbeddedFiles
    && left.newEmbeddedChunks === right.newEmbeddedChunks
    && JSON.stringify(left.cacheMissReasons ?? {}) === JSON.stringify(right.cacheMissReasons ?? {});
}

function validReindexReason(value: unknown): value is ThaiRagReindexReason {
  return typeof value === 'string' && REINDEX_REASONS.has(value as ThaiRagReindexReason);
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function validCounter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 100_000_000;
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
