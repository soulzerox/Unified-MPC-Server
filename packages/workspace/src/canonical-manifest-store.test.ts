import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
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
