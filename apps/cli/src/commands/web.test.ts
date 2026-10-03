import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { GoalRecord, WorkspaceAdmissionReceipt } from '@unified-mpc/domain';
import { GoalWorkspaceTruthReader } from '@unified-mpc/application';
import { describe, expect, it } from 'vitest';
import { createGoalControl, createWebGoalRuntimeProjection, runWeb, parseWebArgs } from './web.js';

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
      const root = await mkdtemp(path.join(process.cwd(), '.web-storage-diagnostics-'));
      const previousDataPath = process.env.UNIFIED_MPC_DATA_PATH;
      const previousPublicUrl = process.env.UNIFIED_MPC_CLOUDFLARE_PUBLIC_URL;
      process.env.UNIFIED_MPC_DATA_PATH = root;
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
                schemaVersion: '029_goal_runtime_integration_observations',
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
        if (previousPublicUrl === undefined) delete process.env.UNIFIED_MPC_CLOUDFLARE_PUBLIC_URL;
        else process.env.UNIFIED_MPC_CLOUDFLARE_PUBLIC_URL = previousPublicUrl;
        await rm(root, { recursive: true, force: true });
      }
    });

    it('keeps successful secret presence truth when another Secret Service lookup fails', async () => {
      const root = await mkdtemp(path.join(process.cwd(), '.web-storage-diagnostics-partial-'));
      const previousDataPath = process.env.UNIFIED_MPC_DATA_PATH;
      process.env.UNIFIED_MPC_DATA_PATH = root;
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
        await rm(root, { recursive: true, force: true });
      }
    });

    it('starts control plane server and returns handle with bound url', async () => {
      const result = await runWeb({ port: 0 }, { goalRuntimeRead: {} as never });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.url).toContain('http://127.0.0.1:');
        await result.value.handle.close();
      }
    });
  });
});
