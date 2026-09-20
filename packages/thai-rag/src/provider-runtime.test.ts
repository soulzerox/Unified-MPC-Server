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
