import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalManifestId, canonicalRevisionId, fileArtifactId } from '@unified-mpc/domain';
import { CanonicalRefStore } from './canonical-ref-store.js';
import { CanonicalManifestStore, type StoredManifest } from './canonical-manifest-store.js';
import { GcLeaseLostError, GcLeaseStore } from './gc-lease.js';
import { GoalOverlayStore } from './goal-overlay-store.js';
import { RevisionPinRegistry } from './revision-pin-registry.js';
import { repairCanonicalStore, type CanonicalStoreRepairLease } from './canonical-store-repair.js';
import { verifyCanonicalStore } from './canonical-store-verify.js';
import { CanonicalArtifactStore } from './canonical-artifact-store.js';
import { collectRetainedManifestIds, planRepositoryArtifactGc } from './artifact-key-gc.js';
import { assembleGcRoots } from './artifact-gc-roots.js';

const REPO = 'repo_abc123';
const REF = 'refs/remotes/origin/main';
const H = (n: string): string => n.repeat(64).slice(0, 64);
const MISSING = `man:v1:${'a'.repeat(64)}`;

function manifestFor(commitSha: string, entries: readonly { path: string; contentHash: string }[]): StoredManifest {
  const revisionId = canonicalRevisionId({
    repositoryId: REPO, commitSha, treeOid: commitSha, targetRef: REF, parents: [],
  });
  return {
    manifestId: canonicalManifestId({ repositoryId: REPO, revisionId, entries }),
    repositoryId: REPO,
    revisionId,
    commitSha,
    treeOid: commitSha,
    targetRef: REF,
    entries,
    createdAt: '2026-10-17T00:00:00.000Z',
  };
}

const LEASE_OWNER = 'test-repair';

function leaseFor(store: GcLeaseStore): CanonicalStoreRepairLease {
  return { store, ownerId: LEASE_OWNER, ttlMs: 60_000 };
}

interface RepairScenario {
  readonly dir: string;
  readonly refs: CanonicalRefStore;
  readonly manifests: CanonicalManifestStore;
  readonly strictManifests: CanonicalManifestStore;
  readonly pins: RevisionPinRegistry;
  readonly overlays: GoalOverlayStore;
  readonly lease: GcLeaseStore;
  readonly live: StoredManifest;
}

async function scenario(): Promise<RepairScenario> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'canonical-repair-'));
  const refs = new CanonicalRefStore(dir);
  const manifests = new CanonicalManifestStore(dir);
  const strictManifests = new CanonicalManifestStore(dir, { strictReads: true });
  const pins = new RevisionPinRegistry(dir);
  const overlays = new GoalOverlayStore(dir);
  const lease = new GcLeaseStore(dir);
  const live = manifestFor('c'.repeat(40), [{ path: 'live.ts', contentHash: H('1') }]);
  await manifests.put(live);
  await refs.promote(REF, {
    expectedCurrent: null, current: null,
    target: { commitSha: live.commitSha, treeOid: live.treeOid, manifestId: live.manifestId },
    targetVerified: true,
  });
  return { dir, refs, manifests, strictManifests, pins, overlays, lease, live };
}

