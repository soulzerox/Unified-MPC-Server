import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { appError, err, ok, type AppError, type Result, type ResultBudget } from '@unified-mpc/domain';
import { createPosixProcessIdentityProbe, type PosixProcessIdentityProbe } from '@unified-mpc/process';
import { resolveThaiRagProviderRoot } from './canonical-workspace.js';
import {
  createProviderHealth,
  type ThaiRagProviderComponents,
  type ThaiRagProviderHealth,
} from './provider-contract.js';

export type ThaiRagProviderDriverHealth = ThaiRagProviderComponents & Pick<ThaiRagProviderHealth, 'capabilities' | 'workspaceScopeModel' | 'embedding' | 'compatibilityRange' | 'contractFingerprint' | 'contractVersion' | 'generation'> & { readonly degradation?: readonly string[]; readonly indexJobContractVersion?: string };

export interface ThaiRagProviderDriverStartOptions {
  readonly providerRoot: string;
  readonly ownerId: string;
  readonly providerVersion: string;
  readonly embeddingIndexGeneration: number;
}

export interface ThaiRagProviderDriver {
  start(options: ThaiRagProviderDriverStartOptions, signal?: AbortSignal): Promise<Result<ThaiRagProviderDriverHealth>>;
  health(signal?: AbortSignal): Promise<Result<ThaiRagProviderDriverHealth>>;
  call(tool: string, args: Readonly<Record<string, unknown>>, signal?: AbortSignal, budget?: ResultBudget): Promise<Result<unknown>>;
  stop(signal?: AbortSignal): Promise<Result<void>>;
}

export interface ThaiRagProviderRuntimeOptions {
  readonly dataRoot: string;
  readonly ownerId: string;
  readonly providerVersion: string;
  readonly embeddingIndexGeneration: number;
  readonly driver: ThaiRagProviderDriver;
  readonly pid?: number;
  readonly now?: () => Date;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly processIdentityProbe?: PosixProcessIdentityProbe;
  readonly platform?: NodeJS.Platform;
  /** How long an owner may go without a heartbeat before its lock is considered abandoned. */
  readonly ownerLockTtlMs?: number;
  /** Heartbeat rewrite interval while this runtime owns the lock. */
  readonly heartbeatIntervalMs?: number;
}

export const THAI_RAG_OWNER_LOCK_CONFLICT_REASON = 'owner-lock';
export const THAI_RAG_UNVERIFIED_OWNER_LOCK_REASON = 'owner-lock-unverified';
/** A live, version-compatible owner that stopped heartbeating: actionable, never auto-stolen. */
export const THAI_RAG_UNRESPONSIVE_OWNER_LOCK_REASON = 'owner-lock-unresponsive';

const DEFAULT_OWNER_LOCK_TTL_MS = 30_000;

export function isThaiRagOwnerLockConflict(error: AppError): boolean {
  return error.code === 'CONFLICT' && error.details?.reason === THAI_RAG_OWNER_LOCK_CONFLICT_REASON;
}

interface ProviderLockRecord {
  readonly ownerId: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly processIdentity?: string;
  /** Written by 4.61.0+ owners; absent on older-release locks. */
  readonly heartbeatAt?: string;
  readonly providerVersion?: string;
}

export class ThaiRagProviderRuntime {
  private readonly pid: number;
  private readonly now: () => Date;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly processIdentityProbe: PosixProcessIdentityProbe;
  private readonly ownerLockTtlMs: number;
  private readonly heartbeatIntervalMs: number;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private healthState: ThaiRagProviderHealth;
  private providerRoot: string | undefined;
  private ownsLock = false;
  private ownedProcessIdentity: string | undefined;
  private callQueue: Promise<unknown> = Promise.resolve();

  public constructor(private readonly options: ThaiRagProviderRuntimeOptions) {
    this.pid = options.pid ?? process.pid;
    this.now = options.now ?? ((): Date => new Date());
    this.isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
    this.processIdentityProbe = options.processIdentityProbe ?? defaultProcessIdentityProbe(options.platform ?? process.platform);
    this.ownerLockTtlMs = options.ownerLockTtlMs ?? DEFAULT_OWNER_LOCK_TTL_MS;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? Math.max(1_000, Math.floor(this.ownerLockTtlMs / 3));
    this.healthState = createProviderHealth(options.providerVersion, options.embeddingIndexGeneration);
  }

