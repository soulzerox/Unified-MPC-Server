import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalManifestId, computeTreeOid } from '@unified-mpc/domain';
import { CanonicalManifestStore, type StoredManifest } from './canonical-manifest-store.js';
import { CanonicalRefStore } from './canonical-ref-store.js';
import { GoalOverlayStore } from './goal-overlay-store.js';
import { attachGoalBasePin } from './goal-base-pin.js';
import { resolveCanonicalSourceIdentity } from './canonical-source-identity.js';

const REPO = 'repo_abc123';
const OTHER_REPO = 'repo_other';
const REF = 'refs/remotes/origin/main';
const COMMIT = 'c'.repeat(40);
const ENTRIES = [
  { path: 'src/a.ts', contentHash: 'a'.repeat(64) },
  { path: 'src/b.ts', contentHash: 'b'.repeat(64) },
];

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'canonical-source-identity-'));
  roots.push(root);
  return root;
}

interface SeededRevision {
  readonly refs: CanonicalRefStore;
  readonly manifests: CanonicalManifestStore;
  readonly overlays: GoalOverlayStore;
  readonly manifest: StoredManifest;
}

async function seedRevision(options: {
  readonly root: string;
  readonly repositoryId?: string;
  readonly commitSha?: string;
  readonly entries?: readonly { readonly path: string; readonly contentHash: string }[];
  readonly ref?: string;
  readonly promote?: boolean;
}): Promise<SeededRevision> {
  const refs = new CanonicalRefStore(options.root);
  const manifests = new CanonicalManifestStore(options.root, { strictReads: true });
  const overlays = new GoalOverlayStore(options.root);
  const entries = options.entries ?? ENTRIES;
  const repositoryId = options.repositoryId ?? REPO;
  const revisionId = `rev:v1:${'e'.repeat(64)}`;
  const commitSha = options.commitSha ?? COMMIT;
  const treeOid = computeTreeOid(entries);
  const manifestId = canonicalManifestId({ repositoryId, revisionId, entries });
  const manifest: StoredManifest = {
    manifestId,
    repositoryId,
    revisionId,
    commitSha,
    treeOid,
    targetRef: options.ref ?? REF,
    entries,
    createdAt: '2026-11-06T00:00:00.000Z',
  };
  await manifests.put(manifest);
  if (options.promote !== false) {
    await refs.promote(options.ref ?? REF, {
      expectedCurrent: null,
      current: null,
      target: { commitSha, treeOid, manifestId },
      targetVerified: true,
    });
  }
  return { refs, manifests, overlays, manifest };
}

