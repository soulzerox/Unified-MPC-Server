import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CanonicalRefStore } from './canonical-ref-store.js';
import { GoalOverlayStore } from './goal-overlay-store.js';
import { attachGoalBasePin } from './goal-base-pin.js';
import { resolveGoalLogicalView } from './goal-logical-view.js';

const C100 = {
  commitSha: 'a'.repeat(40),
  treeOid: 'b'.repeat(40),
  manifestId: 'man:v1:' + 'c'.repeat(64),
};

describe('goal logical view (#210 U14)', () => {
  it('resolves overlay entries before base entries', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'goal-logical-view-'));
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
      await overlays.upsert('goal-1', { path: 'foo.ts', kind: 'modified', contentHash: 'd'.repeat(64) });
      await overlays.upsert('goal-1', { path: 'bar.ts', kind: 'deleted', contentHash: null });
      const view = await resolveGoalLogicalView(refs, overlays, {
        goalWorkspaceId: 'goal-1',
        canonicalRef: 'refs/remotes/origin/main',
        baseEntries: [
          { path: 'foo.ts', contentHash: 'e'.repeat(64) },
          { path: 'bar.ts', contentHash: 'f'.repeat(64) },
          { path: 'baz.ts', contentHash: '0'.repeat(64) },
        ],
      });
      expect(view.get('foo.ts')).toBe('d'.repeat(64));
      expect(view.has('bar.ts')).toBe(false);
      expect(view.get('baz.ts')).toBe('0'.repeat(64));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when the base drifted since the pin', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'goal-logical-view-'));
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
      await expect(resolveGoalLogicalView(refs, overlays, {
        goalWorkspaceId: 'goal-1',
        canonicalRef: 'refs/remotes/origin/main',
        baseEntries: [],
      })).rejects.toThrow(/drift/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when the overlay is missing', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'goal-logical-view-'));
    try {
      const refs = new CanonicalRefStore(dir);
      const overlays = new GoalOverlayStore(dir);
      await refs.promote('refs/remotes/origin/main', {
        expectedCurrent: null, current: null, target: C100, targetVerified: true,
      });
      await expect(resolveGoalLogicalView(refs, overlays, {
        goalWorkspaceId: 'ghost',
        canonicalRef: 'refs/remotes/origin/main',
        baseEntries: [],
      })).rejects.toThrow(/overlay/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
