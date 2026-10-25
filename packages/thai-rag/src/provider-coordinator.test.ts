import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
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

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
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

  it('refreshes live active-job health for both owner and follower projections', async () => {
    const dataRoot = await root();
    let activeJobs: readonly string[] = [];
    let healthCalls = 0;
    const owner = new ThaiRagProviderCoordinator({
      dataRoot,
      ownerId: 'http-runtime',
      providerVersion: '4.61.0',
      embeddingIndexGeneration: 1,
      driver: driver({
        health: async () => {
          healthCalls += 1;
          return ok({ ...healthy, activeJobs });
        },
      }),
    });

    expect((await owner.start()).ok).toBe(true);
    activeJobs = ['idx-live'];

    const ownerHealth = await owner.health();
    expect(ownerHealth).toMatchObject({ ok: true, value: { components: { activeJobs: ['idx-live'] } } });
    expect(healthCalls).toBe(1);

    const follower = new ThaiRagProviderCoordinator({
      dataRoot,
      ownerId: 'stdio-runtime',
      providerVersion: '4.61.0',
      embeddingIndexGeneration: 1,
      driver: driver(),
    });
    const followerStart = await follower.start();
    expect(followerStart).toMatchObject({ ok: true, value: { role: 'follower', health: { components: { activeJobs: ['idx-live'] } } } });

    const followerHealth = await follower.health();
    expect(followerHealth).toMatchObject({ ok: true, value: { components: { activeJobs: ['idx-live'] } } });
    expect(healthCalls).toBeGreaterThanOrEqual(3);

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

  it('fails forward-only startup with forward-host-unreachable and never writes the owner lock (#407 req 3)', async () => {
    const dataRoot = await root();
    let driverStarts = 0;
    const coordinator = new ThaiRagProviderCoordinator({
      dataRoot,
      ownerId: 'stdio-forwarder',
      providerVersion: '4.61.0',
      embeddingIndexGeneration: 1,
      forwardOnly: true,
      followerConnectTimeoutMs: 30,
      driver: driver({ start: async () => { driverStarts += 1; return ok(healthy); } }),
    });

    const started = await coordinator.start();

    expect(started.ok).toBe(false);
    if (!started.ok) {
      expect(started.error.code).toBe('CONFLICT');
      expect(started.error.details?.reason).toBe('forward-host-unreachable');
      expect(started.error.message).toContain('forward host is unreachable');
    }
    expect(existsSync(path.join(dataRoot, 'thai-rag', 'provider.lock'))).toBe(false);
    expect(driverStarts).toBe(0);
  });

  it('forwards as a peer to a live owner without rewriting its lock (#407 req 3)', async () => {
    const dataRoot = await root();
    const providerRoot = path.join(dataRoot, 'thai-rag');
    let ownerStarts = 0;
    let forwardedStarts = 0;
    const owner = new ThaiRagProviderCoordinator({
      dataRoot,
      ownerId: 'http-runtime',
      providerVersion: '4.61.0',
      embeddingIndexGeneration: 1,
      ownerLockTtlMs: 3_600_000,
      driver: driver({ start: async () => { ownerStarts += 1; return ok(healthy); } }),
    });
    expect((await owner.start()).ok).toBe(true);
    const lockBefore = await readFile(path.join(providerRoot, 'provider.lock'), 'utf8');

    const forwarder = new ThaiRagProviderCoordinator({
      dataRoot,
      ownerId: 'stdio-forwarder',
      providerVersion: '4.61.0',
      embeddingIndexGeneration: 1,
      forwardOnly: true,
      driver: driver({ start: async () => { forwardedStarts += 1; return ok(healthy); } }),
    });
    const started = await forwarder.start();
    expect(started.ok && started.value.role).toBe('follower');

    const forwardedHealth = await forwarder.health();
    expect(forwardedHealth.ok).toBe(true);
    if (forwardedHealth.ok) expect(forwardedHealth.value.ownerId).toBe('http-runtime');

    const lockAfter = await readFile(path.join(providerRoot, 'provider.lock'), 'utf8');
    expect(lockAfter).toBe(lockBefore);
    expect(ownerStarts).toBe(1);
    expect(forwardedStarts).toBe(0);

    await forwarder.close();
    await owner.close();
  });

  it('keeps the lock-contention CONFLICT without the forward-only reason for the default election path (#407 req 3)', async () => {
    const dataRoot = await root();
    const providerRoot = path.join(dataRoot, 'thai-rag');
    await mkdir(providerRoot, { recursive: true });
    const heartbeat = new Date().toISOString();
    await writeFile(path.join(providerRoot, 'provider.lock'), JSON.stringify({
      ownerId: 'foreign-runtime',
      pid: process.pid,
      startedAt: heartbeat,
      processIdentity: 'foreign-identity',
      heartbeatAt: heartbeat,
      providerVersion: '4.61.0',
    }));
    await writeFile(path.join(providerRoot, 'provider.sock'), 'stale socket placeholder');
    const coordinator = new ThaiRagProviderCoordinator({
      dataRoot,
      ownerId: 'peer-runtime',
      providerVersion: '4.61.0',
      embeddingIndexGeneration: 1,
      followerConnectTimeoutMs: 20,
      isProcessAlive: (): boolean => true,
      processIdentityProbe: async (): Promise<string | null> => 'foreign-identity',
      driver: driver({ start: async () => { throw new Error('default election with a live owner must not start a driver'); } }),
    });

    const started = await coordinator.start();

    expect(started.ok).toBe(false);
    if (!started.ok) {
      expect(started.error.code).toBe('CONFLICT');
      expect(started.error.message).toContain('owner is locked but not reachable');
      expect(started.error.details?.reason).toBeUndefined();
    }
  });

  it('reconnects a follower when the owner socket is recreated (#418)', async () => {
    const dataRoot = await root();
    const providerRoot = path.join(dataRoot, 'thai-rag');
    const socketPath = path.join(providerRoot, 'provider.sock');
    const owner = new ThaiRagProviderCoordinator({
      dataRoot,
      ownerId: 'owner-before-restart',
      providerVersion: '4.61.0',
      embeddingIndexGeneration: 1,
      driver: driver(),
    });
    expect((await owner.start()).ok).toBe(true);
    const follower = new ThaiRagProviderCoordinator({
      dataRoot,
      ownerId: 'stdio-forwarder',
      providerVersion: '4.61.0',
      embeddingIndexGeneration: 1,
      forwardOnly: true,
      followerConnectTimeoutMs: 2_000,
      driver: driver({ start: async () => { throw new Error('a follower must never start its own driver'); } }),
    });
    expect((await follower.start()).ok).toBe(true);

    await owner.close();
    expect(existsSync(socketPath)).toBe(false);

    // This call begins while the owner socket is gone: the ENOENT phantom from #418.
    const pending = follower.call('memory.search', { query: 'survives an owner restart' });
    await delay(60);
    const replacement = new ThaiRagProviderCoordinator({
      dataRoot,
      ownerId: 'owner-after-restart',
      providerVersion: '4.61.0',
      embeddingIndexGeneration: 1,
      driver: driver(),
    });
    expect((await replacement.start()).ok).toBe(true);

    const result = await pending;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toMatchObject({ tool: 'memory.search' });

    await follower.close();
    await replacement.close();
  });

  it('gives up a follower call within the bounded connect window when the owner never returns (#418)', async () => {
    const dataRoot = await root();
    const owner = new ThaiRagProviderCoordinator({
      dataRoot,
      ownerId: 'owner-gone-for-good',
      providerVersion: '4.61.0',
      embeddingIndexGeneration: 1,
      driver: driver(),
    });
    expect((await owner.start()).ok).toBe(true);
    const follower = new ThaiRagProviderCoordinator({
      dataRoot,
      ownerId: 'stdio-forwarder',
      providerVersion: '4.61.0',
      embeddingIndexGeneration: 1,
      forwardOnly: true,
      followerConnectTimeoutMs: 120,
      driver: driver({ start: async () => { throw new Error('a follower must never start its own driver'); } }),
    });
    expect((await follower.start()).ok).toBe(true);

    await owner.close();
    const startedAt = Date.now();
    const result = await follower.call('memory.search', { query: 'no owner left' });
    const elapsed = Date.now() - startedAt;

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('socket error');
    expect(elapsed).toBeGreaterThanOrEqual(80);
    expect(elapsed).toBeLessThan(5_000);

    await follower.close();
  });

  it('never replays a follower request that already reached the owner socket (#418)', async () => {
    const dataRoot = await root();
    const providerRoot = path.join(dataRoot, 'thai-rag');
    const socketPath = path.join(providerRoot, 'provider.sock');
    const owner = new ThaiRagProviderCoordinator({
      dataRoot,
      ownerId: 'owner-replaced-by-stub',
      providerVersion: '4.61.0',
      embeddingIndexGeneration: 1,
      driver: driver(),
    });
    expect((await owner.start()).ok).toBe(true);
    const follower = new ThaiRagProviderCoordinator({
      dataRoot,
      ownerId: 'stdio-forwarder',
      providerVersion: '4.61.0',
      embeddingIndexGeneration: 1,
      forwardOnly: true,
      followerConnectTimeoutMs: 500,
      driver: driver({ start: async () => { throw new Error('a follower must never start its own driver'); } }),
    });
    expect((await follower.start()).ok).toBe(true);
    await owner.close();

    let connections = 0;
    const destructive = createServer((socket) => {
      connections += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve, reject) => {
      destructive.once('error', reject);
      destructive.listen(socketPath, () => resolve());
    });
    try {
      const result = await follower.call('memory.write', { note: 'must not be replayed' });
      expect(result.ok).toBe(false);
      expect(connections).toBe(1);
    } finally {
      await new Promise<void>((resolve) => destructive.close(() => resolve()));
      await follower.close();
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
