import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalManifestId, canonicalRevisionId, computeTreeOid } from '@unified-mpc/domain';
import { CanonicalManifestStore } from './canonical-manifest-store.js';
import { CanonicalRefStore } from './canonical-ref-store.js';
import { GoalOverlayStore } from './goal-overlay-store.js';
import { RevisionPinRegistry } from './revision-pin-registry.js';
import { ResourceAdmissionController } from './resource-admission.js';
import { DEFAULT_PROCESS_RESOURCE_ADMISSION_LIMITS } from './resource-admission.js';
import { GcLeaseLostError, GcLeaseStore } from './gc-lease.js';
import { runMaintenanceCycle, type MaintenanceCycleDeps, type MaintenanceCycleFence } from './maintenance-cycle.js';
import type { CanonicalStoreVerifyReport } from './canonical-store-verify.js';

const NOW = new Date('2026-10-18T10:00:00.000Z');
const H = (n: string): string => n.repeat(64).slice(0, 64);
const REPO = 'repo_abc123';
const REF = 'refs/remotes/origin/main';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'maint-cycle-'));
  temporaryRoots.push(root);
  return root;
}

function evidence(overrides: Partial<{
  databaseBytes: number;
  freelistBytes: number;
  freelistRatio: number;
  compactionRecommended: boolean;
  checkpointBusy: boolean;
}> = {}): {
  databaseBytes: number;
  freelistBytes: number;
  freelistRatio: number;
  compactionRecommended: boolean;
  checkpointBusy: boolean;
} {
  return {
    databaseBytes: 100 * 1024 * 1024,
    freelistBytes: 80 * 1024 * 1024,
    freelistRatio: 0.4,
    compactionRecommended: true,
    checkpointBusy: false,
    ...overrides,
  };
}

function stores(root: string): {
  refs: CanonicalRefStore;
  manifests: CanonicalManifestStore;
  pins: RevisionPinRegistry;
  overlays: GoalOverlayStore;
} {
  return {
    refs: new CanonicalRefStore(root),
    manifests: new CanonicalManifestStore(root),
    pins: new RevisionPinRegistry(root),
    overlays: new GoalOverlayStore(root),
  };
}

async function seedOneLive(root: string): Promise<string> {
  const { refs, manifests } = stores(root);
  const entries = [{ path: 'live.ts', contentHash: H('a') }];
  const revision = canonicalRevisionId({
    repositoryId: REPO, commitSha: 'c'.repeat(40), treeOid: computeTreeOid(entries), targetRef: REF, parents: [],
  });
  const manifestId = canonicalManifestId({ repositoryId: REPO, revisionId: revision, entries });
  await manifests.put({
    manifestId,
    repositoryId: REPO,
    revisionId: revision,
    commitSha: 'c'.repeat(40),
    treeOid: computeTreeOid(entries),
    targetRef: REF,
    entries,
    createdAt: '2026-10-18T00:00:00.000Z',
  });
  await refs.promote(REF, {
    expectedCurrent: null,
    current: null,
    target: { commitSha: 'c'.repeat(40), treeOid: computeTreeOid(entries), manifestId },
    targetVerified: true,
  });
  return manifestId;
}

function healthyVerify(): Promise<{ status: 'healthy' }> {
  return Promise.resolve({ status: 'healthy' });
}

function degradedVerify(): Promise<CanonicalStoreVerifyReport> {
  return Promise.resolve({
    status: 'degraded',
    danglingRefs: [{ ref: REF, manifestId: H('d') }],
    missingOverlays: ['ws_missing'],
    orphanedPins: [H('e')],
    manifests: [],
  });
}

