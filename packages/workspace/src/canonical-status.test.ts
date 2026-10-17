import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalManifestId, canonicalRevisionId, computeTreeOid } from '@unified-mpc/domain';
import { CanonicalManifestStore } from './canonical-manifest-store.js';
import { CanonicalRefStore } from './canonical-ref-store.js';
import { GoalOverlayStore } from './goal-overlay-store.js';
import { RevisionPinRegistry } from './revision-pin-registry.js';
import { attachGoalBasePin } from './goal-base-pin.js';
import { ArtifactQuarantineStore } from './artifact-quarantine.js';
import { IndexJobLedger } from './index-job-ledger.js';
import { canonicalStatus } from './canonical-status.js';

const REPO = 'repo_abc123';
const REF = 'refs/remotes/origin/main';
const NOW = new Date('2026-10-17T00:00:00.000Z');
const H = (n: string): string => n.repeat(64).slice(0, 64);

describe('canonical status projection (#210 U26)', () => {
  it('projects an empty store as healthy with zero counts', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'canon-status-'));
    try {
      const report = await canonicalStatus({
        refs: new CanonicalRefStore(dir),
        manifests: new CanonicalManifestStore(dir),
        pins: new RevisionPinRegistry(dir),
        overlays: new GoalOverlayStore(dir),
        quarantine: new ArtifactQuarantineStore(dir),
        jobs: new IndexJobLedger(dir),
      });
      expect(report).toMatchObject({
        status: 'healthy',
        refs: [],
        manifestCount: 0,
        pinCount: 0,
        overlayCount: 0,
        quarantinedCount: 0,
        activeJobCount: 0,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('projects live state: ref pointer, pins, overlay, quarantined rows and jobs', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'canon-status-'));
    try {
      const refs = new CanonicalRefStore(dir);
      const manifests = new CanonicalManifestStore(dir);
      const pins = new RevisionPinRegistry(dir);
      const overlays = new GoalOverlayStore(dir);
      const quarantine = new ArtifactQuarantineStore(dir);
      const jobs = new IndexJobLedger(dir);

      const entries = [{ path: 'live.ts', contentHash: H('1') }];
      const revisionId = canonicalRevisionId({
        repositoryId: REPO, commitSha: 'c'.repeat(40), treeOid: computeTreeOid(entries), targetRef: REF, parents: [],
      });
      const manifestId = canonicalManifestId({ repositoryId: REPO, revisionId, entries });
      await manifests.put({
        manifestId, repositoryId: REPO, revisionId,
        commitSha: 'c'.repeat(40), treeOid: computeTreeOid(entries), targetRef: REF,
        entries, createdAt: '2026-10-17T00:00:00.000Z',
      });
      await refs.promote(REF, {
        expectedCurrent: null, current: null,
        target: { commitSha: 'c'.repeat(40), treeOid: computeTreeOid(entries), manifestId },
        targetVerified: true,
      });
      await pins.pin(manifestId, 'rollback', 'LKG');
      await attachGoalBasePin(refs, overlays, {
        goalWorkspaceId: 'goal_a',
        canonicalRef: REF,
        expectedBase: {
          commitSha: 'c'.repeat(40),
          treeOid: computeTreeOid(entries),
          manifestId,
        },
      });
      await quarantine.quarantine([H('9')], { now: NOW, graceMs: 60_000 });
      await jobs.open('op_reindex', manifestId, NOW);

      const report = await canonicalStatus({ refs, manifests, pins, overlays, quarantine, jobs });
      expect(report).toMatchObject({
        status: 'healthy',
        refs: [{ ref: REF, manifestId }],
        manifestCount: 1,
        pinCount: 1,
        overlayCount: 1,
        quarantinedCount: 1,
        activeJobCount: 1,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('degrades when a ref dangles, a pin orphans, or an overlay loses its base', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'canon-status-'));
    try {
      const refs = new CanonicalRefStore(dir);
      const manifests = new CanonicalManifestStore(dir);
      const pins = new RevisionPinRegistry(dir);
      const overlays = new GoalOverlayStore(dir);
      const quarantine = new ArtifactQuarantineStore(dir);
      const jobs = new IndexJobLedger(dir);

      const entries = [{ path: 'a.ts', contentHash: H('2') }];
      const treeOid = computeTreeOid(entries);
      const revisionId = canonicalRevisionId({
        repositoryId: REPO, commitSha: 'f'.repeat(40), treeOid, targetRef: REF, parents: [],
      });
      const manifestId = canonicalManifestId({ repositoryId: REPO, revisionId, entries });
      await manifests.put({
        manifestId, repositoryId: REPO, revisionId,
        commitSha: 'f'.repeat(40), treeOid, targetRef: REF,
        entries, createdAt: '2026-10-17T00:00:00.000Z',
      });
      await refs.promote(REF, {
        expectedCurrent: null, current: null,
        target: { commitSha: 'f'.repeat(40), treeOid, manifestId },
        targetVerified: true,
      });
      await pins.pin(manifestId, 'rollback', 'LKG');
      await attachGoalBasePin(refs, overlays, {
        goalWorkspaceId: 'goal_a',
        canonicalRef: REF,
        expectedBase: { commitSha: 'f'.repeat(40), treeOid, manifestId },
      });
      // Manifest deleted out from under the ref, pin and overlay base:
      // exactly the corruption the status projection must surface.
      expect(await manifests.delete(manifestId)).toBe(true);

      const report = await canonicalStatus({ refs, manifests, pins, overlays, quarantine, jobs });
      expect(report.status).toBe('degraded');
      expect(report.danglingRefs).toEqual([{ ref: REF, manifestId }]);
      expect(report.orphanedPins).toEqual([manifestId]);
      expect(report.missingOverlayBases).toEqual(['goal_a']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('counts quarantined rows and unsettled jobs separately from manifests', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'canon-status-'));
    try {
      const quarantine = new ArtifactQuarantineStore(dir);
      const jobs = new IndexJobLedger(dir);
      await quarantine.quarantine([H('1'), H('2')], { now: NOW, graceMs: 60_000 });
      await jobs.open('op_1', `man:v1:${'a'.repeat(64)}`, NOW);
      await jobs.open('op_2', `man:v1:${'a'.repeat(64)}`, NOW);
      await jobs.settle('op_2');

      const report = await canonicalStatus({
        refs: new CanonicalRefStore(dir),
        manifests: new CanonicalManifestStore(dir),
        pins: new RevisionPinRegistry(dir),
        overlays: new GoalOverlayStore(dir),
        quarantine,
        jobs,
      });
      expect(report.quarantinedCount).toBe(2);
      expect(report.activeJobCount).toBe(1);
      expect(report.manifestCount).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