  public health(): ThaiRagProviderHealth {
    return this.healthState;
  }

  public async start(signal?: AbortSignal): Promise<Result<ThaiRagProviderHealth>> {
    if (this.healthState.state !== 'stopped') {
      return err(appError('CONFLICT', `Thai-RAG provider is already ${this.healthState.state}`, true));
    }
    const resolvedRoot = resolveThaiRagProviderRoot(this.options.dataRoot);
    if (!resolvedRoot.ok) return resolvedRoot;
    this.providerRoot = resolvedRoot.value;
    await mkdir(this.providerRoot, { recursive: true });

    const locked = await this.acquireOwnerLock();
    if (!locked.ok) return locked;

    const startedAt = this.now().toISOString();
    this.healthState = {
      ...this.healthState,
      state: 'starting',
      ownerId: this.options.ownerId,
      startedAt,
    };
    const started = await this.options.driver.start({
      providerRoot: this.providerRoot,
      ownerId: this.options.ownerId,
      providerVersion: this.options.providerVersion,
      embeddingIndexGeneration: this.options.embeddingIndexGeneration,
    }, signal);
    if (!started.ok) {
      this.healthState = createProviderHealth(this.options.providerVersion, this.options.embeddingIndexGeneration);
      await this.releaseOwnerLock();
      return started;
    }

    this.healthState = healthFromComponents(this.healthState, started.value, this.now().toISOString());
    this.startHeartbeat();
    return ok(this.healthState);
  }

  /**
   * Rewrite the owner lock with a fresh heartbeat while this runtime owns it.
   *
   * A running owner must keep proving liveness: the lock TTL is what allows
   * another runtime to distinguish "owner is alive" from "owner died or is
   * wedged", which pid liveness alone cannot do for a stopped process (and
   * never could for an older release that is still running but unreachable).
   */
  public async renewOwnerLock(): Promise<boolean> {
    if (!this.ownsLock || this.providerRoot === undefined) return false;
    const existing = await this.readLock();
    if (existing === null
      || existing.ownerId !== this.options.ownerId
      || existing.pid !== this.pid
      || existing.processIdentity !== this.ownedProcessIdentity) return false;
    await this.writeLock({ ...existing, heartbeatAt: this.now().toISOString() });
    return true;
  }

  public async refresh(signal?: AbortSignal): Promise<Result<ThaiRagProviderHealth>> {
    if (this.healthState.state === 'stopped') return ok(this.healthState);
    const current = await this.options.driver.health(signal);
    if (!current.ok) return current;
    this.healthState = healthFromComponents(this.healthState, current.value, this.healthState.readyAt ?? this.now().toISOString());
    return ok(this.healthState);
  }

