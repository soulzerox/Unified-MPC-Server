import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalManifestId, canonicalRevisionId } from '@unified-mpc/domain';
import { CanonicalRefStore } from './canonical-ref-store.js';
import { CanonicalManifestStore, type StoredManifest } from './canonical-manifest-store.js';
import { GcLeaseLostError, GcLeaseStore } from './gc-lease.js';
import { GoalOverlayStore } from './goal-overlay-store.js';
import { RevisionPinRegistry } from './revision-pin-registry.js';
import { pruneRevisionManifests, type RevisionPruneLease } from './revision-prune.js';

const REPO = 'repo_abc123';
const REF = 'refs/remotes/origin/main';
const H = (n: string): string => n.repeat(64).slice(0, 64);

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

const LEASE_OWNER = 'test-prune';

function leaseFor(store: GcLeaseStore): RevisionPruneLease {
  return { store, ownerId: LEASE_OWNER, ttlMs: 60_000 };
}

async function scenario(): Promise<{
  dir: string;
  refs: CanonicalRefStore;
  manifests: CanonicalManifestStore;
  pins: RevisionPinRegistry;
  overlays: GoalOverlayStore;
  lease: GcLeaseStore;
  active: StoredManifest;
  pinned: StoredManifest;
  overlayBase: StoredManifest;
  stale: StoredManifest;
}> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'revision-prune-'));
  const refs = new CanonicalRefStore(dir);
  const manifests = new CanonicalManifestStore(dir);
  const pins = new RevisionPinRegistry(dir);
  const overlays = new GoalOverlayStore(dir);
  const lease = new GcLeaseStore(dir);
  const active = manifestFor('c'.repeat(40), [{ path: 'live.ts', contentHash: H('1') }]);
  const pinned = manifestFor('d'.repeat(40), [{ path: 'lkg.ts', contentHash: H('2') }]);
  const overlayBase = manifestFor('e'.repeat(40), [{ path: 'base.ts', contentHash: H('3') }]);
  const stale = manifestFor('f'.repeat(40), [{ path: 'old.ts', contentHash: H('4') }]);
  for (const m of [active, pinned, overlayBase, stale]) await manifests.put(m);
  await refs.promote(REF, {
    expectedCurrent: null, current: null,
    target: { commitSha: active.commitSha, treeOid: active.treeOid, manifestId: active.manifestId },
    targetVerified: true,
  });
  await pins.pin(pinned.manifestId, 'rollback', 'keep LKG');
  await overlays.create('goal-1', {
    baseCommitSha: overlayBase.commitSha, baseTreeOid: overlayBase.treeOid, baseManifestId: overlayBase.manifestId,
  });
  return { dir, refs, manifests, pins, overlays, lease, active, pinned, overlayBase, stale };
}

describe('revision manifest prune (#210 U20)', () => {
  it('dry-run reports unreferenced manifests without deleting anything', async () => {
    const s = await scenario();
    try {
      const report = await pruneRevisionManifests({ ...s, indexJobManifestIds: [], dryRun: true });
      expect(report).toMatchObject({ status: 'planned', removed: [] });
      expect(report.pruneable).toEqual([s.stale.manifestId]);
      expect(await s.manifests.get(s.stale.manifestId)).not.toBeNull();
    } finally {
      await rm(s.dir, { recursive: true, force: true });
    }
  });

  it('never prunes refs, pins, overlay bases or index-job manifests', async () => {
    const s = await scenario();
    try {
      const job = manifestFor('9'.repeat(40), [{ path: 'job.ts', contentHash: H('5') }]);
      await s.manifests.put(job);
      const report = await pruneRevisionManifests({
        ...s, indexJobManifestIds: [job.manifestId], dryRun: false, lease: leaseFor(s.lease),
      });
      if (report.status !== 'planned') throw new Error(`expected a plan, got ${report.reason}`);
      expect(report.pruneable).toEqual([s.stale.manifestId]);
      expect(report.removed).toEqual([s.stale.manifestId]);
      for (const keep of [s.active, s.pinned, s.overlayBase, job]) {
        expect(await s.manifests.get(keep.manifestId)).not.toBeNull();
      }
      expect(await s.manifests.get(s.stale.manifestId)).toBeNull();
      // refs, pins and overlays are untouched by prune
      expect((await s.refs.read(REF))!.manifestId).toBe(s.active.manifestId);
      expect(await s.pins.isPinned(s.pinned.manifestId)).toBe(true);
      expect(await s.overlays.listIds()).toEqual(['goal-1']);
    } finally {
      await rm(s.dir, { recursive: true, force: true });
    }
  });

  it('reports retained roots with their reason and skips missing manifests', async () => {
    const s = await scenario();
    try {
      const report = await pruneRevisionManifests({ ...s, indexJobManifestIds: [], dryRun: true });
      expect(report.status).toBe('planned');
      const retained = new Map(report.retained.map((row) => [row.manifestId, row.reason]));
      expect(retained.get(s.active.manifestId)).toBe('canonical-ref');
      expect(retained.get(s.pinned.manifestId)).toBe('pin');
      expect(retained.get(s.overlayBase.manifestId)).toBe('overlay-base');
    } finally {
      await rm(s.dir, { recursive: true, force: true });
    }
  });

  it('is idempotent — a second prune finds nothing left', async () => {
    const s = await scenario();
    try {
      await pruneRevisionManifests({ ...s, indexJobManifestIds: [], dryRun: false, lease: leaseFor(s.lease) });
      const again = await pruneRevisionManifests({ ...s, indexJobManifestIds: [], dryRun: false, lease: leaseFor(s.lease) });
      expect(again).toMatchObject({ status: 'planned', pruneable: [], removed: [] });
    } finally {
      await rm(s.dir, { recursive: true, force: true });
    }
  });
});

