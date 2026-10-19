import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalManifestId, canonicalRevisionId, computeTreeOid, fileArtifactId } from '@unified-mpc/domain';
import { CanonicalRefStore } from './canonical-ref-store.js';
import { CanonicalManifestStore, type StoredManifest } from './canonical-manifest-store.js';
import { CanonicalArtifactStore, type StoredFileArtifact } from './canonical-artifact-store.js';
import { GoalOverlayStore } from './goal-overlay-store.js';
import { RevisionPinRegistry } from './revision-pin-registry.js';
import { ArtifactQuarantineStore } from './artifact-quarantine.js';
import { runGcCycle, type GcCycleStores } from './gc-cycle.js';
import { GcLeaseStore } from './gc-lease.js';

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

describe('GC cycle under the cleanup lease (#210 U30)', () => {
  it('refuses to quarantine while another owner holds the lease', async () => {
    const deps = await scenario();
    try {
      const lease = new GcLeaseStore(deps.dir);
      await lease.acquire({ ownerId: 'other_gc', now: NOW, ttlMs: GRACE * 10 });
      const report = await runGcCycle(deps, {
        candidates: [H('1'), H('2')],
        indexJobManifestIds: [],
        now: NOW, graceMs: GRACE, dryRun: false,
        lease: { store: lease, ownerId: 'gc_me', ttlMs: GRACE },
      });
      expect(report).toMatchObject({ status: 'refused' });
      if (report.status !== 'refused') throw new Error('unexpected');
      expect(report.reason).toMatch(/other_gc/);
      expect(await deps.quarantine.list()).toEqual([]);
    } finally {
      await rm(deps.dir, { recursive: true, force: true });
    }
  });

  it('quarantines under a granted lease and releases it afterwards', async () => {
    const deps = await scenario();
    try {
      const lease = new GcLeaseStore(deps.dir);
      const report = await runGcCycle(deps, {
        candidates: [H('1'), H('2')],
        indexJobManifestIds: [],
        now: NOW, graceMs: GRACE, dryRun: false,
        lease: { store: lease, ownerId: 'gc_me', ttlMs: GRACE },
      });
      expect(report).toMatchObject({ status: 'planned', quarantined: [H('2')] });
      expect((await deps.quarantine.list()).map((entry) => entry.hash)).toEqual([H('2')]);
      expect(await lease.read()).toBeNull();
    } finally {
      await rm(deps.dir, { recursive: true, force: true });
    }
  });

  it('releases the lease even when the plan is refused', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gc-cycle-lease-'));
    try {
      const lease = new GcLeaseStore(dir);
      const report = await runGcCycle({
        refs: new CanonicalRefStore(dir),
        manifests: new CanonicalManifestStore(dir),
        pins: new RevisionPinRegistry(dir),
        overlays: new GoalOverlayStore(dir),
        quarantine: new ArtifactQuarantineStore(dir),
      }, {
        candidates: [H('1')],
        indexJobManifestIds: [],
        now: NOW, graceMs: GRACE, dryRun: false,
        lease: { store: lease, ownerId: 'gc_me', ttlMs: GRACE },
      });
      expect(report).toMatchObject({ status: 'refused' });
      expect(await lease.read()).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('leaves a dry run unfenced', async () => {
    const deps = await scenario();
    try {
      const lease = new GcLeaseStore(deps.dir);
      await lease.acquire({ ownerId: 'other_gc', now: NOW, ttlMs: GRACE * 10 });
      const report = await runGcCycle(deps, {
        candidates: [H('1'), H('2')],
        indexJobManifestIds: [],
        now: NOW, graceMs: GRACE, dryRun: true,
        lease: { store: lease, ownerId: 'gc_me', ttlMs: GRACE },
      });
      expect(report).toMatchObject({ status: 'planned', quarantined: [], unreachable: [H('2')] });
      expect((await lease.read())?.ownerId).toBe('other_gc');
    } finally {
      await rm(deps.dir, { recursive: true, force: true });
    }
  });

  it('refuses an unreadable fence without quarantining', async () => {
    const deps = await scenario();
    try {
      const lease = new GcLeaseStore(deps.dir);
      await lease.acquire({ ownerId: 'other_gc', now: NOW, ttlMs: GRACE * 10 });
      await writeFile(path.join(deps.dir, 'gc', 'lease.json'), '{ broken', 'utf8');
      const report = await runGcCycle(deps, {
        candidates: [H('1'), H('2')],
        indexJobManifestIds: [],
        now: NOW, graceMs: GRACE, dryRun: false,
        lease: { store: lease, ownerId: 'gc_me', ttlMs: GRACE },
      });
      expect(report).toMatchObject({ status: 'refused' });
      if (report.status !== 'refused') throw new Error('unexpected');
      expect(report.reason).toMatch(/unreadable|fence/i);
      expect(await deps.quarantine.list()).toEqual([]);
    } finally {
      await rm(deps.dir, { recursive: true, force: true });
    }
  });
});

/** Artifact-key candidate for a pass; a bare key is not enough to resolve a record. */
function fileArtifact(repositoryId: string, contentHash: string, manifestIds: readonly string[]): StoredFileArtifact {
  const artifactKey = fileArtifactId({
    sourceContentSha256: contentHash,
    language: 'typescript',
    sourceKind: 'source',
    representationVersion: 'v1',
  });
  return {
    kind: 'file',
    artifactKey,
    repositoryId,
    sourceContentSha256: contentHash,
    language: 'typescript',
    sourceKind: 'source',
    representationVersion: 'v1',
    bindings: manifestIds.map((manifestId, index) => ({ path: `src/${index}.ts`, manifestId })),
    createdAt: '2026-10-17T00:00:00.000Z',
  };
}

interface ArtifactScenario extends GcCycleStores {
  readonly dir: string;
  readonly artifacts: CanonicalArtifactStore;
  readonly live: StoredFileArtifact;
  readonly retired: StoredFileArtifact;
  readonly unbound: StoredFileArtifact;
  readonly retiredManifest: StoredManifest;
}

async function artifactScenario(): Promise<ArtifactScenario> {
  const deps = await scenario();
  const artifacts = new CanonicalArtifactStore(deps.dir);
  const [activeRef] = await deps.refs.list();
  const retiredManifest = manifestFor('f'.repeat(40), [{ path: 'old.ts', contentHash: H('9') }]);
  await deps.manifests.put(retiredManifest);
  const live = fileArtifact(REPO, 'a'.repeat(64), [activeRef.state.manifestId]);
  const retired = fileArtifact(REPO, 'b'.repeat(64), [retiredManifest.manifestId]);
  const unbound = fileArtifact(REPO, 'c'.repeat(64), []);
  for (const artifact of [live, retired, unbound]) await artifacts.put(artifact);
  return { ...deps, artifacts, live, retired, unbound, retiredManifest };
}

const byArtifactKey = (a: { artifactKey: string }, b: { artifactKey: string }): number => a.artifactKey.localeCompare(b.artifactKey);

describe('GC cycle artifact-key quarantine (#210 §1/§7)', () => {
  const candidatesOf = (scenarioValue: ArtifactScenario): { repositoryId: string; artifactKey: string }[] =>
    [scenarioValue.live, scenarioValue.retired, scenarioValue.unbound]
      .map((artifact) => ({ repositoryId: artifact.repositoryId, artifactKey: artifact.artifactKey }));

  it('quarantines only artifact keys unreachable from retained manifests, under the lease', async () => {
    const deps = await artifactScenario();
    try {
      const lease = new GcLeaseStore(deps.dir);
      const report = await runGcCycle(deps, {
        candidates: [],
        artifactCandidates: candidatesOf(deps),
        indexJobManifestIds: [],
        now: NOW, graceMs: GRACE, dryRun: false,
        lease: { store: lease, ownerId: 'gc_me', ttlMs: GRACE },
      });
      expect(report).toMatchObject({ status: 'planned', quarantined: [] });
      if (report.status !== 'planned') throw new Error('unexpected');
      expect([...report.quarantinedArtifacts].sort(byArtifactKey)).toEqual(
        [deps.retired, deps.unbound]
          .map((artifact) => ({ repositoryId: REPO, artifactKey: artifact.artifactKey }))
          .sort(byArtifactKey),
      );
      expect((await deps.quarantine.list())
        .map((entry) => (entry.kind === 'artifact-key' ? { repositoryId: entry.repositoryId, artifactKey: entry.artifactKey } : null))
        .sort(byArtifactKey)).toEqual(
        [deps.retired, deps.unbound]
          .map((artifact) => ({ repositoryId: REPO, artifactKey: artifact.artifactKey }))
          .sort(byArtifactKey),
      );
      expect(await lease.read()).toBeNull();
    } finally {
      await rm(deps.dir, { recursive: true, force: true });
    }
  });

  it('keeps an artifact alive while its manifest is still pinned', async () => {
    const deps = await artifactScenario();
    try {
      await deps.pins.pin(deps.retiredManifest.manifestId, 'user-pin', 'hold LKG');
      const report = await runGcCycle(deps, {
        candidates: [],
        artifactCandidates: candidatesOf(deps),
        indexJobManifestIds: [],
        now: NOW, graceMs: GRACE, dryRun: false,
      });
      expect(report).toMatchObject({
        status: 'planned',
        quarantinedArtifacts: [{ repositoryId: REPO, artifactKey: deps.unbound.artifactKey }],
      });
    } finally {
      await rm(deps.dir, { recursive: true, force: true });
    }
  });

  it('refuses artifact candidates when no artifact store is wired', async () => {
    const deps = await scenario();
    try {
      const report = await runGcCycle(deps, {
        candidates: [],
        artifactCandidates: [{ repositoryId: REPO, artifactKey: `file:v1:${H('a')}` }],
        indexJobManifestIds: [],
        now: NOW, graceMs: GRACE, dryRun: false,
      });
      expect(report).toMatchObject({ status: 'refused' });
      if (report.status !== 'refused') throw new Error('unexpected');
      expect(report.reason).toMatch(/artifact store/i);
      expect(await deps.quarantine.list()).toEqual([]);
    } finally {
      await rm(deps.dir, { recursive: true, force: true });
    }
  });

  it('reports artifact candidates in a dry run without quarantining them', async () => {
    const deps = await artifactScenario();
    try {
      const report = await runGcCycle(deps, {
        candidates: [],
        artifactCandidates: candidatesOf(deps),
        indexJobManifestIds: [],
        now: NOW, graceMs: GRACE, dryRun: true,
      });
      expect(report).toMatchObject({ status: 'planned', quarantinedArtifacts: [] });
      expect(await deps.quarantine.list()).toEqual([]);
    } finally {
      await rm(deps.dir, { recursive: true, force: true });
    }
  });
});
