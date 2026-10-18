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
import { GcLeaseStore } from './gc-lease.js';
import { runMaintenanceCycle } from './maintenance-cycle.js';

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

function degradedVerify(): Promise<{ status: 'degraded' }> {
  return Promise.resolve({ status: 'degraded' });
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
  manifestId: string;
}> {
  const { refs, manifests, pins, overlays } = stores(root);
  const manifestId = await seedOneLive(root);
  const leaseStore = new GcLeaseStore(root);
  const controller = new ResourceAdmissionController(DEFAULT_PROCESS_RESOURCE_ADMISSION_LIMITS);
  const physical = overrides.physical ?? evidence();
  let gcCalls = 0;
  const runGcQuarantine = async (): Promise<{ status: 'planned'; reachable: string[]; unreachable: string[]; quarantined: string[] }> => {
    gcCalls += 1;
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
  return { deps, refs, manifests, pins, overlays, controller, leaseStore, gcCalls: () => gcCalls, manifestId };
}

describe('runMaintenanceCycle (#210 §5-§7 bounded maintenance cycle)', () => {
  it('completes under one fence and one admission lease, releasing both in finally', async () => {
    const root = await tempRoot();
    const { deps, gcCalls } = await depsFor(root);

    const report = await runMaintenanceCycle(deps);
    expect(report.status).toBe('completed');
    if (report.status !== 'completed') throw new Error('unreachable');
    expect(report.gc.status).toBe('planned');
    expect(report.verification.status).toBe('healthy');
    expect(report.tookFence).toBe(true);
    expect(report.tookAdmission).toBe(true);
    expect(gcCalls()).toBe(1);

    // Fence released: a second cycle can acquire the same store.
    const second = await runMaintenanceCycle(deps);
    expect(second.status).toBe('completed');
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
    expect(r1).toEqual({ status: 'refused', reason: 'headroom-unknown', tookFence: false, tookAdmission: false });

    const root2 = await tempRoot();
    const { deps: deps2 } = await depsFor(root2, { diskFreeBytes: 10 * 1024 * 1024 });
    const r2 = await runMaintenanceCycle(deps2);
    expect(r2).toEqual({ status: 'refused', reason: 'headroom-insufficient', tookFence: false, tookAdmission: false });
  });

  it('refuses when the fence is held or corrupt, failing closed', async () => {
    // Held: occupy the fence with an unexpired lease.
    const root = await tempRoot();
    const { deps } = await depsFor(root);
    const leaseStore = deps.leaseStore;
    await leaseStore.acquire({ ownerId: 'other-worker', now: NOW, ttlMs: 60_000 });
    const r1 = await runMaintenanceCycle(deps);
    expect(r1).toEqual({ status: 'refused', reason: 'fence-acquire-failed', tookFence: false, tookAdmission: false });
  });

  it('refuses when admission is rejected', async () => {
    const root = await tempRoot();
    const { deps } = await depsFor(root, { admissionCost: 999_999 });
    const report = await runMaintenanceCycle(deps);
    expect(report).toEqual({ status: 'refused', reason: 'admission-rejected', tookFence: true, tookAdmission: false });
    // Fence released: another cycle can still run.
    const deps2 = await depsFor(root);
    expect((await runMaintenanceCycle(deps2.deps)).status).toBe('completed');
  });

  it('refuses when GC quarantine refuses', async () => {
    const root = await tempRoot();
    const { deps } = await depsFor(root);
    const runGcQuarantine = async (): Promise<{ status: 'refused'; reason: string }> => ({ status: 'refused', reason: 'missing root manifest' });
    const report = await runMaintenanceCycle({ ...deps, runGcQuarantine });
    expect(report).toEqual({ status: 'refused', reason: 'gc-refused', tookFence: true, tookAdmission: true });
  });

  it('refuses when post-maintenance verification is degraded', async () => {
    const root = await tempRoot();
    const { deps } = await depsFor(root, { verifyDegraded: true });
    const report = await runMaintenanceCycle(deps);
    expect(report).toEqual({ status: 'refused', reason: 'verify-degraded', tookFence: true, tookAdmission: true });
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