async function depsFor(root: string, overrides: {
  physical?: ReturnType<typeof evidence>;
  diskFreeBytes?: number | null;
  activeReaderCount?: number;
  verifyDegraded?: boolean;
  fenceOwnerId?: string;
  admissionCost?: number;
} = {}): Promise<{
  deps: MaintenanceCycleDeps;
  refs: CanonicalRefStore;
  manifests: CanonicalManifestStore;
  pins: RevisionPinRegistry;
  overlays: GoalOverlayStore;
  controller: ResourceAdmissionController;
  leaseStore: GcLeaseStore;
  gcCalls: () => number;
  gcFence: () => MaintenanceCycleFence | undefined;
  manifestId: string;
}> {
  const { refs, manifests, pins, overlays } = stores(root);
  const manifestId = await seedOneLive(root);
  const leaseStore = new GcLeaseStore(root);
  const controller = new ResourceAdmissionController(DEFAULT_PROCESS_RESOURCE_ADMISSION_LIMITS);
  const physical = overrides.physical ?? evidence();
  let gcCalls = 0;
  let lastFence: MaintenanceCycleFence | undefined;
  const runGcQuarantine = async (fence: MaintenanceCycleFence): Promise<{ status: 'planned'; reachable: string[]; unreachable: string[]; quarantined: string[] }> => {
    gcCalls += 1;
    lastFence = fence;
    return { status: 'planned', reachable: [H('a')], unreachable: [], quarantined: [] };
  };
  const verifyStore = overrides.verifyDegraded ? degradedVerify : healthyVerify;
  const deps = {
    physical,
    diskFreeBytes: overrides.diskFreeBytes !== undefined ? overrides.diskFreeBytes : 1024 * 1024 * 1024,
    activeReaderCount: overrides.activeReaderCount ?? 0,
    ownerId: overrides.fenceOwnerId ?? 'maintenance-worker',
    workspaceId: 'ws_maintenance',
    now: NOW,
    ttlMs: 60_000,
    leaseStore,
    controller,
    resourceClass: 'child_mcp_call' as const,
    admissionCost: overrides.admissionCost ?? 8,
    runGcQuarantine,
    verifyStore,
  };
  return { deps, refs, manifests, pins, overlays, controller, leaseStore, gcCalls: () => gcCalls, gcFence: () => lastFence, manifestId };
}

