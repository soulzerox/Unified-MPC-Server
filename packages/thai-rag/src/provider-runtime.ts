import { mkdir, open, readFile, unlink } from 'node:fs/promises';
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
}

export const THAI_RAG_OWNER_LOCK_CONFLICT_REASON = 'owner-lock';
export const THAI_RAG_UNVERIFIED_OWNER_LOCK_REASON = 'owner-lock-unverified';

export function isThaiRagOwnerLockConflict(error: AppError): boolean {
  return error.code === 'CONFLICT' && error.details?.reason === THAI_RAG_OWNER_LOCK_CONFLICT_REASON;
}

interface ProviderLockRecord {
  readonly ownerId: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly processIdentity?: string;
}

export class ThaiRagProviderRuntime {
  private readonly pid: number;
  private readonly now: () => Date;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly processIdentityProbe: PosixProcessIdentityProbe;
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
    return ok(this.healthState);
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
          const record: ProviderLockRecord = {
            ownerId: this.options.ownerId,
            pid: this.pid,
            startedAt: this.now().toISOString(),
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
    if (this.isProcessAlive(existing.pid)) {
      const observedIdentity = await this.readProcessIdentity(existing.pid);
      if (existing.processIdentity === undefined || observedIdentity === null) {
        return err(appError('CONFLICT', 'Thai-RAG provider owner lock exists but process identity cannot be verified', true, {
          reason: THAI_RAG_UNVERIFIED_OWNER_LOCK_REASON,
        }));
      }
      if (observedIdentity === existing.processIdentity) return first;
      // A live PID with a different start identity is a reused PID, not the lock owner.
    }
    try {
      await unlink(lockPath);
    } catch (error: unknown) {
      if (!isNodeError(error) || error.code !== 'ENOENT') return first;
    }
    return create();
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
        || (parsed.processIdentity !== undefined && (typeof parsed.processIdentity !== 'string' || parsed.processIdentity.length === 0))) return null;
      return {
        ownerId: parsed.ownerId,
        pid: parsed.pid,
        startedAt: parsed.startedAt,
        ...(parsed.processIdentity === undefined ? {} : { processIdentity: parsed.processIdentity }),
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
