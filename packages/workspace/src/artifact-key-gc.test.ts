import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalManifestId, canonicalRevisionId, computeTreeOid, fileArtifactId } from '@unified-mpc/domain';
import { CanonicalRefStore } from './canonical-ref-store.js';
import type { StoredManifest } from './canonical-manifest-store.js';
import { CanonicalArtifactStore, type StoredFileArtifact } from './canonical-artifact-store.js';
import { GoalOverlayStore } from './goal-overlay-store.js';
import { RevisionPinRegistry } from './revision-pin-registry.js';
import {
  collectRetainedManifestIds,
  planArtifactKeyGc,
  planRepositoryArtifactGc,
} from './artifact-key-gc.js';

const REPO = 'repo_abc123';
const OTHER_REPO = 'repo_other456';
const REF = 'refs/remotes/origin/main';
const CONTENT = 'a'.repeat(64);
const M1 = 'man:v1:' + '1'.repeat(64);
const M2 = 'man:v1:' + '2'.repeat(64);

function fileArtifact(repositoryId: string, contentHash: string, manifestIds: readonly string[]): StoredFileArtifact {
  const key = fileArtifactId({
    sourceContentSha256: contentHash,
    language: 'typescript',
    sourceKind: 'source',
    representationVersion: 'v1',
  });
  return {
    kind: 'file',
    artifactKey: key,
    repositoryId,
    sourceContentSha256: contentHash,
    language: 'typescript',
    sourceKind: 'source',
    representationVersion: 'v1',
    bindings: manifestIds.map((manifestId, index) => ({ path: `src/${index}.ts`, manifestId })),
    createdAt: '2026-10-19T00:00:00.000Z',
  };
}

function manifestFor(commitSha: string): StoredManifest {
  const entries = [{ path: 'a.ts', contentHash: CONTENT }];
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
    createdAt: '2026-10-19T00:00:00.000Z',
  };
}

describe('artifact-key GC planner (#210 §7)', () => {
  it('splits candidates by referenced keys, sorted and case-normalized', () => {
    const plan = planArtifactKeyGc({
      retainedManifestIds: [M1],
      referencedKeys: ['file:v1:' + 'A'.repeat(64)],
      candidates: ['file:v1:' + 'a'.repeat(64), 'file:v1:' + 'b'.repeat(64), 'chunk:v1:' + 'c'.repeat(64)],
    });
    expect(plan).toEqual({
      status: 'planned',
      reachable: ['file:v1:' + 'a'.repeat(64)],
      unreachable: ['chunk:v1:' + 'c'.repeat(64), 'file:v1:' + 'b'.repeat(64)].sort(),
    });
  });

  it('refuses without retained manifests — an empty root set would garbage-collect everything', () => {
    expect(planArtifactKeyGc({ retainedManifestIds: [], referencedKeys: [], candidates: ['file:v1:' + 'a'.repeat(64)] }))
      .toEqual({ status: 'refused', reason: expect.stringContaining('no retained manifests') });
  });

  it('refuses when candidates exist with no reachability evidence at all', () => {
    expect(planArtifactKeyGc({ retainedManifestIds: [M1], referencedKeys: [], candidates: ['file:v1:' + 'a'.repeat(64)] }))
      .toEqual({ status: 'refused', reason: expect.stringContaining('no artifact reachability evidence') });
    // an empty candidate list is a legitimate no-op, not a failure
    expect(planArtifactKeyGc({ retainedManifestIds: [M1], referencedKeys: [], candidates: [] }))
      .toEqual({ status: 'planned', reachable: [], unreachable: [] });
  });

  it('rejects malformed candidate keys instead of planning around them', () => {
    expect(() => planArtifactKeyGc({ retainedManifestIds: [M1], referencedKeys: [], candidates: ['not-a-key'] }))
      .toThrow(/invalid artifact key/);
  });

  it('collects retained manifest ids from refs, pins, overlay bases and index jobs', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'artifact-key-gc-'));
    try {
      const refs = new CanonicalRefStore(dir);
      const pins = new RevisionPinRegistry(dir);
      const overlays = new GoalOverlayStore(dir);

      const active = manifestFor('c'.repeat(40));
      const pinned = manifestFor('d'.repeat(40));
      const overlayBase = manifestFor('e'.repeat(40));
      await refs.promote(REF, {
        expectedCurrent: null, current: null,
        target: { commitSha: active.commitSha, treeOid: active.treeOid, manifestId: active.manifestId },
        targetVerified: true,
      });
      await pins.pin(pinned.manifestId, 'rollback', 'keep LKG');
      await overlays.create('goal-1', {
        baseCommitSha: overlayBase.commitSha, baseTreeOid: overlayBase.treeOid, baseManifestId: overlayBase.manifestId,
      });

      expect(await collectRetainedManifestIds({
        refs, pins, overlays, indexJobManifestIds: [active.manifestId, M2],
      })).toEqual([M2, active.manifestId, overlayBase.manifestId, pinned.manifestId].sort());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('plans repository artifacts against the store, keeping pinned-only artifacts alive', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'artifact-key-gc-'));
    try {
      const store = new CanonicalArtifactStore(dir);
      const live = fileArtifact(REPO, '1'.repeat(64), [M1]);
      const retired = fileArtifact(REPO, '2'.repeat(64), [M2]);
      const unbound = fileArtifact(REPO, '3'.repeat(64), []);
      const elsewhere = fileArtifact(OTHER_REPO, '4'.repeat(64), [M1]);
      for (const artifact of [live, retired, unbound, elsewhere]) await store.put(artifact);

      const plan = await planRepositoryArtifactGc({ store, repositoryId: REPO, retainedManifestIds: [M1] });
      expect(plan).toEqual({
        status: 'planned',
        reachable: [live.artifactKey],
        unreachable: [retired.artifactKey, unbound.artifactKey].sort(),
      });

      const pinnedView = await planRepositoryArtifactGc({ store, repositoryId: REPO, retainedManifestIds: [M1, M2] });
      expect(pinnedView).toEqual({
        status: 'planned',
        reachable: [live.artifactKey, retired.artifactKey].sort(),
        unreachable: [unbound.artifactKey],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('never lets another trust boundary make this repository\'s artifact look reachable', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'artifact-key-gc-'));
    try {
      const store = new CanonicalArtifactStore(dir);
      // identical key exists in two boundaries; only the other one is referenced
      const mineLive = fileArtifact(REPO, '6'.repeat(64), [M1]);
      const mineUnbound = fileArtifact(REPO, '5'.repeat(64), []);
      const theirsBound = fileArtifact(OTHER_REPO, '5'.repeat(64), [M1]);
      for (const artifact of [mineLive, mineUnbound, theirsBound]) await store.put(artifact);

      const plan = await planRepositoryArtifactGc({ store, repositoryId: REPO, retainedManifestIds: [M1] });
      expect(plan).toEqual({
        status: 'planned',
        reachable: [mineLive.artifactKey],
        unreachable: [mineUnbound.artifactKey],
      });

      // with no scoped evidence at all the planner refuses rather than treating
      // the other boundary's binding as proof
      const emptyRepoPlan = await planRepositoryArtifactGc({
        store, repositoryId: 'repo_no_artifacts', retainedManifestIds: [M1],
        candidates: [mineUnbound.artifactKey],
      });
      expect(emptyRepoPlan).toEqual({ status: 'refused', reason: expect.stringContaining('no artifact reachability evidence') });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
