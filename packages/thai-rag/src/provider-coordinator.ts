import { readFile, unlink } from 'node:fs/promises';
import { createConnection, createServer, type Server } from 'node:net';
import path from 'node:path';
import { appError, err, ok, type Result, type ResultBudget } from '@unified-mpc/domain';
import type { PosixProcessIdentityProbe } from '@unified-mpc/process';
import { resolveThaiRagProviderRoot } from './canonical-workspace.js';
import {
  isThaiRagOwnerLockConflict,
  THAI_RAG_FORWARD_HOST_UNREACHABLE_REASON,
  ThaiRagProviderRuntime,
  type ThaiRagProviderDriver,
} from './provider-runtime.js';
import type { ThaiRagProviderHealth } from './provider-contract.js';

export type { ThaiRagProviderDriver, ThaiRagProviderDriverHealth } from './provider-runtime.js';

export interface ThaiRagProviderCoordinatorOptions {
  readonly dataRoot: string;
  readonly ownerId: string;
  readonly providerVersion: string;
  readonly embeddingIndexGeneration: number;
  readonly driver: ThaiRagProviderDriver;
  readonly pid?: number;
  readonly now?: () => Date;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly processIdentityProbe?: PosixProcessIdentityProbe;
  readonly followerConnectTimeoutMs?: number;
  /**
   * How long a *steady-state* follower request may keep retrying while the owner
   * socket is being recreated. Startup uses `followerConnectTimeoutMs`; this budget
   * is separate because a completed owner restart (driver start -> listen) can take
   * longer than a startup handshake and must not stall an ordinary tool call forever.
   */
  readonly followerRequestRetryMs?: number;
  /**
   * How long *startup attach* keeps retrying a verified live owner that already
   * holds `provider.lock` but has not created `provider.sock` yet. The owner
   * acquires the lock before it boots the driver and only listens afterwards,
   * so that gap is expected to last as long as a driver start.
   *
   * This gap is the #418 `connect ENOENT` phantom: the lock proves a live owner
   * while `connect()` reports ENOENT. Only connect-level failures use this
   * budget; every other startup failure still fails on `followerConnectTimeoutMs`.
   * Designated-peer (`forwardOnly`) startup never uses it: an unreachable
   * forward host must fail fast (#407 req 3).
   */
  readonly ownerBootWaitMs?: number;
  /**
   * Designated-peer mode (#407 req 3): acquire ownership never, not even after
   * an unreachable owner. Startup connects to the owner socket directly and,
   * when it cannot, fails with the machine-readable `forward-host-unreachable`
   * reason while never touching `provider.lock`; `role` stays unset, so a
   * later start may retry (see the stdio start-retry cooldown). Without this
   * option the try-acquire-then-forward election stays the default.
   */
  readonly forwardOnly?: boolean;
}

export interface ThaiRagProviderCoordinatorStartResult {
  readonly role: 'owner' | 'follower';
  readonly health: ThaiRagProviderHealth;
}

type ProviderRequest =
  | { readonly id: string; readonly method: 'health' }
  | { readonly id: string; readonly method: 'call'; readonly tool: string; readonly args: Readonly<Record<string, unknown>>; readonly budget?: ResultBudget };

type ProviderResponse =
  | { readonly id: string; readonly ok: true; readonly value: unknown }
  | { readonly id: string; readonly ok: false; readonly error: string };

export class ThaiRagProviderCoordinator {
  private readonly runtime: ThaiRagProviderRuntime;
  private readonly socketPath: string;
  private readonly followerConnectTimeoutMs: number;
  private readonly followerRequestRetryMs: number;
  private readonly ownerBootWaitMs: number;
  private server: Server | undefined;
  private role: 'owner' | 'follower' | undefined;
  private nextRequestId = 0;
  /**
   * Fingerprint (`ownerId:startedAt`) of the owner generation whose boot window
   * has already been spent. A wedged owner must not stall every later call by
   * the full window, but a *new* owner legitimately boots again, so the latch is
   * keyed to the lock it was spent on rather than to this coordinator's lifetime.
   */
  private bootWaitSpentFor: string | undefined;

