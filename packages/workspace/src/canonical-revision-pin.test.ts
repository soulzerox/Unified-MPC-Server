import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalManifestId, canonicalRevisionId, computeTreeOid } from '@unified-mpc/domain';
import { CanonicalManifestStore } from './canonical-manifest-store.js';
import { RevisionPinRegistry } from './revision-pin-registry.js';
import { pinCanonicalRevision, unpinCanonicalRevision } from './canonical-revision-pin.js';

const REPO = 'repo_abc123';
const REF = 'refs/remotes/origin/main';
const H = (n: string): string => n.repeat(64).slice(0, 64);
const MISSING = `man:v1:${H('f')}`;

interface ManifestFixture {
  readonly manifestId: string;
  readonly revisionId: string;
  readonly commitSha: string;
  readonly treeOid: string;
  readonly entries: readonly { readonly path: string; readonly contentHash: string }[];
}

function manifestFixture(seed: string): ManifestFixture {
  const entries = [{ path: `${seed}.ts`, contentHash: H(seed) }];
  const treeOid = computeTreeOid(entries);
  const commitSha = seed.repeat(40).slice(0, 40);
  const revisionId = canonicalRevisionId({ repositoryId: REPO, commitSha, treeOid, targetRef: REF, parents: [] });
  const manifestId = canonicalManifestId({ repositoryId: REPO, revisionId, entries });
  return { manifestId, revisionId, commitSha, treeOid, entries };
}

async function withStores(
  run: (stores: { manifests: CanonicalManifestStore; pins: RevisionPinRegistry; fixture: ManifestFixture }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'canonical-revision-pin-'));
  try {
    const manifests = new CanonicalManifestStore(dir);
    const pins = new RevisionPinRegistry(dir);
    const fixture = manifestFixture('a');
    await manifests.put({
      manifestId: fixture.manifestId,
      repositoryId: REPO,
      revisionId: fixture.revisionId,
      commitSha: fixture.commitSha,
      treeOid: fixture.treeOid,
      targetRef: REF,
      entries: fixture.entries,
      createdAt: '2026-10-17T00:00:00.000Z',
    });
    await run({ manifests, pins, fixture });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('canonical revision pin (#210 §7)', () => {
  it('pins an existing revision with the operator reason and note', async () => {
    await withStores(async ({ manifests, pins, fixture }) => {
      const report = await pinCanonicalRevision({ manifests, pins }, {
        manifestId: fixture.manifestId,
        note: 'keep for audit',
      });

      expect(report).toEqual({
        manifestId: fixture.manifestId,
        action: 'pinned',
        pins: ['user-pin'],
      });
      const stored = await pins.list(fixture.manifestId);
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ reason: 'user-pin', note: 'keep for audit' });
    });
  });

  it('re-pinning refreshes the note without duplicating the reason', async () => {
    await withStores(async ({ manifests, pins, fixture }) => {
      await pinCanonicalRevision({ manifests, pins }, { manifestId: fixture.manifestId, note: 'first' });
      const report = await pinCanonicalRevision({ manifests, pins }, { manifestId: fixture.manifestId, note: 'second' });

      expect(report.action).toBe('pinned');
      const stored = await pins.list(fixture.manifestId);
      expect(stored.map((pin) => pin.reason)).toEqual(['user-pin']);
      expect(stored[0]?.note).toBe('second');
    });
  });

  it('never touches system-owned pin reasons', async () => {
    await withStores(async ({ manifests, pins, fixture }) => {
      await pins.pin(fixture.manifestId, 'goal-base', 'goal_a');
      const report = await pinCanonicalRevision({ manifests, pins }, { manifestId: fixture.manifestId });

      expect(report.pins).toEqual(['goal-base', 'user-pin']);
      const stored = await pins.list(fixture.manifestId);
      expect(stored.find((pin) => pin.reason === 'goal-base')?.note).toBe('goal_a');
    });
  });

  it('refuses to pin a manifest that does not exist and writes no pin', async () => {
    await withStores(async ({ manifests, pins }) => {
      await expect(pinCanonicalRevision({ manifests, pins }, { manifestId: MISSING }))
        .rejects.toThrow(`unknown revision manifest: ${MISSING}`);
      expect(await pins.isPinned(MISSING)).toBe(false);
    });
  });

  it('refuses a malformed manifest id', async () => {
    await withStores(async ({ manifests, pins }) => {
      await expect(pinCanonicalRevision({ manifests, pins }, { manifestId: 'not-a-manifest' })).rejects.toThrow(/invalid manifest id/);
    });
  });

  it('unpins only the operator reason and reports what remains', async () => {
    await withStores(async ({ manifests, pins, fixture }) => {
      await pins.pin(fixture.manifestId, 'canonical-ref', REF);
      await pins.pin(fixture.manifestId, 'user-pin', 'audit hold');

      const report = await unpinCanonicalRevision({ manifests, pins }, { manifestId: fixture.manifestId });
      expect(report).toEqual({
        manifestId: fixture.manifestId,
        action: 'unpinned',
        pins: ['canonical-ref'],
      });
      expect((await pins.list(fixture.manifestId)).map((pin) => pin.reason)).toEqual(['canonical-ref']);
    });
  });

  it('reports not-pinned without changing the remaining reasons', async () => {
    await withStores(async ({ manifests, pins, fixture }) => {
      await pins.pin(fixture.manifestId, 'rollback', 'LKG');

      const report = await unpinCanonicalRevision({ manifests, pins }, { manifestId: fixture.manifestId });
      expect(report).toEqual({
        manifestId: fixture.manifestId,
        action: 'not-pinned',
        pins: ['rollback'],
      });
    });
  });

  it('can clean an orphan pin whose manifest is already gone', async () => {
    await withStores(async ({ manifests, pins }) => {
      await pins.pin(MISSING, 'user-pin', 'left by an older build');

      const report = await unpinCanonicalRevision({ manifests, pins }, { manifestId: MISSING });
      expect(report.action).toBe('unpinned');
      expect(report.pins).toEqual([]);
      expect(await pins.isPinned(MISSING)).toBe(false);
    });
  });
});