describe('canonical store repair (#210 §7)', () => {
  it('plans an orphan pin without writing and without taking the lease', async () => {
    const s = await scenario();
    try {
      await s.pins.pin(MISSING, 'user-pin', 'hold');
      const report = await repairCanonicalStore({
        refs: s.refs,
        manifests: s.strictManifests,
        pins: s.pins,
        overlays: s.overlays,
        dryRun: true,
        lease: leaseFor(s.lease),
      });
      expect(report).toMatchObject({
        status: 'planned',
        orphanPins: [{ manifestId: MISSING, reasons: ['user-pin'] }],
        danglingRefs: [],
        missingOverlayBases: [],
      });
      // A dry run never takes the lease and never removes the pin.
      expect(await s.lease.inspect()).toEqual({ status: 'free' });
      expect(await s.pins.isPinned(MISSING)).toBe(true);
    } finally {
      await rm(s.dir, { recursive: true, force: true });
    }
  });

  it('removes every reason on a pin whose manifest is missing and releases the lease', async () => {
    const s = await scenario();
    try {
      await s.pins.pin(MISSING, 'rollback', 'last known good');
      await s.pins.pin(MISSING, 'user-pin', 'keep');
      const report = await repairCanonicalStore({
        refs: s.refs,
        manifests: s.strictManifests,
        pins: s.pins,
        overlays: s.overlays,
        dryRun: false,
        lease: leaseFor(s.lease),
      });
      expect(report).toMatchObject({
        status: 'applied',
        orphanPins: [{ manifestId: MISSING, reasons: ['rollback', 'user-pin'] }],
      });
      expect(await s.pins.isPinned(MISSING)).toBe(false);
      expect(await s.lease.read()).toBeNull();
      // The healthy ref and its manifest are untouched.
      expect((await s.refs.read(REF))!.manifestId).toBe(s.live.manifestId);
      expect(await s.manifests.get(s.live.manifestId)).not.toBeNull();
    } finally {
      await rm(s.dir, { recursive: true, force: true });
    }
  });

  it('never removes a pin whose manifest still exists', async () => {
    const s = await scenario();
    try {
      await s.pins.pin(s.live.manifestId, 'rollback', 'protected');
      const report = await repairCanonicalStore({
        refs: s.refs,
        manifests: s.strictManifests,
        pins: s.pins,
        overlays: s.overlays,
        dryRun: false,
        lease: leaseFor(s.lease),
      });
      expect(report).toMatchObject({ status: 'applied', orphanPins: [] });
      expect(await s.pins.isPinned(s.live.manifestId)).toBe(true);
    } finally {
      await rm(s.dir, { recursive: true, force: true });
    }
  });

  it('reports dangling refs and missing overlay bases instead of deleting them', async () => {
    const s = await scenario();
    try {
      const ghost = `man:v1:${'b'.repeat(64)}`;
      await s.refs.promote(REF, {
        expectedCurrent: null,
        current: null,
        target: { commitSha: 'd'.repeat(40), treeOid: 'd'.repeat(40), manifestId: ghost },
        targetVerified: true,
      });
      await s.overlays.create('goal-ghost', {
        baseCommitSha: 'e'.repeat(40), baseTreeOid: 'e'.repeat(40), baseManifestId: ghost,
      });
      await s.pins.pin(MISSING, 'user-pin', 'orphan');

      const report = await repairCanonicalStore({
        refs: s.refs,
        manifests: s.strictManifests,
        pins: s.pins,
        overlays: s.overlays,
        dryRun: false,
        lease: leaseFor(s.lease),
      });
      expect(report).toMatchObject({
        status: 'applied',
        orphanPins: [{ manifestId: MISSING, reasons: ['user-pin'] }],
        danglingRefs: [{ ref: REF, manifestId: ghost }],
        missingOverlayBases: ['goal-ghost'],
      });
      // The ref and the overlay still hold the evidence only their owner can fix.
      expect((await s.refs.read(REF))!.manifestId).toBe(ghost);
      expect(await s.overlays.listIds()).toEqual(['goal-ghost']);
      expect(await s.pins.isPinned(MISSING)).toBe(false);
    } finally {
      await rm(s.dir, { recursive: true, force: true });
    }
  });

  it('refuses an apply with no lease and removes nothing', async () => {
    const s = await scenario();
    try {
      await s.pins.pin(MISSING, 'user-pin', 'orphan');
      const report = await repairCanonicalStore({
        refs: s.refs,
        manifests: s.strictManifests,
        pins: s.pins,
        overlays: s.overlays,
        dryRun: false,
      });
      expect(report).toMatchObject({ status: 'refused' });
      if (report.status !== 'refused') throw new Error('expected a refusal');
      expect(report.reason).toContain('lease');
      expect(await s.pins.isPinned(MISSING)).toBe(true);
    } finally {
      await rm(s.dir, { recursive: true, force: true });
    }
  });

  it('refuses while another owner holds the lease and removes nothing', async () => {
    const s = await scenario();
    try {
      await s.pins.pin(MISSING, 'user-pin', 'orphan');
      const acquired = await s.lease.acquire({ ownerId: 'other_gc', now: new Date(), ttlMs: 60_000 });
      if (acquired.status !== 'granted') throw new Error(`expected a granted lease, got ${acquired.status}`);
      const report = await repairCanonicalStore({
        refs: s.refs,
        manifests: s.strictManifests,
        pins: s.pins,
        overlays: s.overlays,
        dryRun: false,
        lease: leaseFor(s.lease),
      });
      expect(report).toMatchObject({ status: 'refused' });
      if (report.status !== 'refused') throw new Error('expected a refusal');
      expect(report.reason).toContain('held by other_gc');
      expect(await s.pins.isPinned(MISSING)).toBe(true);
    } finally {
      await rm(s.dir, { recursive: true, force: true });
    }
  });

  it('aborts before any mutation when a pin names a corrupt manifest row', async () => {
    const s = await scenario();
    try {
      const corrupt = `man:v1:${'f'.repeat(64)}`;
      await s.pins.pin(MISSING, 'user-pin', 'genuinely missing');
      await s.pins.pin(corrupt, 'user-pin', 'corrupt row');
      await mkdir(path.join(s.dir, 'manifests'), { recursive: true });
      await writeFile(path.join(s.dir, 'manifests', `${corrupt}.json`), '{not a manifest', 'utf8');

      await expect(repairCanonicalStore({
        refs: s.refs,
        manifests: s.strictManifests,
        pins: s.pins,
        overlays: s.overlays,
        dryRun: false,
        lease: leaseFor(s.lease),
      })).rejects.toThrow(`cannot read canonical manifest ${corrupt}`);
      // Classification finishes before the first unpin, so the genuinely
      // missing pin is still there and the fence was released.
      expect(await s.pins.isPinned(MISSING)).toBe(true);
      expect(await s.pins.isPinned(corrupt)).toBe(true);
      expect(await s.lease.read()).toBeNull();
    } finally {
      await rm(s.dir, { recursive: true, force: true });
    }
  });

  it('refuses an unreadable pin record instead of skipping it', async () => {
    const s = await scenario();
    try {
      await mkdir(path.join(s.dir, 'pins'), { recursive: true });
      await writeFile(path.join(s.dir, 'pins', `${MISSING}.json`), '{not a pin', 'utf8');
      await expect(repairCanonicalStore({
        refs: s.refs,
        manifests: s.strictManifests,
        pins: s.pins,
        overlays: s.overlays,
        dryRun: true,
      })).rejects.toThrow('cannot read revision pin');
    } finally {
      await rm(s.dir, { recursive: true, force: true });
    }
  });

  it('reads orphan-pin reasons strictly after the listing accepted the id', async () => {
    const s = await scenario();
    try {
      await mkdir(path.join(s.dir, 'pins'), { recursive: true });
      await writeFile(path.join(s.dir, 'pins', `${MISSING}.json`), '{not a pin', 'utf8');
      // Force the listing past the id it would return, so the only read left is
      // the one that resolves the reasons. A tolerant read here would plan the
      // pin with no reasons and report the store repaired.
      class ListingOnlyPins extends RevisionPinRegistry {
        public override async pinnedManifestIds(): Promise<string[]> {
          return [MISSING];
        }
      }
      await expect(repairCanonicalStore({
        refs: s.refs,
        manifests: s.strictManifests,
        pins: new ListingOnlyPins(s.dir),
        overlays: s.overlays,
        dryRun: true,
      })).rejects.toThrow('cannot read revision pin');
    } finally {
      await rm(s.dir, { recursive: true, force: true });
    }
  });

  it('refuses a non-canonical pin file name instead of reporting the store repaired', async () => {
    const s = await scenario();
    try {
      await mkdir(path.join(s.dir, 'pins'), { recursive: true });
      const record = [{ manifestId: MISSING, reason: 'user-pin', note: 'hold', createdAt: '2026-11-05T00:00:00.000Z' }];
      const pinPath = path.join(s.dir, 'pins', `${MISSING.toUpperCase()}.json`);
      await writeFile(pinPath, JSON.stringify(record), 'utf8');

      // A case-insensitive pin file name passes the strict listing regex but
      // resolves to a different, absent path when the reasons are read back.
      // Claiming `applied orphan-pins 0` would leave the store degraded.
      await expect(repairCanonicalStore({
        refs: s.refs,
        manifests: s.strictManifests,
        pins: s.pins,
        overlays: s.overlays,
        dryRun: false,
        lease: leaseFor(s.lease),
      })).rejects.toThrow('cannot read revision pin');
      expect(await s.pins.list(MISSING)).toEqual([]);
      expect(await s.lease.read()).toBeNull();
    } finally {
      await rm(s.dir, { recursive: true, force: true });
    }
  });

  it('is idempotent and leaves the verify report healthy', async () => {
    const s = await scenario();
    try {
      await s.pins.pin(MISSING, 'user-pin', 'orphan');
      const first = await repairCanonicalStore({
        refs: s.refs,
        manifests: s.strictManifests,
        pins: s.pins,
        overlays: s.overlays,
        dryRun: false,
        lease: leaseFor(s.lease),
      });
      expect(first).toMatchObject({ status: 'applied', orphanPins: [{ manifestId: MISSING }] });
      const second = await repairCanonicalStore({
        refs: s.refs,
        manifests: s.strictManifests,
        pins: s.pins,
        overlays: s.overlays,
        dryRun: false,
        lease: leaseFor(s.lease),
      });
      expect(second).toMatchObject({ status: 'applied', orphanPins: [] });
      const verify = await verifyCanonicalStore({
        refs: s.refs, manifests: s.manifests, pins: s.pins, overlays: s.overlays,
      });
      expect(verify.status).toBe('healthy');
    } finally {
      await rm(s.dir, { recursive: true, force: true });
    }
  });

  it('releases artifact retention and unblocks GC roots when the orphan pin is removed', async () => {
    const s = await scenario();
    try {
      await s.pins.pin(MISSING, 'rollback', 'orphan');
      const artifacts = new CanonicalArtifactStore(s.dir);
      const orphanKey = fileArtifactId({
        sourceContentSha256: H('7'),
        language: 'typescript',
        sourceKind: 'source',
        representationVersion: 'v1',
      });
      const liveKey = fileArtifactId({
        sourceContentSha256: H('8'),
        language: 'typescript',
        sourceKind: 'source',
        representationVersion: 'v1',
      });
      await artifacts.put({
        kind: 'file',
        artifactKey: orphanKey,
        repositoryId: REPO,
        sourceContentSha256: H('7'),
        language: 'typescript',
        sourceKind: 'source',
        representationVersion: 'v1',
        bindings: [{ path: 'src/orphan.ts', manifestId: MISSING }],
        createdAt: '2026-10-17T00:00:00.000Z',
      });
      // A second artifact stays reachable through the live ref, so the plan has
      // reachability evidence and does not refuse for the wrong reason.
      await artifacts.put({
        kind: 'file',
        artifactKey: liveKey,
        repositoryId: REPO,
        sourceContentSha256: H('8'),
        language: 'typescript',
        sourceKind: 'source',
        representationVersion: 'v1',
        bindings: [{ path: 'src/live.ts', manifestId: s.live.manifestId }],
        createdAt: '2026-10-17T00:00:00.000Z',
      });

      // While the pin exists it is retention evidence, but the missing
      // manifest also refuses the whole GC root assembly.
      const before = await collectRetainedManifestIds({
        refs: s.refs, pins: s.pins, overlays: s.overlays, indexJobManifestIds: [],
      });
      expect(before).toContain(MISSING);
      const beforePlan = await planRepositoryArtifactGc({
        store: artifacts, repositoryId: REPO, retainedManifestIds: before,
      });
      expect(beforePlan).toMatchObject({ status: 'planned', unreachable: [] });
      if (beforePlan.status !== 'planned') throw new Error('expected a plan');
      expect(beforePlan.reachable.sort()).toEqual([orphanKey, liveKey].sort());
      await expect(assembleGcRoots({
        manifests: s.manifests, refs: s.refs, pins: s.pins, overlays: s.overlays, indexJobManifestIds: [],
      })).rejects.toThrow('missing manifests on disk');

      const report = await repairCanonicalStore({
        refs: s.refs,
        manifests: s.strictManifests,
        pins: s.pins,
        overlays: s.overlays,
        dryRun: false,
        lease: leaseFor(s.lease),
      });
      expect(report).toMatchObject({ status: 'applied', orphanPins: [{ manifestId: MISSING }] });

      // The pin is gone, so the artifact bound only to the missing manifest is
      // now a GC candidate and root assembly can proceed. This is the intended
      // reachability change, not a no-op.
      const after = await collectRetainedManifestIds({
        refs: s.refs, pins: s.pins, overlays: s.overlays, indexJobManifestIds: [],
      });
      expect(after).not.toContain(MISSING);
      const afterPlan = await planRepositoryArtifactGc({
        store: artifacts, repositoryId: REPO, retainedManifestIds: after,
      });
      expect(afterPlan).toMatchObject({ status: 'planned', reachable: [liveKey], unreachable: [orphanKey] });
      await expect(assembleGcRoots({
        manifests: s.manifests, refs: s.refs, pins: s.pins, overlays: s.overlays, indexJobManifestIds: [],
      })).resolves.toBeDefined();
    } finally {
      await rm(s.dir, { recursive: true, force: true });
    }
  });

  it('refuses a tolerant manifest store instead of treating a corrupt row as missing', async () => {
    const s = await scenario();
    try {
      await s.pins.pin(MISSING, 'user-pin', 'orphan');
      const report = await repairCanonicalStore({
        refs: s.refs,
        manifests: s.manifests,
        pins: s.pins,
        overlays: s.overlays,
        dryRun: true,
      });
      expect(report).toMatchObject({ status: 'refused' });
      if (report.status !== 'refused') throw new Error('expected a refusal');
      expect(report.reason).toContain('strict-read');
      expect(await s.pins.isPinned(MISSING)).toBe(true);
    } finally {
      await rm(s.dir, { recursive: true, force: true });
    }
  });

  it('leaves a pin in place when its manifest is re-created after classification', async () => {
    const s = await scenario();
    try {
      const orphan = manifestFor('f'.repeat(40), [{ path: 'orphan.ts', contentHash: H('7') }]);
      await s.manifests.put(orphan);
      await s.pins.pin(orphan.manifestId, 'user-pin', 'orphan');
      await rm(path.join(s.dir, 'manifests', `${orphan.manifestId}.json`));
      const recreatedPins = {
        pinnedManifestIds: (options?: Parameters<RevisionPinRegistry['pinnedManifestIds']>[0]) =>
          s.pins.pinnedManifestIds(options),
        list: async (manifestId: string) => {
          // Simulate advanceRevisionFromGit re-creating the row between the
          // classification read and the removal loop.
          await s.manifests.put(orphan);
          return s.pins.list(manifestId);
        },
        unpin: (manifestId: string, reason: Parameters<RevisionPinRegistry['unpin']>[1]) =>
          s.pins.unpin(manifestId, reason),
      } as unknown as RevisionPinRegistry;

      const report = await repairCanonicalStore({
        refs: s.refs,
        manifests: s.strictManifests,
        pins: recreatedPins,
        overlays: s.overlays,
        dryRun: false,
        lease: leaseFor(s.lease),
      });
      expect(report).toMatchObject({ status: 'applied', orphanPins: [] });
      expect(await s.pins.isPinned(orphan.manifestId)).toBe(true);
      expect(await s.manifests.get(orphan.manifestId)).not.toBeNull();
    } finally {
      await rm(s.dir, { recursive: true, force: true });
    }
  });

  it('stops removing when a newer generation takes the fence mid-pass', async () => {
    const s = await scenario();
    try {
      const second = `man:v1:${'9'.repeat(64)}`;
      await s.pins.pin(`man:v1:${'8'.repeat(64)}`, 'user-pin', 'first');
      await s.pins.pin(second, 'user-pin', 'second');
      const grantAt = new Date('2026-10-17T00:02:00.000Z');
      let now = grantAt;
      let handedOver = false;
      const wrapped = {
        pinnedManifestIds: (options?: Parameters<RevisionPinRegistry['pinnedManifestIds']>[0]) =>
          s.pins.pinnedManifestIds(options),
        list: (manifestId: string) => s.pins.list(manifestId),
        unpin: async (manifestId: string, reason: 'user-pin'): Promise<boolean> => {
          if (!handedOver) {
            handedOver = true;
            const held = await s.lease.read();
            if (held === null) throw new Error('expected a held lease');
            await s.lease.release({ ownerId: LEASE_OWNER, generation: held.generation });
            await s.lease.acquire({ ownerId: 'gc_successor', now, ttlMs: 60_000 });
            now = new Date(now.getTime() + 30_000);
          }
          return s.pins.unpin(manifestId, reason);
        },
      } as unknown as RevisionPinRegistry;
      await expect(repairCanonicalStore({
        refs: s.refs,
        manifests: s.strictManifests,
        pins: wrapped,
        overlays: s.overlays,
        dryRun: false,
        now: grantAt,
        lease: { store: s.lease, ownerId: LEASE_OWNER, ttlMs: 60_000, clock: () => now },
      })).rejects.toThrow(GcLeaseLostError);
      // One orphan was removed under the fence; its sibling survives.
      const survivors = await Promise.all([
        s.pins.isPinned(`man:v1:${'8'.repeat(64)}`),
        s.pins.isPinned(second),
      ]);
      expect(survivors.filter(Boolean)).toHaveLength(1);
      expect(await s.lease.inspect()).toMatchObject({ status: 'held', ownerId: 'gc_successor', generation: 2 });
    } finally {
      await rm(s.dir, { recursive: true, force: true });
    }
  });
});
