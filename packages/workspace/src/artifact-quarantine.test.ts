import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ArtifactQuarantineStore } from './artifact-quarantine.js';

const H = (n: string): string => n.repeat(64).slice(0, 64);
const T0 = new Date('2026-10-17T00:00:00.000Z');
const GRACE = 60_000;

async function tempStore(): Promise<{ store: ArtifactQuarantineStore; dir: string; now: Date }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'artifact-quarantine-'));
  return { store: new ArtifactQuarantineStore(dir), dir, now: T0 };
}

describe('artifact quarantine ledger (#210 U21)', () => {
  it('does not release a candidate before its grace window elapses', async () => {
    const { store, dir, now } = await tempStore();
    try {
      await store.quarantine([H('1')], { now, graceMs: GRACE });
      const released = await store.releaseDue({ now: new Date(now.getTime() + GRACE - 1), isReachable: async () => false });
      expect(released).toEqual([]);
      expect(await store.list()).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('releases an expired candidate that is still unreachable and clears the ledger entry', async () => {
    const { store, dir, now } = await tempStore();
    try {
      await store.quarantine([H('1'), H('2')], { now, graceMs: GRACE });
      const released = await store.releaseDue({
        now: new Date(now.getTime() + GRACE),
        isReachable: async () => false,
      });
      expect(released.sort()).toEqual([H('1'), H('2')].sort());
      expect(await store.list()).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('never releases a candidate that became reachable again', async () => {
    const { store, dir, now } = await tempStore();
    try {
      await store.quarantine([H('1'), H('2')], { now, graceMs: GRACE });
      const released = await store.releaseDue({
        now: new Date(now.getTime() + GRACE * 2),
        isReachable: async (hash) => hash === H('1'),
      });
      expect(released).toEqual([H('2')]);
      expect((await store.list()).map((entry) => entry.hash)).toEqual([H('1')]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('survives a reopen and drops hashes on release', async () => {
    const { store, dir, now } = await tempStore();
    try {
      await store.quarantine([H('3')], { now, graceMs: GRACE });
      const reopened = new ArtifactQuarantineStore(dir);
      expect((await reopened.list())[0]).toMatchObject({ hash: H('3'), quarantinedAt: T0.toISOString() });
      await reopened.release([H('3')]);
      expect(await reopened.list()).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects malformed hashes and non-positive grace windows', async () => {
    const { store, dir, now } = await tempStore();
    try {
      await expect(store.quarantine(['nope'], { now, graceMs: GRACE })).rejects.toThrow();
      await expect(store.quarantine([H('1')], { now, graceMs: 0 })).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
