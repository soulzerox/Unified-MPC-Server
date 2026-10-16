import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalManifestId, canonicalRevisionId, computeTreeOid } from '@unified-mpc/domain';
import { CanonicalManifestStore, type StoredManifest } from './canonical-manifest-store.js';
import { CanonicalRefStore } from './canonical-ref-store.js';
import { GoalOverlayStore } from './goal-overlay-store.js';
import { RevisionPinRegistry } from './revision-pin-registry.js';
import { ArtifactQuarantineStore } from './artifact-quarantine.js';
import { runGcCycle } from './gc-cycle.js';
import { IndexJobLedger } from './index-job-ledger.js';

const NOW = new Date('2026-10-17T00:00:00.000Z');
const MAN = (n: string): string => `man:v1:${n.repeat(64).slice(0, 64)}`;

async function ledger(): Promise<{ store: IndexJobLedger; dir: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'index-jobs-'));
  return { store: new IndexJobLedger(dir), dir };
}

describe('index job ledger (#210 U25)', () => {
  it('keeps a pending job root live and drops it once settled', async () => {
    const { store, dir } = await ledger();
    try {
      await store.open('op_1', MAN('a'), NOW);
      expect(await store.liveManifestIds()).toEqual([MAN('a')]);

      expect(await store.settle('op_1')).toBe(true);
      expect(await store.liveManifestIds()).toEqual([]);
      expect(await store.list()).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('deduplicates a manifest referenced by several jobs and keeps it live while any job is', async () => {
    const { store, dir } = await ledger();
    try {
      await store.open('op_1', MAN('a'), NOW);
      await store.open('op_2', MAN('a'), NOW);
      await store.open('op_3', MAN('b'), NOW);
      expect(await store.liveManifestIds()).toEqual([MAN('a'), MAN('b')]);

      await store.settle('op_1');
      expect(await store.liveManifestIds()).toEqual([MAN('a'), MAN('b')]);
      await store.settle('op_2');
      expect(await store.liveManifestIds()).toEqual([MAN('b')]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('persists across instances and tracks the running state', async () => {
    const { store, dir } = await ledger();
    try {
      await store.open('op_1', MAN('c'), NOW);
      const reopened = new IndexJobLedger(dir);
      expect(await reopened.markActive('op_1', NOW)).toBe(true);
      expect(await reopened.list()).toMatchObject([{ operationId: 'op_1', manifestId: MAN('c'), status: 'active' }]);
      expect(await reopened.liveManifestIds()).toEqual([MAN('c')]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports unknown jobs instead of throwing', async () => {
    const { store, dir } = await ledger();
    try {
      expect(await store.settle('op_missing')).toBe(false);
      expect(await store.markActive('op_missing', NOW)).toBe(false);
      expect(await store.list()).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects a malformed manifest id so a bad root cannot poison GC assembly', async () => {
    const { store, dir } = await ledger();
    try {
      await expect(store.open('op_1', 'nonsense', NOW)).rejects.toThrow(/manifest id/i);
      await expect(store.open('', MAN('a'), NOW)).rejects.toThrow(/operation/i);
      expect(await store.liveManifestIds()).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('retargets an existing job when the same operation opens again', async () => {
    const { store, dir } = await ledger();
    try {
      await store.open('op_1', MAN('a'), NOW);
      await store.markActive('op_1', NOW);
      await store.open('op_1', MAN('b'), NOW);
      expect(await store.list()).toMatchObject([{ operationId: 'op_1', manifestId: MAN('b'), status: 'pending' }]);
      expect(await store.liveManifestIds()).toEqual([MAN('b')]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('index job ledger feeds GC roots (#210 U25)', () => {
  it('keeps a pending job artifact reachable across a GC cycle', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'index-jobs-gc-'));
    try {
      const REPO = 'repo_abc123';
      const REF = 'refs/remotes/origin/main';
      const manifests = new CanonicalManifestStore(dir);
      const refs = new CanonicalRefStore(dir);
      const build = (commitSha: string, entries: { path: string; contentHash: string }[]): StoredManifest => {
        const revisionId = canonicalRevisionId({
          repositoryId: REPO, commitSha, treeOid: computeTreeOid(entries), targetRef: REF, parents: [],
        });
        return {
          manifestId: canonicalManifestId({ repositoryId: REPO, revisionId, entries }),
          repositoryId: REPO, revisionId, commitSha, treeOid: computeTreeOid(entries), targetRef: REF,
          entries, createdAt: NOW.toISOString(),
        };
      };
      const H = (n: string): string => n.repeat(64).slice(0, 64);
      const live = build('c'.repeat(40), [{ path: 'live.ts', contentHash: H('a') }]);
      const rebuilding = build('d'.repeat(40), [{ path: 'rebuild.ts', contentHash: H('b') }]);
      await manifests.put(live);
      await manifests.put(rebuilding);
      await refs.promote(REF, {
        expectedCurrent: null, current: null,
        target: { commitSha: live.commitSha, treeOid: live.treeOid, manifestId: live.manifestId },
        targetVerified: true,
      });

      const jobs = new IndexJobLedger(dir);
      await jobs.open('op_reindex', rebuilding.manifestId, NOW);
      const stores = {
        refs, manifests,
        pins: new RevisionPinRegistry(dir),
        overlays: new GoalOverlayStore(dir),
        quarantine: new ArtifactQuarantineStore(dir),
      };
      const cycle = await runGcCycle(stores, {
        candidates: [H('a'), H('b')],
        indexJobManifestIds: await jobs.liveManifestIds(),
        now: NOW, graceMs: 60_000, dryRun: true,
      });
      expect(cycle).toMatchObject({ status: 'planned', reachable: [H('a'), H('b')], unreachable: [] });

      await jobs.settle('op_reindex');
      const after = await runGcCycle(stores, {
        candidates: [H('a'), H('b')],
        indexJobManifestIds: await jobs.liveManifestIds(),
        now: NOW, graceMs: 60_000, dryRun: true,
      });
      expect(after).toMatchObject({ status: 'planned', unreachable: [H('b')] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
