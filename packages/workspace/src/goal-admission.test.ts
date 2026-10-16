import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CanonicalRefStore } from './canonical-ref-store.js';
import { GoalOverlayStore } from './goal-overlay-store.js';
import { attachGoalBasePin } from './goal-base-pin.js';
import { verifyGoalAdmission } from './goal-admission.js';

const C100 = {
  commitSha: 'a'.repeat(40),
  treeOid: 'b'.repeat(40),
  manifestId: 'man:v1:' + 'c'.repeat(64),
};

describe('goal admission verify (#210 U11)', () => {
  it('admits a goal whose overlay base still matches the live ref', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'goal-admission-'));
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
      const verdict = await verifyGoalAdmission(refs, overlays, {
        goalWorkspaceId: 'goal-1',
        canonicalRef: 'refs/remotes/origin/main',
      });
      expect(verdict).toMatchObject({ admitted: true, baseManifestId: C100.manifestId });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses admission when the canonical ref advanced past the pinned base', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'goal-admission-'));
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
      const verdict = await verifyGoalAdmission(refs, overlays, {
        goalWorkspaceId: 'goal-1',
        canonicalRef: 'refs/remotes/origin/main',
      });
      expect(verdict.admitted).toBe(false);
      if (!verdict.admitted) expect(verdict.reason).toMatch(/drift/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses admission when the overlay is missing', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'goal-admission-'));
    try {
      const refs = new CanonicalRefStore(dir);
      const overlays = new GoalOverlayStore(dir);
      await refs.promote('refs/remotes/origin/main', {
        expectedCurrent: null, current: null, target: C100, targetVerified: true,
      });
      const verdict = await verifyGoalAdmission(refs, overlays, {
        goalWorkspaceId: 'ghost',
        canonicalRef: 'refs/remotes/origin/main',
      });
      expect(verdict.admitted).toBe(false);
      if (!verdict.admitted) expect(verdict.reason).toMatch(/overlay/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