describe('resolveCanonicalSourceIdentity (#210 §13)', () => {
  it('binds a clean plain checkout to the exact ref and manifest fields', async () => {
    const root = await tempRoot();
    const stores = await seedRevision({ root });
    const resolution = await resolveCanonicalSourceIdentity(
      { refs: stores.refs, manifests: stores.manifests, overlays: stores.overlays },
      { canonicalRef: REF, expectedRepositoryIds: [REPO, OTHER_REPO], goal: null },
    );
    expect(resolution).toEqual({
      status: 'bound',
      identity: {
        repository_id: REPO,
        manifest_id: stores.manifest.manifestId,
        revision_id: stores.manifest.revisionId,
        commit_sha: COMMIT,
        tree_oid: stores.manifest.treeOid,
        ref: REF,
      },
    });
  });

  it('treats a checkout without an origin as absent, never as a store failure', async () => {
    const root = await tempRoot();
    const stores = await seedRevision({ root });
    await expect(resolveCanonicalSourceIdentity(
      { refs: stores.refs, manifests: stores.manifests, overlays: stores.overlays },
      { canonicalRef: REF, expectedRepositoryIds: null, goal: null },
    )).resolves.toEqual({ status: 'absent', reason: 'no_repository' });
  });

  it('reports a never-promoted ref as absent', async () => {
    const root = await tempRoot();
    const stores = await seedRevision({ root, promote: false });
    await expect(resolveCanonicalSourceIdentity(
      { refs: stores.refs, manifests: stores.manifests, overlays: stores.overlays },
      { canonicalRef: REF, expectedRepositoryIds: [REPO], goal: null },
    )).resolves.toEqual({ status: 'absent', reason: 'no_canonical_ref' });
  });

  it('refuses a corrupt ref instead of reading it as never promoted', async () => {
    const root = await tempRoot();
    const stores = await seedRevision({ root });
    await writeFile(path.join(root, 'refs', 'remotes', 'origin', 'main.json'), '{not json', 'utf8');
    await expect(resolveCanonicalSourceIdentity(
      { refs: stores.refs, manifests: stores.manifests, overlays: stores.overlays },
      { canonicalRef: REF, expectedRepositoryIds: [REPO], goal: null },
    )).rejects.toThrow(/cannot read canonical ref/);
  });

  it('refuses a ref that names a missing manifest row', async () => {
    const root = await tempRoot();
    const refs = new CanonicalRefStore(root);
    const manifests = new CanonicalManifestStore(root, { strictReads: true });
    const overlays = new GoalOverlayStore(root);
    await refs.promote(REF, {
      expectedCurrent: null,
      current: null,
      target: { commitSha: COMMIT, treeOid: 'd'.repeat(40), manifestId: `man:v1:${'f'.repeat(64)}` },
      targetVerified: true,
    });
    await expect(resolveCanonicalSourceIdentity(
      { refs, manifests, overlays },
      { canonicalRef: REF, expectedRepositoryIds: [REPO], goal: null },
    )).rejects.toThrow(/missing manifest/);
  });

  it('refuses a manifest that belongs to another repository', async () => {
    const root = await tempRoot();
    const stores = await seedRevision({ root, repositoryId: OTHER_REPO });
    await expect(resolveCanonicalSourceIdentity(
      { refs: stores.refs, manifests: stores.manifests, overlays: stores.overlays },
      { canonicalRef: REF, expectedRepositoryIds: [REPO], goal: null },
    )).rejects.toThrow(new RegExp(`belongs to repository ${OTHER_REPO}`));
  });

  it('refuses a manifest whose revision metadata disagrees with the ref', async () => {
    const root = await tempRoot();
    const stores = await seedRevision({ root, commitSha: '9'.repeat(40) });
    const refs = new CanonicalRefStore(root);
    await refs.promote(REF, {
      expectedCurrent: {
        commitSha: '9'.repeat(40), treeOid: stores.manifest.treeOid, manifestId: stores.manifest.manifestId,
      },
      current: {
        commitSha: '9'.repeat(40), treeOid: stores.manifest.treeOid, manifestId: stores.manifest.manifestId,
      },
      target: { commitSha: COMMIT, treeOid: stores.manifest.treeOid, manifestId: stores.manifest.manifestId },
      targetVerified: true,
    });
    await expect(resolveCanonicalSourceIdentity(
      { refs, manifests: stores.manifests, overlays: stores.overlays },
      { canonicalRef: REF, expectedRepositoryIds: [REPO], goal: null },
    )).rejects.toThrow(/does not describe|describes/);
  });

  it('binds an admitted Goal through its overlay base', async () => {
    const root = await tempRoot();
    const stores = await seedRevision({ root });
    await attachGoalBasePin(stores.refs, stores.overlays, {
      goalWorkspaceId: 'goal-1',
      canonicalRef: REF,
      expectedBase: {
        commitSha: COMMIT, treeOid: stores.manifest.treeOid, manifestId: stores.manifest.manifestId,
      },
    });
    await stores.overlays.upsert('goal-1', {
      path: 'src/a.ts', kind: 'modified', contentHash: '1'.repeat(64),
    });
    const resolution = await resolveCanonicalSourceIdentity(
      { refs: stores.refs, manifests: stores.manifests, overlays: stores.overlays },
      { canonicalRef: REF, expectedRepositoryIds: [REPO], goal: { goalWorkspaceId: 'goal-1' } },
    );
    expect(resolution.status).toBe('bound');
    if (resolution.status !== 'bound') return;
    expect(resolution.identity.manifest_id).toBe(stores.manifest.manifestId);
    expect(resolution.identity.commit_sha).toBe(COMMIT);
  });

  it('reports an unpinned Goal as goal_unadmitted but keeps the reason', async () => {
    const root = await tempRoot();
    const stores = await seedRevision({ root });
    const resolution = await resolveCanonicalSourceIdentity(
      { refs: stores.refs, manifests: stores.manifests, overlays: stores.overlays },
      { canonicalRef: REF, expectedRepositoryIds: [REPO], goal: { goalWorkspaceId: 'goal-2' } },
    );
    expect(resolution.status).toBe('goal_unadmitted');
    if (resolution.status !== 'goal_unadmitted') return;
    expect(resolution.reason).toMatch(/no overlay/);
  });

  it('reports a drifted Goal base as goal_unadmitted', async () => {
    const root = await tempRoot();
    const stores = await seedRevision({ root });
    await attachGoalBasePin(stores.refs, stores.overlays, {
      goalWorkspaceId: 'goal-1',
      canonicalRef: REF,
      expectedBase: {
        commitSha: COMMIT, treeOid: stores.manifest.treeOid, manifestId: stores.manifest.manifestId,
      },
    });
    const movedCommit = 'd'.repeat(40);
    const movedRevisionId = `rev:v1:${'1'.repeat(64)}`;
    const movedManifest: StoredManifest = {
      manifestId: canonicalManifestId({ repositoryId: REPO, revisionId: movedRevisionId, entries: ENTRIES }),
      repositoryId: REPO,
      revisionId: movedRevisionId,
      commitSha: movedCommit,
      treeOid: computeTreeOid(ENTRIES),
      targetRef: REF,
      entries: ENTRIES,
      createdAt: '2026-11-06T00:10:00.000Z',
    };
    await stores.manifests.put(movedManifest);
    await stores.refs.promote(REF, {
      expectedCurrent: {
        commitSha: COMMIT, treeOid: stores.manifest.treeOid, manifestId: stores.manifest.manifestId,
      },
      current: {
        commitSha: COMMIT, treeOid: stores.manifest.treeOid, manifestId: stores.manifest.manifestId,
      },
      target: {
        commitSha: movedManifest.commitSha, treeOid: movedManifest.treeOid, manifestId: movedManifest.manifestId,
      },
      targetVerified: true,
    });
    const resolution = await resolveCanonicalSourceIdentity(
      { refs: stores.refs, manifests: stores.manifests, overlays: stores.overlays },
      { canonicalRef: REF, expectedRepositoryIds: [REPO], goal: { goalWorkspaceId: 'goal-1' } },
    );
    expect(resolution.status).toBe('goal_unadmitted');
    if (resolution.status !== 'goal_unadmitted') return;
    expect(resolution.reason).toMatch(/drift/);
  });

  it('refuses a corrupt Goal overlay instead of calling the Goal unadmitted', async () => {
    const root = await tempRoot();
    const stores = await seedRevision({ root });
    await attachGoalBasePin(stores.refs, stores.overlays, {
      goalWorkspaceId: 'goal-1',
      canonicalRef: REF,
      expectedBase: {
        commitSha: COMMIT, treeOid: stores.manifest.treeOid, manifestId: stores.manifest.manifestId,
      },
    });
    await writeFile(path.join(root, 'overlays', 'goal-1.json'), '{not json', 'utf8');
    await expect(resolveCanonicalSourceIdentity(
      { refs: stores.refs, manifests: stores.manifests, overlays: stores.overlays },
      { canonicalRef: REF, expectedRepositoryIds: [REPO], goal: { goalWorkspaceId: 'goal-1' } },
    )).rejects.toThrow(/goal overlay/);
  });
});
