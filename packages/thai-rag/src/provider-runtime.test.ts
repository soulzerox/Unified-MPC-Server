import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appError, err, ok, type ResultBudget } from '@unified-mpc/domain';
import {
  ThaiRagProviderRuntime,
  type ThaiRagProviderDriver,
  type ThaiRagProviderDriverHealth,
} from './provider-runtime.js';

const roots: string[] = [];
const healthy: ThaiRagProviderDriverHealth = {
  indexJobContractVersion: '1.0',
  workerReachable: true,
  sqliteAvailable: true,
  ftsAvailable: true,
  vectorStoreAvailable: true,
  embedderAvailable: true,
  lexicalRetrievalAvailable: true,
  semanticRetrievalAvailable: true,
  activeJobs: [],
};

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error('timed out waiting for the expected state');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function driver(overrides: Partial<ThaiRagProviderDriver> = {}): ThaiRagProviderDriver {
  return {
    start: async () => ok(healthy),
    health: async () => ok(healthy),
    stop: async () => ok(undefined),
    ...overrides,
  };
}

async function root(): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), 'unified-thai-rag-'));
  roots.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

describe('ThaiRagProviderRuntime', () => {
  it('owns deterministic start/readiness/stop lifecycle under the Unified data root', async () => {
    const dataRoot = await root();
    const calls: string[] = [];
    const runtime = new ThaiRagProviderRuntime({
      dataRoot,
      ownerId: 'http-runtime',
      providerVersion: '4.61.0',
      embeddingIndexGeneration: 3,
      driver: driver({
        start: async (options) => {
          calls.push(`start:${options.providerRoot}`);
          return ok(healthy);
        },
        stop: async () => {
          calls.push('stop');
          return ok(undefined);
        },
      }),
    });

    const started = await runtime.start();
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.value.state).toBe('ready');
    expect(started.value.ownerId).toBe('http-runtime');
    expect(started.value.components).toEqual(healthy);
    expect(started.value.indexJobContractVersion).toBe('1.0');
    expect(calls).toEqual([`start:${dataRoot}/thai-rag`]);

    const stopped = await runtime.stop();
    expect(stopped.ok).toBe(true);
    if (stopped.ok) expect(stopped.value.state).toBe('stopped');
    expect(calls).toEqual([`start:${dataRoot}/thai-rag`, 'stop']);
  });

  it('enforces a single provider owner across runtimes sharing the same data root', async () => {
    const dataRoot = await root();
    const processIdentityProbe = async (): Promise<string> => 'process:current';
    const first = new ThaiRagProviderRuntime({
      dataRoot,
      ownerId: 'http-runtime',
      providerVersion: '4.61.0',
      embeddingIndexGeneration: 1,
      driver: driver(),
      processIdentityProbe,
    });
    const second = new ThaiRagProviderRuntime({
      dataRoot,
      ownerId: 'stdio-runtime',
      providerVersion: '4.61.0',
      embeddingIndexGeneration: 1,
      driver: driver(),
      processIdentityProbe,
    });

    expect((await first.start()).ok).toBe(true);
    const duplicate = await second.start();
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) {
      expect(duplicate.error.code).toBe('CONFLICT');
      expect(duplicate.error.details?.reason).toBe('owner-lock');
    }

    expect((await first.stop()).ok).toBe(true);
    expect((await second.start()).ok).toBe(true);
    expect((await second.stop()).ok).toBe(true);
  });

  it('reclaims a provably stale owner lock but never steals a live or unprovable owner', async () => {
    const dataRoot = await root();
    const providerRoot = path.join(dataRoot, 'thai-rag');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(providerRoot, { recursive: true }));
    await writeFile(path.join(providerRoot, 'provider.lock'), JSON.stringify({ ownerId: 'dead-owner', pid: 424242, startedAt: '2026-01-01T00:00:00.000Z' }));

    const runtime = new ThaiRagProviderRuntime({
      dataRoot,
      ownerId: 'replacement',
      providerVersion: '4.61.0',
      embeddingIndexGeneration: 1,
      driver: driver(),
      isProcessAlive: (pid): boolean => pid !== 424242,
      processIdentityProbe: async (): Promise<string> => 'process:replacement',
    });
    expect((await runtime.start()).ok).toBe(true);
    const lock = JSON.parse(await readFile(path.join(providerRoot, 'provider.lock'), 'utf8')) as { ownerId: string; processIdentity?: string };
    expect(lock).toMatchObject({ ownerId: 'replacement', processIdentity: 'process:replacement' });
    expect((await runtime.stop()).ok).toBe(true);

    const denied = new ThaiRagProviderRuntime({
      dataRoot,
      ownerId: 'denied',
      providerVersion: '4.61.0',
      embeddingIndexGeneration: 1,
      driver: driver({ start: async () => err(appError('INTERNAL_ERROR', 'must not start')) }),
      isProcessAlive: (): boolean => true,
      processIdentityProbe: async (): Promise<string> => 'process:live',
    });
    await writeFile(path.join(providerRoot, 'provider.lock'), JSON.stringify({ ownerId: 'live-owner', pid: process.pid, startedAt: '2026-01-01T00:00:00.000Z' }));
    const unverified = await denied.start();
    expect(unverified.ok).toBe(false);
    if (!unverified.ok) expect(unverified.error.details?.reason).toBe('owner-lock-unverified');
  });

  it('reclaims a lock when a live PID has been reused by a different process identity', async () => {
    const dataRoot = await root();
    const providerRoot = path.join(dataRoot, 'thai-rag');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(providerRoot, { recursive: true }));
    await writeFile(path.join(providerRoot, 'provider.lock'), JSON.stringify({
      ownerId: 'old-owner',
      pid: 777,
      startedAt: '2026-01-01T00:00:00.000Z',
      processIdentity: 'process:old-start',
    }));

    const runtime = new ThaiRagProviderRuntime({
      dataRoot,
      ownerId: 'replacement',
      providerVersion: '4.61.0',
      embeddingIndexGeneration: 1,
      pid: 888,
      driver: driver(),
      isProcessAlive: (): boolean => true,
      processIdentityProbe: async (pid): Promise<string> => pid === 777 ? 'process:reused-pid' : 'process:replacement',
    });

    expect((await runtime.start()).ok).toBe(true);
    const lock = JSON.parse(await readFile(path.join(providerRoot, 'provider.lock'), 'utf8')) as {
      ownerId: string;
      pid: number;
      processIdentity?: string;
    };
    expect(lock).toMatchObject({ ownerId: 'replacement', pid: 888, processIdentity: 'process:replacement' });
    expect((await runtime.stop()).ok).toBe(true);
  });

  it('keeps a verified live owner lock when PID and process identity both match', async () => {
    const dataRoot = await root();
    const providerRoot = path.join(dataRoot, 'thai-rag');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(providerRoot, { recursive: true }));
    await writeFile(path.join(providerRoot, 'provider.lock'), JSON.stringify({
      ownerId: 'live-owner',
      pid: 777,
      startedAt: '2026-01-01T00:00:00.000Z',
      processIdentity: 'process:same-start',
    }));

    const runtime = new ThaiRagProviderRuntime({
      dataRoot,
      ownerId: 'contender',
      providerVersion: '4.61.0',
      embeddingIndexGeneration: 1,
      driver: driver({ start: async () => err(appError('INTERNAL_ERROR', 'must not start')) }),
      isProcessAlive: (): boolean => true,
      processIdentityProbe: async (): Promise<string> => 'process:same-start',
    });

    const started = await runtime.start();
    expect(started.ok).toBe(false);
    if (!started.ok) expect(started.error.details?.reason).toBe('owner-lock');
  });

  it('fails closed instead of crashing when process identity is unavailable on a non-POSIX platform', async () => {
    const dataRoot = await root();
    const providerRoot = path.join(dataRoot, 'thai-rag');
    const first = new ThaiRagProviderRuntime({
      dataRoot,
      ownerId: 'windows-owner',
      providerVersion: '4.61.0',
      embeddingIndexGeneration: 1,
      driver: driver(),
      platform: 'win32',
      isProcessAlive: (): boolean => true,
    });

    expect((await first.start()).ok).toBe(true);
    const lock = JSON.parse(await readFile(path.join(providerRoot, 'provider.lock'), 'utf8')) as {
      processIdentity?: string;
    };
    expect(lock.processIdentity).toBeUndefined();

    const contender = new ThaiRagProviderRuntime({
      dataRoot,
      ownerId: 'windows-contender',
      providerVersion: '4.61.0',
      embeddingIndexGeneration: 1,
      driver: driver({ start: async () => err(appError('INTERNAL_ERROR', 'must not start')) }),
      platform: 'win32',
      isProcessAlive: (): boolean => true,
    });
    const denied = await contender.start();
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.details?.reason).toBe('owner-lock-unverified');

    expect((await first.stop()).ok).toBe(true);
  });

  it('passes result budgets to every provider producer', async () => {
    const dataRoot = await root();
    let observedBudget: ResultBudget | undefined;
    const runtime = new ThaiRagProviderRuntime({
      dataRoot,
      ownerId: 'http-runtime',
      providerVersion: '4.61.0',
      embeddingIndexGeneration: 1,
      driver: driver({
        call: async (_tool, _args, _signal, budget) => {
          observedBudget = budget;
          return ok({ bounded: true });
        },
      }),
    });
    expect((await runtime.start()).ok).toBe(true);

    const budget: ResultBudget = { maxItems: 2, maxTextBytes: 3, maxStructuredBytes: 4, maxBinaryBytes: 5, maxBase64Bytes: 6 };
    await runtime.call('code_search', { query: 'needle' }, undefined, budget);

    expect(observedBudget).toEqual(budget);
    await runtime.stop();
  });

  it('reports degraded readiness without pretending semantic retrieval is healthy', async () => {
    const dataRoot = await root();
    const degraded: ThaiRagProviderDriverHealth = {
      ...healthy,
      embedderAvailable: false,
      semanticRetrievalAvailable: false,
    };
    const runtime = new ThaiRagProviderRuntime({
      dataRoot,
      ownerId: 'http-runtime',
      providerVersion: '4.61.0',
      embeddingIndexGeneration: 1,
      driver: driver({ start: async () => ok(degraded) }),
    });

    const started = await runtime.start();
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.value.state).toBe('degraded');
    expect(started.value.components?.lexicalRetrievalAvailable).toBe(true);
    expect(started.value.components?.semanticRetrievalAvailable).toBe(false);
    expect(started.value.degradation).toContain('embedder-offline');
    expect((await runtime.stop()).ok).toBe(true);
  });
});

