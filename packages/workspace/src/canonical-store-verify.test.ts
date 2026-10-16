import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalManifestId, canonicalRevisionId } from '@unified-mpc/domain';
import { CanonicalRefStore } from './canonical-ref-store.js';
import { CanonicalManifestStore, type StoredManifest } from './canonical-manifest-store.js';
import { GoalOverlayStore } from './goal-overlay-store.js';
import { RevisionPinRegistry } from './revision-pin-registry.js';
import { verifyCanonicalStore } from './canonical-store-verify.js';

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

describe('canonical store verify report (#210 U19)', () => {
  it('reports healthy when refs, manifests, overlays and pins are consistent', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'canonical-verify-'));
    try {
      const refs = new CanonicalRefStore(dir);
      const manifests = new CanonicalManifestStore(dir);
      const pins = new RevisionPinRegistry(dir);
      const overlays = new GoalOverlayStore(dir);
      const m = manifestFor('c'.repeat(40), [{ path: 'a.ts', contentHash: H('1') }]);
      await manifests.put(m);
      await refs.promote(REF, {
        expectedCurrent: null, current: null,
        target: { commitSha: m.commitSha, treeOid: m.treeOid, manifestId: m.manifestId },
        targetVerified: true,
      });
      await pins.pin(m.manifestId, 'canonical-ref', REF);
      await overlays.create('goal-1', {
        baseCommitSha: m.commitSha, baseTreeOid: m.treeOid, baseManifestId: m.manifestId,
      });

      const report = await verifyCanonicalStore({ refs, manifests, pins, overlays });
      expect(report).toMatchObject({ status: 'healthy', danglingRefs: [], missingOverlays: [], orphanedPins: [] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('flags a ref whose manifest is missing from the store', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'canonical-verify-'));
    try {
      const refs = new CanonicalRefStore(dir);
      const manifests = new CanonicalManifestStore(dir);
      const pins = new RevisionPinRegistry(dir);
      const overlays = new GoalOverlayStore(dir);
      await refs.promote(REF, {
        expectedCurrent: null, current: null,
        target: { commitSha: 'c'.repeat(40), treeOid: 'c'.repeat(40), manifestId: 'man:v1:' + 'a'.repeat(64) },
        targetVerified: true,
      });

      const report = await verifyCanonicalStore({ refs, manifests, pins, overlays });
      expect(report.status).toBe('degraded');
      expect(report.danglingRefs).toHaveLength(1);
      expect(report.danglingRefs[0]).toMatchObject({ ref: REF });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('flags an overlay whose base manifest is missing and a pin without a manifest', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'canonical-verify-'));
    try {
      const refs = new CanonicalRefStore(dir);
      const manifests = new CanonicalManifestStore(dir);
      const pins = new RevisionPinRegistry(dir);
      const overlays = new GoalOverlayStore(dir);
      await overlays.create('goal-ghost', {
        baseCommitSha: 'c'.repeat(40), baseTreeOid: 'c'.repeat(40), baseManifestId: 'man:v1:' + 'b'.repeat(64),
      });
      await pins.pin('man:v1:' + 'd'.repeat(64), 'user-pin', 'hold');

      const report = await verifyCanonicalStore({ refs, manifests, pins, overlays });
      expect(report.status).toBe('degraded');
      expect(report.missingOverlays).toEqual(['goal-ghost']);
      expect(report.orphanedPins).toEqual(['man:v1:' + 'd'.repeat(64)]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('lists all manifests with their pin state for audit', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'canonical-verify-'));
    try {
      const refs = new CanonicalRefStore(dir);
      const manifests = new CanonicalManifestStore(dir);
      const pins = new RevisionPinRegistry(dir);
      const overlays = new GoalOverlayStore(dir);
      const m = manifestFor('c'.repeat(40), [{ path: 'a.ts', contentHash: H('1') }]);
      await manifests.put(m);
      await pins.pin(m.manifestId, 'rollback', 'LKG');

      const report = await verifyCanonicalStore({ refs, manifests, pins, overlays });
      expect(report.status).toBe('healthy');
      const row = report.manifests.find((row) => row.manifestId === m.manifestId);
      expect(row).toMatchObject({ pinned: true, reasons: ['rollback'] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
