import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CanonicalRefStore } from './canonical-ref-store.js';
import { GoalOverlayStore } from './goal-overlay-store.js';
import { attachGoalBasePin } from './goal-base-pin.js';

const C100 = {
  commitSha: 'a'.repeat(40),
  treeOid: 'b'.repeat(40),
  manifestId: 'man:v1:' + 'c'.repeat(64),
};

describe('goal base pin (#210 U9)', () => {
  it('attaches an overlay only when the pin matches the live canonical ref', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'goal-base-pin-'));
    try {
      const refs = new CanonicalRefStore(dir);
      const overlays = new GoalOverlayStore(dir);
      await refs.promote('refs/remotes/origin/main', {
        expectedCurrent: null,
        current: null,
        target: C100,
        targetVerified: true,
      });
      const pin = await attachGoalBasePin(refs, overlays, {
        goalWorkspaceId: 'goal-1',
        canonicalRef: 'refs/remotes/origin/main',
        expectedBase: C100,
      });
      expect(pin.baseManifestId).toBe(C100.manifestId);
      expect((await overlays.read('goal-1'))?.baseManifestId).toBe(C100.manifestId);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when the canonical ref moved since the expected base', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'goal-base-pin-'));
    try {
      const refs = new CanonicalRefStore(dir);
      const overlays = new GoalOverlayStore(dir);
      await refs.promote('refs/remotes/origin/main', {
        expectedCurrent: null,
        current: null,
        target: C100,
        targetVerified: true,
      });
      const moved = {
        commitSha: 'd'.repeat(40),
        treeOid: 'e'.repeat(40),
        manifestId: 'man:v1:' + 'f'.repeat(64),
      };
      await refs.promote('refs/remotes/origin/main', {
        expectedCurrent: C100,
        current: C100,
        target: moved,
        targetVerified: true,
      });
      await expect(attachGoalBasePin(refs, overlays, {
        goalWorkspaceId: 'goal-1',
        canonicalRef: 'refs/remotes/origin/main',
        expectedBase: C100,
      })).rejects.toThrow(/base moved/);
      expect(await overlays.read('goal-1')).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when no canonical ref exists yet', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'goal-base-pin-'));
    try {
      const refs = new CanonicalRefStore(dir);
      const overlays = new GoalOverlayStore(dir);
      await expect(attachGoalBasePin(refs, overlays, {
        goalWorkspaceId: 'goal-1',
        canonicalRef: 'refs/remotes/origin/main',
        expectedBase: C100,
      })).rejects.toThrow(/no canonical ref/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
