import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalManifestId, canonicalRevisionId, computeTreeOid } from '@unified-mpc/domain';
import { CanonicalManifestStore } from './canonical-manifest-store.js';
import { GcLeaseStore } from './gc-lease.js';
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

interface PinStores {
  readonly dir: string;
  readonly manifests: CanonicalManifestStore;
  readonly pins: RevisionPinRegistry;
  readonly lease: GcLeaseStore;
  readonly fixture: ManifestFixture;
}

const LEASE = { ownerId: 'pin_fence_test', ttlMs: 60_000 };

async function withStores(run: (stores: PinStores) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'canonical-revision-pin-'));
  try {
    const manifests = new CanonicalManifestStore(dir);
    const pins = new RevisionPinRegistry(dir);
    const lease = new GcLeaseStore(dir);
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
    await run({ dir, manifests, pins, lease, fixture });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('canonical revision pin (#210 §7)', () => {
  it('pins an existing revision with the operator reason and note', async () => {
    await withStores(async ({ manifests, pins, lease, fixture }) => {
      const report = await pinCanonicalRevision({ manifests, pins, lease: { store: lease, ...LEASE } }, {
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
      // The fence is released: a subsequent prune can take it.
      expect(await lease.read()).toBeNull();
    });
  });

  it('re-pinning refreshes the note without duplicating the reason', async () => {
    await withStores(async ({ manifests, pins, lease, fixture }) => {
      const deps = { manifests, pins, lease: { store: lease, ...LEASE } };
      await pinCanonicalRevision(deps, { manifestId: fixture.manifestId, note: 'first' });
      const report = await pinCanonicalRevision(deps, { manifestId: fixture.manifestId, note: 'second' });

      expect(report.action).toBe('pinned');
      const stored = await pins.list(fixture.manifestId);
      expect(stored.map((pin) => pin.reason)).toEqual(['user-pin']);
      expect(stored[0]?.note).toBe('second');
    });
  });

  it('never touches system-owned pin reasons', async () => {
    await withStores(async ({ manifests, pins, lease, fixture }) => {
      await pins.pin(fixture.manifestId, 'goal-base', 'goal_a');
      const report = await pinCanonicalRevision({ manifests, pins, lease: { store: lease, ...LEASE } }, { manifestId: fixture.manifestId });

      expect(report.pins).toEqual(['goal-base', 'user-pin']);
      const stored = await pins.list(fixture.manifestId);
      expect(stored.find((pin) => pin.reason === 'goal-base')?.note).toBe('goal_a');
    });
  });

  it('refuses to pin a manifest that does not exist and writes no pin', async () => {
    await withStores(async ({ manifests, pins, lease }) => {
      await expect(pinCanonicalRevision({ manifests, pins, lease: { store: lease, ...LEASE } }, { manifestId: MISSING }))
        .rejects.toThrow(`unknown revision manifest: ${MISSING}`);
      expect(await pins.isPinned(MISSING)).toBe(false);
      expect(await lease.read()).toBeNull();
    });
  });

  it('refuses a malformed manifest id before taking the fence', async () => {
    await withStores(async ({ manifests, pins, lease }) => {
      // A held fence is the ordering proof: if the id check moved inside the
      // fenced block, the held lease would refuse the call with the lease
      // error instead of the invalid-id error.
      const held = await lease.acquire({ ownerId: 'gc_prune', now: new Date(), ttlMs: 60_000 });
      if (held.status !== 'granted') throw new Error(`expected a granted lease, got ${held.status}`);
      await expect(pinCanonicalRevision({ manifests, pins, lease: { store: lease, ...LEASE } }, { manifestId: 'not-a-manifest' }))
        .rejects.toThrow(/invalid manifest id/);
      // Validation failed before the fence, so it did not release the holder.
      expect(await lease.read()).toMatchObject({ ownerId: 'gc_prune', generation: held.generation });
    });
  });

  it('refuses to pin while a destructive pass holds the lease', async () => {
    await withStores(async ({ manifests, pins, lease, fixture }) => {
      await lease.acquire({ ownerId: 'gc_prune', now: new Date(), ttlMs: 60_000 });
      await expect(pinCanonicalRevision({ manifests, pins, lease: { store: lease, ...LEASE } }, { manifestId: fixture.manifestId }))
        .rejects.toThrow(/gc lease held by gc_prune/);
      expect(await pins.isPinned(fixture.manifestId)).toBe(false);
    });
  });

  it('refuses to pin when the fence record is unreadable', async () => {
    await withStores(async ({ dir, manifests, pins, lease, fixture }) => {
      // Create the store's directory through the supported API, then corrupt
      // the record so the fence read cannot classify it as free.
      await lease.acquire({ ownerId: 'previous', now: new Date(), ttlMs: 60_000 });
      await writeFile(path.join(dir, 'gc', 'lease.json'), '{ broken', 'utf8');
      await expect(pinCanonicalRevision({ manifests, pins, lease: { store: lease, ...LEASE } }, { manifestId: fixture.manifestId }))
        .rejects.toThrow(/fence unreadable/);
      expect(await pins.isPinned(fixture.manifestId)).toBe(false);
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
