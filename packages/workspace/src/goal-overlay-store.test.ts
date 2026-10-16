import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GoalOverlayStore } from './goal-overlay-store.js';

const BASE = {
  baseCommitSha: 'a'.repeat(40),
  baseTreeOid: 'b'.repeat(40),
  baseManifestId: 'man:v1:' + 'c'.repeat(64),
};

describe('goal overlay store (#210 U8)', () => {
  it('creates an overlay pinned to an exact base revision', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'goal-overlay-'));
    try {
      const store = new GoalOverlayStore(dir);
      const overlay = await store.create('goal-1', BASE);
      expect(overlay.goalWorkspaceId).toBe('goal-1');
      expect(overlay.baseManifestId).toBe(BASE.baseManifestId);
      expect(overlay.entries).toEqual([]);
      expect(await store.read('goal-1')).toEqual(overlay);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('upserts path entries and resolves overlay before base', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'goal-overlay-'));
    try {
      const store = new GoalOverlayStore(dir);
      await store.create('goal-1', BASE);
      await store.upsert('goal-1', { path: 'foo.ts', kind: 'modified', contentHash: 'd'.repeat(64) });
      await store.upsert('goal-1', { path: 'bar.ts', kind: 'deleted', contentHash: null });
      const overlay = await store.read('goal-1');
      expect(overlay?.entries).toHaveLength(2);
      expect(store.resolve('foo.ts', [], overlay!)).toBe('d'.repeat(64));
      expect(store.resolve('bar.ts', [{ path: 'bar.ts', contentHash: 'e'.repeat(64) }], overlay!)).toBeNull();
      expect(store.resolve('baz.ts', [{ path: 'baz.ts', contentHash: 'f'.repeat(64) }], overlay!)).toBe('f'.repeat(64));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects entries for unknown goals and invalid paths', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'goal-overlay-'));
    try {
      const store = new GoalOverlayStore(dir);
      await expect(store.upsert('missing', { path: 'a.ts', kind: 'added', contentHash: 'd'.repeat(64) }))
        .rejects.toThrow();
      await store.create('goal-1', BASE);
      await expect(store.upsert('goal-1', { path: '../escape.ts', kind: 'added', contentHash: 'd'.repeat(64) }))
        .rejects.toThrow();
      await expect(store.upsert('goal-1', { path: 'a.ts', kind: 'modified', contentHash: 'xyz' }))
        .rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('survives a store re-open and deletes cleanly', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'goal-overlay-'));
    try {
      const store = new GoalOverlayStore(dir);
      await store.create('goal-1', BASE);
      await store.upsert('goal-1', { path: 'foo.ts', kind: 'modified', contentHash: 'd'.repeat(64) });
      const reopened = new GoalOverlayStore(dir);
      expect((await reopened.read('goal-1'))?.entries).toHaveLength(1);
      expect(await reopened.delete('goal-1')).toBe(true);
      expect(await reopened.read('goal-1')).toBeNull();
      expect(await reopened.delete('goal-1')).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