describe('revision manifest prune apply (#210 §12)', () => {
  it('deletes only unreachable manifests and releases the lease', async () => {
    const s = await scenario();
    try {
      const report = await pruneRevisionManifests({
        ...s, indexJobManifestIds: [], dryRun: false, lease: leaseFor(s.lease),
      });
      if (report.status !== 'planned') throw new Error(`expected a plan, got ${report.reason}`);
      expect(report.pruneable).toEqual([s.stale.manifestId]);
      expect(report.removed).toEqual([s.stale.manifestId]);
      expect(await s.manifests.get(s.stale.manifestId)).toBeNull();
      expect(await s.manifests.get(s.active.manifestId)).not.toBeNull();
      // Release retires the record instead of deleting it, so the generation
      // stays monotonic for the next destructive pass.
      expect(await s.lease.inspect()).toMatchObject({
        status: 'released',
        ownerId: LEASE_OWNER,
        generation: 1,
      });
    } finally {
      await rm(s.dir, { recursive: true, force: true });
    }
  });

  it('stops pruning when a newer generation takes the fence mid-pass', async () => {
    const s = await scenario();
    try {
      const secondStale = manifestFor('a'.repeat(40), [{ path: 'older.ts', contentHash: H('6') }]);
      await s.manifests.put(secondStale);
      const grantAt = new Date('2026-10-17T00:02:00.000Z');
      let now = grantAt;
      let handedOver = false;
      // The first delete simulates a competing operator acquiring the fence
      // after the pass read its roots; the pass must not delete anything else.
      const wrapped = {
        get: (manifestId: string) => s.manifests.get(manifestId),
        listAll: () => s.manifests.listAll(),
        delete: async (manifestId: string): Promise<boolean> => {
          if (!handedOver) {
            handedOver = true;
            const held = await s.lease.read();
            if (held === null) throw new Error('expected a held lease');
            await s.lease.release({ ownerId: LEASE_OWNER, generation: held.generation });
            await s.lease.acquire({ ownerId: 'gc_successor', now, ttlMs: 60_000 });
            now = new Date(now.getTime() + 30_000);
          }
          return s.manifests.delete(manifestId);
        },
      } as unknown as CanonicalManifestStore;
      await expect(pruneRevisionManifests({
        ...s,
        manifests: wrapped,
        indexJobManifestIds: [],
        dryRun: false,
        now: grantAt,
        lease: { store: s.lease, ownerId: LEASE_OWNER, ttlMs: 60_000, clock: () => now },
      })).rejects.toThrow(GcLeaseLostError);
      // One stale manifest was removed under the fence; its sibling survives.
      const survivors = await Promise.all(
        [s.stale, secondStale].map(async (m) => (await s.manifests.get(m.manifestId)) !== null),
      );
      expect(survivors.filter(Boolean)).toHaveLength(1);
      expect(await s.lease.inspect()).toMatchObject({ status: 'held', ownerId: 'gc_successor', generation: 2 });
    } finally {
      await rm(s.dir, { recursive: true, force: true });
    }
  });

  it('refuses an apply with no lease and deletes nothing', async () => {
    const s = await scenario();
    try {
      const { lease: _lease, ...stores } = s;
      const report = await pruneRevisionManifests({ ...stores, indexJobManifestIds: [], dryRun: false });
      expect(report).toMatchObject({ status: 'refused' });
      if (report.status !== 'refused') throw new Error('expected a refusal');
      expect(report.reason).toContain('lease');
      expect(await s.manifests.get(s.stale.manifestId)).not.toBeNull();
    } finally {
      await rm(s.dir, { recursive: true, force: true });
    }
  });

  it('refuses while another owner holds the lease and deletes nothing', async () => {
    const s = await scenario();
    try {
      const acquired = await s.lease.acquire({ ownerId: 'other_gc', now: new Date(), ttlMs: 60_000 });
      if (acquired.status !== 'granted') throw new Error(`expected a granted lease, got ${acquired.status}`);
      const report = await pruneRevisionManifests({
        ...s, indexJobManifestIds: [], dryRun: false, lease: leaseFor(s.lease),
      });
      expect(report).toMatchObject({ status: 'refused' });
      if (report.status !== 'refused') throw new Error('expected a refusal');
      expect(report.reason).toContain('held by other_gc');
      expect(await s.manifests.get(s.stale.manifestId)).not.toBeNull();
    } finally {
      await rm(s.dir, { recursive: true, force: true });
    }
  });

  it('refuses an unreadable lease fence and deletes nothing', async () => {
    const s = await scenario();
    try {
      await mkdir(path.join(s.dir, 'gc'), { recursive: true });
      await writeFile(path.join(s.dir, 'gc', 'lease.json'), '{not a lease');
      const report = await pruneRevisionManifests({
        ...s, indexJobManifestIds: [], dryRun: false, lease: leaseFor(s.lease),
      });
      expect(report).toMatchObject({ status: 'refused' });
      if (report.status !== 'refused') throw new Error('expected a refusal');
      expect(report.reason).toContain('unreadable');
      expect(await s.manifests.get(s.stale.manifestId)).not.toBeNull();
    } finally {
      await rm(s.dir, { recursive: true, force: true });
    }
  });

  it('never takes the lease for a dry run, even when one is supplied', async () => {
    const s = await scenario();
    try {
      const report = await pruneRevisionManifests({
        ...s, indexJobManifestIds: [], dryRun: true, lease: leaseFor(s.lease),
      });
      expect(report.status).toBe('planned');
      expect(await s.lease.inspect()).toEqual({ status: 'free' });
    } finally {
      await rm(s.dir, { recursive: true, force: true });
    }
  });

  it('re-checks pins at apply time: a pin created after the plan is retained', async () => {
    const s = await scenario();
    try {
      const plan = await pruneRevisionManifests({ ...s, indexJobManifestIds: [], dryRun: true });
      expect(plan.pruneable).toEqual([s.stale.manifestId]);

      await s.pins.pin(s.stale.manifestId, 'rollback', 'pinned after the plan');
      const applied = await pruneRevisionManifests({
        ...s, indexJobManifestIds: [], dryRun: false, lease: leaseFor(s.lease),
      });
      if (applied.status !== 'planned') throw new Error(`expected a plan, got ${applied.reason}`);
      expect(applied.pruneable).toEqual([]);
      expect(applied.removed).toEqual([]);
      expect(await s.manifests.get(s.stale.manifestId)).not.toBeNull();
    } finally {
      await rm(s.dir, { recursive: true, force: true });
    }
  });

  it('releases the lease even when the pass throws', async () => {
    const s = await scenario();
    try {
      const refs = {
        list: async (): Promise<never> => { throw new Error('refs unreadable'); },
      } as unknown as CanonicalRefStore;
      await expect(pruneRevisionManifests({
        ...s, refs, indexJobManifestIds: [], dryRun: false, lease: leaseFor(s.lease),
      })).rejects.toThrow('refs unreadable');
      expect(await s.lease.inspect()).toMatchObject({ status: 'released', generation: 1 });
    } finally {
      await rm(s.dir, { recursive: true, force: true });
    }
  });
});
