import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalManifestId, canonicalRevisionId } from '@unified-mpc/domain';
import { CanonicalRefStore } from './canonical-ref-store.js';
import { CanonicalManifestStore, type StoredManifest } from './canonical-manifest-store.js';
import { GoalOverlayStore } from './goal-overlay-store.js';
import { RevisionPinRegistry } from './revision-pin-registry.js';
import { ArtifactQuarantineStore } from './artifact-quarantine.js';
import { expireGcQuarantine } from './gc-expire.js';

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

describe('GC quarantine expiry (#210 U23)', () => {
  it('deletes nothing while entries are still inside grace', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gc-expire-'));
    try {
      const refs = new CanonicalRefStore(dir);
      const manifests = new CanonicalManifestStore(dir);
      const pins = new RevisionPinRegistry(dir);
      const overlays = new GoalOverlayStore(dir);
      const quarantine = new ArtifactQuarantineStore(dir);
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
