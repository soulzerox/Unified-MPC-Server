import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalManifestId, canonicalRevisionId } from '@unified-mpc/domain';
import { CanonicalRefStore } from './canonical-ref-store.js';
import { CanonicalManifestStore, type StoredManifest } from './canonical-manifest-store.js';
import { GoalOverlayStore } from './goal-overlay-store.js';
import { RevisionPinRegistry } from './revision-pin-registry.js';
import { ArtifactQuarantineStore } from './artifact-quarantine.js';
import { expireGcQuarantine } from './gc-expire.js';
import { GcLeaseStore } from './gc-lease.js';

const REPO = 'repo_abc123';
const REF = 'refs/remotes/origin/main';
const H = (n: string): string => n.repeat(64).slice(0, 64);
const GRACE = 60_000;
const T0 = new Date('2026-10-17T00:00:00.000Z');
const at = (ms: number): Date => new Date(T0.getTime() + ms);

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

/**
 * Seed one live canonical root. The destructive pass now refuses when no
 * root can be proven reachable (a zero-root plan must not delete anything),
 * so every delete-path fixture needs at least one live ref.
 */
async function seedLiveRoot(manifests: CanonicalManifestStore, refs: CanonicalRefStore): Promise<StoredManifest> {
  const live = manifestFor('c'.repeat(40), [{ path: 'live.ts', contentHash: H('1') }]);
  await manifests.put(live);
  await refs.promote(REF, {
    expectedCurrent: null, current: null,
    target: { commitSha: live.commitSha, treeOid: live.treeOid, manifestId: live.manifestId },
    targetVerified: true,
  });
  return live;
}

