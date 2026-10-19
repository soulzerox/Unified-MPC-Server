import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalManifestId, canonicalRevisionId } from '@unified-mpc/domain';
import { CanonicalArtifactStore } from './canonical-artifact-store.js';
import { CanonicalManifestStore, type StoredManifest } from './canonical-manifest-store.js';
import { CanonicalRefStore } from './canonical-ref-store.js';
import { registerManifestArtifacts, type ArtifactClassification } from './manifest-artifact-registration.js';
import { resolveRefFileArtifact } from './file-artifact-resolution.js';

const REPO = 'repo_abc123';
const OTHER_REPO = 'repo_other456';
const REF = 'refs/remotes/origin/main';
const H = (n: string): string => n.repeat(64).slice(0, 64);
const NOW = new Date('2026-10-19T00:00:00.000Z');
const classOf = (pathValue: string, language = 'typescript'): ArtifactClassification =>
  ({ path: pathValue, language, sourceKind: 'source', representationVersion: 'v1' });

function manifestFor(
  repositoryId: string,
  commitSha: string,
  entries: readonly { path: string; contentHash: string }[],
): StoredManifest {
  const revisionId = canonicalRevisionId({
    repositoryId, commitSha, treeOid: commitSha, targetRef: REF, parents: [],
  });
  return {
    manifestId: canonicalManifestId({ repositoryId, revisionId, entries }),
    repositoryId,
    revisionId,
    commitSha,
    treeOid: commitSha,
    targetRef: REF,
    entries,
    createdAt: '2026-10-19T00:00:00.000Z',
  };
}

async function scenario(): Promise<{
  dir: string;
  refs: CanonicalRefStore;
  manifests: CanonicalManifestStore;
  store: CanonicalArtifactStore;
}> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'artifact-resolution-'));
  return {
    dir,
    refs: new CanonicalRefStore(dir),
    manifests: new CanonicalManifestStore(dir),
    store: new CanonicalArtifactStore(dir),
  };
}

async function seedRef(refs: CanonicalRefStore, manifests: CanonicalManifestStore, manifest: StoredManifest): Promise<void> {
  await manifests.put(manifest);
  await refs.promote(REF, {
    expectedCurrent: null,
    current: null,
    target: { commitSha: manifest.commitSha, treeOid: manifest.treeOid, manifestId: manifest.manifestId },
    targetVerified: true,
  });
}

