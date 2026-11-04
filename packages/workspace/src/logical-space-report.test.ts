import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalManifestId, canonicalRevisionId, computeTreeOid, fileArtifactId } from '@unified-mpc/domain';
import { CanonicalArtifactStore } from './canonical-artifact-store.js';
import { CanonicalManifestStore } from './canonical-manifest-store.js';
import { CanonicalRefStore } from './canonical-ref-store.js';
import { GoalOverlayStore } from './goal-overlay-store.js';
import { RevisionPinRegistry } from './revision-pin-registry.js';
import { logicalSpaceReport, logicalSpaceReportFromRoot } from './logical-space-report.js';

const REPO = 'repo_abc123';
const REF = 'refs/remotes/origin/main';
const H = (n: string): string => n.repeat(64).slice(0, 64);

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'logical-space-'));
  temporaryRoots.push(root);
  return root;
}

async function stores(root: string): Promise<{
  refs: CanonicalRefStore;
  manifests: CanonicalManifestStore;
  pins: RevisionPinRegistry;
  overlays: GoalOverlayStore;
}> {
  return {
    refs: new CanonicalRefStore(root),
    manifests: new CanonicalManifestStore(root),
    pins: new RevisionPinRegistry(root),
    overlays: new GoalOverlayStore(root),
  };
}

/** One live manifest (reachable from the canonical ref) + one orphan manifest. */
async function seeded(root: string): Promise<{
  refs: CanonicalRefStore;
  manifests: CanonicalManifestStore;
  pins: RevisionPinRegistry;
  overlays: GoalOverlayStore;
  liveManifestId: string;
  orphanManifestId: string;
}> {
  const { refs, manifests, pins, overlays } = await stores(root);
  const liveEntries = [{ path: 'live.ts', contentHash: H('a') }];
  const orphanEntries = [{ path: 'orphan.ts', contentHash: H('b') }];
  const liveRevision = canonicalRevisionId({
    repositoryId: REPO, commitSha: 'c'.repeat(40), treeOid: computeTreeOid(liveEntries), targetRef: REF, parents: [],
  });
  const liveManifestId = canonicalManifestId({ repositoryId: REPO, revisionId: liveRevision, entries: liveEntries });
  const orphanRevision = canonicalRevisionId({
    repositoryId: REPO, commitSha: 'd'.repeat(40), treeOid: computeTreeOid(orphanEntries), targetRef: REF, parents: [],
  });
  const orphanManifestId = canonicalManifestId({ repositoryId: REPO, revisionId: orphanRevision, entries: orphanEntries });

  for (const [manifestId, commitSha, entries] of [
    [liveManifestId, 'c'.repeat(40), liveEntries],
    [orphanManifestId, 'd'.repeat(40), orphanEntries],
  ] as const) {
    await manifests.put({
      manifestId,
      repositoryId: REPO,
      revisionId: canonicalRevisionId({
        repositoryId: REPO, commitSha, treeOid: computeTreeOid(entries), targetRef: REF, parents: [],
      }),
      commitSha,
      treeOid: computeTreeOid(entries),
      targetRef: REF,
      entries,
      createdAt: '2026-10-18T00:00:00.000Z',
    });
  }
  await refs.promote(REF, {
    expectedCurrent: null,
    current: null,
    target: { commitSha: 'c'.repeat(40), treeOid: computeTreeOid(liveEntries), manifestId: liveManifestId },
    targetVerified: true,
  });
  return { refs, manifests, pins, overlays, liveManifestId, orphanManifestId };
}

/** Register one file artifact so the store-backed report has a candidate. */
async function seedArtifact(root: string, contentHash: string): Promise<void> {
  await new CanonicalArtifactStore(root).put({
    kind: 'file',
    artifactKey: fileArtifactId({
      sourceContentSha256: contentHash,
      language: 'typescript',
      sourceKind: 'source',
      representationVersion: 'v1',
    }),
    repositoryId: REPO,
    sourceContentSha256: contentHash,
    language: 'typescript',
    sourceKind: 'source',
    representationVersion: 'v1',
    bindings: [{ path: 'live.ts' }],
    createdAt: '2026-10-18T00:00:00.000Z',
  });
}

