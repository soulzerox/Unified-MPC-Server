import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalManifestId, canonicalRevisionId } from '@unified-mpc/domain';
import { CanonicalArtifactStore } from './canonical-artifact-store.js';
import { CanonicalManifestStore, type StoredManifest } from './canonical-manifest-store.js';
import { registerManifestArtifacts, type ArtifactClassification } from './manifest-artifact-registration.js';

const REPO = 'repo_abc123';
const REF = 'refs/remotes/origin/main';
const H = (n: string): string => n.repeat(64).slice(0, 64);
const NOW = new Date('2026-10-19T00:00:00.000Z');

function classOf(pathValue: string, language = 'typescript'): ArtifactClassification {
  return { path: pathValue, language, sourceKind: 'source', representationVersion: 'v1' };
}

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
    createdAt: '2026-10-19T00:00:00.000Z',
  };
}

async function scenario(): Promise<{ dir: string; manifests: CanonicalManifestStore; store: CanonicalArtifactStore }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'manifest-artifacts-'));
  return { dir, manifests: new CanonicalManifestStore(dir), store: new CanonicalArtifactStore(dir) };
}

describe('manifest -> file artifact registration (#210 §1/§2/§8)', () => {
  it('registers one content-addressed artifact per classified entry, bound to the manifest revision', async () => {
    const { dir, manifests, store } = await scenario();
    try {
      const manifest = manifestFor('c'.repeat(40), [
        { path: 'src/a.ts', contentHash: H('1') },
        { path: 'src/b.ts', contentHash: H('2') },
      ]);
      await manifests.put(manifest);

      const report = await registerManifestArtifacts({
        manifests, store, manifestId: manifest.manifestId, now: NOW,
        classifications: [classOf('src/a.ts'), classOf('src/b.ts')],
      });

      expect(report).toMatchObject({
        status: 'registered', manifestId: manifest.manifestId, repositoryId: REPO,
        unclassifiedPaths: [], unknownClassifiedPaths: [],
      });
      if (report.status !== 'registered') throw new Error('unexpected');
      expect(report.artifacts.map((artifact) => [artifact.path, artifact.reused]))
        .toEqual([['src/a.ts', false], ['src/b.ts', false]]);

      expect(await store.get(REPO, report.artifacts[0].artifactKey)).toMatchObject({
        kind: 'file',
        repositoryId: REPO,
        sourceContentSha256: H('1'),
        language: 'typescript',
        sourceKind: 'source',
        representationVersion: 'v1',
        createdAt: NOW.toISOString(),
        bindings: [{ path: 'src/a.ts', manifestId: manifest.manifestId, revisionId: manifest.revisionId }],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reuses one artifact across revisions, accumulating bindings per path and revision', async () => {
    const { dir, manifests, store } = await scenario();
    try {
      const first = manifestFor('c'.repeat(40), [{ path: 'src/a.ts', contentHash: H('1') }]);
      const second = manifestFor('d'.repeat(40), [{ path: 'src/a.ts', contentHash: H('1') }]);
      await manifests.put(first);
      await manifests.put(second);

      const firstPass = await registerManifestArtifacts({
        manifests, store, manifestId: first.manifestId, now: NOW, classifications: [classOf('src/a.ts')],
      });
      const secondPass = await registerManifestArtifacts({
        manifests, store, manifestId: second.manifestId, now: NOW, classifications: [classOf('src/a.ts')],
      });

      expect(firstPass).toMatchObject({ status: 'registered', artifacts: [{ reused: false }] });
      expect(secondPass).toMatchObject({ status: 'registered', artifacts: [{ reused: true }] });
      if (firstPass.status !== 'registered' || secondPass.status !== 'registered') throw new Error('unexpected');
      expect(secondPass.artifacts[0].artifactKey).toBe(firstPass.artifacts[0].artifactKey);
      const bindings = (await store.get(REPO, firstPass.artifacts[0].artifactKey))?.bindings ?? [];
      expect(bindings).toHaveLength(2);
      expect(bindings.map((binding) => binding.manifestId).sort()).toEqual([first.manifestId, second.manifestId].sort());
      expect(bindings.map((binding) => binding.path)).toEqual(['src/a.ts', 'src/a.ts']);
      expect(await store.listRepository(REPO)).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps a renamed path on the same artifact (§8: path is metadata)', async () => {
    const { dir, manifests, store } = await scenario();
    try {
      const before = manifestFor('c'.repeat(40), [{ path: 'src/a.ts', contentHash: H('1') }]);
      const after = manifestFor('d'.repeat(40), [{ path: 'src/renamed.ts', contentHash: H('1') }]);
      await manifests.put(before);
      await manifests.put(after);

      const beforePass = await registerManifestArtifacts({
        manifests, store, manifestId: before.manifestId, now: NOW, classifications: [classOf('src/a.ts')],
      });
      const afterPass = await registerManifestArtifacts({
        manifests, store, manifestId: after.manifestId, now: NOW, classifications: [classOf('src/renamed.ts')],
      });

      if (beforePass.status !== 'registered' || afterPass.status !== 'registered') throw new Error('unexpected');
      expect(afterPass.artifacts[0].artifactKey).toBe(beforePass.artifacts[0].artifactKey);
      expect(afterPass.artifacts[0].reused).toBe(true);
      expect(await store.listRepository(REPO)).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports unclassified manifest paths and unknown policy paths instead of dropping either side', async () => {
    const { dir, manifests, store } = await scenario();
    try {
      const manifest = manifestFor('c'.repeat(40), [
        { path: 'src/a.ts', contentHash: H('1') },
        { path: 'assets/logo.png', contentHash: H('2') },
      ]);
      await manifests.put(manifest);

      const report = await registerManifestArtifacts({
        manifests, store, manifestId: manifest.manifestId, now: NOW,
        classifications: [classOf('src/a.ts'), classOf('src/absent.ts')],
      });

      if (report.status !== 'registered') throw new Error('unexpected');
      expect(report.unclassifiedPaths).toEqual(['assets/logo.png']);
      expect(report.unknownClassifiedPaths).toEqual(['src/absent.ts']);
      expect(report.artifacts.map((artifact) => artifact.path)).toEqual(['src/a.ts']);
      expect(await store.listRepository(REPO)).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses an unknown manifest without writing anything', async () => {
    const { dir, manifests, store } = await scenario();
    try {
      const report = await registerManifestArtifacts({
        manifests, store, manifestId: `man:v1:${H('9')}`, now: NOW, classifications: [classOf('src/a.ts')],
      });
      expect(report).toMatchObject({ status: 'refused' });
      if (report.status !== 'refused') throw new Error('unexpected');
      expect(report.reason).toMatch(/unknown manifest/i);
      expect(await store.listRepository(REPO)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses an invalid classification without a partial write', async () => {
    const { dir, manifests, store } = await scenario();
    try {
      const manifest = manifestFor('c'.repeat(40), [
        { path: 'src/a.ts', contentHash: H('1') },
        { path: 'src/b.ts', contentHash: H('2') },
      ]);
      await manifests.put(manifest);

      const report = await registerManifestArtifacts({
        manifests, store, manifestId: manifest.manifestId, now: NOW,
        classifications: [classOf('src/a.ts'), classOf('src/b.ts', '')],
      });
      expect(report).toMatchObject({ status: 'refused' });
      if (report.status !== 'refused') throw new Error('unexpected');
      expect(report.reason).toMatch(/language/i);
      expect(await store.listRepository(REPO)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses two classifications for one path rather than guessing a policy', async () => {
    const { dir, manifests, store } = await scenario();
    try {
      const manifest = manifestFor('c'.repeat(40), [{ path: 'src/a.ts', contentHash: H('1') }]);
      await manifests.put(manifest);

      const report = await registerManifestArtifacts({
        manifests, store, manifestId: manifest.manifestId, now: NOW,
        classifications: [classOf('src/a.ts'), classOf('src/a.ts', 'python')],
      });
      expect(report).toMatchObject({ status: 'refused' });
      if (report.status !== 'refused') throw new Error('unexpected');
      expect(report.reason).toMatch(/duplicate classification/i);
      expect(await store.listRepository(REPO)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('treats a classification change as a different artifact for the same content', async () => {
    const { dir, manifests, store } = await scenario();
    try {
      const manifest = manifestFor('c'.repeat(40), [{ path: 'src/a.ts', contentHash: H('1') }]);
      await manifests.put(manifest);

      const typescript = await registerManifestArtifacts({
        manifests, store, manifestId: manifest.manifestId, now: NOW, classifications: [classOf('src/a.ts')],
      });
      const python = await registerManifestArtifacts({
        manifests, store, manifestId: manifest.manifestId, now: NOW, classifications: [classOf('src/a.ts', 'python')],
      });

      if (typescript.status !== 'registered' || python.status !== 'registered') throw new Error('unexpected');
      expect(python.artifacts[0].artifactKey).not.toBe(typescript.artifacts[0].artifactKey);
      expect(await store.listRepository(REPO)).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
