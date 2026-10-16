import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalManifestId, canonicalRevisionId, computeTreeOid } from '@unified-mpc/domain';
import { CanonicalManifestStore, type StoredManifest } from './canonical-manifest-store.js';
import { verifyRevisionAgainstManifest } from './revision-verify.js';

const REPO = 'repo_abc123';
const REF = 'refs/remotes/origin/main';
const H = (n: string): string => n.repeat(64).slice(0, 64);

function manifestFor(
  repositoryId: string,
  commitSha: string,
  entries: readonly { path: string; contentHash: string }[],
  overrides: Partial<StoredManifest> = {},
): StoredManifest {
  const revisionId = canonicalRevisionId({
    repositoryId, commitSha, treeOid: computeTreeOid(entries), targetRef: REF, parents: [],
  });
  return {
    manifestId: canonicalManifestId({ repositoryId, revisionId, entries }),
    repositoryId,
    revisionId,
    commitSha,
    treeOid: computeTreeOid(entries),
    targetRef: REF,
    entries,
    createdAt: '2026-10-17T00:00:00.000Z',
    ...overrides,
  };
}

async function store(): Promise<{ manifests: CanonicalManifestStore; dir: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'revision-verify-'));
  return { manifests: new CanonicalManifestStore(dir), dir };
}

describe('revision verify against manifest (#210 U24)', () => {
  it('verifies an exact matching revision and expected content hashes', async () => {
    const { manifests, dir } = await store();
    try {
      const m = manifestFor(REPO, 'c'.repeat(40), [
        { path: 'a.ts', contentHash: H('1') },
        { path: 'b.ts', contentHash: H('2') },
      ]);
      await manifests.put(m);
      const verdict = await verifyRevisionAgainstManifest(manifests, {
        repositoryId: REPO,
        manifestId: m.manifestId,
        expectedEntriesByPath: { 'a.ts': H('1'), 'b.ts': H('2') },
      });
      expect(verdict).toMatchObject({ verified: true, manifestId: m.manifestId, commitSha: m.commitSha });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects a content mismatch at the affected path', async () => {
    const { manifests, dir } = await store();
    try {
      const m = manifestFor(REPO, 'c'.repeat(40), [{ path: 'a.ts', contentHash: H('1') }]);
      await manifests.put(m);
      const verdict = await verifyRevisionAgainstManifest(manifests, {
        repositoryId: REPO,
        manifestId: m.manifestId,
        expectedEntriesByPath: { 'a.ts': H('9') },
      });
      expect(verdict).toMatchObject({ verified: false });
      if (verdict.verified) throw new Error('unexpected');
      expect(verdict.reason).toMatch(/content mismatch/i);
      expect(verdict.path).toBe('a.ts');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects a missing expected path and a foreign repository manifest', async () => {
    const { manifests, dir } = await store();
    try {
      const m = manifestFor(REPO, 'c'.repeat(40), [{ path: 'a.ts', contentHash: H('1') }]);
      await manifests.put(m);
      const missingPath = await verifyRevisionAgainstManifest(manifests, {
        repositoryId: REPO,
        manifestId: m.manifestId,
        expectedEntriesByPath: { 'ghost.ts': H('1') },
      });
      expect(missingPath).toMatchObject({ verified: false, path: 'ghost.ts' });

      const foreign = await verifyRevisionAgainstManifest(manifests, {
        repositoryId: 'repo_other',
        manifestId: m.manifestId,
        expectedEntriesByPath: {},
      });
      expect(foreign).toMatchObject({ verified: false });
      if (foreign.verified) throw new Error('unexpected');
      expect(foreign.reason).toMatch(/repository/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects a manifest whose stored tree does not match its entries', async () => {
    const { manifests, dir } = await store();
    try {
      const entries = [{ path: 'a.ts', contentHash: H('1') }];
      const m = manifestFor(REPO, 'c'.repeat(40), entries);
      // Correct identity, tampered tree: put() cannot detect this, verify must.
      await mkdir(path.join(dir, 'manifests'), { recursive: true });
      await writeFile(
        path.join(dir, 'manifests', `${m.manifestId}.json`),
        JSON.stringify({ ...m, treeOid: 'a'.repeat(40) }),
        'utf8',
      );
      const verdict = await verifyRevisionAgainstManifest(manifests, {
        repositoryId: REPO,
        manifestId: m.manifestId,
        expectedEntriesByPath: { 'a.ts': H('1') },
      });
      expect(verdict).toMatchObject({ verified: false });
      if (verdict.verified) throw new Error('unexpected');
      expect(verdict.reason).toMatch(/tree/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects an unknown manifest id', async () => {
    const { manifests, dir } = await store();
    try {
      const verdict = await verifyRevisionAgainstManifest(manifests, {
        repositoryId: REPO,
        manifestId: 'man:v1:' + 'a'.repeat(64),
        expectedEntriesByPath: {},
      });
      expect(verdict).toMatchObject({ verified: false });
      if (verdict.verified) throw new Error('unexpected');
      expect(verdict.reason).toMatch(/missing manifest/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
