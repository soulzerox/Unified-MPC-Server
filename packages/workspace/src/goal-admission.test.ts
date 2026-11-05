import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalManifestId } from '@unified-mpc/domain';
import { CanonicalManifestStore } from './canonical-manifest-store.js';
import { CanonicalRefStore } from './canonical-ref-store.js';
import { GoalOverlayStore } from './goal-overlay-store.js';
import { attachGoalBasePin } from './goal-base-pin.js';
import { pinGoalBaseAtCommit, verifyGoalAdmission } from './goal-admission.js';

const C100 = {
  commitSha: 'a'.repeat(40),
  treeOid: 'b'.repeat(40),
  manifestId: 'man:v1:' + 'c'.repeat(64),
};

const C200 = {
  commitSha: 'd'.repeat(40),
  treeOid: 'e'.repeat(40),
  manifestId: 'man:v1:' + 'f'.repeat(64),
};

describe('goal admission verify (#210 U11)', () => {
  it('admits a goal whose overlay base still matches the live ref', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'goal-admission-'));
    try {
      const refs = new CanonicalRefStore(dir);
      const overlays = new GoalOverlayStore(dir);
      await refs.promote('refs/remotes/origin/main', {
        expectedCurrent: null, current: null, target: C100, targetVerified: true,
      });
      await attachGoalBasePin(refs, overlays, {
        goalWorkspaceId: 'goal-1',
        canonicalRef: 'refs/remotes/origin/main',
        expectedBase: C100,
      });
      const verdict = await verifyGoalAdmission(refs, overlays, {
        goalWorkspaceId: 'goal-1',
        canonicalRef: 'refs/remotes/origin/main',
      });
      expect(verdict).toMatchObject({ admitted: true, baseManifestId: C100.manifestId });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses admission when the canonical ref advanced past the pinned base', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'goal-admission-'));
    try {
      const refs = new CanonicalRefStore(dir);
      const overlays = new GoalOverlayStore(dir);
      await refs.promote('refs/remotes/origin/main', {
        expectedCurrent: null, current: null, target: C100, targetVerified: true,
      });
      await attachGoalBasePin(refs, overlays, {
        goalWorkspaceId: 'goal-1',
        canonicalRef: 'refs/remotes/origin/main',
        expectedBase: C100,
      });
      const moved = {
        commitSha: 'd'.repeat(40),
        treeOid: 'e'.repeat(40),
        manifestId: 'man:v1:' + 'f'.repeat(64),
      };
      await refs.promote('refs/remotes/origin/main', {
        expectedCurrent: C100, current: C100, target: moved, targetVerified: true,
      });
      const verdict = await verifyGoalAdmission(refs, overlays, {
        goalWorkspaceId: 'goal-1',
        canonicalRef: 'refs/remotes/origin/main',
      });
      expect(verdict.admitted).toBe(false);
      if (!verdict.admitted) expect(verdict.reason).toMatch(/drift/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses admission when the overlay is missing', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'goal-admission-'));
    try {
      const refs = new CanonicalRefStore(dir);
      const overlays = new GoalOverlayStore(dir);
      await refs.promote('refs/remotes/origin/main', {
        expectedCurrent: null, current: null, target: C100, targetVerified: true,
      });
      const verdict = await verifyGoalAdmission(refs, overlays, {
        goalWorkspaceId: 'ghost',
        canonicalRef: 'refs/remotes/origin/main',
      });
      expect(verdict.admitted).toBe(false);
      if (!verdict.admitted) expect(verdict.reason).toMatch(/overlay/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('pinGoalBaseAtCommit (#210 §4)', () => {
  const REF = 'refs/remotes/origin/main';
  const GOAL_REPOSITORY = 'repo:goal';
  const OTHER_REPOSITORY = 'repo:other';

  async function storedManifest(
    dir: string,
    repositoryId: string,
    base = C100,
  ): Promise<{ manifests: CanonicalManifestStore; manifestId: string }> {
    const entries = [{ path: 'README.md', contentHash: '1'.repeat(64) }];
    const manifestId = canonicalManifestId({ repositoryId, revisionId: base.commitSha, entries });
    const manifests = new CanonicalManifestStore(dir);
    await manifests.put({
      manifestId,
      repositoryId,
      revisionId: base.commitSha,
      commitSha: base.commitSha,
      treeOid: base.treeOid,
      targetRef: REF,
      entries,
      createdAt: '2026-11-05T00:00:00.000Z',
    });
    return { manifests, manifestId };
  }

  it('pins the overlay when the live canonical ref is the requested commit', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'goal-pin-'));
    try {
      const refs = new CanonicalRefStore(dir);
      const overlays = new GoalOverlayStore(dir);
      await refs.promote(REF, {
        expectedCurrent: null, current: null, target: C100, targetVerified: true,
      });

      const outcome = await pinGoalBaseAtCommit(refs, overlays, {
        goalWorkspaceId: 'goal-1',
        canonicalRef: REF,
        commitSha: C100.commitSha,
      });

      expect(outcome).toMatchObject({ status: 'pinned', baseManifestId: C100.manifestId });
      expect(await overlays.read('goal-1')).toMatchObject({
        baseCommitSha: C100.commitSha,
        baseTreeOid: C100.treeOid,
        baseManifestId: C100.manifestId,
        entries: [],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('skips with no_canonical_ref instead of failing admission', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'goal-pin-'));
    try {
      const refs = new CanonicalRefStore(dir);
      const overlays = new GoalOverlayStore(dir);

      const outcome = await pinGoalBaseAtCommit(refs, overlays, {
        goalWorkspaceId: 'goal-1',
        canonicalRef: REF,
        commitSha: C100.commitSha,
      });

      expect(outcome).toMatchObject({ status: 'skipped', reason: 'no_canonical_ref' });
      expect(await overlays.listIds()).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('skips with commit_not_live when the ref moved past the requested base', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'goal-pin-'));
    try {
      const refs = new CanonicalRefStore(dir);
      const overlays = new GoalOverlayStore(dir);
      await refs.promote(REF, {
        expectedCurrent: null, current: null, target: C100, targetVerified: true,
      });

      const outcome = await pinGoalBaseAtCommit(refs, overlays, {
        goalWorkspaceId: 'goal-1',
        canonicalRef: REF,
        commitSha: 'd'.repeat(40),
      });

      expect(outcome).toMatchObject({ status: 'skipped', reason: 'commit_not_live' });
      expect(await overlays.listIds()).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports a corrupt canonical ref as failed, never as never promoted', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'goal-pin-'));
    try {
      const refs = new CanonicalRefStore(dir);
      const overlays = new GoalOverlayStore(dir);
      await refs.promote(REF, {
        expectedCurrent: null, current: null, target: C100, targetVerified: true,
      });
      await writeFile(path.join(dir, 'refs', 'remotes', 'origin', 'main.json'), '{not json', 'utf8');

      const outcome = await pinGoalBaseAtCommit(refs, overlays, {
        goalWorkspaceId: 'goal-1',
        canonicalRef: REF,
        commitSha: C100.commitSha,
      });

      expect(outcome.status).toBe('failed');
      if (outcome.status === 'failed') expect(outcome.reason).toMatch(/cannot read canonical ref/);
      expect(await overlays.listIds()).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports an overlay write failure as failed without throwing', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'goal-pin-'));
    try {
      const refs = new CanonicalRefStore(dir);
      const overlays = new GoalOverlayStore(dir);
      overlays.create = async (): Promise<never> => { throw new Error('disk full'); };
      await refs.promote(REF, {
        expectedCurrent: null, current: null, target: C100, targetVerified: true,
      });

      const outcome = await pinGoalBaseAtCommit(refs, overlays, {
        goalWorkspaceId: 'goal-1',
        canonicalRef: REF,
        commitSha: C100.commitSha,
      });

      expect(outcome).toMatchObject({ status: 'failed', reason: expect.stringContaining('disk full') });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports a ref advanced between the strict read and the attach as skipped', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'goal-pin-'));
    try {
      const overlays = new GoalOverlayStore(dir);
      let reads = 0;
      const racing = {
        read: async (): Promise<typeof C100> => (reads++ === 0 ? C100 : C200),
      } as unknown as CanonicalRefStore;

      const outcome = await pinGoalBaseAtCommit(racing, overlays, {
        goalWorkspaceId: 'goal-1',
        canonicalRef: REF,
        commitSha: C100.commitSha,
      });

      expect(outcome).toMatchObject({ status: 'skipped', reason: 'commit_not_live' });
      if (outcome.status === 'skipped') expect(outcome.detail).toMatch(/is at/);
      expect(reads).toBe(3);
      expect(await overlays.listIds()).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports a ref deleted between the strict read and the attach as skipped', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'goal-pin-'));
    try {
      const overlays = new GoalOverlayStore(dir);
      let reads = 0;
      const racing = {
        read: async (): Promise<typeof C100 | null> => (reads++ === 0 ? C100 : null),
      } as unknown as CanonicalRefStore;

      const outcome = await pinGoalBaseAtCommit(racing, overlays, {
        goalWorkspaceId: 'goal-1',
        canonicalRef: REF,
        commitSha: C100.commitSha,
      });

      expect(outcome).toMatchObject({ status: 'skipped', reason: 'no_canonical_ref' });
      expect(await overlays.listIds()).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps a corrupt ref that only the error-path re-read sees as failed', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'goal-pin-'));
    try {
      const overlays = new GoalOverlayStore(dir);
      let reads = 0;
      const racing = {
        read: async (_ref: string, options?: { strict?: boolean }): Promise<typeof C100 | null> => {
          if (reads++ === 0) return C100;
          // The attach's tolerant read sees "never promoted"; only a strict
          // re-read may report the corruption as a store failure.
          if (options?.strict === true) throw new Error('cannot read canonical ref: corrupt');
          return null;
        },
      } as unknown as CanonicalRefStore;

      const outcome = await pinGoalBaseAtCommit(racing, overlays, {
        goalWorkspaceId: 'goal-1',
        canonicalRef: REF,
        commitSha: C100.commitSha,
      });

      expect(outcome.status).toBe('failed');
      if (outcome.status === 'failed') expect(outcome.reason).toMatch(/cannot pin goal|no canonical ref/);
      expect(await overlays.listIds()).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('skips a live manifest that belongs to another repository (#210 §1)', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'goal-pin-'));
    try {
      const refs = new CanonicalRefStore(dir);
      const overlays = new GoalOverlayStore(dir);
      const { manifests, manifestId } = await storedManifest(dir, OTHER_REPOSITORY);
      await refs.promote(REF, {
        expectedCurrent: null, current: null,
        target: { ...C100, manifestId },
        targetVerified: true,
      });

      const outcome = await pinGoalBaseAtCommit(refs, overlays, {
        goalWorkspaceId: 'goal-1',
        canonicalRef: REF,
        commitSha: C100.commitSha,
      }, { manifests, expectedRepositoryIds: [GOAL_REPOSITORY] });

      expect(outcome).toMatchObject({ status: 'skipped', reason: 'repository_mismatch' });
      if (outcome.status === 'skipped') expect(outcome.detail).toContain(OTHER_REPOSITORY);
      expect(await overlays.listIds()).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails when the live manifest row is missing instead of pinning nothing', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'goal-pin-'));
    try {
      const refs = new CanonicalRefStore(dir);
      const overlays = new GoalOverlayStore(dir);
      const missingManifestId = 'man:v1:' + '9'.repeat(64);
      await refs.promote(REF, {
        expectedCurrent: null, current: null,
        target: { ...C100, manifestId: missingManifestId },
        targetVerified: true,
      });

      const outcome = await pinGoalBaseAtCommit(refs, overlays, {
        goalWorkspaceId: 'goal-1',
        canonicalRef: REF,
        commitSha: C100.commitSha,
      }, {
        manifests: new CanonicalManifestStore(dir, { strictReads: true }),
        expectedRepositoryIds: [GOAL_REPOSITORY],
      });

      expect(outcome.status).toBe('failed');
      if (outcome.status === 'failed') expect(outcome.reason).toMatch(/manifest .* is missing/);
      expect(await overlays.listIds()).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('pins when the live manifest has the Goal repository id', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'goal-pin-'));
    try {
      const refs = new CanonicalRefStore(dir);
      const overlays = new GoalOverlayStore(dir);
      const { manifests, manifestId } = await storedManifest(dir, GOAL_REPOSITORY);
      await refs.promote(REF, {
        expectedCurrent: null, current: null,
        target: { ...C100, manifestId },
        targetVerified: true,
      });

      const outcome = await pinGoalBaseAtCommit(refs, overlays, {
        goalWorkspaceId: 'goal-1',
        canonicalRef: REF,
        commitSha: C100.commitSha,
      }, { manifests, expectedRepositoryIds: [GOAL_REPOSITORY] });

      expect(outcome).toMatchObject({ status: 'pinned', baseManifestId: manifestId });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('pins a manifest written under the released legacy repository id', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'goal-pin-'));
    try {
      const refs = new CanonicalRefStore(dir);
      const overlays = new GoalOverlayStore(dir);
      const legacyRepository = 'repo:legacy';
      const { manifests, manifestId } = await storedManifest(dir, legacyRepository);
      await refs.promote(REF, {
        expectedCurrent: null, current: null,
        target: { ...C100, manifestId },
        targetVerified: true,
      });

      const outcome = await pinGoalBaseAtCommit(refs, overlays, {
        goalWorkspaceId: 'goal-1',
        canonicalRef: REF,
        commitSha: C100.commitSha,
      }, { manifests, expectedRepositoryIds: [GOAL_REPOSITORY, legacyRepository] });

      expect(outcome).toMatchObject({ status: 'pinned', baseManifestId: manifestId });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps the previous pin behaviour when no repository guard is supplied', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'goal-pin-'));
    try {
      const refs = new CanonicalRefStore(dir);
      const overlays = new GoalOverlayStore(dir);
      const unverifiableManifestId = 'man:v1:' + '9'.repeat(64);
      await refs.promote(REF, {
        expectedCurrent: null, current: null,
        target: { ...C100, manifestId: unverifiableManifestId },
        targetVerified: true,
      });

      const outcome = await pinGoalBaseAtCommit(refs, overlays, {
        goalWorkspaceId: 'goal-1',
        canonicalRef: REF,
        commitSha: C100.commitSha,
      });

      expect(outcome).toMatchObject({ status: 'pinned', baseManifestId: unverifiableManifestId });
      expect(await overlays.read('goal-1')).toMatchObject({ baseManifestId: unverifiableManifestId });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
