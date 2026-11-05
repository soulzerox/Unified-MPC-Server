import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

  it('refuses a non-canonical pin file name in a strict listing', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'revision-pins-'));
    try {
      const pins = new RevisionPinRegistry(dir);
      await mkdir(path.join(dir, 'pins'), { recursive: true });
      const record = [{ manifestId: M1, reason: 'user-pin', note: 'hold', createdAt: '2026-11-05T00:00:00.000Z' }];
      const nonCanonical = `${M1.toUpperCase()}.json`;
      await writeFile(path.join(dir, 'pins', nonCanonical), JSON.stringify(record), 'utf8');

      // The destructive readers look the id up as a lowercase path, so a
      // differently-cased file name must refuse instead of yielding an id whose
      // reasons read back empty.
      await expect(pins.pinnedManifestIds({ strict: true })).rejects.toThrow('cannot read revision pin');
      expect(await pins.pinnedManifestIds()).toEqual([M1.toUpperCase()]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reads and removes pins strictly on request instead of treating unreadable as empty', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'revision-pins-'));
    try {
      const pins = new RevisionPinRegistry(dir);
      await pins.pin(M1, 'user-pin', 'hold');
      await writeFile(path.join(dir, 'pins', `${M1}.json`), '{not a pin', 'utf8');

      await expect(pins.list(M1, { strict: true })).rejects.toThrow('cannot read revision pin');
      await expect(pins.unpin(M1, 'user-pin', { strict: true })).rejects.toThrow('cannot read revision pin');
      expect(await pins.list(M1)).toEqual([]);
      expect(await pins.unpin(M1, 'user-pin')).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses empty and partly malformed records strictly while a missing file stays empty', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'revision-pins-'));
    try {
      const pins = new RevisionPinRegistry(dir);
      await mkdir(path.join(dir, 'pins'), { recursive: true });
      const pinPath = path.join(dir, 'pins', `${M1}.json`);

      await writeFile(pinPath, '[]', 'utf8');
      await expect(pins.list(M1, { strict: true })).rejects.toThrow('cannot read revision pin');
      expect(await pins.list(M1)).toEqual([]);

      const valid = { manifestId: M1, reason: 'user-pin', note: 'hold', createdAt: '2026-11-05T00:00:00.000Z' };
      await writeFile(pinPath, JSON.stringify([valid, { manifestId: M1, reason: 'bogus' }]), 'utf8');
      await expect(pins.list(M1, { strict: true })).rejects.toThrow('cannot read revision pin');
      expect((await pins.list(M1)).map((pin) => pin.reason)).toEqual(['user-pin']);

      await rm(pinPath);
      expect(await pins.list(M1, { strict: true })).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