  public async call(
    tool: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
    budget?: ResultBudget,
  ): Promise<Result<unknown>> {
    if (this.healthState.state !== 'ready' && this.healthState.state !== 'degraded') {
      return err(appError('CONFLICT', `Thai-RAG provider is not callable while ${this.healthState.state}`, true));
    }
    const operation = (): Promise<Result<unknown>> => this.options.driver.call(tool, args, signal, budget);
    const pending = this.callQueue.then(operation, operation);
    this.callQueue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  public async stop(signal?: AbortSignal): Promise<Result<ThaiRagProviderHealth>> {
    if (this.healthState.state === 'stopped') return ok(this.healthState);
    this.healthState = { ...this.healthState, state: 'stopping' };
    const stopped = await this.options.driver.stop(signal);
    if (!stopped.ok) {
      this.healthState = { ...this.healthState, state: 'degraded', degradation: ['shutdown-failed'] };
      return stopped;
    }
    this.stopHeartbeat();
    await this.releaseOwnerLock();
    this.healthState = createProviderHealth(this.options.providerVersion, this.options.embeddingIndexGeneration);
    return ok(this.healthState);
  }

  private async acquireOwnerLock(): Promise<Result<void>> {
    const lockPath = this.lockPath();
    const create = async (): Promise<Result<void>> => {
      try {
        const processIdentity = await this.readProcessIdentity(this.pid);
        const handle = await open(lockPath, 'wx', 0o600);
        try {
          const stamp = this.now().toISOString();
          const record: ProviderLockRecord = {
            ownerId: this.options.ownerId,
            pid: this.pid,
            startedAt: stamp,
            heartbeatAt: stamp,
            providerVersion: this.options.providerVersion,
            ...(processIdentity === null ? {} : { processIdentity }),
          };
          await handle.writeFile(JSON.stringify(record));
        } finally {
          await handle.close();
        }
        this.ownsLock = true;
        this.ownedProcessIdentity = processIdentity ?? undefined;
        return ok(undefined);
      } catch (error: unknown) {
        if (isNodeError(error) && error.code === 'EEXIST') {
          return err(appError('CONFLICT', 'Thai-RAG provider already has an active owner', true, {
            reason: THAI_RAG_OWNER_LOCK_CONFLICT_REASON,
          }));
        }
        return err(appError('INTERNAL_ERROR', 'Unable to acquire Thai-RAG provider owner lock', true));
      }
    };

    const first = await create();
    if (first.ok) return first;
    const existing = await this.readLock();
    if (existing === null) {
      return err(appError('CONFLICT', 'Thai-RAG provider owner lock exists but cannot be validated', true, {
        reason: THAI_RAG_UNVERIFIED_OWNER_LOCK_REASON,
      }));
    }
    const verdict = await this.classifyExistingLock(existing);
    if (verdict === 'live') return first;
    if (verdict === 'unverified') {
      return err(appError('CONFLICT', 'Thai-RAG provider owner lock exists but process identity cannot be verified', true, {
        reason: THAI_RAG_UNVERIFIED_OWNER_LOCK_REASON,
      }));
    }
    if (verdict === 'unresponsive') {
      return err(appError(
        'CONFLICT',
        `Thai-RAG provider owner lock is held by an unresponsive owner: pid ${existing.pid} owned by ${existing.ownerId} `
        + `since ${existing.startedAt}; stop that process or remove ${lockPath} to reclaim it`,
        true,
        { reason: THAI_RAG_UNRESPONSIVE_OWNER_LOCK_REASON },
      ));
    }
    try {
      await unlink(lockPath);
    } catch (error: unknown) {
      if (!isNodeError(error) || error.code !== 'ENOENT') return first;
    }
    return create();
  }

  /**
   * Decide whether an existing lock may be reclaimed (#210 U32).
   *
   * `reclaim` is granted only with evidence the owner is gone: the PID is dead,
   * the PID was reused by another process, or a heartbeat-aware owner stopped
   * heartbeating *and* was written by an incompatible provider version (an
   * older release cannot be a valid owner for this build). A live owner is
   * never stolen just because it is silent: a heartbeat-less (pre-4.61.0)
   * owner is respected as live because it can be proven neither dead nor
   * compatible, and a same-version silent owner is reported as `unresponsive`
   * with the pid/lock path so an operator can reclaim it deliberately.
   */
  private async classifyExistingLock(
    existing: ProviderLockRecord,
  ): Promise<'reclaim' | 'live' | 'unresponsive' | 'unverified'> {
    if (!this.isProcessAlive(existing.pid)) return 'reclaim';
    const observed = await this.readProcessIdentity(existing.pid);
    if (existing.processIdentity === undefined || observed === null) {
      // The owner's liveness cannot be verified at all here; never act on it.
      return 'unverified';
    }
    if (observed !== existing.processIdentity) return 'reclaim';
    if (existing.heartbeatAt === undefined) {
      // Verified-live pre-heartbeat owner: it can never prove liveness, but it
      // also cannot be proven dead, so it keeps its lock.
      return 'live';
    }
    if (this.now().getTime() - Date.parse(existing.heartbeatAt) <= this.ownerLockTtlMs) return 'live';
    if (existing.providerVersion !== this.options.providerVersion) return 'reclaim';
    return 'unresponsive';
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) return;
    this.heartbeatTimer = setInterval(() => {
      void this.renewOwnerLock().catch(() => undefined);
    }, this.heartbeatIntervalMs);
    // A heartbeat must never hold the process open on shutdown.
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer === undefined) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private async writeLock(record: ProviderLockRecord): Promise<void> {
    const finalPath = this.lockPath();
    const tmpPath = `${finalPath}.tmp-${this.pid}`;
    await writeFile(tmpPath, JSON.stringify(record), { mode: 0o600 });
    await rename(tmpPath, finalPath);
  }

  private async releaseOwnerLock(): Promise<void> {
    if (!this.ownsLock) return;
    const existing = await this.readLock();
    if (existing?.ownerId === this.options.ownerId
      && existing.pid === this.pid
      && existing.processIdentity === this.ownedProcessIdentity) {
      await unlink(this.lockPath()).catch(() => undefined);
    }
    this.ownsLock = false;
    this.ownedProcessIdentity = undefined;
  }

