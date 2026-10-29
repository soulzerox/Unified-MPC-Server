import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ok } from '@unified-mpc/domain';
import type { ThaiRagProviderDriver } from '@unified-mpc/thai-rag';
import { createStdioMcpRuntime } from './stdio-mcp-runtime.js';

/**
 * Cross-runtime topology (#407 addendum): the long-lived host runtime and a
 * short-lived stdio peer share one Thai-RAG data root. The owner side is built
 * through the same `createStdioMcpRuntime` factory the long-lived HTTP host
 * uses (`apps/cli/src/bin/mcp-http.ts`), and the peer is the stdio wiring with
 * `UNIFIED_THAI_RAG_FORWARD_ONLY` set. Both run in this process so their real
 * provider lock and socket are exercised without a Python worker.
 */
const temporaryRoots: string[] = [];
const TEST_CHECKPOINT_KEY = Buffer.alloc(32, 0x46).toString('base64');

const workspace = {
  id: 'workspace-1',
  displayName: 'fixture',
  rootPath: 'E:\fixture',
  realRootPath: 'E:\fixture',
  createdAt: '2026-08-10T00:00:00.000Z',
};

const HEALTHY = {
  workerReachable: true,
  sqliteAvailable: true,
  ftsAvailable: true,
  vectorStoreAvailable: true,
  embedderAvailable: true,
  lexicalRetrievalAvailable: true,
  semanticRetrievalAvailable: true,
  activeJobs: [] as readonly unknown[],
};

interface DriverProbe {
  readonly driver: ThaiRagProviderDriver;
  readonly starts: () => number;
}

function createOwnerDriver(servedBy: string): DriverProbe {
  let startCalls = 0;
  return {
    starts: () => startCalls,
    driver: {
      start: async (): ReturnType<ThaiRagProviderDriver['start']> => {
        startCalls += 1;
        return ok(HEALTHY);
      },
      health: async () => ok(HEALTHY),
      call: async () => ok({ servedBy }),
      stop: async () => ok(undefined),
    },
  };
}

function providerLockPath(dataPath: string): string {
  return path.join(dataPath, 'thai-rag', 'provider.lock');
}