  public constructor(private readonly options: ThaiRagProviderCoordinatorOptions) {
    const providerRoot = resolveThaiRagProviderRoot(options.dataRoot);
    if (!providerRoot.ok) throw new Error(providerRoot.error.message);
    this.socketPath = path.join(providerRoot.value, 'provider.sock');
    this.followerConnectTimeoutMs = normalizeBudget(options.followerConnectTimeoutMs, 2_000);
    this.followerRequestRetryMs = normalizeBudget(options.followerRequestRetryMs, 5_000);
    this.ownerBootWaitMs = normalizeBudget(options.ownerBootWaitMs, 15_000);
    this.runtime = new ThaiRagProviderRuntime({
      dataRoot: options.dataRoot,
      ownerId: options.ownerId,
      providerVersion: options.providerVersion,
      embeddingIndexGeneration: options.embeddingIndexGeneration,
      driver: options.driver,
      ...(options.pid === undefined ? {} : { pid: options.pid }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.isProcessAlive === undefined ? {} : { isProcessAlive: options.isProcessAlive }),
      ...(options.processIdentityProbe === undefined ? {} : { processIdentityProbe: options.processIdentityProbe }),
    });
  }

  public async start(signal?: AbortSignal): Promise<Result<ThaiRagProviderCoordinatorStartResult>> {
    if (this.role !== undefined) {
      return err(appError('CONFLICT', `Thai-RAG provider coordinator is already ${this.role}`, true));
    }

    if (this.options.forwardOnly === true) {
      // Ownership is designated by configuration, never contested by lock:
      // connect straight to the designated owner or fail with a distinct
      // machine reason (#407 req 3).
      const remoteHealth = await this.waitForFollowerHealth(signal, true);
      if (!remoteHealth.ok) return remoteHealth;
      this.role = 'follower';
      return ok({ role: 'follower', health: remoteHealth.value });
    }

    const started = await this.runtime.start(signal);
    if (started.ok) {
      const serving = await this.startOwnerServer(signal);
      if (!serving.ok) {
        await this.runtime.stop(signal).catch(() => undefined);
        return serving;
      }
      this.role = 'owner';
      return ok({ role: 'owner', health: started.value });
    }

    if (!isThaiRagOwnerLockConflict(started.error)) return started;
    const remoteHealth = await this.waitForFollowerHealth(signal, false);
    if (!remoteHealth.ok) return remoteHealth;
    this.role = 'follower';
    return ok({ role: 'follower', health: remoteHealth.value });
  }

  public async health(signal?: AbortSignal): Promise<Result<ThaiRagProviderHealth>> {
    if (this.role === 'owner') return this.runtime.refresh(signal);
    if (this.role === 'follower') {
      const response = await this.requestFollower({
        id: this.requestId(),
        method: 'health',
      }, signal);
      if (!response.ok) return response;
      return isProviderHealth(response.value)
        ? ok(response.value)
        : err(appError('INTERNAL_ERROR', 'Thai-RAG provider owner returned malformed health', true));
    }
    return err(appError('CONFLICT', 'Thai-RAG provider coordinator is not started', true));
  }

  public async call(
    tool: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
    budget?: ResultBudget,
  ): Promise<Result<unknown>> {
    if (this.role === 'owner') return this.runtime.call(tool, args, signal, budget);
    if (this.role === 'follower') {
      return this.requestFollower({ id: this.requestId(), method: 'call', tool, args, ...(budget === undefined ? {} : { budget }) }, signal);
    }
    return err(appError('CONFLICT', 'Thai-RAG provider coordinator is not started', true));
  }