  private async readLock(): Promise<ProviderLockRecord | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.lockPath(), 'utf8'));
      if (!isRecord(parsed)
        || typeof parsed.ownerId !== 'string'
        || typeof parsed.pid !== 'number'
        || !Number.isInteger(parsed.pid)
        || parsed.pid <= 0
        || typeof parsed.startedAt !== 'string'
        || (parsed.processIdentity !== undefined && (typeof parsed.processIdentity !== 'string' || parsed.processIdentity.length === 0))
        || (parsed.heartbeatAt !== undefined && typeof parsed.heartbeatAt !== 'string')
        || (parsed.providerVersion !== undefined && typeof parsed.providerVersion !== 'string')) return null;
      return {
        ownerId: parsed.ownerId,
        pid: parsed.pid,
        startedAt: parsed.startedAt,
        ...(parsed.processIdentity === undefined ? {} : { processIdentity: parsed.processIdentity }),
        ...(parsed.heartbeatAt === undefined ? {} : { heartbeatAt: parsed.heartbeatAt }),
        ...(parsed.providerVersion === undefined ? {} : { providerVersion: parsed.providerVersion }),
      };
    } catch {
      return null;
    }
  }

  private async readProcessIdentity(pid: number): Promise<string | null> {
    try {
      return await this.processIdentityProbe(pid);
    } catch {
      return null;
    }
  }

  private lockPath(): string {
    if (this.providerRoot === undefined) throw new Error('Thai-RAG provider root is not resolved');
    return path.join(this.providerRoot, 'provider.lock');
  }
}

function healthFromComponents(
  base: ThaiRagProviderHealth,
  components: ThaiRagProviderDriverHealth,
  readyAt: string,
): ThaiRagProviderHealth {
  const degradation = [...new Set([...(components.degradation ?? []), ...degradationReasons(components)])];
  return {
    schemaVersion: base.schemaVersion,
    providerId: base.providerId,
    providerVersion: base.providerVersion,
    indexJobContractVersion: components.indexJobContractVersion ?? base.indexJobContractVersion,
    ...(components.contractVersion === undefined ? {} : { contractVersion: components.contractVersion }),
    ...(components.capabilities === undefined ? {} : { capabilities: components.capabilities }),
    ...(components.workspaceScopeModel === undefined ? {} : { workspaceScopeModel: components.workspaceScopeModel }),
    ...(components.embedding === undefined ? {} : { embedding: components.embedding }),
    ...(components.compatibilityRange === undefined ? {} : { compatibilityRange: components.compatibilityRange }),
    ...(components.contractFingerprint === undefined ? {} : { contractFingerprint: components.contractFingerprint }),
    ...(components.generation === undefined ? {} : { generation: components.generation }),
    embeddingIndexGeneration: base.embeddingIndexGeneration,
    ...(base.startedAt === undefined ? {} : { startedAt: base.startedAt }),
    ...(base.ownerId === undefined ? {} : { ownerId: base.ownerId }),
    state: degradation.length === 0 ? 'ready' : 'degraded',
    readyAt,
    components,
    ...(degradation.length === 0 ? {} : { degradation }),
  };
}

function degradationReasons(components: ThaiRagProviderComponents): string[] {
  const reasons: string[] = [];
  if (!components.workerReachable) reasons.push('worker-offline');
  if (!components.sqliteAvailable) reasons.push('sqlite-offline');
  if (!components.ftsAvailable) reasons.push('fts-offline');
  if (!components.vectorStoreAvailable) reasons.push('vector-store-offline');
  if (!components.embedderAvailable) reasons.push('embedder-offline');
  if (!components.lexicalRetrievalAvailable) reasons.push('lexical-retrieval-unavailable');
  if (!components.semanticRetrievalAvailable) reasons.push('semantic-retrieval-unavailable');
  return reasons;
}

function defaultProcessIdentityProbe(platform: NodeJS.Platform): PosixProcessIdentityProbe {
  if (platform === 'darwin' || platform === 'linux') return createPosixProcessIdentityProbe(platform);
  // No trustworthy process-start probe exists for other supported runtimes yet.
  // Returning an unverifiable identity keeps live owner locks fail-closed instead of crashing at construction time.
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
