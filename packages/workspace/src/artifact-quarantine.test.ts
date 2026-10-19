import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ArtifactQuarantineStore, quarantineEntryTarget } from './artifact-quarantine.js';

const H = (n: string): string => n.repeat(64).slice(0, 64);
const REPO = 'repo_abc123';
const OTHER_REPO = 'repo_other456';
const KEY = (n: string): string => `file:v1:${H(n)}`;
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
      expect(released.map(quarantineEntryTarget).sort()).toEqual([H('1'), H('2')].sort());
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
        isReachable: async (entry) => entry.kind === 'content-hash' && entry.hash === H('1'),
      });
      expect(released.map(quarantineEntryTarget)).toEqual([H('2')]);
      expect((await store.list()).map((entry) => (entry.kind === 'content-hash' ? entry.hash : entry.artifactKey))).toEqual([H('1')]);
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
      await expect(store.quarantine([{ kind: 'nonsense' } as never], { now, graceMs: GRACE })).rejects.toThrow(/quarantine target/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('artifact-key quarantine rows (#210 §1/U21)', () => {
  const keyTarget = (repositoryId: string, artifactKey: string): { kind: 'artifact-key'; repositoryId: string; artifactKey: string } =>
    ({ kind: 'artifact-key', repositoryId, artifactKey });

  it('records, dedupes and releases an artifact-key row by repository + key', async () => {
    const { store, dir, now } = await tempStore();
    try {
      await store.quarantine([keyTarget(REPO, KEY('a')), keyTarget(REPO, KEY('a'))], { now, graceMs: GRACE });
      expect(await store.list()).toEqual([
        { kind: 'artifact-key', repositoryId: REPO, artifactKey: KEY('a'), quarantinedAt: now.toISOString(), graceMs: GRACE },
      ]);

      // The same key in another trust boundary is a different row: deletion
      // needs the owning repository, so identity includes it.
      await store.quarantine([keyTarget(OTHER_REPO, KEY('a'))], { now, graceMs: GRACE });
      expect(await store.list()).toHaveLength(2);
      await store.release([keyTarget(REPO, KEY('a'))]);
      expect(await store.list()).toEqual([expect.objectContaining({ repositoryId: OTHER_REPO, artifactKey: KEY('a') })]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps both id spaces in one ledger and releases them independently', async () => {
    const { store, dir, now } = await tempStore();
    try {
      await store.quarantine([H('1'), keyTarget(REPO, KEY('b'))], { now, graceMs: GRACE });
      expect((await store.list()).map((entry) => entry.kind).sort()).toEqual(['artifact-key', 'content-hash']);
      await store.release([H('1')]);
      expect(await store.list()).toEqual([expect.objectContaining({ kind: 'artifact-key', artifactKey: KEY('b') })]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('releases a due artifact-key row only while it is still unreachable', async () => {
    const { store, dir, now } = await tempStore();
    try {
      await store.quarantine([keyTarget(REPO, KEY('b')), keyTarget(REPO, KEY('c'))], { now, graceMs: GRACE });
      const released = await store.releaseDue({
        now: new Date(now.getTime() + GRACE),
        isReachable: async (entry) => entry.kind === 'artifact-key' && entry.artifactKey === KEY('b'),
      });
      expect(released).toEqual([expect.objectContaining({ repositoryId: REPO, artifactKey: KEY('c') })]);
      // became reachable again: stays in the ledger for operator review
      expect(await store.list()).toEqual([expect.objectContaining({ repositoryId: REPO, artifactKey: KEY('b') })]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('exposes the entry-as-target conversion callers release with', async () => {
    expect(quarantineEntryTarget({ kind: 'content-hash', hash: H('2'), quarantinedAt: 'x', graceMs: 1 })).toBe(H('2'));
    expect(quarantineEntryTarget({ kind: 'artifact-key', repositoryId: REPO, artifactKey: KEY('d'), quarantinedAt: 'x', graceMs: 1 }))
      .toEqual({ kind: 'artifact-key', repositoryId: REPO, artifactKey: KEY('d') });
  });

  it('rejects malformed artifact-key targets instead of recording them', async () => {
    const { store, dir, now } = await tempStore();
    try {
      await expect(store.quarantine([keyTarget(REPO, 'file:v1:' + 'z'.repeat(64))], { now, graceMs: GRACE }))
        .rejects.toThrow(/artifact key/i);
      await expect(store.quarantine([keyTarget('', KEY('a'))], { now, graceMs: GRACE })).rejects.toThrow(/repositoryId/);
      await expect(store.release([keyTarget(REPO, 'man:v1:' + H('1'))])).rejects.toThrow(/artifact key/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reads rows written before the kind discriminator as content-hash rows', async () => {
    const { store, dir } = await tempStore();
    try {
      const file = path.join(dir, 'quarantine', 'candidates.json');
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify([{ hash: H('4'), quarantinedAt: T0.toISOString(), graceMs: GRACE }]), 'utf8');
      expect(await store.list()).toEqual([
        { kind: 'content-hash', hash: H('4'), quarantinedAt: T0.toISOString(), graceMs: GRACE },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
