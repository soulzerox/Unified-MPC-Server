import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RevisionPinRegistry } from './revision-pin-registry.js';

const M1 = 'man:v1:' + 'a'.repeat(64);

describe('revision pin registry (#210 U13)', () => {
  it('pins a revision with a reason and lists it back', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'revision-pins-'));
    try {
      const pins = new RevisionPinRegistry(dir);
      await pins.pin(M1, 'goal-base', 'goal-1');
      await pins.pin(M1, 'user-pin', 'audit hold');
      const listed = await pins.list(M1);
      expect(listed.map((p) => p.reason).sort()).toEqual(['goal-base', 'user-pin']);
      expect(await pins.isPinned(M1)).toBe(true);
      expect(await pins.isPinned('man:v1:' + 'b'.repeat(64))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('unpins one reason while keeping the others', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'revision-pins-'));
    try {
      const pins = new RevisionPinRegistry(dir);
      await pins.pin(M1, 'goal-base', 'goal-1');
      await pins.pin(M1, 'user-pin', 'audit hold');
      expect(await pins.unpin(M1, 'goal-base')).toBe(true);
      expect((await pins.list(M1)).map((p) => p.reason)).toEqual(['user-pin']);
      expect(await pins.unpin(M1, 'goal-base')).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses to prune a pinned revision and reports the blocking reasons', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'revision-pins-'));
    try {
      const pins = new RevisionPinRegistry(dir);
      await pins.pin(M1, 'goal-base', 'goal-1');
      const verdict = await pins.checkPrune(M1);
      expect(verdict).toMatchObject({ prunable: false });
      if (!verdict.prunable) expect(verdict.blockedBy).toContain('goal-base');
      expect(await pins.checkPrune('man:v1:' + 'b'.repeat(64))).toMatchObject({ prunable: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects malformed manifest ids and reasons', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'revision-pins-'));
    try {
      const pins = new RevisionPinRegistry(dir);
      await expect(pins.pin('not-a-manifest', 'goal-base', 'x')).rejects.toThrow();
      await expect(pins.pin(M1, 'bogus-reason' as never, 'x')).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
