import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appError, err, ok, type ResultBudget } from '@unified-mpc/domain';
import {
  ThaiRagProviderCoordinator,
  type ThaiRagProviderDriver,
  type ThaiRagProviderDriverHealth,
} from './provider-coordinator.js';

const roots: string[] = [];
const healthy: ThaiRagProviderDriverHealth = {
  workerReachable: true,
  sqliteAvailable: true,
  ftsAvailable: true,
  vectorStoreAvailable: true,
  embedderAvailable: true,
  lexicalRetrievalAvailable: true,
  semanticRetrievalAvailable: true,
  activeJobs: [],
};

async function root(): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), 'unified-thai-rag-coordinator-'));
  roots.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

describe('ThaiRagProviderCoordinator', () => {
  it('lets concurrent runtimes share one parent-owned provider instead of spawning duplicate workers', async () => {
    const dataRoot = await root();
    let ownerStarts = 0;
    let followerStarts = 0;
    const owner = new ThaiRagProviderCoordinator({
      dataRoot,
      ownerId: 'http-runtime',
      providerVersion: '4.61.0',
      embeddingIndexGeneration: 1,
      driver: driver({ start: async () => { ownerStarts += 1; return ok(healthy); } }),
    });
    const follower = new ThaiRagProviderCoordinator({
      dataRoot,
      ownerId: 'stdio-runtime',
      providerVersion: '4.61.0',
      embeddingIndexGeneration: 1,
      driver: driver({ start: async () => { followerStarts += 1; return ok(healthy); } }),
    });

    const first = await owner.start();
    const second = await follower.start();
    expect(first.ok && first.value.role).toBe('owner');
    expect(second.ok && second.value.role).toBe('follower');
    expect(ownerStarts).toBe(1);
    expect(followerStarts).toBe(0);

    const remoteHealth = await follower.health();
    expect(remoteHealth.ok).toBe(true);
    if (remoteHealth.ok) expect(remoteHealth.value.ownerId).toBe('http-runtime');

    await follower.close();
    await owner.close();
  });

  it('serializes owner and follower calls through one writer queue', async () => {
    const dataRoot = await root();
    let inFlight = 0;
    let maxInFlight = 0;
    const calls: string[] = [];
    const sharedDriver = driver({
      call: async (tool, args) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        calls.push(`${tool}:${String(args['id'])}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight -= 1;
        return ok({ tool, args });
      },
    });
    const owner = new ThaiRagProviderCoordinator({
      dataRoot,
      ownerId: 'http-runtime',
      providerVersion: '4.61.0',
      embeddingIndexGeneration: 1,
      driver: sharedDriver,
    });
    const follower = new ThaiRagProviderCoordinator({
      dataRoot,
      ownerId: 'cline-runtime',
      providerVersion: '4.61.0',
      embeddingIndexGeneration: 1,
      driver: driver({ call: async () => { throw new Error('follower driver must never be used'); } }),
    });
    expect((await owner.start()).ok).toBe(true);
    expect((await follower.start()).ok).toBe(true);

    const results = await Promise.all([
      owner.call('remember_turn', { id: 1 }),
      follower.call('pre_edit_context', { id: 2 }),
      follower.call('code_search', { id: 3 }),
      owner.call('code_index', { id: 4 }),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(maxInFlight).toBe(1);
    expect(calls).toHaveLength(4);

    await follower.close();
    await owner.close();
  });

  it('propagates result budgets through follower and owner sockets', async () => {
    const dataRoot = await root();
    let observedBudget: ResultBudget | undefined;
    const owner = new ThaiRagProviderCoordinator({
      dataRoot,
      ownerId: 'owner',
      providerVersion: '4.61.0',
      embeddingIndexGeneration: 1,
      driver: driver({ call: async (_tool, _args, _signal, budget) => { observedBudget = budget; return ok({ bounded: true }); } }),
    });
    const follower = new ThaiRagProviderCoordinator({
      dataRoot,
      ownerId: 'follower',
      providerVersion: '4.61.0',
      embeddingIndexGeneration: 1,
      driver: driver({ call: async () => { throw new Error('follower driver must not run'); } }),
    });
    expect((await owner.start()).ok).toBe(true);
    expect((await follower.start()).ok).toBe(true);

    const budget: ResultBudget = { maxItems: 2, maxTextBytes: 3, maxStructuredBytes: 4, maxBinaryBytes: 5, maxBase64Bytes: 6 };
    await follower.call('code_search', { query: 'needle' }, undefined, budget);

    expect(observedBudget).toEqual(budget);
    await follower.close();
    await owner.close();
  });

  it('propagates follower cancellation to the owner producer', async () => {
    const dataRoot = await root();
    let producerAborted = false;
    let releaseProducer!: () => void;
    let startProducer!: () => void;
    const producerStarted = new Promise<void>((resolve) => { startProducer = resolve; });
    const producerStopped = new Promise<void>((resolve) => { releaseProducer = resolve; });
    const owner = new ThaiRagProviderCoordinator({
      dataRoot,
      ownerId: 'owner',
      providerVersion: '4.61.0',
      embeddingIndexGeneration: 1,
      driver: driver({
        call: async (_tool, _args, signal) => new Promise((resolve) => {
          startProducer();
          signal?.addEventListener('abort', () => {
            producerAborted = true;
            releaseProducer();
            resolve(ok({ cancelled: true }));
          }, { once: true });
        }),
      }),
    });
    const follower = new ThaiRagProviderCoordinator({
      dataRoot,
      ownerId: 'follower',
      providerVersion: '4.61.0',
      embeddingIndexGeneration: 1,
      driver: driver({ call: async () => { throw new Error('follower driver must not run'); } }),
    });
    expect((await owner.start()).ok).toBe(true);
    expect((await follower.start()).ok).toBe(true);

    const controller = new AbortController();
    const pending = follower.call('code_search', { query: 'needle' }, controller.signal);
    await producerStarted;
    controller.abort();
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
    await producerStopped;
    expect(producerAborted).toBe(true);

    await follower.close();
    await owner.close();
  });

  it('allows a follower to become owner after the prior owner shuts down cleanly', async () => {
    const dataRoot = await root();
    const first = new ThaiRagProviderCoordinator({
      dataRoot,
      ownerId: 'first',
      providerVersion: '4.61.0',
      embeddingIndexGeneration: 1,
      driver: driver(),
    });
    expect((await first.start()).ok && (await first.health()).ok).toBe(true);
    await first.close();

    let starts = 0;
    const replacement = new ThaiRagProviderCoordinator({
      dataRoot,
      ownerId: 'replacement',
      providerVersion: '4.61.0',
      embeddingIndexGeneration: 1,
      driver: driver({ start: async () => { starts += 1; return ok(healthy); } }),
    });
    const started = await replacement.start();
    expect(started.ok && started.value.role).toBe('owner');
    expect(starts).toBe(1);
    await replacement.close();
  });

  it('preserves a generic provider CONFLICT instead of treating it as owner contention', async () => {
    const dataRoot = await root();
    const startupError = appError('CONFLICT', 'Native Thai-RAG worker contract is incompatible', true, {
      reason: 'incompatible-contract',
    });
    const coordinator = new ThaiRagProviderCoordinator({
      dataRoot,
      ownerId: 'http-runtime',
      providerVersion: '4.61.0',
      embeddingIndexGeneration: 1,
      followerConnectTimeoutMs: 20,
      driver: driver({ start: async () => err(startupError) }),
    });

    const started = await coordinator.start();

    expect(started.ok).toBe(false);
    if (!started.ok) expect(started.error).toBe(startupError);
  });

  it('does not enter follower mode for an unverified lock beside an unowned socket', async () => {
    const dataRoot = await root();
    const providerRoot = path.join(dataRoot, 'thai-rag');
    await mkdir(providerRoot, { recursive: true });
    await writeFile(path.join(providerRoot, 'provider.lock'), '{not-json');
    await writeFile(path.join(providerRoot, 'provider.sock'), 'stale socket placeholder');
    const coordinator = new ThaiRagProviderCoordinator({
      dataRoot,
      ownerId: 'replacement',
      providerVersion: '4.61.0',
      embeddingIndexGeneration: 1,
      followerConnectTimeoutMs: 20,
      driver: driver({ start: async () => { throw new Error('must not start with an unverified owner lock'); } }),
    });

    const started = await coordinator.start();

    expect(started.ok).toBe(false);
    if (!started.ok) {
      expect(started.error.code).toBe('CONFLICT');
      expect(started.error.details?.reason).toBe('owner-lock-unverified');
      expect(started.error.message).not.toContain('owner is locked but not reachable');
    }
  });
});

function driver(overrides: Partial<ThaiRagProviderDriver> = {}): ThaiRagProviderDriver {
  return {
    start: async () => ok(healthy),
    health: async () => ok(healthy),
    call: async (tool, args) => ok({ tool, args }),
    stop: async () => ok(undefined),
    ...overrides,
  };
}