describe('logical space report (#210 §2 logical counts)', () => {
  it('counts retained vs prunable manifests and reachable vs unreferenced artifacts', async () => {
    const root = await tempRoot();
    const { refs, manifests, pins, overlays, liveManifestId, orphanManifestId } = await seeded(root);

    const report = await logicalSpaceReport({
      refs, manifests, pins, overlays,
      indexJobManifestIds: [],
      artifactCandidates: [H('a'), H('b')],
    });

    expect(report.status).toBe('measured');
    if (report.status !== 'measured') throw new Error('unreachable');
    expect(report.manifests).toMatchObject({ total: 2, retained: 1, prunable: 1 });
    expect(report.manifests.retainedManifestIds).toEqual([liveManifestId]);
    expect(report.manifests.prunableManifestIds).toEqual([orphanManifestId]);
    expect(report.artifacts).toMatchObject({ total: 2, reachable: 1, unreferenced: 1 });
    expect(report.artifacts.unreferencedHashes).toEqual([H('b')]);
    // Sizes were not supplied, so bytes are reported as not measurable — never zero.
    expect(report.artifacts.bytesMeasurable).toBe(false);
    expect(report.artifacts.unreferencedBytes).toBeNull();
    expect(report.artifacts.reachableBytes).toBeNull();
  });

  it('sums artifact bytes only when every counted artifact has a measured size', async () => {
    const root = await tempRoot();
    const { refs, manifests, pins, overlays } = await seeded(root);
    const sizes = new Map([[H('a'), 1_000], [H('b'), 2_500]]);

    const report = await logicalSpaceReport({
      refs, manifests, pins, overlays,
      indexJobManifestIds: [],
      artifactCandidates: [H('a'), H('b')],
      artifactBytes: sizes,
    });

    expect(report.status).toBe('measured');
    if (report.status !== 'measured') throw new Error('unreachable');
    expect(report.artifacts.bytesMeasurable).toBe(true);
    expect(report.artifacts.reachableBytes).toBe(1_000);
    expect(report.artifacts.unreferencedBytes).toBe(2_500);
  });

  it('refuses to claim byte totals when a counted artifact has no measured size', async () => {
    const root = await tempRoot();
    const { refs, manifests, pins, overlays } = await seeded(root);

    const report = await logicalSpaceReport({
      refs, manifests, pins, overlays,
      indexJobManifestIds: [],
      artifactCandidates: [H('a'), H('b')],
      artifactBytes: new Map([[H('a'), 1_000]]),
    });

    expect(report.status).toBe('measured');
    if (report.status !== 'measured') throw new Error('unreachable');
    expect(report.artifacts.bytesMeasurable).toBe(false);
    expect(report.artifacts.reachableBytes).toBeNull();
    expect(report.artifacts.unreferencedBytes).toBeNull();
  });

  it('refuses instead of reporting zero retention when no reachability roots exist', async () => {
    const root = await tempRoot();
    const { refs, manifests, pins, overlays } = await stores(root);

    const report = await logicalSpaceReport({
      refs, manifests, pins, overlays,
      indexJobManifestIds: [],
      artifactCandidates: [H('a'), H('b')],
    });

    expect(report.status).toBe('refused');
    if (report.status !== 'refused') throw new Error('unreachable');
    expect(report.reason).toMatch(/no reachability roots/i);
  });

  it('refuses when a reachability root manifest is missing on disk', async () => {
    const root = await tempRoot();
    const { refs, manifests, pins, overlays, liveManifestId } = await seeded(root);
    await manifests.delete(liveManifestId);

    const report = await logicalSpaceReport({
      refs, manifests, pins, overlays,
      indexJobManifestIds: [],
      artifactCandidates: [H('a')],
    });

    expect(report.status).toBe('refused');
    if (report.status !== 'refused') throw new Error('unreachable');
    expect(report.reason).toMatch(/missing manifests/i);
  });

  it('reports only logical counts, never a physical database claim', async () => {
    const root = await tempRoot();
    const { refs, manifests, pins, overlays } = await seeded(root);

    const report = await logicalSpaceReport({
      refs, manifests, pins, overlays,
      indexJobManifestIds: [],
      artifactCandidates: [H('a'), H('b')],
    });

    // Row deletion / prune is not compaction: this projection never exposes
    // SQLite file sizes, page counts, or freelist values. Those are owned by
    // @unified-mpc/storage's physical metrics.
    for (const physical of ['databaseBytes', 'walBytes', 'shmBytes', 'pageCount', 'freelistCount', 'checkpoint']) {
      expect(physical in report).toBe(false);
    }
  });
});

describe('logical space report from the canonical root (#210 §2)', () => {
  it('measures a seeded store from the root alone', async () => {
    const root = await tempRoot();
    await seeded(root);
    await seedArtifact(root, H('a'));

    const report = await logicalSpaceReportFromRoot(root);

    expect(report.status).toBe('measured');
    if (report.status !== 'measured') throw new Error('unreachable');
    expect(report.manifests).toMatchObject({ total: 2, retained: 1, prunable: 1 });
    expect(report.artifacts).toMatchObject({ total: 1, reachable: 1, unreferenced: 0 });
  });

  it('refuses an unreadable artifact record instead of undercounting it', async () => {
    const root = await tempRoot();
    await seeded(root);
    await seedArtifact(root, H('a'));
    await writeFile(path.join(root, 'artifacts', 'corrupt.json'), '{not json', 'utf8');

    const report = await logicalSpaceReportFromRoot(root);

    expect(report.status).toBe('refused');
    if (report.status !== 'refused') throw new Error('unreachable');
    expect(report.reason).toMatch(/cannot read canonical artifact/);
  });

  it('refuses an unreadable ref record instead of reporting a smaller store', async () => {
    const root = await tempRoot();
    await seeded(root);
    await seedArtifact(root, H('a'));
    await writeFile(path.join(root, 'refs', 'remotes', 'origin', 'main.json'), '{not json', 'utf8');

    const report = await logicalSpaceReportFromRoot(root);

    expect(report.status).toBe('refused');
    if (report.status !== 'refused') throw new Error('unreachable');
    expect(report.reason).toMatch(/cannot read canonical ref/);
  });

  it('returns refused rather than throwing when a root store cannot be read', async () => {
    const root = await tempRoot();
    const { refs, manifests, pins, overlays } = await seeded(root);
    await writeFile(path.join(root, 'refs', 'remotes', 'origin', 'main.json'), '{not json', 'utf8');

    // The prune planner reads roots strictly; a direct caller of the
    // deps-based report must get the documented refusal, not a raw throw.
    const report = await logicalSpaceReport({
      refs, manifests, pins, overlays,
      indexJobManifestIds: [],
      artifactCandidates: [H('a')],
    });

    expect(report.status).toBe('refused');
    if (report.status !== 'refused') throw new Error('unreachable');
    expect(report.reason).toMatch(/cannot read canonical ref/);
  });
});