describe('file artifact resolution for a canonical ref (#210 §2/§6/§8)', () => {
  it('resolves the current artifact and reports it as reused', async () => {
    const { dir, refs, manifests, store } = await scenario();
    try {
      const manifest = manifestFor(REPO, 'c'.repeat(40), [
        { path: 'src/a.ts', contentHash: H('1') },
        { path: 'src/aliased.ts', contentHash: H('1') },
      ]);
      await seedRef(refs, manifests, manifest);
      const registration = await registerManifestArtifacts({
        manifests, store, manifestId: manifest.manifestId, now: NOW,
        classifications: [classOf('src/a.ts'), classOf('src/aliased.ts')],
      });
      if (registration.status !== 'registered') throw new Error('unexpected');

      const resolution = await resolveRefFileArtifact({
        refs, manifests, store, repositoryId: REPO, ref: REF, path: 'src/a.ts', classification: classOf('src/a.ts'),
      });

      expect(resolution).toMatchObject({
        status: 'resolved',
        repositoryId: REPO,
        ref: REF,
        commitSha: manifest.commitSha,
        treeOid: manifest.treeOid,
        manifestId: manifest.manifestId,
        revisionId: manifest.revisionId,
        path: 'src/a.ts',
        contentHash: H('1'),
        registered: true,
      });
      if (resolution.status !== 'resolved') throw new Error('unexpected');
      expect(resolution.artifactKey).toBe(registration.artifacts[0].artifactKey);
      expect(resolution.artifact).toMatchObject({ artifactKey: registration.artifacts[0].artifactKey, repositoryId: REPO });

      // path is metadata: the alias resolves to the same artifact
      const alias = await resolveRefFileArtifact({
        refs, manifests, store, repositoryId: REPO, ref: REF, path: 'src/aliased.ts', classification: classOf('src/aliased.ts'),
      });
      if (alias.status !== 'resolved') throw new Error('unexpected');
      expect(alias.artifactKey).toBe(resolution.artifactKey);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports an unregistered artifact explicitly instead of a silent absence', async () => {
    const { dir, refs, manifests, store } = await scenario();
    try {
      const manifest = manifestFor(REPO, 'c'.repeat(40), [{ path: 'src/a.ts', contentHash: H('1') }]);
      await seedRef(refs, manifests, manifest);

      const resolution = await resolveRefFileArtifact({
        refs, manifests, store, repositoryId: REPO, ref: REF, path: 'src/a.ts', classification: classOf('src/a.ts'),
      });
      expect(resolution).toMatchObject({ status: 'resolved', contentHash: H('1'), registered: false });
      if (resolution.status !== 'resolved') throw new Error('unexpected');
      expect(resolution.artifactKey).toMatch(/^file:v1:[a-f0-9]{64}$/);
      expect(resolution).not.toHaveProperty('artifact');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('resolves content without a classification policy, claiming no artifact key', async () => {
    const { dir, refs, manifests, store } = await scenario();
    try {
      const manifest = manifestFor(REPO, 'c'.repeat(40), [{ path: 'src/a.ts', contentHash: H('1') }]);
      await seedRef(refs, manifests, manifest);

      const resolution = await resolveRefFileArtifact({ refs, manifests, store, repositoryId: REPO, ref: REF, path: 'src/a.ts' });
      expect(resolution).toMatchObject({ status: 'resolved', contentHash: H('1'), registered: false });
      expect(resolution).not.toHaveProperty('artifactKey');
      expect(resolution).not.toHaveProperty('artifact');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('never reports a stale artifact when the content changed', async () => {
    const { dir, refs, manifests, store } = await scenario();
    try {
      const before = manifestFor(REPO, 'c'.repeat(40), [{ path: 'src/a.ts', contentHash: H('1') }]);
      await seedRef(refs, manifests, before);
      const registration = await registerManifestArtifacts({
        manifests, store, manifestId: before.manifestId, now: NOW, classifications: [classOf('src/a.ts')],
      });
      if (registration.status !== 'registered') throw new Error('unexpected');

      const after = manifestFor(REPO, 'd'.repeat(40), [{ path: 'src/a.ts', contentHash: H('2') }]);
      await seedRef(refs, manifests, after);

      const resolution = await resolveRefFileArtifact({
        refs, manifests, store, repositoryId: REPO, ref: REF, path: 'src/a.ts', classification: classOf('src/a.ts'),
      });
      if (resolution.status !== 'resolved') throw new Error('unexpected');
      expect(resolution.contentHash).toBe(H('2'));
      expect(resolution.artifactKey).not.toBe(registration.artifacts[0].artifactKey);
      expect(resolution.registered).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when the ref is not observed', async () => {
    const { dir, refs, manifests, store } = await scenario();
    try {
      expect(await resolveRefFileArtifact({ refs, manifests, store, repositoryId: REPO, ref: REF, path: 'src/a.ts' }))
        .toEqual({ status: 'ref-not-observed', repositoryId: REPO, ref: REF, path: 'src/a.ts' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when the ref points at a manifest that is not stored', async () => {
    const { dir, refs, manifests, store } = await scenario();
    try {
      const orphanId = `man:v1:${H('9')}`;
      await refs.promote(REF, {
        expectedCurrent: null,
        current: null,
        target: { commitSha: 'e'.repeat(40), treeOid: 'e'.repeat(40), manifestId: orphanId },
        targetVerified: true,
      });

      expect(await resolveRefFileArtifact({ refs, manifests, store, repositoryId: REPO, ref: REF, path: 'src/a.ts' }))
        .toEqual({ status: 'manifest-missing', repositoryId: REPO, ref: REF, path: 'src/a.ts', manifestId: orphanId });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses a manifest belonging to another repository instead of answering for this one', async () => {
    const { dir, refs, manifests, store } = await scenario();
    try {
      const foreign = manifestFor(OTHER_REPO, 'c'.repeat(40), [{ path: 'src/a.ts', contentHash: H('1') }]);
      await seedRef(refs, manifests, foreign);

      expect(await resolveRefFileArtifact({ refs, manifests, store, repositoryId: REPO, ref: REF, path: 'src/a.ts' }))
        .toEqual({
          status: 'repository-mismatch',
          repositoryId: REPO,
          ref: REF,
          path: 'src/a.ts',
          manifestRepositoryId: OTHER_REPO,
        });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports a path the observed revision does not carry', async () => {
    const { dir, refs, manifests, store } = await scenario();
    try {
      const manifest = manifestFor(REPO, 'c'.repeat(40), [{ path: 'src/a.ts', contentHash: H('1') }]);
      await seedRef(refs, manifests, manifest);

      expect(await resolveRefFileArtifact({ refs, manifests, store, repositoryId: REPO, ref: REF, path: 'src/gone.ts' }))
        .toEqual({ status: 'path-not-in-revision', repositoryId: REPO, ref: REF, path: 'src/gone.ts', commitSha: manifest.commitSha });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses an invalid classification rather than deriving a bogus key', async () => {
    const { dir, refs, manifests, store } = await scenario();
    try {
      const manifest = manifestFor(REPO, 'c'.repeat(40), [{ path: 'src/a.ts', contentHash: H('1') }]);
      await seedRef(refs, manifests, manifest);

      const resolution = await resolveRefFileArtifact({
        refs, manifests, store, repositoryId: REPO, ref: REF, path: 'src/a.ts', classification: classOf('src/a.ts', ''),
      });
      expect(resolution).toMatchObject({ status: 'refused' });
      if (resolution.status !== 'refused') throw new Error('unexpected');
      expect(resolution.reason).toMatch(/language/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