async function readLockRecord(dataPath: string): Promise<{ ownerId?: string; pid?: number; startedAt?: string } | undefined> {
  const lockPath = providerLockPath(dataPath);
  if (!existsSync(lockPath)) return undefined;
  return JSON.parse(await readFile(lockPath, 'utf8')) as { ownerId?: string; pid?: number; startedAt?: string };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// Captured once so a developer running the suite with the peer switch exported
// still gets the host side on the election path, and gets their value back.
const previousForwardOnly = process.env.UNIFIED_THAI_RAG_FORWARD_ONLY;

beforeEach(() => {
  process.env.UNIFIED_MPC_CHECKPOINT_KEY_BASE64 = TEST_CHECKPOINT_KEY;
  delete process.env.UNIFIED_THAI_RAG_FORWARD_ONLY;
});

afterEach(async () => {
  delete process.env.UNIFIED_MPC_CHECKPOINT_KEY_BASE64;
  if (previousForwardOnly === undefined) delete process.env.UNIFIED_THAI_RAG_FORWARD_ONLY;
  else process.env.UNIFIED_THAI_RAG_FORWARD_ONLY = previousForwardOnly;
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('cross-runtime Thai-RAG provider topology (#407)', () => {
  it('forwards a stdio peer read to the live host without taking or rewriting its lock', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'unified-rag-cross-runtime-forward-'));
    temporaryRoots.push(dataPath);

    const owner = createOwnerDriver('host-a');
    const ownerRuntime = createStdioMcpRuntime(dataPath, workspace, false, { thaiRagDriver: owner.driver });
    const peer = createOwnerDriver('peer-must-not-serve');
    let peerRuntime: ReturnType<typeof createStdioMcpRuntime> | undefined;
    try {
      await ownerRuntime.initializeThaiRag();
      const ownerLock = await readLockRecord(dataPath);
      expect(ownerLock).toMatchObject({ pid: process.pid });

      process.env.UNIFIED_THAI_RAG_FORWARD_ONLY = '1';
      peerRuntime = createStdioMcpRuntime(dataPath, workspace, false, { thaiRagDriver: peer.driver });

      const forwarded = await peerRuntime.services.thaiRag?.call('code_search', { query: 'needle' });
      expect(forwarded).toMatchObject({ ok: true, value: { servedBy: 'host-a' } });
      // The peer read reaches the host's driver; the peer's own driver is never started.
      expect(peer.starts()).toBe(0);
      expect(owner.starts()).toBe(1);

      // A follower holds no provider state: the host's lock generation is untouched.
      const peerObservedLock = await readLockRecord(dataPath);
      expect(peerObservedLock?.startedAt).toBe(ownerLock?.startedAt);
      expect(peerObservedLock?.pid).toBe(ownerLock?.pid);
    } finally {
      await peerRuntime?.close();
      await ownerRuntime.close();
    }
  }, 30_000);

  it('never elects itself when the designated host is gone and reports the topology honestly', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'unified-rag-cross-runtime-host-gone-'));
    temporaryRoots.push(dataPath);

    const owner = createOwnerDriver('host-a');
    const ownerRuntime = createStdioMcpRuntime(dataPath, workspace, false, { thaiRagDriver: owner.driver });
    const peer = createOwnerDriver('peer-must-not-serve');
    let peerRuntime: ReturnType<typeof createStdioMcpRuntime> | undefined;
    try {
      await ownerRuntime.initializeThaiRag();
      process.env.UNIFIED_THAI_RAG_FORWARD_ONLY = '1';
      peerRuntime = createStdioMcpRuntime(dataPath, workspace, false, {
        thaiRagDriver: peer.driver,
        thaiRagStartRetryMs: 10,
        thaiRagFollowerRequestRetryMs: 50,
      });
      await expect(peerRuntime.services.thaiRag?.call('code_search', { query: 'warm' }))
        .resolves.toMatchObject({ ok: true, value: { servedBy: 'host-a' } });

      // The designated host exits; the peer must report the topology honestly
      // instead of promoting itself to owner.
      await ownerRuntime.close();
      await sleep(30);
      const afterHostGone = await peerRuntime.services.thaiRag?.call('code_search', { query: 'after-host-gone' });
      // A peer that never attached reports `forward-host-unreachable`; one that
      // lost a live host reports `follower-reconnect-exhausted`. Both are
      // machine-readable CONFLICTs and neither may promote the peer to owner.
      expect(afterHostGone).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
      expect(['forward-host-unreachable', 'follower-reconnect-exhausted'])
        .toContain(afterHostGone && !afterHostGone.ok ? afterHostGone.error.details?.reason : undefined);
      expect(afterHostGone && !afterHostGone.ok ? afterHostGone.error.message : '').toMatch(/unreachable|socket/i);
      expect(peer.starts()).toBe(0);
      // No lock was written by the peer: the host's released lock is not recreated.
      expect(await readLockRecord(dataPath)).toBeUndefined();
    } finally {
      await peerRuntime?.close();
      await ownerRuntime.close();
    }
  }, 30_000);

  it('re-attaches the same stdio peer to a restarted host generation without a peer restart', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'unified-rag-cross-runtime-restart-'));
    temporaryRoots.push(dataPath);

    const firstOwner = createOwnerDriver('host-a');
    let ownerRuntime = createStdioMcpRuntime(dataPath, workspace, false, { thaiRagDriver: firstOwner.driver });
    const peer = createOwnerDriver('peer-must-not-serve');
    let peerRuntime: ReturnType<typeof createStdioMcpRuntime> | undefined;
    try {
      await ownerRuntime.initializeThaiRag();
      const firstGeneration = await readLockRecord(dataPath);

      process.env.UNIFIED_THAI_RAG_FORWARD_ONLY = '1';
      peerRuntime = createStdioMcpRuntime(dataPath, workspace, false, {
        thaiRagDriver: peer.driver,
        thaiRagStartRetryMs: 10,
        thaiRagFollowerRequestRetryMs: 50,
      });
      await expect(peerRuntime.services.thaiRag?.call('code_search', { query: 'before-restart' }))
        .resolves.toMatchObject({ ok: true, value: { servedBy: 'host-a' } });

      await ownerRuntime.close();
      await sleep(30);
      await peerRuntime.services.thaiRag?.call('code_search', { query: 'during-downtime' });

      // A new host process takes over the data root with a new lock generation.
      // The owner must be built on the election path, not the peer env.
      delete process.env.UNIFIED_THAI_RAG_FORWARD_ONLY;
      await sleep(30);
      const nextOwner = createOwnerDriver('host-b');
      ownerRuntime = createStdioMcpRuntime(dataPath, workspace, false, { thaiRagDriver: nextOwner.driver });
      await ownerRuntime.initializeThaiRag();
      const nextGeneration = await readLockRecord(dataPath);
      expect(nextGeneration?.startedAt).not.toBe(firstGeneration?.startedAt);

      const reattached = await peerRuntime.services.thaiRag?.call('code_search', { query: 'after-restart' });
      expect(reattached).toMatchObject({ ok: true, value: { servedBy: 'host-b' } });
      expect(peer.starts()).toBe(0);
      expect(nextOwner.starts()).toBe(1);
    } finally {
      await peerRuntime?.close();
      await ownerRuntime.close();
    }
  }, 30_000);
});
