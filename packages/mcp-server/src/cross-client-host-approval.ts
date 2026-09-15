import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import type { HostMutationApprovalRequest } from './tool-registry.js';

export type CrossClientHostMutationApprovalProvider = (request: HostMutationApprovalRequest) => Promise<boolean>;

export interface CrossClientHostApprovalBrokerOptions {
  readonly directory: string;
  readonly timeoutMs?: number;
  readonly pollMs?: number;
  readonly workerFreshMs?: number;
  readonly now?: () => number;
}

export interface CrossClientHostApprovalWorkerOptions extends CrossClientHostApprovalBrokerOptions {
  readonly provider: CrossClientHostMutationApprovalProvider;
  readonly workerId?: string;
  readonly heartbeatMs?: number;
}

export interface CrossClientHostApprovalWorker {
  readonly workerId: string;
  close(): Promise<void>;
}

interface BrokerRequest {
  readonly version: 1;
  readonly id: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly request: HostMutationApprovalRequest;
  readonly preferredWorkerId?: string;
}

interface BrokerResponse {
  readonly version: 1;
  readonly id: string;
  readonly approved: boolean;
  readonly workerId: string;
  readonly completedAt: number;
}

interface BrokerHeartbeat {
  readonly version: 1;
  readonly workerId: string;
  readonly updatedAt: number;
}

interface BrokerRoute {
  readonly version: 1;
  readonly scopeId: string;
  readonly workerId: string;
  readonly updatedAt: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_MS = 100;
const DEFAULT_HEARTBEAT_MS = 1_000;
const DEFAULT_WORKER_FRESH_MS = 5_000;

export function createCrossClientHostMutationApprovalProvider(
  options: CrossClientHostApprovalBrokerOptions,
): CrossClientHostMutationApprovalProvider {
  const resolved = resolveOptions(options);
  return async (request): Promise<boolean> => {
    try {
      await ensureBrokerDirectories(resolved.directory);
      const id = randomUUID();
      const createdAt = resolved.now();
      const route = request.approvalScope === undefined
        ? undefined
        : await readLiveRoute(resolved.directory, request.approvalScope.id, resolved.now(), resolved.workerFreshMs);
      const payload: BrokerRequest = {
        version: 1,
        id,
        createdAt,
        expiresAt: createdAt + resolved.timeoutMs,
        request,
        ...(route === undefined ? {} : { preferredWorkerId: route.workerId }),
      };
      const pendingPath = path.join(resolved.directory, 'pending', `${id}.json`);
      const responsePath = path.join(resolved.directory, 'responses', `${id}.json`);
      await writeJsonAtomic(pendingPath, payload);
      try {
        while (resolved.now() < payload.expiresAt) {
          const response = await readJson<BrokerResponse>(responsePath);
          if (response !== null && response.version === 1 && response.id === id && typeof response.approved === 'boolean') {
            return response.approved;
          }
          await delay(resolved.pollMs);
        }
        return false;
      } finally {
        await Promise.all([
          rm(pendingPath, { force: true }).catch(() => undefined),
          rm(responsePath, { force: true }).catch(() => undefined),
        ]);
      }
    } catch {
      return false;
    }
  };
}

export function startCrossClientHostApprovalWorker(
  options: CrossClientHostApprovalWorkerOptions,
): CrossClientHostApprovalWorker {
  const resolved = resolveOptions(options);
  const workerId = options.workerId ?? randomUUID();
  const heartbeatMs = positiveInteger(options.heartbeatMs, DEFAULT_HEARTBEAT_MS);
  let closed = false;
  let scanning = false;

  const heartbeat = async (): Promise<void> => {
    if (closed) return;
    await ensureBrokerDirectories(resolved.directory);
    const heartbeatPath = path.join(resolved.directory, 'workers', `${workerId}.json`);
    await writeJsonAtomic(heartbeatPath, { version: 1, workerId, updatedAt: resolved.now() } satisfies BrokerHeartbeat);
  };

  const scan = async (): Promise<void> => {
    if (closed || scanning) return;
    scanning = true;
    try {
      await heartbeat();
      const pendingDir = path.join(resolved.directory, 'pending');
      const entries = await readdir(pendingDir).catch(() => [] as string[]);
      for (const entry of entries) {
        if (closed || !entry.endsWith('.json')) break;
        const pendingPath = path.join(pendingDir, entry);
        const payload = await readJson<BrokerRequest>(pendingPath);
        if (!isBrokerRequest(payload)) {
          await rm(pendingPath, { force: true }).catch(() => undefined);
          continue;
        }
        if (resolved.now() >= payload.expiresAt) {
          await rm(pendingPath, { force: true }).catch(() => undefined);
          continue;
        }
        if (payload.preferredWorkerId !== undefined && payload.preferredWorkerId !== workerId) {
          const preferredLive = await isWorkerLive(resolved.directory, payload.preferredWorkerId, resolved.now(), resolved.workerFreshMs);
          if (preferredLive) continue;
        }
        const claimedPath = path.join(resolved.directory, 'claimed', `${payload.id}.${workerId}.json`);
        try {
          await rename(pendingPath, claimedPath);
        } catch {
          continue;
        }
        let approved = false;
        try {
          approved = await options.provider(payload.request);
          if (approved && payload.request.approvalScope !== undefined) {
            await writeRoute(resolved.directory, payload.request.approvalScope.id, workerId, resolved.now());
          }
        } catch {
          approved = false;
        }
        const response: BrokerResponse = {
          version: 1,
          id: payload.id,
          approved,
          workerId,
          completedAt: resolved.now(),
        };
        await writeJsonAtomic(path.join(resolved.directory, 'responses', `${payload.id}.json`), response).catch(() => undefined);
        await rm(claimedPath, { force: true }).catch(() => undefined);
      }
    } finally {
      scanning = false;
    }
  };

  void scan();
  const scanTimer = setInterval(() => { void scan(); }, resolved.pollMs);
  const heartbeatTimer = setInterval(() => { void heartbeat(); }, heartbeatMs);
  scanTimer.unref?.();
  heartbeatTimer.unref?.();

  return {
    workerId,
    close: async (): Promise<void> => {
      if (closed) return;
      closed = true;
      clearInterval(scanTimer);
      clearInterval(heartbeatTimer);
      await rm(path.join(resolved.directory, 'workers', `${workerId}.json`), { force: true }).catch(() => undefined);
    },
  };
}

export function hostApprovalBrokerDirectory(dataPath: string): string {
  return path.join(dataPath, 'host-approval-broker');
}

function resolveOptions(options: CrossClientHostApprovalBrokerOptions): Required<Pick<CrossClientHostApprovalBrokerOptions, 'directory'>> & {
  readonly timeoutMs: number;
  readonly pollMs: number;
  readonly workerFreshMs: number;
  readonly now: () => number;
} {
  return {
    directory: path.resolve(options.directory),
    timeoutMs: positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS),
    pollMs: positiveInteger(options.pollMs, DEFAULT_POLL_MS),
    workerFreshMs: positiveInteger(options.workerFreshMs, DEFAULT_WORKER_FRESH_MS),
    now: options.now ?? Date.now,
  };
}

