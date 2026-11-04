import { describe, expect, it } from 'vitest';
import { access, chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileArtifactId, semanticArtifactId } from '@unified-mpc/domain';
import {
  CanonicalArtifactStore,
  type StoredFileArtifact,
  type StoredSemanticArtifact,
} from './canonical-artifact-store.js';

const REPO = 'repo_abc123';
const OTHER_REPO = 'repo_other456';
const CONTENT = 'a'.repeat(64);

async function withStore<T>(run: (store: CanonicalArtifactStore, root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'artifact-store-'));
  try {
    return await run(new CanonicalArtifactStore(root), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function fileArtifact(overrides: Partial<StoredFileArtifact> = {}): StoredFileArtifact {
  const identity = {
    sourceContentSha256: overrides.sourceContentSha256 ?? CONTENT,
    language: overrides.language ?? 'typescript',
    sourceKind: overrides.sourceKind ?? 'source',
    representationVersion: overrides.representationVersion ?? 'v1',
  };
  return {
    kind: 'file',
    artifactKey: overrides.artifactKey ?? fileArtifactId(identity),
    repositoryId: overrides.repositoryId ?? REPO,
    ...identity,
    bindings: overrides.bindings ?? [{ path: 'src/a.ts', manifestId: 'man:v1:' + '1'.repeat(64) }],
    createdAt: overrides.createdAt ?? '2026-10-19T00:00:00.000Z',
  };
}

function chunkArtifact(overrides: Partial<StoredSemanticArtifact> = {}): StoredSemanticArtifact {
  const identity = {
    trustBoundaryKey: overrides.trustBoundaryKey ?? 'b'.repeat(64),
    chunkContentSha256: overrides.chunkContentSha256 ?? CONTENT,
    embeddingProfile: overrides.embeddingProfile ?? 'nomic-embed/embed-v1',
    dimension: overrides.dimension ?? 768,
    normalizationFingerprint: overrides.normalizationFingerprint ?? 'norm:l2:trunc-1',
    chunkerFingerprint: overrides.chunkerFingerprint ?? 'chunker:v2:token-512-overlap-64',
    representationVersion: overrides.representationVersion ?? 'v1',
  };
  return {
    kind: 'chunk',
    artifactKey: overrides.artifactKey ?? semanticArtifactId(identity),
    repositoryId: overrides.repositoryId ?? REPO,
    ...identity,
    createdAt: overrides.createdAt ?? '2026-10-19T00:00:00.000Z',
  };
}

describe('canonical artifact store (#210 §1/§6)', () => {
  it('round-trips file and semantic artifacts with their recomputed identity', async () => {
    await withStore(async (store) => {
      const file = fileArtifact();
      const chunk = chunkArtifact();
      await store.put(file);
      await store.put(chunk);

      expect(await store.get(REPO, file.artifactKey)).toEqual(file);
      expect(await store.get(REPO, chunk.artifactKey)).toEqual(chunk);
      expect(await store.get(REPO, 'file:v1:' + 'f'.repeat(64))).toBeNull();
      expect(await store.has(REPO, file.artifactKey)).toBe(true);
      expect(await store.listRepository(REPO)).toHaveLength(2);
    });
  });

  it('refuses a declared key that disagrees with the artifact inputs', async () => {
    await withStore(async (store) => {
      await expect(store.put(fileArtifact({ artifactKey: 'file:v1:' + 'e'.repeat(64) })))
        .rejects.toThrow(/identity mismatch/);
      await expect(store.put(chunkArtifact({ artifactKey: 'chunk:v1:' + 'e'.repeat(64) })))
        .rejects.toThrow(/identity mismatch/);
      // a drifted input (dimension changed after the key was frozen) is refused too
      const drifted = chunkArtifact();
      await expect(store.put({ ...drifted, dimension: 1024 })).rejects.toThrow(/identity mismatch/);
    });
  });

  it('refuses kind/prefix mismatches and malformed keys', async () => {
    await withStore(async (store) => {
      await expect(store.put({ ...fileArtifact(), kind: 'chunk' } as unknown as StoredFileArtifact))
        .rejects.toThrow(/kind/);
      await expect(store.put(fileArtifact({ artifactKey: 'chunk:v1:' + 'a'.repeat(64) })))
        .rejects.toThrow(/kind/);
      await expect(store.get(REPO, 'not-a-key')).rejects.toThrow();
    });
  });

  it('isolates repositories structurally — same content, two boundaries, two records', async () => {
    await withStore(async (store) => {
      const here = fileArtifact();
      const there = fileArtifact({ repositoryId: OTHER_REPO });
      await store.put(here);
      await store.put(there);

      expect(await store.get(REPO, here.artifactKey)).toEqual(here);
      expect(await store.get(OTHER_REPO, there.artifactKey)).toEqual(there);
      // the same key is legitimately absent from an unrelated repository
      expect(await store.get('repo_unknown', here.artifactKey)).toBeNull();

      // cross-boundary content sharing stays a caller policy decision, never a
      // dedupe side effect: deleting one boundary's record cannot touch the other
      expect(await store.delete(REPO, here.artifactKey)).toBe(true);
      expect(await store.get(REPO, here.artifactKey)).toBeNull();
      expect(await store.get(OTHER_REPO, there.artifactKey)).toEqual(there);
    });
  });

  it('lists every record across trust boundaries for a GC candidate universe', async () => {
    await withStore(async (store) => {
      const here = fileArtifact();
      const there = fileArtifact({ repositoryId: OTHER_REPO });
      const chunk = chunkArtifact();
      await store.put(here);
      await store.put(there);
      await store.put(chunk);

      const listed = await store.list();
      expect(listed.map((artifact) => `${artifact.repositoryId}:${artifact.artifactKey}`).sort()).toEqual([
        `${OTHER_REPO}:${there.artifactKey}`,
        `${REPO}:${here.artifactKey}`,
        `${REPO}:${chunk.artifactKey}`,
      ].sort());
    });
  });

  it('unions bindings on re-put and appends idempotently', async () => {
    await withStore(async (store) => {
      const first = fileArtifact({
        bindings: [{ path: 'src/a.ts', gitBlobOid: '1'.repeat(40), manifestId: 'man:v1:' + '1'.repeat(64) }],
      });
      await store.put(first);
      const renamed = fileArtifact({
        bindings: [
          { path: 'src/a.ts', gitBlobOid: '1'.repeat(40), manifestId: 'man:v1:' + '1'.repeat(64) },
          { path: 'src/renamed.ts', gitBlobOid: '1'.repeat(40), manifestId: 'man:v1:' + '2'.repeat(64) },
        ],
      });
      await store.put(renamed);

      const stored = await store.get(REPO, first.artifactKey);
      expect(stored?.kind).toBe('file');
      expect(stored !== null && stored.kind === 'file' ? stored.bindings : []).toEqual([
        { path: 'src/a.ts', gitBlobOid: '1'.repeat(40), manifestId: 'man:v1:' + '1'.repeat(64) },
        { path: 'src/renamed.ts', gitBlobOid: '1'.repeat(40), manifestId: 'man:v1:' + '2'.repeat(64) },
      ]);

      await store.addBinding(REPO, first.artifactKey, { path: 'src/third.ts' });
      await store.addBinding(REPO, first.artifactKey, { path: 'src/third.ts' });
      const after = await store.get(REPO, first.artifactKey);
      expect(after !== null && after.kind === 'file' ? after.bindings : []).toHaveLength(3);
    });
  });

  it('fails closed when binding an unknown artifact', async () => {
    await withStore(async (store) => {
      await expect(store.addBinding(REPO, 'file:v1:' + 'c'.repeat(64), { path: 'x.ts' }))
        .rejects.toThrow(/unknown artifact/);
    });
  });

  it('refuses path bindings on semantic artifacts', async () => {
    await withStore(async (store) => {
      const chunk = chunkArtifact();
      await store.put(chunk);
      await expect(store.addBinding(REPO, chunk.artifactKey, { path: 'src/a.ts' }))
        .rejects.toThrow(/no path bindings/);
    });
  });

  it('projects the artifact keys referenced by given manifests', async () => {
    await withStore(async (store) => {
      const m1 = 'man:v1:' + '1'.repeat(64);
      const m2 = 'man:v1:' + '2'.repeat(64);
      const a = fileArtifact({ bindings: [{ path: 'src/a.ts', manifestId: m1 }] });
      const b = fileArtifact({
        sourceContentSha256: 'd'.repeat(64),
        bindings: [{ path: 'src/b.ts', manifestId: m2 }],
      });
      const c = chunkArtifact();
      await store.put(a);
      await store.put(b);
      await store.put(c);

      expect(await store.artifactKeysReferencedBy([m1, m2])).toEqual([a.artifactKey, b.artifactKey].sort());
      expect(await store.artifactKeysReferencedBy([m1])).toEqual([a.artifactKey]);
      expect(await store.artifactKeysReferencedBy([])).toEqual([]);
    });
  });

  it('skips corrupt records when listing and reports missing deletes', async () => {
    await withStore(async (store, root) => {
      const good = fileArtifact();
      await store.put(good);
      const artifactsDir = path.join(root, 'artifacts');
      await writeFile(path.join(artifactsDir, 'corrupt.json'), '{not json', 'utf8');

      expect(await store.listRepository(REPO)).toEqual([good]);
      expect(await store.listRepository(OTHER_REPO)).toEqual([]);
      expect(await store.delete(REPO, 'file:v1:' + 'a'.repeat(64))).toBe(false);
      expect((await readdir(artifactsDir)).length).toBeGreaterThanOrEqual(2);
    });
  });

  it('refuses a strict listing instead of silently undercounting a corrupt record', async () => {
    await withStore(async (store, root) => {
      const good = fileArtifact();
      await store.put(good);
      const artifactsDir = path.join(root, 'artifacts');
      await writeFile(path.join(artifactsDir, 'corrupt.json'), '{not json', 'utf8');

      // Operator surfaces keep reporting what they can...
      expect(await store.list()).toEqual([good]);
      // ...but a count that must be exact refuses, naming the record it could
      // not read: a skipped record would print a smaller "measured" store.
      await expect(store.list({ strict: true })).rejects.toThrow(/cannot read canonical artifact corrupt\.json/);
    });
  });

  it('refuses a strict listing of a JSON file that is not an artifact record', async () => {
    await withStore(async (store, root) => {
      await store.put(fileArtifact());
      const artifactsDir = path.join(root, 'artifacts');
      await writeFile(path.join(artifactsDir, 'not-a-record.json'), '{"kind":"file"}', 'utf8');

      await expect(store.list({ strict: true })).rejects.toThrow(/not a canonical artifact record/);
    });
  });

  it('treats a missing artifacts directory as an empty strict listing', async () => {
    await withStore(async (store) => {
      // Nothing has been written yet: "no records" is a real answer, not a
      // read failure, so the strict read stays empty instead of refusing.
      expect(await store.list({ strict: true })).toEqual([]);
    });
  });

  it('deletes a corrupt record by path instead of treating it as missing', async () => {
    await withStore(async (store, root) => {
      const artifact = fileArtifact();
      const digest = createHash('sha256').update(REPO, 'utf8').digest('hex');
      const recordPath = path.join(root, 'artifacts', `${digest}.${artifact.artifactKey}.json`);
      await mkdir(path.dirname(recordPath), { recursive: true });
      await writeFile(recordPath, '{not json', 'utf8');

      // A record that cannot be read is still deletable: the destructive path
      // must never depend on parsing the thing it is removing.
      expect(await store.delete(REPO, artifact.artifactKey)).toBe(true);
      await expect(access(recordPath)).rejects.toThrow();
    });
  });

  it('throws when a record cannot be removed instead of reporting it missing', async () => {
    if (process.geteuid?.() === 0) return; // root ignores the directory mode
    await withStore(async (store, root) => {
      const artifact = fileArtifact();
      await store.put(artifact);
      const artifactsDir = path.join(root, 'artifacts');
      await chmod(artifactsDir, 0o500);
      try {
        // A failed unlink must surface: `false` would tell the GC pass the
        // record is gone, releasing the ledger row and orphaning the record.
        await expect(store.delete(REPO, artifact.artifactKey)).rejects.toThrow();
        expect(await store.get(REPO, artifact.artifactKey)).toEqual(artifact);
      } finally {
        await chmod(artifactsDir, 0o700);
      }
    });
  });
});
