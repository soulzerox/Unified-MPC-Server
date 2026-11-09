import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { appError, canonicalManifestId, err, type GoalRecord, type WorkspaceAdmissionReceipt } from '@unified-mpc/domain';
import { GoalWorkspaceTruthReader } from '@unified-mpc/application';
import { IdeSyncService, POLICY_BLOCK_END, POLICY_BLOCK_START } from '@unified-mpc/extensions';
import { CURRENT_SCHEMA_MIGRATION_ID } from '@unified-mpc/storage';
import { CanonicalManifestStore, CanonicalRefStore, ArtifactQuarantineStore, IndexJobLedger, ProviderGenerationLedger } from '@unified-mpc/workspace';
import { ControlPlaneServer } from '@unified-mpc/web';
import { describe, expect, it, vi } from 'vitest';
import {
  createCanonicalLifecycleProbe,
  createCanonicalStatusProbe,
  createGoalControl,
  createWebGoalRuntimeProjection,
  createWorkspaceControl,
  resolveCanonicalLifecycleLimit,
  resolveCanonicalStatusLimit,
  runWeb,
  parseWebArgs,
} from './web.js';

describe('web CLI command', () => {
  describe('parseWebArgs', () => {
    it('parses empty args with loopback web port', () => {
      const parsed = parseWebArgs([]);
      expect(parsed).toEqual({
        ok: true,
        value: {
          kind: 'web',
          port: 3000,
        },
      });
    });

    it('parses custom port and rejects custom host', () => {
      const parsed = parseWebArgs(['--port', '19000']);
      expect(parsed).toEqual({
        ok: true,
        value: {
          kind: 'web',
          port: 19000,
        },
      });
      expect(parseWebArgs(['--host', '0.0.0.0'])).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });
  });

  describe('canonical status probe', () => {
    it('projects the canonical store rooted at the data path', async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'web-canonical-status-'));
      try {
        const entries = [{ path: 'a.ts', contentHash: '1'.repeat(64) }];
        const revisionId = 'rev:v1:' + 'a'.repeat(64);
        await new CanonicalManifestStore(path.join(root, 'canonical')).put({
          manifestId: canonicalManifestId({ repositoryId: 'repo_abc123', revisionId, entries }),
          repositoryId: 'repo_abc123',
          revisionId,
          commitSha: 'c'.repeat(40),
          treeOid: 'd'.repeat(40),
          targetRef: 'refs/remotes/origin/main',
          entries,
          createdAt: '2026-11-01T00:00:00.000Z',
        });
        const report = await createCanonicalStatusProbe(root)();
        expect(report).toMatchObject({
          status: 'healthy',
          manifestCount: 1,
          pinCount: 0,
          refCount: 0,
          overlayCount: 0,
          activeJobCount: 0,
          danglingRefCount: 0,
          missingOverlayBaseCount: 0,
          orphanedPinCount: 0,
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('resolves the requested window to a bounded integer', () => {
      // Omitted, non-finite and non-numeric input all fall back to the default.
      expect(resolveCanonicalStatusLimit(undefined)).toBe(50);
      expect(resolveCanonicalStatusLimit(Number.NaN)).toBe(50);
      expect(resolveCanonicalStatusLimit(Number.POSITIVE_INFINITY)).toBe(50);
      // The window is clamped to at least one row and at most the route cap.
      expect(resolveCanonicalStatusLimit(0)).toBe(1);
      expect(resolveCanonicalStatusLimit(-5)).toBe(1);
      expect(resolveCanonicalStatusLimit(2)).toBe(2);
      expect(resolveCanonicalStatusLimit(12.9)).toBe(12);
      expect(resolveCanonicalStatusLimit(200)).toBe(200);
      expect(resolveCanonicalStatusLimit(201)).toBe(200);
      expect(resolveCanonicalStatusLimit(10_000)).toBe(200);
    });

    it('bounds the probe rows and keeps the full-store counts', async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'web-canonical-status-'));
      try {
        const canonicalRoot = path.join(root, 'canonical');
        const manifests = new CanonicalManifestStore(canonicalRoot);
        const refs = new CanonicalRefStore(canonicalRoot);
        const entries = [{ path: 'a.ts', contentHash: '1'.repeat(64) }];
        const revisionId = 'rev:v1:' + 'a'.repeat(64);
        const manifestId = canonicalManifestId({ repositoryId: 'repo_abc123', revisionId, entries });
        await manifests.put({
          manifestId,
          repositoryId: 'repo_abc123',
          revisionId,
          commitSha: 'c'.repeat(40),
          treeOid: 'd'.repeat(40),
          targetRef: 'refs/remotes/origin/main',
          entries,
          createdAt: '2026-11-01T00:00:00.000Z',
        });
        for (const ref of ['refs/remotes/origin/main', 'refs/remotes/origin/next']) {
          await refs.promote(ref, {
            expectedCurrent: null,
            current: null,
            target: { commitSha: 'c'.repeat(40), treeOid: 'd'.repeat(40), manifestId },
            targetVerified: true,
          });
        }
        const jobs = new IndexJobLedger(canonicalRoot);
        await jobs.open('op_1', manifestId, new Date('2026-11-01T00:00:00.000Z'));
        await jobs.open('op_2', manifestId, new Date('2026-11-02T00:00:00.000Z'));

        // The probe must apply the shared bound itself: the route already
        // forwards a window, but no store may widen the card past it.
        const bounded = await createCanonicalStatusProbe(root)({ limit: 1 });
        expect(bounded).toMatchObject({ refCount: 2, activeJobCount: 2, manifestCount: 1 });
        const boundedRows = bounded as { refs: readonly unknown[]; jobs: readonly unknown[] };
        expect(boundedRows.refs).toHaveLength(1);
        expect(boundedRows.jobs).toHaveLength(1);

        // An omitted window resolves to the advertised default, which still
        // carries every row of this store.
        const defaulted = await createCanonicalStatusProbe(root)();
        const defaultedRows = defaulted as { refs: readonly unknown[]; jobs: readonly unknown[] };
        expect(defaultedRows.refs).toHaveLength(2);
        expect(defaultedRows.jobs).toHaveLength(2);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  describe('canonical lifecycle probe', () => {
    it('resolves the requested limit to a bounded integer', () => {
      // Omitted, non-finite and non-numeric input all fall back to the default.
      expect(resolveCanonicalLifecycleLimit(undefined)).toBe(50);
      expect(resolveCanonicalLifecycleLimit(Number.NaN)).toBe(50);
      expect(resolveCanonicalLifecycleLimit(Number.POSITIVE_INFINITY)).toBe(50);
      // The window is clamped to at least one row and at most the route cap.
      expect(resolveCanonicalLifecycleLimit(0)).toBe(1);
      expect(resolveCanonicalLifecycleLimit(-5)).toBe(1);
      expect(resolveCanonicalLifecycleLimit(2)).toBe(2);
      expect(resolveCanonicalLifecycleLimit(12.9)).toBe(12);
      expect(resolveCanonicalLifecycleLimit(200)).toBe(200);
      expect(resolveCanonicalLifecycleLimit(201)).toBe(200);
      expect(resolveCanonicalLifecycleLimit(10_000)).toBe(200);
    });

    it('projects revision history and GC status from the canonical store rooted at the data path', async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'web-canonical-lifecycle-'));
      try {
        const entries = [{ path: 'a.ts', contentHash: '1'.repeat(64) }];
        const revisionId = 'rev:v1:' + 'a'.repeat(64);
        const manifestId = canonicalManifestId({ repositoryId: 'repo_abc123', revisionId, entries });
        const canonicalRoot = path.join(root, 'canonical');
        await new CanonicalManifestStore(canonicalRoot).put({
          manifestId,
          repositoryId: 'repo_abc123',
          revisionId,
          commitSha: 'c'.repeat(40),
          treeOid: 'd'.repeat(40),
          targetRef: 'refs/remotes/origin/main',
          entries,
          createdAt: '2026-11-01T00:00:00.000Z',
        });
        const artifactKey = 'file:v1:' + 'e'.repeat(64);
        await new ArtifactQuarantineStore(canonicalRoot).quarantine(
          [{ kind: 'artifact-key', repositoryId: 'repo_abc123', artifactKey }],
          { now: new Date('2026-11-02T00:00:00.000Z'), graceMs: 1_000 },
        );

        const snapshot = await createCanonicalLifecycleProbe(root)();

        expect(snapshot.revisions).toMatchObject({
          total: 1,
          revisions: [{
            manifestId,
            entryCount: 1,
            refs: [],
            overlayGoalIds: [],
            indexJobOperationIds: [],
          }],
        });
        expect(snapshot.gc).toMatchObject({
          status: 'healthy',
          lease: { status: 'free' },
          quarantine: {
            total: 1,
            returned: 1,
            rows: [{
              target: { kind: 'artifact-key', repositoryId: 'repo_abc123', artifactKey },
              graceMs: 1_000,
              due: true,
            }],
          },
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('bounds revisions and quarantine rows while keeping the full counts', async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'web-canonical-lifecycle-'));
      try {
        const canonicalRoot = path.join(root, 'canonical');
        const manifests = new CanonicalManifestStore(canonicalRoot);
        const keys: string[] = [];
        const seeds: ReadonlyArray<readonly [string, string]> = [
          ['a', '2026-11-01T00:00:00.000Z'],
          ['b', '2026-11-02T00:00:00.000Z'],
          ['c', '2026-11-03T00:00:00.000Z'],
        ];
        for (const [seed, createdAt] of seeds) {
          const entries = [{ path: `${seed}.ts`, contentHash: seed.repeat(64) }];
          const revisionId = 'rev:v1:' + seed.repeat(64);
          await manifests.put({
            manifestId: canonicalManifestId({ repositoryId: 'repo_abc123', revisionId, entries }),
            repositoryId: 'repo_abc123',
            revisionId,
            commitSha: seed.repeat(40),
            treeOid: seed.repeat(40),
            targetRef: 'refs/remotes/origin/main',
            entries,
            createdAt,
          });
          keys.push('file:v1:' + seed.repeat(64));
        }
        await new ArtifactQuarantineStore(canonicalRoot).quarantine(
          keys.map((artifactKey) => ({ kind: 'artifact-key' as const, repositoryId: 'repo_abc123', artifactKey })),
          { now: new Date('2026-11-04T00:00:00.000Z'), graceMs: 1_000 },
        );

        const snapshot = await createCanonicalLifecycleProbe(root)({ limit: 2 });
        const revisions = snapshot.revisions as { total: number; revisions: readonly unknown[] };
        const gc = snapshot.gc as { quarantine: { total: number; returned: number; rows: readonly unknown[] } };

        expect(revisions.total).toBe(3);
        expect(revisions.revisions).toHaveLength(2);
        expect(gc.quarantine.total).toBe(3);
        expect(gc.quarantine.returned).toBe(2);
        expect(gc.quarantine.rows).toHaveLength(2);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  describe('goal control', () => {
    it('summarizes open goals and persists a preferred continuation goal without acquiring its lease', async () => {
      const goal = {
        id: 'goal-a',
        goalKey: 'project-goals',
        workspaceId: 'workspace-a',
        ownerClientId: 'client-a',
        objective: 'Expose open goals in the Projects view.',
        plan: {
          steps: [
            { id: 'inspect', title: 'Inspect', status: 'completed' },
            { id: 'frontend', title: 'Build UI', status: 'in_progress' },
          ],
        },
        status: 'active',
        revision: 2,
        currentPhase: 'frontend',
        nextAction: 'Finish the UI.',
        blockers: ['Need browser verification'],
        activeTaskIds: [],
        leaseGeneration: 3,
        leaseActivitySeq: 0,
        createdAt: '2026-09-16T00:00:00.000Z',
        updatedAt: '2026-09-16T01:00:00.000Z',
        checkpoints: [],
      } as GoalRecord;
      const values = new Map<string, string>();
      const settings = {
        get: (key: string): string | null => values.get(key) ?? null,
        set: (key: string, value: string): void => { values.set(key, value); },
      };
      const repository = {
        countWorkspaceGoalsForHost: async (workspaceId: string): Promise<number> => workspaceId === 'workspace-a' ? 1 : 0,
        listWorkspaceGoalsForHost: async (): Promise<readonly GoalRecord[]> => [goal],
        getById: async (goalId: string): Promise<GoalRecord | null> => goalId === goal.id ? goal : null,
      };
      const control = createGoalControl(repository as never, settings as never);

      expect(await control.countOpen('workspace-a')).toBe(1);
      expect(await control.preferred('workspace-a')).toBeNull();
      expect(await control.listOpen('workspace-a')).toEqual([expect.objectContaining({
        goalId: 'goal-a',
        objective: goal.objective,
        progress: { completed: 1, total: 2 },
        blockers: goal.blockers,
      })]);

      expect(await control.continue('workspace-a', 'goal-a')).toMatchObject({ goalId: 'goal-a', currentPhase: 'frontend' });
      expect(await control.preferred('workspace-a')).toBe('goal-a');
      expect([...values.values()].join('\n')).toContain('goal-a');
    });
  });

  describe('workspace control', () => {
    it('releases the provider generation ledger row when a workspace registration is removed', async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'web-workspace-remove-'));
      try {
        const canonicalRoot = path.join(root, 'canonical');
        const ledger = new ProviderGenerationLedger(canonicalRoot);
        const workspace = {
          id: '11111111-1111-4111-8111-111111111111',
          displayName: 'Project',
          rootPath: path.join(root, 'project'),
          realRootPath: path.join(root, 'project'),
          createdAt: '2026-11-09T00:00:00.000Z',
        };
        await ledger.record({
          workspaceId: workspace.id,
          generationId: 'generation-1',
          manifestId: `man:v1:${'a'.repeat(64)}`,
          repositoryId: 'repo_abc123',
        });

        let registered = true;
        let restored = false;
        const control = createWorkspaceControl(
          {
            get: async (id: string) => (registered && id === workspace.id ? workspace : null),
            restore: async () => { restored = true; },
          } as never,
          {
            list: async () => (registered ? [workspace] : []),
            unregister: async () => {
              registered = false;
              return { ok: true, value: undefined };
            },
          } as never,
          {} as never,
          { forgetWorkspace: async () => undefined },
          { getGoalRuntimeSnapshot: async () => null },
          ledger,
        );

        await expect(control.remove(workspace.id)).resolves.toBeNull();
        expect(restored).toBe(false);
        // Without the release a live-provider pin would outlive the registration
        // and keep the manifest unprunable indefinitely.
        await expect(ledger.get(workspace.id)).resolves.toBeNull();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('restores the registration when the provider generation row cannot be released', async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'web-workspace-release-fail-'));
      try {
        const workspace = {
          id: '22222222-2222-4222-8222-222222222222',
          displayName: 'Project',
          rootPath: path.join(root, 'project'),
          realRootPath: path.join(root, 'project'),
          createdAt: '2026-11-09T00:00:00.000Z',
        };
        let registered = true;
        let restored = false;
        const control = createWorkspaceControl(
          {
            get: async (id: string) => (registered && id === workspace.id ? workspace : null),
            restore: async () => { restored = true; },
          } as never,
          {
            list: async () => (registered ? [workspace] : []),
            unregister: async () => {
              registered = false;
              return { ok: true, value: undefined };
            },
          } as never,
          {} as never,
          { forgetWorkspace: async () => undefined },
          { getGoalRuntimeSnapshot: async () => null },
          { release: async () => { throw new Error('ledger is read-only'); } },
        );

        await expect(control.remove(workspace.id)).rejects.toThrow('ledger is read-only');
        expect(restored).toBe(true);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  describe('runWeb', () => {
    it('projects persisted runtime as last-admitted when standalone Web has no serving-runtime proof', async () => {
      const root = await mkdtemp(path.join(process.cwd(), '.web-admission-'));
      try {
        await writeFile(path.join(root, 'source.ts'), 'web snapshot source');
        const workspaceId = '11111111-1111-4111-8111-111111111111';
        const createdAt = '2026-09-22T00:00:00.000Z';
        const baseRevision = 'snapshot-base-1';
        const workspace = {
          id: workspaceId,
          displayName: 'Web snapshot',
          rootPath: root,
          realRootPath: root,
          createdAt,
          lifecycleKind: 'goal',
          goalWorkspaceKind: 'snapshot',
          goalId: 'goal-web',
          parentWorkspaceId: 'project-web',
          baseRevision,
          writerLease: { leaseId: 'lease-web', ownerId: 'owner-web', generation: 3, expiresAt: '2099-01-01T00:00:00.000Z' },
        };
        let receipt: WorkspaceAdmissionReceipt | null = null;
        const workspaceRepository = {
          get: async (id: string): Promise<typeof workspace | null> => id === workspaceId ? workspace : null,
          getAdmissionReceipt: async (): Promise<WorkspaceAdmissionReceipt | null> => receipt,
          compareAndSwapAdmissionReceipt: async (): Promise<boolean> => { throw new Error('Web projection must not write admission'); },
        };
        const truth = new GoalWorkspaceTruthReader(workspaceRepository as never, {} as never);
        const observed = await truth.readAdmission(workspaceId);
        const generation = `${createdAt}:${baseRevision}`;
        const runtime = {
          runtimeDeploymentId: 'web-deployment',
          runtimeGeneration: 'web-runtime-generation',
          runtimeBuildVersion: '4.61.0+0123456789ab',
          runtimeBuildCommit: '0123456789abcdef0123456789abcdef01234567',
          runtimeBuildDirty: false,
          runtimeProtocolGeneration: 1,
          runtimeStartedAt: '2026-09-27T00:00:00.000Z',
        };
        receipt = {
          admissionId: 'web-admission',
          projectId: 'project-web',
          workspaceId,
          goalId: 'goal-web',
          workspaceKind: 'non_git',
          worktreeIdentity: generation,
          expectedWorkspaceHead: generation,
          observedWorkspaceHead: generation,
          dirtyState: 'clean',
          dirtyFingerprint: observed.sourceContentFingerprint!,
          writeLeaseGeneration: 3,
          ...runtime,
          workflowVersion: 1,
          admissionGeneration: 2,
          createdAt,
        };
        const projection = createWebGoalRuntimeProjection(
          {} as never,
          {} as never,
          {} as never,
          workspaceRepository as never,
        );
        await expect(projection.readWorkspaceAdmissionProjection(workspaceId)).resolves.toMatchObject({
          runtime: { source: 'last_admitted', generation: 'web-runtime-generation' },
          workspace: { kind: 'non_git' },
          admission: {
            status: 'RECOVERY_REQUIRED',
            blocker: 'runtime_provenance_missing',
            remediation: 'recover_workspace',
          },
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('reports canonical storage identity and credential presence without secret values', async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'web-storage-diagnostics-'));
      const previousDataPath = process.env.UNIFIED_MPC_DATA_PATH;
      const previousPublicUrl = process.env.UNIFIED_MPC_CLOUDFLARE_PUBLIC_URL;
      const previousHome = process.env.HOME;
      const previousXdgDataHome = process.env.XDG_DATA_HOME;
      process.env.UNIFIED_MPC_DATA_PATH = root;
      process.env.HOME = root;
      process.env.XDG_DATA_HOME = path.join(root, 'xdg');
      process.env.UNIFIED_MPC_CLOUDFLARE_PUBLIC_URL = 'https://storage.example.test';
      const secretValues = new Map<string, string>([
        ['cloudflare_api_token', 'super-secret-api-token'],
        ['cloudflare_tunnel_token', 'super-secret-tunnel-token'],
      ]);
      const secretStore = {
        describe: (): { provider: string; service: string } => ({
          provider: 'linux-secret-service',
          service: 'fixture-unified-mpc',
        }),
        get: async (key: string): Promise<string | null> => secretValues.get(key) ?? null,
        set: async (key: string, value: string): Promise<void> => { secretValues.set(key, value); },
        delete: async (key: string): Promise<void> => { secretValues.delete(key); },
      };

      try {
        const result = await runWeb({ port: 0 }, {
          goalRuntimeRead: {} as never,
          secretStore: secretStore as never,
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        try {
          const response = await fetch(`${result.value.url}/api/storage-diagnostics`);
          expect(response.status).toBe(200);
          const text = await response.text();
          expect(text).not.toContain('super-secret-api-token');
          expect(text).not.toContain('super-secret-tunnel-token');
          expect(JSON.parse(text)).toMatchObject({
            available: true,
            scope: 'control-plane-storage',
            diagnostics: {
              dataRoot: root,
              sqlite: {
                path: path.join(root, 'unified-mpc.sqlite'),
                exists: true,
                schemaVersion: CURRENT_SCHEMA_MIGRATION_ID,
                settingsRowCount: expect.any(Number),
                keyPresence: {
                  cloudflare_public_url: true,
                  cloudflare_tunnel_token_configured: false,
                  cloudflare_api_token_configured: false,
                },
              },
              secretService: {
                provider: 'linux-secret-service',
                service: 'fixture-unified-mpc',
                available: true,
                secretPresence: {
                  cloudflare_tunnel_token: true,
                  cloudflare_api_token: true,
                },
              },
            },
          });
        } finally {
          await result.value.handle.close();
        }
      } finally {
        if (previousDataPath === undefined) delete process.env.UNIFIED_MPC_DATA_PATH;
        else process.env.UNIFIED_MPC_DATA_PATH = previousDataPath;
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = previousXdgDataHome;
        if (previousPublicUrl === undefined) delete process.env.UNIFIED_MPC_CLOUDFLARE_PUBLIC_URL;
        else process.env.UNIFIED_MPC_CLOUDFLARE_PUBLIC_URL = previousPublicUrl;
        await rm(root, { recursive: true, force: true });
      }
    });

    it('keeps successful secret presence truth when another Secret Service lookup fails', async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'web-storage-diagnostics-partial-'));
      const previousDataPath = process.env.UNIFIED_MPC_DATA_PATH;
      const previousHome = process.env.HOME;
      const previousXdgDataHome = process.env.XDG_DATA_HOME;
      process.env.UNIFIED_MPC_DATA_PATH = root;
      process.env.HOME = root;
      process.env.XDG_DATA_HOME = path.join(root, 'xdg');
      const secretStore = {
        describe: (): { provider: string; service: string } => ({
          provider: 'linux-secret-service',
          service: 'fixture-unified-mpc',
        }),
        get: async (key: string): Promise<string | null> => {
          if (key === 'cloudflare_api_token') throw new Error('fixture lookup failure');
          return key === 'cloudflare_tunnel_token' ? 'not-returned-secret' : null;
        },
        set: async (): Promise<void> => {},
        delete: async (): Promise<void> => {},
      };

      try {
        const result = await runWeb({ port: 0 }, {
          goalRuntimeRead: {} as never,
          secretStore: secretStore as never,
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        try {
          const response = await fetch(`${result.value.url}/api/storage-diagnostics`);
          expect(response.status).toBe(200);
          const text = await response.text();
          expect(text).not.toContain('not-returned-secret');
          expect(JSON.parse(text)).toMatchObject({
            diagnostics: {
              secretService: {
                available: false,
                error: 'lookup_failed',
                secretPresence: {
                  cloudflare_tunnel_token: true,
                  cloudflare_api_token: null,
                },
              },
            },
          });
        } finally {
          await result.value.handle.close();
        }
      } finally {
        if (previousDataPath === undefined) delete process.env.UNIFIED_MPC_DATA_PATH;
        else process.env.UNIFIED_MPC_DATA_PATH = previousDataPath;
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = previousXdgDataHome;
        await rm(root, { recursive: true, force: true });
      }
    });

    it('fails visibly before creating a fresh canonical DB when a historical HOME DB contains gateway settings', async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'web-storage-drift-'));
      const canonical = path.join(root, 'canonical');
      const home = path.join(root, 'home');
      const historicalRoot = path.join(home, '.local', 'share', 'unified-mpc');
      await mkdir(historicalRoot, { recursive: true });
      const historicalPath = path.join(historicalRoot, 'unified-mpc.sqlite');
      const historical = new DatabaseSync(historicalPath);
      try {
        historical.exec('CREATE TABLE settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);');
        historical.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
          'cloudflare_public_url',
          'https://historical.example.test',
        );
      } finally {
        historical.close();
      }

      const previousDataPath = process.env.UNIFIED_MPC_DATA_PATH;
      const previousHome = process.env.HOME;
      const previousXdgDataHome = process.env.XDG_DATA_HOME;
      process.env.UNIFIED_MPC_DATA_PATH = canonical;
      process.env.HOME = home;
      process.env.XDG_DATA_HOME = path.join(root, 'xdg');

      try {
        const result = await runWeb({ port: 0 }, { goalRuntimeRead: {} as never });
        expect(result.ok).toBe(false);
        if (result.ok) {
          await result.value.handle.close();
          return;
        }
        expect(result.error.message).toContain('STORAGE_IDENTITY_DRIFT:');
        expect(result.error.message).toContain(historicalPath);
        expect(existsSync(path.join(canonical, 'unified-mpc.sqlite'))).toBe(false);
      } finally {
        if (previousDataPath === undefined) delete process.env.UNIFIED_MPC_DATA_PATH;
        else process.env.UNIFIED_MPC_DATA_PATH = previousDataPath;
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = previousXdgDataHome;
        await rm(root, { recursive: true, force: true });
      }
    });

    it('repairs managed policy artifacts before listening only when the opt-in flag is set', async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'web-policy-repair-'));
      const workspaceRoot = path.join(root, 'workspace');
      const home = path.join(root, 'home');
      await mkdir(workspaceRoot, { recursive: true });
      await mkdir(home, { recursive: true });
      const previousDataPath = process.env.UNIFIED_MPC_DATA_PATH;
      const previousHome = process.env.HOME;
      const previousXdgDataHome = process.env.XDG_DATA_HOME;
      const previousCodexHome = process.env.CODEX_HOME;
      process.env.UNIFIED_MPC_DATA_PATH = path.join(root, 'data');
      process.env.HOME = home;
      process.env.XDG_DATA_HOME = path.join(root, 'xdg');
      // `resolveCodexHome` reads CODEX_HOME before HOME, so leaving it set
      // would point the codex-global target at the developer's real file.
      delete process.env.CODEX_HOME;
      const agentsFile = path.join(workspaceRoot, 'AGENTS.md');
      const claudeGlobal = path.join(home, '.claude', 'CLAUDE.md');
      const staleBlock = `${POLICY_BLOCK_START}\n| P1 | child:memory | memory | server | REALTIME | ✅ YES |\n${POLICY_BLOCK_END}\n`;
      await writeFile(agentsFile, `# Project notes\n\nKeep me.\n\n${staleBlock}`, 'utf8');
      await mkdir(path.dirname(claudeGlobal), { recursive: true });
      await writeFile(claudeGlobal, `# Global notes\n\nKeep me too.\n\n${staleBlock}`, 'utf8');

      try {
        // Observe the artifacts exactly when `listen()` is entered: a repair
        // that moved after the server started would snapshot the stale file
        // even though every assertion below still held.
        const listenEntrySnapshots: string[] = [];
        const originalListen = ControlPlaneServer.prototype.listen;
        const listenSpy = vi.spyOn(ControlPlaneServer.prototype, 'listen').mockImplementation(async function (this: ControlPlaneServer) {
          listenEntrySnapshots.push(await readFile(agentsFile, 'utf8'));
          return originalListen.call(this);
        });
        try {
          const withoutOptIn = await runWeb({ port: 0 }, { goalRuntimeRead: {} as never, workspaceRoots: [workspaceRoot] });
          expect(withoutOptIn.ok).toBe(true);
          if (!withoutOptIn.ok) return;
          expect(withoutOptIn.value.policyRepair).toBeUndefined();
          await withoutOptIn.value.handle.close();
          expect(await readFile(agentsFile, 'utf8')).toContain('child:memory');

          const result = await runWeb(
            { port: 0, repairManagedPolicies: true },
            { goalRuntimeRead: {} as never, workspaceRoots: [workspaceRoot] },
          );
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          try {
            // The control plane owns the host-global files and the selected
            // workspace root: six workspace targets plus five global ones.
            expect(result.value.policyRepair?.scanned).toBe(11);
            expect(result.value.policyRepair?.updated).toEqual(expect.arrayContaining([agentsFile, claudeGlobal]));
            expect(result.value.policyRepair?.failed).toEqual([]);
            expect(await readFile(agentsFile, 'utf8')).toContain('memory:workspace-selective');
            expect(await readFile(claudeGlobal, 'utf8')).toContain('memory:workspace-selective');
          } finally {
            await result.value.handle.close();
          }
          expect(listenEntrySnapshots).toHaveLength(2);
          expect(listenEntrySnapshots[0]).toContain('child:memory');
          expect(listenEntrySnapshots[1]).toContain('memory:workspace-selective');
        } finally {
          listenSpy.mockRestore();
        }

        // A whole-run failure (for example the shared lock timing out) has no
        // per-file report; the result must still carry it so the CLI can show
        // it instead of silently starting without a repair.
        const repairFailure = vi.spyOn(IdeSyncService.prototype, 'repairManagedBlocks').mockResolvedValue(
          err(appError('CONFLICT', 'Failed to lock managed policy files: timed out')),
        );
        try {
          const failed = await runWeb(
            { port: 0, repairManagedPolicies: true },
            { goalRuntimeRead: {} as never, workspaceRoots: [workspaceRoot] },
          );
          expect(failed.ok).toBe(true);
          if (!failed.ok) return;
          try {
            expect(failed.value.policyRepair).toBeUndefined();
            expect(failed.value.policyRepairError).toBe('Failed to lock managed policy files: timed out');
          } finally {
            await failed.value.handle.close();
          }
        } finally {
          repairFailure.mockRestore();
        }
      } finally {
        if (previousDataPath === undefined) delete process.env.UNIFIED_MPC_DATA_PATH;
        else process.env.UNIFIED_MPC_DATA_PATH = previousDataPath;
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = previousXdgDataHome;
        if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = previousCodexHome;
        await rm(root, { recursive: true, force: true });
      }
    });

    it('falls back to process.cwd() for the repair root when no workspace root is configured', async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'web-policy-repair-cwd-'));
      const workspaceRoot = path.join(root, 'cwd');
      const home = path.join(root, 'home');
      await mkdir(workspaceRoot, { recursive: true });
      await mkdir(home, { recursive: true });
      const previousDataPath = process.env.UNIFIED_MPC_DATA_PATH;
      const previousHome = process.env.HOME;
      const previousXdgDataHome = process.env.XDG_DATA_HOME;
      const previousCodexHome = process.env.CODEX_HOME;
      const previousCwd = process.cwd();
      process.env.UNIFIED_MPC_DATA_PATH = path.join(root, 'data');
      process.env.HOME = home;
      process.env.XDG_DATA_HOME = path.join(root, 'xdg');
      delete process.env.CODEX_HOME;
      const agentsFile = path.join(workspaceRoot, 'AGENTS.md');
      await writeFile(agentsFile, `# Project notes\n\n${POLICY_BLOCK_START}\n| P1 | child:memory | memory | server | REALTIME | ✅ YES |\n${POLICY_BLOCK_END}\n`, 'utf8');
      process.chdir(workspaceRoot);
      try {
        // The production CLI calls runWeb with no serverOptions, so the repair
        // has to mirror ControlPlaneServer's own `process.cwd()` default.
        const result = await runWeb({ port: 0, repairManagedPolicies: true }, { goalRuntimeRead: {} as never });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        try {
          expect(result.value.policyRepair?.updated).toContain(agentsFile);
          expect(await readFile(agentsFile, 'utf8')).toContain('memory:workspace-selective');
        } finally {
          await result.value.handle.close();
        }
      } finally {
        process.chdir(previousCwd);
        if (previousDataPath === undefined) delete process.env.UNIFIED_MPC_DATA_PATH;
        else process.env.UNIFIED_MPC_DATA_PATH = previousDataPath;
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = previousXdgDataHome;
        if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = previousCodexHome;
        await rm(root, { recursive: true, force: true });
      }
    });

    it('starts control plane server and returns handle with bound url', async () => {
      const result = await runWeb({ port: 0 }, { goalRuntimeRead: {} as never });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.url).toContain('http://127.0.0.1:');
        const cleanup = await fetch(`${result.value.url}/api/workspaces/cleanup-evaluations`);
        expect(cleanup.status).toBe(200);
        expect(cleanup.headers.get('cache-control')).toBe('no-store');
        expect(await cleanup.json()).toMatchObject({ evaluations: expect.any(Array) });
        await result.value.handle.close();
      }
    });
  });
});