async function ensureBrokerDirectories(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);
  await Promise.all(['pending', 'claimed', 'responses', 'workers', 'routes'].map(async (name) => {
    const target = path.join(directory, name);
    await mkdir(target, { recursive: true, mode: 0o700 });
    await chmod(target, 0o700).catch(() => undefined);
  }));
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
  await rename(temporaryPath, filePath);
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

function isBrokerRequest(value: BrokerRequest | null): value is BrokerRequest {
  return value !== null
    && value.version === 1
    && typeof value.id === 'string'
    && Number.isFinite(value.createdAt)
    && Number.isFinite(value.expiresAt)
    && typeof value.request === 'object'
    && value.request !== null;
}

async function writeRoute(directory: string, scopeId: string, workerId: string, now: number): Promise<void> {
  const route: BrokerRoute = { version: 1, scopeId, workerId, updatedAt: now };
  await writeJsonAtomic(path.join(directory, 'routes', `${scopeFileName(scopeId)}.json`), route);
}

async function readLiveRoute(directory: string, scopeId: string, now: number, workerFreshMs: number): Promise<BrokerRoute | undefined> {
  const route = await readJson<BrokerRoute>(path.join(directory, 'routes', `${scopeFileName(scopeId)}.json`));
  if (route === null || route.version !== 1 || route.scopeId !== scopeId || typeof route.workerId !== 'string') return undefined;
  return await isWorkerLive(directory, route.workerId, now, workerFreshMs) ? route : undefined;
}

async function isWorkerLive(directory: string, workerId: string, now: number, workerFreshMs: number): Promise<boolean> {
  const heartbeat = await readJson<BrokerHeartbeat>(path.join(directory, 'workers', `${workerId}.json`));
  return heartbeat !== null
    && heartbeat.version === 1
    && heartbeat.workerId === workerId
    && Number.isFinite(heartbeat.updatedAt)
    && now - heartbeat.updatedAt <= workerFreshMs;
}

function scopeFileName(scopeId: string): string {
  return createHash('sha256').update(scopeId).digest('hex');
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}
