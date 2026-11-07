import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalManifestId, canonicalRevisionId, computeTreeOid } from '@unified-mpc/domain';
import { CanonicalManifestStore } from './canonical-manifest-store.js';
import { CanonicalRefStore } from './canonical-ref-store.js';
import { GoalOverlayStore } from './goal-overlay-store.js';
import { RevisionPinRegistry } from './revision-pin-registry.js';
import { IndexJobLedger } from './index-job-ledger.js';
import { attachGoalBasePin } from './goal-base-pin.js';
import { canonicalRevisionList } from './canonical-revision-list.js';

const REPO = 'repo_abc123';
const REF = 'refs/remotes/origin/main';
const NOW = new Date('2026-10-17T00:00:00.000Z');
const H = (n: string): string => n.repeat(64).slice(0, 64);

interface ManifestFixture {
  readonly manifestId: string;
  readonly revisionId: string;
  readonly commitSha: string;
  readonly treeOid: string;
  readonly entries: readonly { readonly path: string; readonly contentHash: string }[];
  readonly createdAt: string;
}

function manifestFixture(seed: string, createdAt: string): ManifestFixture {
  const entries = [{ path: `${seed}.ts`, contentHash: H(seed) }];
  const treeOid = computeTreeOid(entries);
  const commitSha = seed.repeat(40).slice(0, 40);
  const revisionId = canonicalRevisionId({ repositoryId: REPO, commitSha, treeOid, targetRef: REF, parents: [] });
  const manifestId = canonicalManifestId({ repositoryId: REPO, revisionId, entries });
  return { manifestId, revisionId, commitSha, treeOid, entries, createdAt };
}

async function putManifest(
  manifests: CanonicalManifestStore,
  fixture: ManifestFixture,
): Promise<void> {
  await manifests.put({
    manifestId: fixture.manifestId,
    repositoryId: REPO,
    revisionId: fixture.revisionId,
    commitSha: fixture.commitSha,
    treeOid: fixture.treeOid,
    targetRef: REF,
    entries: fixture.entries,
    createdAt: fixture.createdAt,
  });
}

describe('canonical revision list projection (#210 §7)', () => {
  it('lists an empty store as zero revisions', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'canon-revisions-'));
    try {
      const report = await canonicalRevisionList({
        refs: new CanonicalRefStore(dir),
        manifests: new CanonicalManifestStore(dir),
        pins: new RevisionPinRegistry(dir),
        overlays: new GoalOverlayStore(dir),
        jobs: new IndexJobLedger(dir),
      });
      expect(report.revisions).toEqual([]);
      expect(report.total).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('lists newest first and reports every retention root per revision', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'canon-revisions-'));
    try {
      const refs = new CanonicalRefStore(dir);
      const manifests = new CanonicalManifestStore(dir);
      const pins = new RevisionPinRegistry(dir);
      const overlays = new GoalOverlayStore(dir);
      const jobs = new IndexJobLedger(dir);

      const older = manifestFixture('a', '2026-10-15T00:00:00.000Z');
      const newer = manifestFixture('b', '2026-10-16T00:00:00.000Z');
      await putManifest(manifests, older);
      await putManifest(manifests, newer);

      await refs.promote(REF, {
        expectedCurrent: null,
        current: null,
        target: { commitSha: newer.commitSha, treeOid: newer.treeOid, manifestId: newer.manifestId },
        targetVerified: true,
      });
      await pins.pin(newer.manifestId, 'rollback', 'LKG');
      await pins.pin(newer.manifestId, 'goal-base', 'goal_a');
      await attachGoalBasePin(refs, overlays, {
        goalWorkspaceId: 'goal_a',
        canonicalRef: REF,
        expectedBase: {
          commitSha: newer.commitSha,
          treeOid: newer.treeOid,
          manifestId: newer.manifestId,
        },
      });
      await jobs.open('op_reindex', older.manifestId, NOW);

      const report = await canonicalRevisionList({ refs, manifests, pins, overlays, jobs });

      expect(report.revisions.map((revision) => revision.manifestId)).toEqual([
        newer.manifestId,
        older.manifestId,
      ]);

      expect(report.revisions[0]).toMatchObject({
        manifestId: newer.manifestId,
        repositoryId: REPO,
        revisionId: newer.revisionId,
        commitSha: newer.commitSha,
        treeOid: newer.treeOid,
        targetRef: REF,
        entryCount: 1,
        createdAt: '2026-10-16T00:00:00.000Z',
        refs: [REF],
        pins: ['goal-base', 'rollback'],
        overlayGoalIds: ['goal_a'],
        indexJobOperationIds: [],
      });

      // The older revision is only held by an unsettled index job.
      expect(report.revisions[1]).toMatchObject({
        manifestId: older.manifestId,
        refs: [],
        pins: [],
        overlayGoalIds: [],
        indexJobOperationIds: ['op_reindex'],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('breaks a createdAt tie by manifest id so the order is stable', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'canon-revisions-'));
    try {
      const manifests = new CanonicalManifestStore(dir);
      const first = manifestFixture('c', '2026-10-16T00:00:00.000Z');
      const second = manifestFixture('d', '2026-10-16T00:00:00.000Z');
      await putManifest(manifests, first);
      await putManifest(manifests, second);

      const report = await canonicalRevisionList({
        refs: new CanonicalRefStore(dir),
        manifests,
        pins: new RevisionPinRegistry(dir),
        overlays: new GoalOverlayStore(dir),
        jobs: new IndexJobLedger(dir),
      });

      const expected = [first.manifestId, second.manifestId].sort();
      expect(report.revisions.map((revision) => revision.manifestId)).toEqual(expected);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('bounds the window before pin reads and keeps the full total', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'canon-revisions-'));
    try {
      const manifests = new CanonicalManifestStore(dir);
      const pins = new RevisionPinRegistry(dir);
      const oldest = manifestFixture('e', '2026-10-14T00:00:00.000Z');
      const middle = manifestFixture('f', '2026-10-15T00:00:00.000Z');
      const newest = manifestFixture('a', '2026-10-16T00:00:00.000Z');
      for (const fixture of [oldest, middle, newest]) await putManifest(manifests, fixture);
      const listSpy = vi.spyOn(pins, 'list');

      const report = await canonicalRevisionList({
        refs: new CanonicalRefStore(dir),
        manifests,
        pins,
        overlays: new GoalOverlayStore(dir),
        jobs: new IndexJobLedger(dir),
      }, { limit: 2 });

      expect(report.total).toBe(3);
      expect(report.revisions.map((revision) => revision.manifestId)).toEqual([
        newest.manifestId,
        middle.manifestId,
      ]);
      // The pruned manifest is never read: the limit applies before pin I/O.
      expect(listSpy.mock.calls.map(([manifestId]) => manifestId)).toEqual([
        newest.manifestId,
        middle.manifestId,
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