describe('ThaiRagProviderRuntime owner-lock heartbeat and version fence (#210 U32)', () => {
  const make = (dataRoot: string, overrides: Record<string, unknown> = {}): ThaiRagProviderRuntime => new ThaiRagProviderRuntime({
    dataRoot,
    ownerId: 'stdio-runtime',
    providerVersion: '4.61.0',
    embeddingIndexGeneration: 1,
    driver: driver(),
    ...overrides,
  } as ConstructorParameters<typeof ThaiRagProviderRuntime>[0]);

  it('records the provider version and a heartbeat on the owner lock', async () => {
    const dataRoot = await root();
    const now = (): Date => new Date('2026-10-17T00:00:00.000Z');
    const runtime = make(dataRoot, { now });
    expect((await runtime.start()).ok).toBe(true);
    const lock = JSON.parse(await readFile(path.join(dataRoot, 'thai-rag', 'provider.lock'), 'utf8')) as {
      providerVersion: string; heartbeatAt: string;
    };
    expect(lock.providerVersion).toBe('4.61.0');
    expect(lock.heartbeatAt).toBe('2026-10-17T00:00:00.000Z');
    await runtime.stop();
  });

  it('advances the heartbeat while it still owns the lock', async () => {
    const dataRoot = await root();
    let clock = Date.parse('2026-10-17T00:00:00.000Z');
    const runtime = make(dataRoot, { now: () => new Date(clock) });
    expect((await runtime.start()).ok).toBe(true);

    clock += 5_000;
    await runtime.renewOwnerLock();
    const lock = JSON.parse(await readFile(path.join(dataRoot, 'thai-rag', 'provider.lock'), 'utf8')) as { heartbeatAt: string };
    expect(lock.heartbeatAt).toBe('2026-10-17T00:00:05.000Z');
    await runtime.stop();
  });

  it('keeps proving owner liveness while the driver is still starting (#418)', async () => {
    const dataRoot = await root();
    let clock = Date.parse('2026-10-17T00:00:00.000Z');
    let releaseDriver: (() => void) | undefined;
    const driverGate = new Promise<void>((resolve) => { releaseDriver = resolve; });
    const runtime = make(dataRoot, {
      now: () => new Date(clock),
      heartbeatIntervalMs: 5,
      driver: driver({ start: async () => { await driverGate; return ok(healthy); } }),
    });

    const pending = runtime.start();
    const lockPath = path.join(dataRoot, 'thai-rag', 'provider.lock');
    await waitFor(async () => {
      try {
        await readFile(lockPath, 'utf8');
        return true;
      } catch {
        return undefined;
      }
    });
    clock += 5_000;

    // A booting owner must not look dead: heartbeat renewal has to start with
    // the lock, not after the driver is ready (#418).
    const during = await waitFor(async () => {
      try {
        const lock = JSON.parse(await readFile(lockPath, 'utf8')) as { heartbeatAt: string };
        return lock.heartbeatAt === '2026-10-17T00:00:05.000Z' ? lock : undefined;
      } catch {
        return undefined;
      }
    });
    expect(during.heartbeatAt).toBe('2026-10-17T00:00:05.000Z');

    releaseDriver?.();
    expect((await pending).ok).toBe(true);
    await runtime.stop();
  });

  it('releases the owner lock when the driver start rejects (#418)', async () => {
    const dataRoot = await root();
    const lockPath = path.join(dataRoot, 'thai-rag', 'provider.lock');
    const runtime = make(dataRoot, {
      heartbeatIntervalMs: 5,
      driver: driver({ start: async () => { throw new Error('driver exploded'); } }),
    });

    await expect(runtime.start()).rejects.toThrow('driver exploded');
    expect(existsSync(lockPath)).toBe(false);

    // The heartbeat must be stopped too, or it would resurrect the abandoned
    // lock and keep advertising an owner that never came up.
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(existsSync(lockPath)).toBe(false);
  });

  it('reclaims a stale lock left by an incompatible release', async () => {
    const dataRoot = await root();
    const providerRoot = path.join(dataRoot, 'thai-rag');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(providerRoot, { recursive: true }));
    // An older release, alive and heartbeating, but from an incompatible version.
    await writeFile(path.join(providerRoot, 'provider.lock'), JSON.stringify({
      ownerId: 'old-release',
      pid: 424242,
      startedAt: '2026-10-16T13:55:21.531Z',
      processIdentity: '2026-10-16T13:55:05.000Z',
      providerVersion: '4.60.0',
      heartbeatAt: '2026-10-16T13:55:21.531Z',
    }));

    const runtime = make(dataRoot, {
      now: () => new Date('2026-10-17T00:00:00.000Z'),
      isProcessAlive: (): boolean => true,
      processIdentityProbe: async () => '2026-10-16T13:55:05.000Z',
    });
    expect((await runtime.start()).ok).toBe(true);
    const lock = JSON.parse(await readFile(path.join(providerRoot, 'provider.lock'), 'utf8')) as { ownerId: string; providerVersion: string };
    expect(lock.ownerId).toBe('stdio-runtime');
    expect(lock.providerVersion).toBe('4.61.0');
    await runtime.stop();
  });

  it('keeps heartbeat-fresh locks and reports a same-version stale owner as unresponsive', async () => {
    const dataRoot = await root();
    const providerRoot = path.join(dataRoot, 'thai-rag');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(providerRoot, { recursive: true }));
    const lockPath = path.join(providerRoot, 'provider.lock');
    const now = (): Date => new Date('2026-10-17T00:00:00.000Z');
    const owner = { ownerId: 'live-owner', pid: 424242, startedAt: '2026-10-17T00:00:00.000Z', processIdentity: '2026-10-16T13:55:05.000Z', providerVersion: '4.61.0' };
    const denyOptions = {
      now,
      isProcessAlive: (): boolean => true,
      processIdentityProbe: async (): Promise<string> => '2026-10-16T13:55:05.000Z',
    };

    // Fresh heartbeat: the owner is live, so the lock is respected.
    await writeFile(lockPath, JSON.stringify({ ...owner, heartbeatAt: '2026-10-17T00:00:00.000Z' }));
    const fresh = await make(dataRoot, denyOptions).start();
    expect(fresh.ok).toBe(false);
    if (!fresh.ok) expect(fresh.error.message).toContain('already has an active owner');

    // Stale heartbeat, same version: refuse, but name the wedged owner.
    await writeFile(lockPath, JSON.stringify({ ...owner, heartbeatAt: '2026-10-16T00:00:00.000Z' }));
    const wedged = await make(dataRoot, denyOptions).start();
    expect(wedged.ok).toBe(false);
    if (!wedged.ok) {
      expect(wedged.error.message).toContain('424242');
      expect(wedged.error.message).toMatch(/unresponsive/i);
    }

    // A pre-heartbeat lock is respected even though it can never prove liveness.
    const { heartbeatAt: _dropped, providerVersion: _dropped2, ...legacy } = owner;
    void _dropped; void _dropped2;
    await writeFile(lockPath, JSON.stringify(legacy));
    const legacyStart = await make(dataRoot, denyOptions).start();
    expect(legacyStart.ok).toBe(false);
    if (!legacyStart.ok) expect(legacyStart.error.message).toContain('already has an active owner');
  });
});
