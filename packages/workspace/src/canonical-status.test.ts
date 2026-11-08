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
import { canonicalStatus, boundCanonicalStatusReport, type CanonicalStatusReport } from './canonical-status.js';

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
        refCount: 0,
        overlayCount: 0,
        quarantinedCount: 0,
        activeJobCount: 0,
        danglingRefCount: 0,
        missingOverlayBaseCount: 0,
        orphanedPinCount: 0,
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
        manifestCount: 1,
        pinCount: 1,
        overlayCount: 1,
        quarantinedCount: 1,
        activeJobCount: 1,
      });
      expect(report.refs).toEqual([{
        ref: REF,
        manifestId,
        commitSha: 'c'.repeat(40),
        treeOid: computeTreeOid(entries),
        manifestCreatedAt: '2026-10-17T00:00:00.000Z',
        manifestEntryCount: 1,
        manifestExists: true,
        pinned: true,
        pinReasons: ['rollback'],
      }]);
      expect(report.overlays).toEqual([{
        goalWorkspaceId: 'goal_a',
        baseManifestId: manifestId,
        baseCommitSha: 'c'.repeat(40),
        baseTreeOid: computeTreeOid(entries),
        baseManifestExists: true,
        baseMatchesLiveRef: true,
        modifiedCount: 0,
        addedCount: 0,
        deletedCount: 0,
        updatedAt: expect.any(String),
      }]);
      expect(report.jobs).toEqual([{
        operationId: 'op_reindex',
        manifestId,
        status: 'pending',
        openedAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
        manifestExists: true,
      }]);
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
      expect(report.danglingRefCount).toBe(1);
      expect(report.orphanedPinCount).toBe(1);
      expect(report.missingOverlayBaseCount).toBe(1);
      expect(report.refs).toEqual([expect.objectContaining({ ref: REF, manifestId, manifestExists: false })]);
      expect(report.overlays).toEqual([
        expect.objectContaining({ goalWorkspaceId: 'goal_a', baseManifestExists: false, baseMatchesLiveRef: false }),
      ]);
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

  it('reports an overlay base that drifted from the live ref without degrading', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'canon-status-'));
    try {
      const refs = new CanonicalRefStore(dir);
      const manifests = new CanonicalManifestStore(dir);
      const pins = new RevisionPinRegistry(dir);
      const overlays = new GoalOverlayStore(dir);
      const quarantine = new ArtifactQuarantineStore(dir);
      const jobs = new IndexJobLedger(dir);

      const baseEntries = [{ path: 'live.ts', contentHash: H('1') }];
      const baseTree = computeTreeOid(baseEntries);
      const baseRevision = canonicalRevisionId({
        repositoryId: REPO, commitSha: '1'.repeat(40), treeOid: baseTree, targetRef: REF, parents: [],
      });
      const baseManifest = canonicalManifestId({ repositoryId: REPO, revisionId: baseRevision, entries: baseEntries });
      await manifests.put({
        manifestId: baseManifest, repositoryId: REPO, revisionId: baseRevision,
        commitSha: '1'.repeat(40), treeOid: baseTree, targetRef: REF,
        entries: baseEntries, createdAt: '2026-10-17T00:00:00.000Z',
      });
      await refs.promote(REF, {
        expectedCurrent: null, current: null,
        target: { commitSha: '1'.repeat(40), treeOid: baseTree, manifestId: baseManifest },
        targetVerified: true,
      });
      await attachGoalBasePin(refs, overlays, {
        goalWorkspaceId: 'goal_a',
        canonicalRef: REF,
        expectedBase: { commitSha: '1'.repeat(40), treeOid: baseTree, manifestId: baseManifest },
      });
      await overlays.upsert('goal_a', { path: 'dirty.ts', kind: 'modified', contentHash: H('2') });
      await overlays.upsert('goal_a', { path: 'new.ts', kind: 'added', contentHash: H('3') });
      await overlays.upsert('goal_a', { path: 'gone.ts', kind: 'deleted', contentHash: null });

      const nextEntries = [{ path: 'live.ts', contentHash: H('4') }];
      const nextTree = computeTreeOid(nextEntries);
      const nextRevision = canonicalRevisionId({
        repositoryId: REPO, commitSha: '2'.repeat(40), treeOid: nextTree, targetRef: REF, parents: [],
      });
      const nextManifest = canonicalManifestId({ repositoryId: REPO, revisionId: nextRevision, entries: nextEntries });
      await manifests.put({
        manifestId: nextManifest, repositoryId: REPO, revisionId: nextRevision,
        commitSha: '2'.repeat(40), treeOid: nextTree, targetRef: REF,
        entries: nextEntries, createdAt: '2026-10-18T00:00:00.000Z',
      });
      await refs.promote(REF, {
        expectedCurrent: { commitSha: '1'.repeat(40), treeOid: baseTree, manifestId: baseManifest },
        target: { commitSha: '2'.repeat(40), treeOid: nextTree, manifestId: nextManifest },
        targetVerified: true,
      });

      const report = await canonicalStatus({ refs, manifests, pins, overlays, quarantine, jobs });
      expect(report.status).toBe('healthy');
      expect(report.refs).toEqual([expect.objectContaining({ manifestId: nextManifest, manifestExists: true })]);
      expect(report.overlays).toEqual([{
        goalWorkspaceId: 'goal_a',
        baseManifestId: baseManifest,
        baseCommitSha: '1'.repeat(40),
        baseTreeOid: baseTree,
        baseManifestExists: true,
        baseMatchesLiveRef: false,
        modifiedCount: 1,
        addedCount: 1,
        deletedCount: 1,
        updatedAt: expect.any(String),
      }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports a malformed ref manifest id as dangling instead of throwing', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'canon-status-'));
    try {
      const refs = new CanonicalRefStore(dir);
      await refs.promote(REF, {
        expectedCurrent: null, current: null,
        target: { commitSha: 'c'.repeat(40), treeOid: 'd'.repeat(40), manifestId: 'not-a-manifest' },
        targetVerified: true,
      });

      const report = await canonicalStatus({
        refs,
        manifests: new CanonicalManifestStore(dir),
        pins: new RevisionPinRegistry(dir),
        overlays: new GoalOverlayStore(dir),
        quarantine: new ArtifactQuarantineStore(dir),
        jobs: new IndexJobLedger(dir),
      });
      expect(report.status).toBe('degraded');
      expect(report.danglingRefs).toEqual([{ ref: REF, manifestId: 'not-a-manifest' }]);
      expect(report.refs).toEqual([expect.objectContaining({
        ref: REF,
        manifestId: 'not-a-manifest',
        manifestExists: false,
        treeOid: null,
        manifestEntryCount: null,
        pinned: false,
        pinReasons: [],
      })]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports an unsettled job whose manifest is no longer stored', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'canon-status-'));
    try {
      const jobs = new IndexJobLedger(dir);
      const missingManifest = `man:v1:${'a'.repeat(64)}`;
      await jobs.open('op_orphan', missingManifest, NOW);

      const report = await canonicalStatus({
        refs: new CanonicalRefStore(dir),
        manifests: new CanonicalManifestStore(dir),
        pins: new RevisionPinRegistry(dir),
        overlays: new GoalOverlayStore(dir),
        quarantine: new ArtifactQuarantineStore(dir),
        jobs,
      });
      // The store's own verdict ignores jobs; the projection must still expose
      // that the ledger roots at a manifest no longer stored.
      expect(report.status).toBe('healthy');
      expect(report.jobs).toEqual([{
        operationId: 'op_orphan',
        manifestId: missingManifest,
        status: 'pending',
        openedAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
        manifestExists: false,
      }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('boundCanonicalStatusReport (#210 status bound)', () => {
  const manifestId = `man:v1:${'a'.repeat(64)}`;
  const refRow = (ref: string): CanonicalStatusReport['refs'][number] => ({
    ref,
    manifestId,
    commitSha: 'b'.repeat(40),
    treeOid: 'c'.repeat(40),
    manifestCreatedAt: '2026-11-01T00:00:00.000Z',
    manifestEntryCount: 1,
    manifestExists: true,
    pinned: false,
    pinReasons: [],
  });
  const overlayRow = (goalWorkspaceId: string): CanonicalStatusReport['overlays'][number] => ({
    goalWorkspaceId,
    baseManifestId: manifestId,
    baseCommitSha: 'b'.repeat(40),
    baseTreeOid: 'c'.repeat(40),
    baseManifestExists: true,
    baseMatchesLiveRef: true,
    modifiedCount: 0,
    addedCount: 0,
    deletedCount: 0,
    updatedAt: '2026-11-01T00:00:00.000Z',
  });
  const jobRow = (operationId: string, openedAt: string): CanonicalStatusReport['jobs'][number] => ({
    operationId,
    manifestId,
    status: 'pending',
    openedAt,
    updatedAt: openedAt,
    manifestExists: true,
  });

  const wide: CanonicalStatusReport = {
    status: 'degraded',
    refs: [refRow('refs/remotes/origin/main'), refRow('refs/remotes/origin/next'), refRow('refs/remotes/origin/dev')],
    overlays: [overlayRow('goal_a'), overlayRow('goal_b')],
    jobs: [jobRow('op_c', '2026-11-03T00:00:00.000Z'), jobRow('op_b', '2026-11-02T00:00:00.000Z'), jobRow('op_a', '2026-11-01T00:00:00.000Z')],
    manifestCount: 4,
    pinCount: 2,
    refCount: 3,
    overlayCount: 2,
    quarantinedCount: 1,
    activeJobCount: 3,
    danglingRefs: [{ ref: 'refs/remotes/origin/gone', manifestId }, { ref: 'refs/remotes/origin/lost', manifestId }],
    missingOverlayBases: ['goal_x', 'goal_y'],
    orphanedPins: [manifestId, `man:v1:${'d'.repeat(64)}`],
    danglingRefCount: 2,
    missingOverlayBaseCount: 2,
    orphanedPinCount: 2,
  };

  it('windows every row collection while keeping full-store counts and the verdict', () => {
    const bounded = boundCanonicalStatusReport(wide, 1);
    expect(bounded.status).toBe('degraded');
    expect(bounded.refs).toHaveLength(1);
    expect(bounded.overlays).toHaveLength(1);
    expect(bounded.jobs).toHaveLength(1);
    expect(bounded.danglingRefs).toHaveLength(1);
    expect(bounded.missingOverlayBases).toHaveLength(1);
    expect(bounded.orphanedPins).toHaveLength(1);
    // Every count still describes the whole store, so truncation is visible.
    expect(bounded).toMatchObject({
      manifestCount: 4,
      pinCount: 2,
      refCount: 3,
      overlayCount: 2,
      quarantinedCount: 1,
      activeJobCount: 3,
      danglingRefCount: 2,
      missingOverlayBaseCount: 2,
      orphanedPinCount: 2,
    });
    // The input report is not mutated.
    expect(wide.refs).toHaveLength(3);
    expect(wide.jobs).toHaveLength(3);
  });

  it('windows jobs in a deterministic opened-at then operation-id order', () => {
    expect(boundCanonicalStatusReport(wide, 2).jobs.map((job) => job.operationId)).toEqual(['op_a', 'op_b']);
    const sameInstant = {
      ...wide,
      jobs: [jobRow('op_z', '2026-11-01T00:00:00.000Z'), jobRow('op_y', '2026-11-01T00:00:00.000Z')],
    };
    expect(boundCanonicalStatusReport(sameInstant, 2).jobs.map((job) => job.operationId)).toEqual(['op_y', 'op_z']);
  });

  it('treats an omitted, non-finite, fractional or negative limit as a bounded window', () => {
    expect(boundCanonicalStatusReport(wide, Number.NaN).refs).toHaveLength(0);
    expect(boundCanonicalStatusReport(wide, Number.POSITIVE_INFINITY).refs).toHaveLength(0);
    expect(boundCanonicalStatusReport(wide, -5).refs).toHaveLength(0);
    expect(boundCanonicalStatusReport(wide, 0).refs).toHaveLength(0);
    expect(boundCanonicalStatusReport(wide, 1.9).refs).toHaveLength(1);
    expect(boundCanonicalStatusReport(wide, 10).refs).toHaveLength(3);
  });
});