describe('runMaintenanceCycle (#210 §5-§7 bounded maintenance cycle)', () => {
  it('completes under one fence and one admission lease, releasing both in finally', async () => {
    const root = await tempRoot();
    const { deps, gcCalls } = await depsFor(root);

    const report = await runMaintenanceCycle(deps);
    expect(report.status).toBe('completed');
    if (report.status !== 'completed') throw new Error('unreachable');
    expect(report.gc.status).toBe('planned');
    expect(report.compaction).toEqual({ status: 'not-requested' });
    expect(report.verification.status).toBe('healthy');
    expect(report.tookFence).toBe(true);
    expect(report.tookAdmission).toBe(true);
    expect(gcCalls()).toBe(1);

    // Fence released: a second cycle can acquire the same store.
    const second = await runMaintenanceCycle(deps);
    expect(second.status).toBe('completed');
  });

  it('hands the GC pass the live fence instead of letting it acquire a second one', async () => {
    const root = await tempRoot();
    const { deps, gcFence, leaseStore } = await depsFor(root);

    const report = await runMaintenanceCycle(deps);
    expect(report.status).toBe('completed');

    const fence = gcFence();
    expect(fence).toBeDefined();
    // The GC pass renews and asserts this exact record: same store, owner and
    // generation the cycle was granted. A second acquire would self-deny while
    // it is live, and no heartbeat at all would let a long pass outlive it.
    expect(fence?.store).toBe(leaseStore);
    expect(fence?.ownerId).toBe('maintenance-worker');
    expect(fence?.generation).toBe(1);
    expect(fence?.ttlMs).toBe(60_000);
    expect(fence?.grantedAt).toEqual(NOW);
    // The owner released it; the GC pass never did.
    expect(await leaseStore.read()).toBeNull();
  });

  it('compacts only after GC, under the same fence, and reports the evidence', async () => {
    const root = await tempRoot();
    const { deps, gcCalls } = await depsFor(root);
    let gcCallsWhenCompacted = -1;
    const compacted = {
      status: 'compacted' as const,
      beforeBytes: 10_000,
      afterBytes: 4_000,
      reclaimedBytes: 6_000,
      beforeFreelistBytes: 7_000,
      afterFreelistBytes: 0,
      checkpointBusy: false,
      checkpointTruncated: true,
      walBytesAfter: 0,
    };

    const report = await runMaintenanceCycle({
      ...deps,
      compactStore: async () => {
        gcCallsWhenCompacted = gcCalls();
        return compacted;
      },
    });
    expect(gcCallsWhenCompacted).toBe(1);
    expect(report.status).toBe('completed');
    if (report.status !== 'completed') throw new Error('unreachable');
    expect(report.compaction).toEqual(compacted);
    expect(report.verification.status).toBe('healthy');
  });

  it('renews the cycle fence at the compaction boundary', async () => {
    const root = await tempRoot();
    const { deps, leaseStore } = await depsFor(root);
    let expiresAtDuringCompaction: string | undefined;

    const report = await runMaintenanceCycle({
      ...deps,
      // Half the 60s window has elapsed when compaction starts.
      clock: () => new Date(NOW.getTime() + 31_000),
      compactStore: async () => {
        expiresAtDuringCompaction = (await leaseStore.read())?.expiresAt;
        return { status: 'planned', reason: 'pressure-justified' };
      },
    });
    expect(report.status).toBe('completed');
    // The renewal is written against the grant, not a second acquisition.
    expect(expiresAtDuringCompaction).toBe('2026-10-18T10:01:31.000Z');
  });

  it('reports a reader-pressure compaction skip without failing the cycle', async () => {
    const root = await tempRoot();
    const { deps } = await depsFor(root);
    const report = await runMaintenanceCycle({
      ...deps,
      compactStore: async () => ({ status: 'skipped', reason: 'reader-pressure', detail: 'database is locked' }),
    });
    expect(report.status).toBe('completed');
    if (report.status !== 'completed') throw new Error('unreachable');
    expect(report.compaction).toEqual({ status: 'skipped', reason: 'reader-pressure', detail: 'database is locked' });
    expect(report.verification.status).toBe('healthy');
  });

  it('refuses compaction-failed and releases both locks', async () => {
    const root = await tempRoot();
    const { deps, leaseStore, controller } = await depsFor(root);
    const report = await runMaintenanceCycle({
      ...deps,
      compactStore: async () => {
        throw new Error('disk I/O error');
      },
    });
    expect(report).toEqual({
      status: 'refused',
      reason: 'compaction-failed',
      detail: 'disk I/O error',
      tookFence: true,
      tookAdmission: true,
    });
    expect(await leaseStore.read()).toBeNull();
    expect(controller.snapshot().activeOperations).toBe(0);
    expect(controller.snapshot().activeCost).toBe(0);
  });

  it('reports degraded verification, not just the compaction error, when both fail', async () => {
    const root = await tempRoot();
    const { deps } = await depsFor(root, { verifyDegraded: true });
    const report = await runMaintenanceCycle({
      ...deps,
      compactStore: async () => {
        throw new Error('disk I/O error');
      },
    });
    expect(report).toEqual({
      status: 'refused',
      reason: 'verify-degraded',
      detail: 'dangling refs 1 missing overlays 1 orphaned pins 1; compaction failed: disk I/O error',
      tookFence: true,
      tookAdmission: true,
    });
  });

  it('keeps the compaction failure when verification throws while diagnosing it', async () => {
    const root = await tempRoot();
    const { deps, leaseStore, controller } = await depsFor(root);
    const report = await runMaintenanceCycle({
      ...deps,
      verifyStore: async () => {
        throw new Error('manifest unreadable');
      },
      compactStore: async () => {
        throw new Error('disk I/O error');
      },
    });
    // The verification error must not replace the compaction failure that
    // triggered the diagnosis, and the refusal still releases both locks.
    expect(report).toEqual({
      status: 'refused',
      reason: 'compaction-failed',
      detail: 'disk I/O error; verification threw: manifest unreadable',
      tookFence: true,
      tookAdmission: true,
    });
    expect(await leaseStore.read()).toBeNull();
    expect(controller.snapshot().activeOperations).toBe(0);
    expect(controller.snapshot().activeCost).toBe(0);
  });

  it('propagates a lost fence before compaction and releases the grant', async () => {
    const root = await tempRoot();
    const { deps, leaseStore } = await depsFor(root);
    await expect(runMaintenanceCycle({
      ...deps,
      compactStore: async () => {
        throw new GcLeaseLostError('fence replaced');
      },
    })).rejects.toThrow('fence replaced');
    expect(await leaseStore.read()).toBeNull();
  });

  it('stops before compaction when the heartbeat assert finds the fence lost', async () => {
    const root = await tempRoot();
    const { deps, leaseStore } = await depsFor(root);
    let compactionCalls = 0;
    // Half the TTL later the heartbeat is due. The GC stub released the grant
    // instead of renewing it, so the assert at the compaction boundary fails
    // closed and the callback is never reached — an assert-driven loss, not a
    // callback that throws on its own.
    await expect(runMaintenanceCycle({
      ...deps,
      clock: () => new Date(NOW.getTime() + 30_000),
      runGcQuarantine: async (fence) => {
        await leaseStore.release({ ownerId: fence.ownerId, generation: fence.generation });
        return { status: 'planned', reachable: [H('a')], unreachable: [], quarantined: [] };
      },
      compactStore: async () => {
        compactionCalls += 1;
        return { status: 'skipped', reason: 'reader-pressure', detail: 'never reached' };
      },
    })).rejects.toThrow('no longer held');
    expect(compactionCalls).toBe(0);
    expect(await leaseStore.read()).toBeNull();
  });

  it('skips below threshold without taking admission', async () => {
    const root = await tempRoot();
    const { deps, gcCalls } = await depsFor(root, { physical: evidence({ compactionRecommended: false, freelistBytes: 8 * 1024 * 1024, freelistRatio: 0.02 }) });

    const report = await runMaintenanceCycle(deps);
    expect(report).toEqual({ status: 'skipped', reason: 'below-threshold', tookFence: true, tookAdmission: false });
    expect(gcCalls()).toBe(0);
  });

  it('skips when checkpoint busy or readers hold the database', async () => {
    const root = await tempRoot();
    const { deps } = await depsFor(root, { physical: evidence({ checkpointBusy: true }) });
    expect((await runMaintenanceCycle(deps))).toEqual({ status: 'skipped', reason: 'reader-pressure', tookFence: true, tookAdmission: false });

    const root2 = await tempRoot();
    const { deps: deps2 } = await depsFor(root2, { activeReaderCount: 2 });
    expect((await runMaintenanceCycle(deps2))).toEqual({ status: 'skipped', reason: 'reader-pressure', tookFence: true, tookAdmission: false });
  });

  it('refuses unknown or insufficient headroom before any fence', async () => {
    const root = await tempRoot();
    const { deps } = await depsFor(root, { diskFreeBytes: null });
    const r1 = await runMaintenanceCycle(deps);
    expect(r1).toEqual({
      status: 'refused',
      reason: 'headroom-unknown',
      detail: 'databaseBytes 104857600 diskFreeBytes unknown',
      tookFence: false,
      tookAdmission: false,
    });

    const root2 = await tempRoot();
    const { deps: deps2 } = await depsFor(root2, { diskFreeBytes: 10 * 1024 * 1024 });
    const r2 = await runMaintenanceCycle(deps2);
    expect(r2).toEqual({
      status: 'refused',
      reason: 'headroom-insufficient',
      detail: 'required 276824064 bytes free 10485760',
      tookFence: false,
      tookAdmission: false,
    });
  });

  it('refuses when the fence is held or corrupt, failing closed', async () => {
    // Held: occupy the fence with an unexpired lease.
    const root = await tempRoot();
    const { deps } = await depsFor(root);
    const leaseStore = deps.leaseStore;
    await leaseStore.acquire({ ownerId: 'other-worker', now: NOW, ttlMs: 60_000 });
    const r1 = await runMaintenanceCycle(deps);
    expect(r1).toEqual({
      status: 'refused',
      reason: 'fence-acquire-failed',
      detail: 'held by other-worker until 2026-10-18T10:01:00.000Z',
      tookFence: false,
      tookAdmission: false,
    });
  });

  it('refuses when admission is rejected', async () => {
    const root = await tempRoot();
    const { deps } = await depsFor(root, { admissionCost: 999_999 });
    const report = await runMaintenanceCycle(deps);
    expect(report).toMatchObject({
      status: 'refused',
      reason: 'admission-rejected',
      tookFence: true,
      tookAdmission: false,
    });
    if (report.status !== 'refused') throw new Error('unexpected');
    expect(report.detail).toMatch(/^admission denied: /);
    // Fence released: another cycle can still run.
    const deps2 = await depsFor(root);
    expect((await runMaintenanceCycle(deps2.deps)).status).toBe('completed');
  });

  it('refuses when GC quarantine refuses', async () => {
    const root = await tempRoot();
    const { deps } = await depsFor(root);
    const runGcQuarantine = async (): Promise<{ status: 'refused'; reason: string }> => ({ status: 'refused', reason: 'missing root manifest' });
    const report = await runMaintenanceCycle({ ...deps, runGcQuarantine });
    expect(report).toEqual({
      status: 'refused',
      reason: 'gc-refused',
      detail: 'missing root manifest',
      tookFence: true,
      tookAdmission: true,
    });
  });

  it('refuses when post-maintenance verification is degraded', async () => {
    const root = await tempRoot();
    const { deps } = await depsFor(root, { verifyDegraded: true });
    const report = await runMaintenanceCycle(deps);
    expect(report).toEqual({
      status: 'refused',
      reason: 'verify-degraded',
      detail: 'dangling refs 1 missing overlays 1 orphaned pins 1',
      tookFence: true,
      tookAdmission: true,
    });
  });

  it('releases the fence and admission lease when GC quarantine throws', async () => {
    const root = await tempRoot();
    const { deps, leaseStore, controller } = await depsFor(root);
    const runGcQuarantine = async (): Promise<never> => {
      throw new Error('gc interrupted');
    };

    await expect(runMaintenanceCycle({ ...deps, runGcQuarantine })).rejects.toThrow('gc interrupted');

    // Interruption must not leak either lock.
    expect(await leaseStore.read()).toBeNull();
    expect(controller.snapshot().activeOperations).toBe(0);
    expect(controller.snapshot().activeCost).toBe(0);
  });

  it('releases the fence and admission lease when post-maintenance verification throws', async () => {
    const root = await tempRoot();
    const { deps, leaseStore, controller } = await depsFor(root);
    const verifyStore = async (): Promise<never> => {
      throw new Error('verify interrupted');
    };

    await expect(runMaintenanceCycle({ ...deps, verifyStore })).rejects.toThrow('verify interrupted');

    expect(await leaseStore.read()).toBeNull();
    expect(controller.snapshot().activeOperations).toBe(0);
    expect(controller.snapshot().activeCost).toBe(0);
  });

  it('leaves the fence takeable by a successor after an interrupted run', async () => {
    const root = await tempRoot();
    const first = await depsFor(root);
    const runGcQuarantine = async (): Promise<never> => {
      throw new Error('gc interrupted');
    };
    await expect(runMaintenanceCycle({ ...first.deps, runGcQuarantine })).rejects.toThrow();

    const second = await depsFor(root);
    expect((await runMaintenanceCycle(second.deps)).status).toBe('completed');
  });
});
