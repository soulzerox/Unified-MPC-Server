import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalRevisionId } from '@unified-mpc/domain';
import { CanonicalRefStore } from './canonical-ref-store.js';
import { CanonicalManifestStore, type StoredManifest } from './canonical-manifest-store.js';
import { advanceCanonicalRevision } from './advance-revision.js';

const REPO = 'repo_abc123';
const REF = 'refs/remotes/origin/main';
const H = (n: string): string => n.repeat(64).slice(0, 64);

function revisionId(commitSha: string): string {
  return canonicalRevisionId({
    repositoryId: REPO,
    commitSha,
    treeOid: commitSha,
    targetRef: REF,
    parents: [],
  });
}

async function tempPair(): Promise<{ refs: CanonicalRefStore; manifests: CanonicalManifestStore; dir: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'advance-revision-'));
  return { refs: new CanonicalRefStore(dir), manifests: new CanonicalManifestStore(dir), dir };
}

describe('advance canonical revision (#210 U16)', () => {
  it('promotes a first revision reporting every path as new', async () => {
    const { refs, manifests, dir } = await tempPair();
    try {
      const result = await advanceCanonicalRevision(manifests, refs, {
        canonicalRef: REF,
        repositoryId: REPO,
        revisionId: revisionId('c'.repeat(40)),
        commitSha: 'c'.repeat(40),
        targetEntries: [
          { path: 'a.ts', contentHash: H('1') },
          { path: 'b.ts', contentHash: H('2') },
        ],
        expectedCurrent: null,
        targetVerified: true,
        createdAt: '2026-10-17T00:00:00.000Z',
      });
      expect(result).toMatchObject({ status: 'promoted', newPaths: ['a.ts', 'b.ts'], reusedPaths: [] });
      const live = await refs.read(REF);
      expect(live).not.toBeNull();
      expect(await manifests.get(live!.manifestId)).not.toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reuses unchanged paths and reports only changed/added/deleted', async () => {
    const { refs, manifests, dir } = await tempPair();
    try {
      const first = await advanceCanonicalRevision(manifests, refs, {
        canonicalRef: REF,
        repositoryId: REPO,
        revisionId: revisionId('c'.repeat(40)),
        commitSha: 'c'.repeat(40),
        targetEntries: [
          { path: 'same.ts', contentHash: H('1') },
          { path: 'chg.ts', contentHash: H('2') },
          { path: 'gone.ts', contentHash: H('3') },
        ],
        expectedCurrent: null,
        targetVerified: true,
        createdAt: '2026-10-17T00:00:00.000Z',
      });
      expect(first.status).toBe('promoted');
      const current = await refs.read(REF);

      const second = await advanceCanonicalRevision(manifests, refs, {
        canonicalRef: REF,
        repositoryId: REPO,
        revisionId: revisionId('d'.repeat(40)),
        commitSha: 'd'.repeat(40),
        targetEntries: [
          { path: 'same.ts', contentHash: H('1') },
          { path: 'chg.ts', contentHash: H('4') },
          { path: 'new.ts', contentHash: H('5') },
        ],
        expectedCurrent: current,
        targetVerified: true,
        createdAt: '2026-10-17T01:00:00.000Z',
      });
      expect(second).toMatchObject({
        status: 'promoted',
        reusedPaths: ['same.ts'],
        newPaths: ['chg.ts', 'new.ts'],
        deletedPaths: ['gone.ts'],
      });
      const advanced = await refs.read(REF);
      expect(advanced!.commitSha).toBe('d'.repeat(40));
      expect(advanced!.manifestId).not.toBe(current!.manifestId);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('is a no-op when the target equals the active revision', async () => {
    const { refs, manifests, dir } = await tempPair();
    try {
      const input = {
        canonicalRef: REF,
        repositoryId: REPO,
        revisionId: revisionId('c'.repeat(40)),
        commitSha: 'c'.repeat(40),
        targetEntries: [{ path: 'a.ts', contentHash: H('1') }],
        expectedCurrent: null,
        targetVerified: true,
        createdAt: '2026-10-17T00:00:00.000Z',
      };
      const first = await advanceCanonicalRevision(manifests, refs, input);
      expect(first.status).toBe('promoted');
      const current = await refs.read(REF);
      const again = await advanceCanonicalRevision(manifests, refs, { ...input, expectedCurrent: current });
      expect(again.status).toBe('noop');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('conflicts on a stale expected current and leaves the winner ref intact', async () => {
    const { refs, manifests, dir } = await tempPair();
    try {
      await advanceCanonicalRevision(manifests, refs, {
        canonicalRef: REF,
        repositoryId: REPO,
        revisionId: revisionId('c'.repeat(40)),
        commitSha: 'c'.repeat(40),
        targetEntries: [{ path: 'a.ts', contentHash: H('1') }],
        expectedCurrent: null,
        targetVerified: true,
        createdAt: '2026-10-17T00:00:00.000Z',
      });
      const winner = await refs.read(REF);
      const result = await advanceCanonicalRevision(manifests, refs, {
        canonicalRef: REF,
        repositoryId: REPO,
        revisionId: revisionId('e'.repeat(40)),
        commitSha: 'e'.repeat(40),
        targetEntries: [{ path: 'a.ts', contentHash: H('9') }],
        expectedCurrent: { commitSha: 'f'.repeat(40), treeOid: 'f'.repeat(40), manifestId: 'man:v1:' + 'f'.repeat(64) },
        targetVerified: true,
        createdAt: '2026-10-17T02:00:00.000Z',
      });
      expect(result.status).toBe('conflict');
      expect(await refs.read(REF)).toEqual(winner);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when the active ref has no readable base manifest', async () => {
    const { refs, manifests, dir } = await tempPair();
    try {
      await refs.promote(REF, {
        expectedCurrent: null,
        current: null,
        target: { commitSha: 'c'.repeat(40), treeOid: 'c'.repeat(40), manifestId: 'man:v1:' + 'a'.repeat(64) },
        targetVerified: true,
      });
      const result = await advanceCanonicalRevision(manifests, refs, {
        canonicalRef: REF,
        repositoryId: REPO,
        revisionId: revisionId('d'.repeat(40)),
        commitSha: 'd'.repeat(40),
        targetEntries: [{ path: 'a.ts', contentHash: H('1') }],
        expectedCurrent: await refs.read(REF),
        targetVerified: true,
        createdAt: '2026-10-17T03:00:00.000Z',
      });
      expect(result).toMatchObject({ status: 'rejected' });
      expect((await refs.read(REF))!.commitSha).toBe('c'.repeat(40));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails closed on an unverifiable base entry instead of guessing', async () => {
    const { refs, manifests, dir } = await tempPair();
    try {
      // Legacy/hand-written manifest with a non-hex content hash on disk.
      const legacyEntries = [{ path: 'a.ts', contentHash: 'not-a-hash' }];
      const legacyId = 'man:v1:' + 'a'.repeat(64);
      await mkdir(path.join(dir, 'manifests'), { recursive: true });
      const legacy: StoredManifest = {
        manifestId: legacyId,
        repositoryId: REPO,
        revisionId: revisionId('c'.repeat(40)),
        commitSha: 'c'.repeat(40),
        treeOid: 'c'.repeat(40),
        targetRef: REF,
        entries: legacyEntries,
        createdAt: '2026-10-17T00:00:00.000Z',
      };
      await writeFile(path.join(dir, 'manifests', `${legacyId}.json`), JSON.stringify(legacy), 'utf8');
      await refs.promote(REF, {
        expectedCurrent: null,
        current: null,
        target: { commitSha: 'c'.repeat(40), treeOid: 'c'.repeat(40), manifestId: legacyId },
        targetVerified: true,
      });
      const result = await advanceCanonicalRevision(manifests, refs, {
        canonicalRef: REF,
        repositoryId: REPO,
        revisionId: revisionId('d'.repeat(40)),
        commitSha: 'd'.repeat(40),
        targetEntries: [{ path: 'a.ts', contentHash: H('1') }],
        expectedCurrent: await refs.read(REF),
        targetVerified: true,
        createdAt: '2026-10-17T04:00:00.000Z',
      });
      expect(result).toMatchObject({ status: 'rejected' });
      expect((await refs.read(REF))!.commitSha).toBe('c'.repeat(40));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
