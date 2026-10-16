import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalManifestId, canonicalRevisionId, computeTreeOid } from '@unified-mpc/domain';
import { CanonicalRefStore } from './canonical-ref-store.js';
import { CanonicalManifestStore, type StoredManifest } from './canonical-manifest-store.js';
import { GoalOverlayStore } from './goal-overlay-store.js';
import { RevisionPinRegistry } from './revision-pin-registry.js';
import { ArtifactQuarantineStore } from './artifact-quarantine.js';
import { runGcCycle } from './gc-cycle.js';

const REPO = 'repo_abc123';
const REF = 'refs/remotes/origin/main';
const H = (n: string): string => n.repeat(64).slice(0, 64);
const NOW = new Date('2026-10-17T00:00:00.000Z');
const GRACE = 60_000;

function manifestFor(commitSha: string, entries: readonly { path: string; contentHash: string }[]): StoredManifest {
  const revisionId = canonicalRevisionId({
    repositoryId: REPO, commitSha, treeOid: computeTreeOid(entries), targetRef: REF, parents: [],
  });
  return {
    manifestId: canonicalManifestId({ repositoryId: REPO, revisionId, entries }),
    repositoryId: REPO,
    revisionId,
    commitSha,
    treeOid: computeTreeOid(entries),
    targetRef: REF,
    entries,
    createdAt: '2026-10-17T00:00:00.000Z',
  };
}

async function scenario(): Promise<Parameters<typeof runGcCycle>[0] & { dir: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gc-cycle-'));
  const refs = new CanonicalRefStore(dir);
  const manifests = new CanonicalManifestStore(dir);
  const pins = new RevisionPinRegistry(dir);
  const overlays = new GoalOverlayStore(dir);
  const quarantine = new ArtifactQuarantineStore(dir);
  const active = manifestFor('c'.repeat(40), [{ path: 'live.ts', contentHash: H('1') }]);
  await manifests.put(active);
  await refs.promote(REF, {
    expectedCurrent: null, current: null,
    target: { commitSha: active.commitSha, treeOid: active.treeOid, manifestId: active.manifestId },
    targetVerified: true,
  });
  return { dir, refs, manifests, pins, overlays, quarantine } as Parameters<typeof runGcCycle>[0] & { dir: string };
}

describe('GC cycle orchestrator (#210 U22)', () => {
  it('dry-run reports unreachable candidates without quarantining anything', async () => {
    const deps = await scenario();
    try {
      const report = await runGcCycle(deps, {
        candidates: [H('1'), H('2')],
        indexJobManifestIds: [],
        now: NOW,
        graceMs: GRACE,
        dryRun: true,
      });
      expect(report).toMatchObject({ status: 'planned', unreachable: [H('2')], quarantined: [] });
      expect(await deps.quarantine.list()).toEqual([]);
    } finally {
      await rm(deps.dir, { recursive: true, force: true });
    }
  });

  it('quarantines only unreachable candidates when not a dry run', async () => {
    const deps = await scenario();
    try {
      const report = await runGcCycle(deps, {
        candidates: [H('1'), H('2'), H('3')],
        indexJobManifestIds: [],
        now: NOW,
        graceMs: GRACE,
        dryRun: false,
      });
      expect(report).toMatchObject({ status: 'planned', unreachable: [H('2'), H('3')], quarantined: [H('2'), H('3')] });
      expect((await deps.quarantine.list()).map((entry) => entry.hash)).toEqual([H('2'), H('3')]);
      expect(report.reachable).toEqual([H('1')]);
    } finally {
      await rm(deps.dir, { recursive: true, force: true });
    }
  });

  it('propagates a refused plan and quarantines nothing when no roots exist', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gc-cycle-'));
    try {
      const deps = {
        refs: new CanonicalRefStore(dir),
        manifests: new CanonicalManifestStore(dir),
        pins: new RevisionPinRegistry(dir),
        overlays: new GoalOverlayStore(dir),
        quarantine: new ArtifactQuarantineStore(dir),
      };
      const report = await runGcCycle(deps, {
        candidates: [H('1')],
        indexJobManifestIds: [],
        now: NOW,
        graceMs: GRACE,
        dryRun: false,
      });
      expect(report.status).toBe('refused');
      expect(await deps.quarantine.list()).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not re-quarantine a hash already under quarantine', async () => {
    const deps = await scenario();
    try {
      const input = {
        candidates: [H('2')],
        indexJobManifestIds: [],
        now: NOW,
        graceMs: GRACE,
        dryRun: false,
      };
      await runGcCycle(deps, input);
      const before = (await deps.quarantine.list())[0];
      const second = await runGcCycle(deps, { ...input, now: new Date(NOW.getTime() + 1000) });
      expect(second.quarantined).toEqual([H('2')]);
      expect((await deps.quarantine.list())[0]).toEqual(before);
    } finally {
      await rm(deps.dir, { recursive: true, force: true });
    }
  });
});
