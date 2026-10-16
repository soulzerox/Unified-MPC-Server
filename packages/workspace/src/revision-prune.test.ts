import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalManifestId, canonicalRevisionId } from '@unified-mpc/domain';
import { CanonicalRefStore } from './canonical-ref-store.js';
import { CanonicalManifestStore, type StoredManifest } from './canonical-manifest-store.js';
import { GoalOverlayStore } from './goal-overlay-store.js';
import { RevisionPinRegistry } from './revision-pin-registry.js';
import { pruneRevisionManifests } from './revision-prune.js';

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

async function scenario(): Promise<{
  dir: string;
  refs: CanonicalRefStore;
  manifests: CanonicalManifestStore;
  pins: RevisionPinRegistry;
  overlays: GoalOverlayStore;
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
  return { dir, refs, manifests, pins, overlays, active, pinned, overlayBase, stale };
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
      const report = await pruneRevisionManifests({ ...s, indexJobManifestIds: [job.manifestId], dryRun: false });
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
      await pruneRevisionManifests({ ...s, indexJobManifestIds: [], dryRun: false });
      const again = await pruneRevisionManifests({ ...s, indexJobManifestIds: [], dryRun: false });
      expect(again).toMatchObject({ status: 'planned', pruneable: [], removed: [] });
    } finally {
      await rm(s.dir, { recursive: true, force: true });
    }
  });
});
