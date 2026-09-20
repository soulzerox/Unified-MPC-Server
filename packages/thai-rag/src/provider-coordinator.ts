import { unlink } from 'node:fs/promises';
import { createConnection, createServer, type Server } from 'node:net';
import path from 'node:path';
import { appError, err, ok, type Result, type ResultBudget } from '@unified-mpc/domain';
import type { PosixProcessIdentityProbe } from '@unified-mpc/process';
import { resolveThaiRagProviderRoot } from './canonical-workspace.js';
import {
  isThaiRagOwnerLockConflict,
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
  private server: Server | undefined;
  private role: 'owner' | 'follower' | undefined;
  private nextRequestId = 0;

  public constructor(private readonly options: ThaiRagProviderCoordinatorOptions) {
    const providerRoot = resolveThaiRagProviderRoot(options.dataRoot);
    if (!providerRoot.ok) throw new Error(providerRoot.error.message);
    this.socketPath = path.join(providerRoot.value, 'provider.sock');
    this.followerConnectTimeoutMs = options.followerConnectTimeoutMs ?? 2_000;
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
    const remoteHealth = await this.waitForFollowerHealth(signal);
    if (!remoteHealth.ok) return remoteHealth;
    this.role = 'follower';
    return ok({ role: 'follower', health: remoteHealth.value });
  }

  public async health(signal?: AbortSignal): Promise<Result<ThaiRagProviderHealth>> {
    if (this.role === 'owner') return ok(this.runtime.health());
    if (this.role === 'follower') {
      const response = await this.request({
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
      return this.request({ id: this.requestId(), method: 'call', tool, args, ...(budget === undefined ? {} : { budget }) }, signal);
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
      return { id: parsed.value.id, ok: true, value: this.runtime.health() };
    }
    const result = await this.runtime.call(parsed.value.tool, parsed.value.args, signal, parsed.value.budget);
    return result.ok
      ? { id: parsed.value.id, ok: true, value: result.value }
      : { id: parsed.value.id, ok: false, error: result.error.message };
  }

  private async waitForFollowerHealth(signal?: AbortSignal): Promise<Result<ThaiRagProviderHealth>> {
    const deadline = Date.now() + this.followerConnectTimeoutMs;
    let lastError = 'Thai-RAG provider owner socket is unavailable';
    do {
      const response = await this.request({ id: this.requestId(), method: 'health' }, signal);
      if (response.ok && isProviderHealth(response.value)) return ok(response.value);
      if (!response.ok) lastError = response.error.message;
      if (signal?.aborted === true) {
        return err(appError('PROCESS_TIMEOUT', 'Thai-RAG provider follower startup was cancelled', true));
      }
      await delay(20, signal);
    } while (Date.now() < deadline);
    return err(appError('CONFLICT', `Thai-RAG provider owner is locked but not reachable: ${lastError}`, true));
  }

  private request(request: ProviderRequest, signal?: AbortSignal): Promise<Result<unknown>> {
    return new Promise((resolve) => {
      if (signal?.aborted === true) {
        resolve(err(appError('PROCESS_TIMEOUT', 'Thai-RAG provider request was cancelled', true)));
        return;
      }
      const socket = createConnection(this.socketPath);
      socket.setEncoding('utf8');
      let buffer = '';
      let settled = false;
      const finish = (result: Result<unknown>): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        socket.destroy();
        resolve(result);
      };
      const onAbort = (): void => finish(err(appError('PROCESS_TIMEOUT', 'Thai-RAG provider request was cancelled', true)));
      signal?.addEventListener('abort', onAbort, { once: true });
      socket.once('error', (error) => finish(err(appError('CONFLICT', `Thai-RAG provider owner socket error: ${errorMessage(error)}`, true))));
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
      socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    });
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
    const timer = setTimeout(resolve, ms);
    // This delay is part of awaited startup/recovery work and must keep the parent alive.
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
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