  public async close(signal?: AbortSignal): Promise<void> {
    if (this.role === 'owner') {
      const server = this.server;
      this.server = undefined;
      if (server !== undefined) {
        await new Promise<void>((resolve) => server.close(() => resolve())).catch(() => undefined);
      }
      await unlink(this.socketPath).catch(() => undefined);
      await this.runtime.stop(signal).catch(() => undefined);
    }
    this.role = undefined;
    this.bootWaitSpentFor = undefined;
  }

  private async startOwnerServer(signal?: AbortSignal): Promise<Result<void>> {
    if (signal?.aborted === true) return err(appError('PROCESS_TIMEOUT', 'Thai-RAG provider startup was cancelled', true));
    await unlink(this.socketPath).catch((error: unknown) => {
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
    });

    const server = createServer((socket) => {
      socket.setEncoding('utf8');
      const requestController = new AbortController();
      socket.once('close', () => requestController.abort());
      let buffer = '';
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        void this.handleOwnerRequest(line, requestController.signal).then((response) => {
          socket.end(`${JSON.stringify(response)}\n`);
        }).catch((error: unknown) => {
          socket.end(`${JSON.stringify({ id: 'unknown', ok: false, error: errorMessage(error) } satisfies ProviderResponse)}\n`);
        });
      });
    });

    const listening = await new Promise<Result<void>>((resolve) => {
      const onAbort = (): void => {
        server.close();
        resolve(err(appError('PROCESS_TIMEOUT', 'Thai-RAG provider startup was cancelled', true)));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      server.once('error', (error) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(err(appError('INTERNAL_ERROR', `Unable to listen on Thai-RAG provider socket: ${errorMessage(error)}`, true)));
      });
      server.listen(this.socketPath, () => {
        signal?.removeEventListener('abort', onAbort);
        resolve(ok(undefined));
      });
    });
    if (!listening.ok) {
      server.close();
      return listening;
    }
    this.server = server;
    return ok(undefined);
  }

  private async handleOwnerRequest(line: string, signal?: AbortSignal): Promise<ProviderResponse> {
    const parsed = parseRequest(line);
    if (!parsed.ok) return { id: 'unknown', ok: false, error: parsed.error.message };
    if (parsed.value.method === 'health') {
      const health = await this.runtime.refresh(signal);
      return health.ok
        ? { id: parsed.value.id, ok: true, value: health.value }
        : { id: parsed.value.id, ok: false, error: health.error.message };
    }
    const result = await this.runtime.call(parsed.value.tool, parsed.value.args, signal, parsed.value.budget);
    return result.ok
      ? { id: parsed.value.id, ok: true, value: result.value }
      : { id: parsed.value.id, ok: false, error: result.error.message };
  }

  private async waitForFollowerHealth(
    signal: AbortSignal | undefined,
    forwardOnly: boolean,
  ): Promise<Result<ThaiRagProviderHealth>> {
    const currentOwner = await this.ownerLockFingerprint();
    const bootArmed = !forwardOnly
      && (this.bootWaitSpentFor === undefined || (currentOwner !== undefined && currentOwner !== this.bootWaitSpentFor));
    const bootDeadline = bootArmed ? Date.now() + this.ownerBootWaitMs : undefined;
    const hardDeadline = Date.now() + this.followerConnectTimeoutMs;
    let lastError = 'Thai-RAG provider owner socket is unavailable';
    for (let attempt = 1; ; attempt += 1) {
      const outcome = await this.requestAttempt({ id: this.requestId(), method: 'health' }, signal);
      if (outcome.result.ok && isProviderHealth(outcome.result.value)) {
        this.bootWaitSpentFor = undefined;
        return ok(outcome.result.value);
      }
      if (!outcome.result.ok) lastError = outcome.result.error.message;
      if (signal?.aborted === true) {
        return err(appError('PROCESS_TIMEOUT', 'Thai-RAG provider follower startup was cancelled', true));
      }
      // `provider-runtime` takes the owner lock before it boots the driver and
      // the socket is only created once the driver is up, so a verified live
      // owner legitimately answers `connect ENOENT` for the whole driver start
      // (#418). Connect-level failures therefore use the owner-boot budget;
      // anything else keeps the short startup budget so real faults surface fast.
      const onBootBudget = outcome.retryableFailure && bootDeadline !== undefined;
      const deadline = onBootBudget ? bootDeadline : hardDeadline;
      if (Date.now() >= deadline) {
        // Spend the boot window once per owner generation: a lock whose owner
        // never listens must not stall every later call by the same amount.
        if (onBootBudget) this.bootWaitSpentFor = currentOwner ?? '';
        break;
      }
      await delay(Math.min(followerRetryDelayMs(attempt), Math.max(0, deadline - Date.now())), signal);
    }
    if (forwardOnly) {
      return err(appError('CONFLICT', `Thai-RAG provider forward host is unreachable: ${lastError}`, true, {
        reason: THAI_RAG_FORWARD_HOST_UNREACHABLE_REASON,
      }));
    }
    return err(appError('CONFLICT', `Thai-RAG provider owner is locked but not reachable: ${lastError}`, true));
  }

  /**
   * A follower holds no provider state, so a recreated owner socket (owner restart)
   * is recoverable. Only failures that happened before `connect` are retried: provider
   * calls mutate state, so an already-delivered request is never replayed (#418).
   */
  private async requestFollower(request: ProviderRequest, signal?: AbortSignal): Promise<Result<unknown>> {
    const deadline = Date.now() + this.followerRequestRetryMs;
    let attempts = 0;
    for (;;) {
      attempts += 1;
      const attempt = await this.requestAttempt(request, signal);
      if (attempt.result.ok || !attempt.retryableFailure) return attempt.result;
      if (signal?.aborted === true || Date.now() >= deadline) {
        const failure = attempt.result.ok ? undefined : attempt.result.error;
        if (failure === undefined || attempts < 2) return attempt.result;
        return err(appError(failure.code, failure.message, failure.recoverable, {
          ...(failure.details ?? {}),
          reason: 'follower-reconnect-exhausted',
          attempts,
        }));
      }
      await delay(Math.min(followerRetryDelayMs(attempts), Math.max(0, deadline - Date.now())), signal);
    }
  }

  private requestAttempt(
    request: ProviderRequest,
    signal?: AbortSignal,
  ): Promise<{ result: Result<unknown>; retryableFailure: boolean }> {
    return new Promise((resolve) => {
      if (signal?.aborted === true) {
        resolve({ result: err(appError('PROCESS_TIMEOUT', 'Thai-RAG provider request was cancelled', true)), retryableFailure: false });
        return;
      }
      const socket = createConnection(this.socketPath);
      socket.setEncoding('utf8');
      let buffer = '';
      let settled = false;
      let delivered = false;
      const finish = (result: Result<unknown>, retryableFailure = false): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        socket.destroy();
        resolve({ result, retryableFailure: retryableFailure });
      };
      const onAbort = (): void => finish(err(appError('PROCESS_TIMEOUT', 'Thai-RAG provider request was cancelled', true)));
      signal?.addEventListener('abort', onAbort, { once: true });
      socket.once('error', (error) => {
        finish(
          err(appError('CONFLICT', `Thai-RAG provider owner socket error: ${errorMessage(error)}`, true)),
          !delivered && isRetryableConnectCode(isNodeError(error) ? error.code : undefined),
        );
      });
      socket.once('close', () => {
        finish(err(appError('CONFLICT', 'Thai-RAG provider owner closed the connection before responding', true)));
      });
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        const response = parseResponse(buffer.slice(0, newline));
        if (!response.ok) {
          finish(response);
          return;
        }
        if (response.value.id !== request.id) {
          finish(err(appError('INTERNAL_ERROR', 'Thai-RAG provider response correlation mismatch', true)));
          return;
        }
        finish(response.value.ok
          ? ok(response.value.value)
          : err(appError('CONFLICT', response.value.error, true)));
      });
      socket.once('connect', () => {
        delivered = true;
        socket.write(`${JSON.stringify(request)}\n`);
      });
    });
  }

  /**
   * Identify the current owner generation from the lock the runtime wrote. Used
   * only to decide whether an already-spent boot window still applies.
   */
  private async ownerLockFingerprint(): Promise<string | undefined> {
    try {
      const parsed: unknown = JSON.parse(
        await readFile(path.join(path.dirname(this.socketPath), 'provider.lock'), 'utf8'),
      );
      if (!isRecord(parsed)) return undefined;
      const { ownerId, startedAt } = parsed;
      return typeof ownerId === 'string' && typeof startedAt === 'string' ? `${ownerId}:${startedAt}` : undefined;
    } catch {
      return undefined;
    }
  }

  private requestId(): string {
    this.nextRequestId += 1;
    return `${this.options.ownerId}:${process.pid}:${this.nextRequestId}`;
  }
}