describe('GC quarantine expiry (#210 U23)', () => {
  it('deletes nothing while entries are still inside grace', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gc-expire-'));
    try {
      const refs = new CanonicalRefStore(dir);
      const manifests = new CanonicalManifestStore(dir);
      const pins = new RevisionPinRegistry(dir);
      const overlays = new GoalOverlayStore(dir);
      const quarantine = new ArtifactQuarantineStore(dir);
      await seedLiveRoot(manifests, refs);
      const stale = manifestFor('f'.repeat(40), [{ path: 'old.ts', contentHash: H('9') }]);
      await manifests.put(stale);
      const result = await expireGcQuarantine(
        { refs, manifests, pins, overlays, quarantine },
        { indexJobManifestIds: [], now: at(GRACE - 1), graceMs: GRACE, dryRun: false },
      );
      expect(result).toMatchObject({ status: 'planned', expired: [], deleted: [] });
      expect(await manifests.get(stale.manifestId)).not.toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('re-resolves and refuses when the hash got referenced by a pin', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gc-expire-'));
    try {
      const refs = new CanonicalRefStore(dir);
      const manifests = new CanonicalManifestStore(dir);
      const pins = new RevisionPinRegistry(dir);
      const overlays = new GoalOverlayStore(dir);
      const quarantine = new ArtifactQuarantineStore(dir);
      const deleted: string[] = [];
      const m = manifestFor('c'.repeat(40), [{ path: 'live.ts', contentHash: H('1') }]);
      await manifests.put(m);
      await refs.promote(REF, {
        expectedCurrent: null, current: null,
        target: { commitSha: m.commitSha, treeOid: m.treeOid, manifestId: m.manifestId },
        targetVerified: true,
      });
      await pins.pin(m.manifestId, 'user-pin', 'hold');
      await quarantine.quarantine([H('1')], { now: at(0), graceMs: GRACE });

      const result = await expireGcQuarantine(
        { refs, manifests, pins, overlays, quarantine },
        { indexJobManifestIds: [], now: at(GRACE * 2), graceMs: GRACE, dryRun: false, deleteArtifact: async (hash) => { deleted.push(hash); } },
      );
      expect(result).toMatchObject({ status: 'planned', expired: [], deleted: [] });
      expect(result.retained).toEqual([H('1')]);
      expect((await quarantine.list()).map((e) => e.hash)).toEqual([H('1')]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('deletes only what the callback confirms and drops ledger rows', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gc-expire-'));
    try {
      const refs = new CanonicalRefStore(dir);
      const manifests = new CanonicalManifestStore(dir);
      const pins = new RevisionPinRegistry(dir);
      const overlays = new GoalOverlayStore(dir);
      const quarantine = new ArtifactQuarantineStore(dir);
      const deleted: string[] = [];
      await seedLiveRoot(manifests, refs);
      await quarantine.quarantine([H('7')], { now: at(0), graceMs: GRACE });
      const result = await expireGcQuarantine(
        { refs, manifests, pins, overlays, quarantine },
        { indexJobManifestIds: [], now: at(GRACE * 2), graceMs: GRACE, dryRun: false, deleteArtifact: async (hash) => { deleted.push(hash); } },
      );
      expect(result).toMatchObject({ status: 'planned' });
      expect(deleted).toEqual([H('7')]);
      expect(await quarantine.list()).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('dry-run reports expired without touching the ledger', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gc-expire-'));
    try {
      const refs = new CanonicalRefStore(dir);
      const manifests = new CanonicalManifestStore(dir);
      const pins = new RevisionPinRegistry(dir);
      const overlays = new GoalOverlayStore(dir);
      const quarantine = new ArtifactQuarantineStore(dir);
      await seedLiveRoot(manifests, refs);
      await quarantine.quarantine([H('8')], { now: T0, graceMs: GRACE });
      const result = await expireGcQuarantine(
        { refs, manifests, pins, overlays, quarantine },
        { indexJobManifestIds: [], now: at(GRACE * 2), graceMs: GRACE, dryRun: true },
      );
      expect(result).toMatchObject({ status: 'planned', expired: [H('8')], deleted: [] });
      expect((await quarantine.list()).map((e) => e.hash)).toEqual([H('8')]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('expire under the GC cleanup lease (#210 U29)', () => {
  const setup = async (): Promise<{ dir: string; stores: Parameters<typeof expireGcQuarantine>[0]; quarantine: ArtifactQuarantineStore }> => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gc-expire-lease-'));
    const quarantine = new ArtifactQuarantineStore(dir);
    const manifests = new CanonicalManifestStore(dir);
    const refs = new CanonicalRefStore(dir);
    await seedLiveRoot(manifests, refs);
    await quarantine.quarantine([H('5')], { now: at(0), graceMs: GRACE });
    return {
      dir,
      quarantine,
      stores: {
        refs,
        manifests,
        pins: new RevisionPinRegistry(dir),
        overlays: new GoalOverlayStore(dir),
        quarantine,
      },
    };
  };

  it('refuses to delete while another owner holds the GC lease', async () => {
    const { dir, stores, quarantine } = await setup();
    try {
      const lease = new GcLeaseStore(dir);
      await lease.acquire({ ownerId: 'other_gc', now: at(0), ttlMs: GRACE * 10 });
      const deleted: string[] = [];
      const result = await expireGcQuarantine(stores, {
        indexJobManifestIds: [], now: at(GRACE * 2), graceMs: GRACE, dryRun: false,
        deleteArtifact: async (hash) => { deleted.push(hash); },
        lease: { store: lease, ownerId: 'gc_me', ttlMs: GRACE },
      });
      expect(result).toMatchObject({ status: 'refused' });
      if (result.status !== 'refused') throw new Error('unexpected');
      expect(result.reason).toMatch(/other_gc/);
      expect(deleted).toEqual([]);
      expect((await quarantine.list()).map((entry) => entry.hash)).toEqual([H('5')]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('deletes under a granted lease and releases it so the next run can proceed', async () => {
    const { dir, stores, quarantine } = await setup();
    try {
      const lease = new GcLeaseStore(dir);
      const deleted: string[] = [];
      const result = await expireGcQuarantine(stores, {
        indexJobManifestIds: [], now: at(GRACE * 2), graceMs: GRACE, dryRun: false,
        deleteArtifact: async (hash) => { deleted.push(hash); },
        lease: { store: lease, ownerId: 'gc_me', ttlMs: GRACE },
      });
      expect(result).toMatchObject({ status: 'planned', expired: [H('5')], deleted: [H('5')] });
      expect(await lease.read()).toBeNull();

      await quarantine.quarantine([H('6')], { now: at(0), graceMs: GRACE });
      const second = await expireGcQuarantine(stores, {
        indexJobManifestIds: [], now: at(GRACE * 2), graceMs: GRACE, dryRun: false,
        lease: { store: lease, ownerId: 'gc_next', ttlMs: GRACE },
      });
      expect(second).toMatchObject({ status: 'planned', deleted: [H('6')] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('releases the lease even when the run refuses on unassemblable roots', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gc-expire-lease-'));
    try {
      const stores = {
        refs: new CanonicalRefStore(dir),
        manifests: new CanonicalManifestStore(dir),
        pins: new RevisionPinRegistry(dir),
        overlays: new GoalOverlayStore(dir),
        quarantine: new ArtifactQuarantineStore(dir),
      };
      const lease = new GcLeaseStore(dir);
      const result = await expireGcQuarantine(stores, {
        indexJobManifestIds: [], now: at(GRACE * 2), graceMs: GRACE, dryRun: false,
        lease: { store: lease, ownerId: 'gc_me', ttlMs: GRACE },
      });
      expect(result).toMatchObject({ status: 'refused' });
      if (result.status !== 'refused') throw new Error('unexpected');
      expect(result.reason).toMatch(/roots/i);
      expect(await lease.read()).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses when the recorded fence is unreadable and never writes under it', async () => {
    const { dir, stores, quarantine } = await setup();
    try {
      const lease = new GcLeaseStore(dir);
      await lease.acquire({ ownerId: 'other_gc', now: at(0), ttlMs: GRACE * 10 });
      await writeFile(path.join(dir, 'gc', 'lease.json'), '{ broken', 'utf8');
      const result = await expireGcQuarantine(stores, {
        indexJobManifestIds: [], now: at(GRACE * 2), graceMs: GRACE, dryRun: false,
        lease: { store: lease, ownerId: 'gc_me', ttlMs: GRACE },
      });
      expect(result).toMatchObject({ status: 'refused' });
      if (result.status !== 'refused') throw new Error('unexpected');
      expect(result.reason).toMatch(/unreadable|fence/i);
      expect((await quarantine.list()).map((entry) => entry.hash)).toEqual([H('5')]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('dry-run reports without needing the lease at all', async () => {
    const { dir, stores, quarantine } = await setup();
    try {
      const lease = new GcLeaseStore(dir);
      await lease.acquire({ ownerId: 'other_gc', now: at(0), ttlMs: GRACE * 10 });
      const result = await expireGcQuarantine(stores, {
        indexJobManifestIds: [], now: at(GRACE * 2), graceMs: GRACE, dryRun: true,
        lease: { store: lease, ownerId: 'gc_me', ttlMs: GRACE },
      });
      expect(result).toMatchObject({ status: 'planned', expired: [H('5')], deleted: [] });
      expect((await quarantine.list()).map((entry) => entry.hash)).toEqual([H('5')]);
      expect((await lease.read())?.ownerId).toBe('other_gc');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
