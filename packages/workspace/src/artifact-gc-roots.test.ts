import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalManifestId, canonicalRevisionId, computeTreeOid } from '@unified-mpc/domain';
import { CanonicalRefStore } from './canonical-ref-store.js';
import { CanonicalManifestStore, type StoredManifest } from './canonical-manifest-store.js';
import { GoalOverlayStore } from './goal-overlay-store.js';
import { RevisionPinRegistry } from './revision-pin-registry.js';
import { planArtifactGc } from './artifact-gc.js';
import { assembleGcRoots } from './artifact-gc-roots.js';

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
    treeOid: computeTreeOid(entries),
    targetRef: REF,
    entries,
    createdAt: '2026-10-17T00:00:00.000Z',
  };
}

describe('GC root assembler (#210 U18)', () => {
  it('enumerates stored refs, pinned ids and overlay ids', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gc-roots-'));
    try {
      const refs = new CanonicalRefStore(dir);
      const pins = new RevisionPinRegistry(dir);
      const overlays = new GoalOverlayStore(dir);
      const m = manifestFor('c'.repeat(40), [{ path: 'a.ts', contentHash: H('1') }]);
      await refs.promote(REF, {
        expectedCurrent: null, current: null,
        target: { commitSha: m.commitSha, treeOid: m.treeOid, manifestId: m.manifestId },
        targetVerified: true,
      });
      await pins.pin(m.manifestId, 'user-pin', 'hold');
      await overlays.create('goal-1', {
        baseCommitSha: m.commitSha, baseTreeOid: m.treeOid, baseManifestId: m.manifestId,
      });

      expect(await refs.list()).toEqual([{ ref: REF, state: { commitSha: m.commitSha, treeOid: m.treeOid, manifestId: m.manifestId } }]);
      expect(await pins.pinnedManifestIds()).toEqual([m.manifestId]);
      expect(await overlays.listIds()).toEqual(['goal-1']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('assumes only reachable roots and lets the planner retain pin/overlay content', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gc-roots-'));
    try {
      const refs = new CanonicalRefStore(dir);
      const manifests = new CanonicalManifestStore(dir);
      const pins = new RevisionPinRegistry(dir);
      const overlays = new GoalOverlayStore(dir);

      const active = manifestFor('c'.repeat(40), [{ path: 'live.ts', contentHash: H('1') }]);
      const pinned = manifestFor('d'.repeat(40), [{ path: 'old.ts', contentHash: H('2') }]);
      const overlayBase = manifestFor('e'.repeat(40), [{ path: 'base.ts', contentHash: H('3') }]);
      await manifests.put(active);
      await manifests.put(pinned);
      await manifests.put(overlayBase);
      await refs.promote(REF, {
        expectedCurrent: null, current: null,
        target: { commitSha: active.commitSha, treeOid: active.treeOid, manifestId: active.manifestId },
        targetVerified: true,
      });
      await pins.pin(pinned.manifestId, 'rollback', 'keep LKG');
      await overlays.create('goal-1', {
        baseCommitSha: overlayBase.commitSha, baseTreeOid: overlayBase.treeOid, baseManifestId: overlayBase.manifestId,
      });

      const roots = await assembleGcRoots({ manifests, refs, pins, overlays, indexJobManifestIds: [] });
      const plan = planArtifactGc({ roots, candidates: [H('1'), H('2'), H('3'), H('9')] });
      if (plan.status !== 'planned') throw new Error('expected planned');
      expect(plan.reachable).toEqual([H('1'), H('2'), H('3')]);
      expect(plan.unreachable).toEqual([H('9')]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('includes caller-supplied index-job manifests as roots', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gc-roots-'));
    try {
      const refs = new CanonicalRefStore(dir);
      const manifests = new CanonicalManifestStore(dir);
      const pins = new RevisionPinRegistry(dir);
      const overlays = new GoalOverlayStore(dir);
      const job = manifestFor('f'.repeat(40), [{ path: 'job.ts', contentHash: H('4') }]);
      await manifests.put(job);

      const roots = await assembleGcRoots({ manifests, refs, pins, overlays, indexJobManifestIds: [job.manifestId] });
      const plan = planArtifactGc({ roots, candidates: [H('4')] });
      if (plan.status !== 'planned') throw new Error('expected planned');
      expect(plan.unreachable).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when a reachability root manifest is missing from the store', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gc-roots-'));
    try {
      const refs = new CanonicalRefStore(dir);
      const manifests = new CanonicalManifestStore(dir);
      const pins = new RevisionPinRegistry(dir);
      const overlays = new GoalOverlayStore(dir);
      const ghostId = 'man:v1:' + 'a'.repeat(64);
      await pins.pin(ghostId, 'user-pin', 'no manifest on disk');

      await expect(assembleGcRoots({ manifests, refs, pins, overlays, indexJobManifestIds: [] }))
        .rejects.toThrow(/missing/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