function parseRequest(line: string): Result<ProviderRequest> {
  try {
    const value: unknown = JSON.parse(line);
    if (!isRecord(value) || typeof value.id !== 'string' || typeof value.method !== 'string') {
      return err(appError('INVALID_INPUT', 'Malformed Thai-RAG provider request'));
    }
    if (value.method === 'health') return ok({ id: value.id, method: 'health' });
    if (value.method === 'call' && typeof value.tool === 'string' && isRecord(value.args)) {
    return ok({ id: value.id, method: 'call', tool: value.tool, args: value.args, ...(isResultBudget(value.budget) ? { budget: value.budget } : {}) });
    }
    return err(appError('INVALID_INPUT', 'Unsupported Thai-RAG provider request'));
  } catch {
    return err(appError('INVALID_INPUT', 'Invalid Thai-RAG provider request JSON'));
  }
}

function isResultBudget(value: unknown): value is ResultBudget {
  return isRecord(value)
    && ['maxItems', 'maxTextBytes', 'maxStructuredBytes', 'maxBinaryBytes', 'maxBase64Bytes'].every((key) => typeof value[key] === 'number' && Number.isSafeInteger(value[key]) && value[key] > 0);
}

function parseResponse(line: string): Result<ProviderResponse> {
  try {
    const value: unknown = JSON.parse(line);
    if (!isRecord(value) || typeof value.id !== 'string' || typeof value.ok !== 'boolean') {
      return err(appError('INTERNAL_ERROR', 'Malformed Thai-RAG provider response', true));
    }
    if (value.ok) return ok({ id: value.id, ok: true, value: value.value });
    if (typeof value.error === 'string') return ok({ id: value.id, ok: false, error: value.error });
    return err(appError('INTERNAL_ERROR', 'Malformed Thai-RAG provider error response', true));
  } catch {
    return err(appError('INTERNAL_ERROR', 'Invalid Thai-RAG provider response JSON', true));
  }
}

function isProviderHealth(value: unknown): value is ThaiRagProviderHealth {
  return isRecord(value)
    && value.providerId === 'thai-rag'
    && typeof value.providerVersion === 'string'
    && typeof value.state === 'string'
    && typeof value.embeddingIndexGeneration === 'number';
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
      signal?.removeEventListener('abort', onAbort);
    };
    // This delay is part of awaited startup/recovery work and must keep the parent alive.
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Capped exponential backoff with jitter. A booting owner is retried by every
 * waiting follower at once, so a fixed 20 ms poll turns one owner start into a
 * reconnect stampede; jitter keeps those attempts from lining up.
 */
function followerRetryDelayMs(attempt: number): number {
  const base = Math.min(250, 20 * 2 ** Math.min(attempt - 1, 4));
  return base + Math.floor(Math.random() * (base / 2));
}

function normalizeBudget(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, value);
}

function isRetryableConnectCode(code: string | undefined): boolean {
  return code === 'ENOENT' || code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EAGAIN';
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error;
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
