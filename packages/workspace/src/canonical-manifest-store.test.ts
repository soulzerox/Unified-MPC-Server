import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalManifestId } from '@unified-mpc/domain';
import { CanonicalManifestStore, type StoredManifest } from './canonical-manifest-store.js';

const REPO = 'repo_abc123';
const REV = 'rev:v1:' + 'a'.repeat(64);

function manifest(overrides: Partial<StoredManifest> = {}): StoredManifest {
  const entries = overrides.entries ?? [
    { path: 'a.ts', contentHash: '1'.repeat(64) },
    { path: 'b.ts', contentHash: '2'.repeat(64) },
  ];
  const base = {
    repositoryId: REPO,
    revisionId: REV,
    commitSha: 'c'.repeat(40),
    treeOid: 'd'.repeat(40),
    targetRef: 'refs/remotes/origin/main',
    entries,
    createdAt: '2026-10-17T00:00:00.000Z',
  };
  const merged = { ...base, ...overrides, entries };
  let manifestId: string;
  try {
    manifestId = canonicalManifestId({
      repositoryId: merged.repositoryId,
      revisionId: merged.revisionId,
      entries: merged.entries,
    });
  } catch {
    // Deliberately-invalid fixtures still need a syntactically valid id so
    // the store's own validation is what rejects them.
    manifestId = 'man:v1:' + '0'.repeat(64);
  }
  return { ...merged, manifestId };
}

describe('canonical manifest store (#210 U15)', () => {
  it('stores and reads a manifest by id and by commit identity', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'manifest-store-'));
    try {
      const store = new CanonicalManifestStore(dir);
      const target = manifest();
      await store.put(target);
      expect(await store.get(target.manifestId)).toEqual(target);
      expect(await store.getByCommit(REPO, target.commitSha)).toEqual(target);
      expect(await store.getByCommit('repo_other', target.commitSha)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects a manifest whose declared id does not match its recomputed identity', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'manifest-store-'));
    try {
      const store = new CanonicalManifestStore(dir);
      const tampered = { ...manifest(), entries: [{ path: 'a.ts', contentHash: '9'.repeat(64) }] };
      await expect(store.put(tampered)).rejects.toThrow(/identity/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('isolates repositories when listing and survives a reopen', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'manifest-store-'));
    try {
      const store = new CanonicalManifestStore(dir);
      const main = manifest();
      const other = manifest({ repositoryId: 'repo_other', commitSha: 'e'.repeat(40) });
      await store.put(main);
      await store.put(other);
      const reopened = new CanonicalManifestStore(dir);
      const listed = await reopened.listRepository(REPO);
      expect(listed.map((m) => m.manifestId)).toEqual([main.manifestId]);
      expect(await reopened.get(other.manifestId)).toEqual(other);
      expect(await reopened.delete(main.manifestId)).toBe(true);
      expect(await reopened.get(main.manifestId)).toBeNull();
      expect(await reopened.delete(main.manifestId)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns false only when the row is already absent and rethrows a failed delete', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'manifest-store-'));
    try {
      const store = new CanonicalManifestStore(dir);
      const main = manifest();
      await store.put(main);
      // Replace the row with a non-empty directory: a non-recursive rm cannot
      // remove it, so delete must fail rather than look like an absent row.
      const row = path.join(dir, 'manifests', `${main.manifestId}.json`);
      await rm(row);
      await mkdir(path.join(row, 'child'), { recursive: true });
      await expect(store.delete(main.manifestId)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('skips a corrupt row when listing tolerantly and refuses it when reads are strict', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'manifest-store-'));
    try {
      const store = new CanonicalManifestStore(dir);
      const main = manifest();
      await store.put(main);
      await writeFile(path.join(dir, 'manifests', 'corrupt.json'), '{not json', 'utf8');

      expect(await store.listAll()).toEqual([main]);
      await expect(new CanonicalManifestStore(dir, { strictReads: true }).listAll())
        .rejects.toThrow(/cannot read canonical manifest corrupt\.json/);
      // The tolerant row lookup stays available to operator surfaces.
      expect(await store.get(main.manifestId)).toEqual(main);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses an unreadable or non-record row on a strict read but tolerates a missing directory', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'manifest-store-'));
    try {
      const strict = new CanonicalManifestStore(dir, { strictReads: true });
      expect(await strict.listAll()).toEqual([]);

      await mkdir(path.join(dir, 'manifests'), { recursive: true });
      const target = manifest();
      const row = path.join(dir, 'manifests', `${target.manifestId}.json`);
      await writeFile(row, '{not json', 'utf8');
      await expect(strict.get(target.manifestId)).rejects.toThrow(/cannot read canonical manifest/);

      await writeFile(row, JSON.stringify({ manifestId: target.manifestId }), 'utf8');
      await expect(strict.get(target.manifestId)).rejects.toThrow(/not a canonical manifest record/);

      expect(await new CanonicalManifestStore(dir).get(target.manifestId)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('treats a malformed id as an absent row unless reads are strict', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'manifest-store-'));
    try {
      expect(await new CanonicalManifestStore(dir).get('not-a-manifest-id')).toBeNull();
      const strict = new CanonicalManifestStore(dir, { strictReads: true });
      await expect(strict.get('not-a-manifest-id')).rejects.toThrow(/invalid manifest id/);
      // A well-formed id with no row is legitimately absent, even when strict.
      expect(await strict.get(manifest().manifestId)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses an unreadable manifests directory on a strict read', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'manifest-store-'));
    try {
      // A regular file where the directory belongs makes readdir/readFile fail
      // with ENOTDIR, which is not the legitimately-missing path.
      await writeFile(path.join(dir, 'manifests'), '', 'utf8');
      const strict = new CanonicalManifestStore(dir, { strictReads: true });
      await expect(strict.listAll()).rejects.toThrow(/cannot read the canonical manifests directory/);
      const id = manifest().manifestId;
      await expect(strict.get(id)).rejects.toThrow(/cannot read canonical manifest/);
      expect(await new CanonicalManifestStore(dir).listAll()).toEqual([]);
      expect(await new CanonicalManifestStore(dir).get(id)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects malformed commit, tree and repository ids', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'manifest-store-'));
    try {
      const store = new CanonicalManifestStore(dir);
      await expect(store.put(manifest({ commitSha: 'short' }))).rejects.toThrow();
      await expect(store.put(manifest({ treeOid: '' }))).rejects.toThrow();
      await expect(store.put(manifest({ repositoryId: '' }))).rejects.toThrow();
      await expect(store.put(manifest({ targetRef: 'main' }))).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
