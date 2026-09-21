import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SqliteDatabase,
  SqliteGoalRepository,
  SqliteGoalRuntimeSnapshotRepository,
  SqliteSettingsRepository,
  SqliteWorkspaceRepository,
} from '@unified-mpc/storage';
import { permissionProfiles } from '@unified-mpc/permissions';
import { CAPABILITY_TASK_OWNER_METADATA_KEY } from '@unified-mpc/capabilities';
import { DEFAULT_EXTENSIONS_SETTINGS, EXTENSIONS_SETTINGS_KEY } from '@unified-mpc/extensions';
import { USER_SETTING_KEYS, serializeToolAvailabilitySnapshot } from '@unified-mpc/shared';
import { ok, type ResultBudget } from '@unified-mpc/domain';
import type { ThaiRagProviderDriver } from '@unified-mpc/thai-rag';
import { createStdioMcpRuntime } from './stdio-mcp-runtime.js';
import { sharedActivityLeaseDirectoryPath } from '@unified-mpc/mcp-server';

const temporaryRoots: string[] = [];
const TEST_CHECKPOINT_KEY = Buffer.alloc(32, 0x46).toString('base64');

const workspace = {
  id: 'workspace-1',
  displayName: 'fixture',
  rootPath: 'E:\fixture',
  realRootPath: 'E:\fixture',
  createdAt: '2026-08-10T00:00:00.000Z',
};

async function waitUntil(predicate: () => boolean, timeoutMs: number = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for cross-process tool availability refresh');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

beforeEach(() => {
  process.env.UNIFIED_MPC_CHECKPOINT_KEY_BASE64 = TEST_CHECKPOINT_KEY;
});

afterEach(async () => {
  delete process.env.TUNNEL_CLIENT_PROFILE_DIR;
  delete process.env.UNIFIED_MPC_CHECKPOINT_KEY_BASE64;
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
    maxRetries: process.platform === 'win32' ? 5 : 0,
    retryDelay: 100,
  })));
});

describe('stdio MCP runtime', () => {
  it('propagates result budgets through the stdio Thai-RAG port', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-stdio-rag-budget-'));
    temporaryRoots.push(dataPath);
    let observedBudget: ResultBudget | undefined;
    const driver: ThaiRagProviderDriver = {
      start: async () => ok({ workerReachable: true, sqliteAvailable: true, ftsAvailable: true, vectorStoreAvailable: true, embedderAvailable: true, lexicalRetrievalAvailable: true, semanticRetrievalAvailable: true, activeJobs: [] }),
      health: async () => ok({ workerReachable: true, sqliteAvailable: true, ftsAvailable: true, vectorStoreAvailable: true, embedderAvailable: true, lexicalRetrievalAvailable: true, semanticRetrievalAvailable: true, activeJobs: [] }),
      call: async (_tool, _args, _signal, budget) => { observedBudget = budget; return ok({ bounded: true }); },
      stop: async () => ok(undefined),
    };
    const runtime = createStdioMcpRuntime(dataPath, workspace, false, { thaiRagDriver: driver });
    try {
      await runtime.initializeThaiRag();
      const budget: ResultBudget = { maxItems: 2, maxTextBytes: 3, maxStructuredBytes: 4, maxBinaryBytes: 5, maxBase64Bytes: 6 };
      await runtime.services.thaiRag?.call('code_search', { query: 'needle' }, undefined, budget);
      expect(observedBudget).toEqual(budget);
    } finally {
      await runtime.close();
    }
  });

  it('defaults Ponytail to OFF and loads a persisted mode for direct STDIO', async () => {
    const defaultDataPath = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-stdio-ponytail-default-'));
    const persistedDataPath = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-stdio-ponytail-persisted-'));
    temporaryRoots.push(defaultDataPath, persistedDataPath);

    const defaultRuntime = createStdioMcpRuntime(defaultDataPath, workspace);
    try {
      expect(defaultRuntime.ponytailMode).toBe('off');
    } finally {
      await defaultRuntime.close();
    }

    const database = new SqliteDatabase(path.join(persistedDataPath, 'unified-mpc.sqlite'));
    new SqliteSettingsRepository(database).set(USER_SETTING_KEYS.ponytailMode, 'ultra');
    database.close();

    const persistedRuntime = createStdioMcpRuntime(persistedDataPath, workspace);
    try {
      expect(persistedRuntime.ponytailMode).toBe('ultra');
    } finally {
      await persistedRuntime.close();
    }
  }, 15_000);

  it('wires durable goals and scheduled continuation orchestration from the same SQLite repository', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-stdio-continuation-'));
    temporaryRoots.push(dataPath);
    const runtime = createStdioMcpRuntime(dataPath, workspace);
    try {
      expect(runtime.services.goals).toBeDefined();
      expect(runtime.services.scheduledContinuations).toBeDefined();
    } finally {
      await runtime.close();
    }
  });

  it('uses the registered host-facing root for active execution scopes when it differs from the canonical root', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-stdio-active-root-alias-'));
    temporaryRoots.push(dataPath);
    const aliasedWorkspace = {
      ...workspace,
      rootPath: '/home/qwerty/thai-rag-mcp',
      realRootPath: '/mnt/workspace_data/thai-rag-mcp',
    };
    const database = new SqliteDatabase(path.join(dataPath, 'unified-mpc.sqlite'));
    await new SqliteWorkspaceRepository(database).insert(aliasedWorkspace);
    database.close();
    const runtime = createStdioMcpRuntime(dataPath, aliasedWorkspace);
    try {
      await expect(runtime.activeWorkspaceScopeProvider()).resolves.toEqual({
        workspaceId: aliasedWorkspace.id,
        rootPath: aliasedWorkspace.rootPath,
      });
      await expect(runtime.activeWorkspaceScopesProvider()).resolves.toEqual([
        expect.objectContaining({ workspaceId: aliasedWorkspace.id, rootPath: aliasedWorkspace.rootPath }),
      ]);
    } finally {
      await runtime.close();
    }
  });

  it('fails closed when another client archives the runtime primary workspace', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-stdio-archive-scope-'));
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-stdio-archive-project-'));
    temporaryRoots.push(dataPath, projectRoot);
    const database = new SqliteDatabase(path.join(dataPath, 'unified-mpc.sqlite'));
    const repository = new SqliteWorkspaceRepository(database);
    const registered = { ...workspace, rootPath: projectRoot, realRootPath: await realpath(projectRoot) };
    await repository.insert(registered);
    database.close();

    const runtime = createStdioMcpRuntime(dataPath, registered);
    const externalDatabase = new SqliteDatabase(path.join(dataPath, 'unified-mpc.sqlite'));
    try {
      await new SqliteWorkspaceRepository(externalDatabase).archive(registered.id, '2026-08-24T00:00:00.000Z');
      await expect(runtime.activeWorkspaceScopeProvider()).resolves.toBeNull();
      await expect(runtime.activeWorkspaceScopesProvider()).resolves.toEqual([]);
    } finally {
      externalDatabase.close();
      await runtime.close();
    }
  });

  it('fails closed when another client deletes the runtime primary workspace', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-stdio-delete-scope-'));
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-stdio-delete-project-'));
    temporaryRoots.push(dataPath, projectRoot);
    const database = new SqliteDatabase(path.join(dataPath, 'unified-mpc.sqlite'));
    const repository = new SqliteWorkspaceRepository(database);
    const registered = { ...workspace, rootPath: projectRoot, realRootPath: await realpath(projectRoot) };
    await repository.insert(registered);
    database.close();

    const runtime = createStdioMcpRuntime(dataPath, registered);
    const externalDatabase = new SqliteDatabase(path.join(dataPath, 'unified-mpc.sqlite'));
    try {
      await new SqliteWorkspaceRepository(externalDatabase).delete(registered.id);
      await expect(runtime.activeWorkspaceScopeProvider()).resolves.toBeNull();
      await expect(runtime.activeWorkspaceScopesProvider()).resolves.toEqual([]);
    } finally {
      externalDatabase.close();
      await runtime.close();
    }
  });

  it('bootstraps Goal runtime truth for registered workspaces outside the current Web selection', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-stdio-runtime-all-projects-'));
    const primaryRoot = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-stdio-runtime-primary-'));
    const secondaryRoot = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-stdio-runtime-secondary-'));
    temporaryRoots.push(dataPath, primaryRoot, secondaryRoot);
    const primary = {
      ...workspace,
      rootPath: primaryRoot,
      realRootPath: await realpath(primaryRoot),
    };
    const secondary = {
      id: 'workspace-2',
      displayName: 'background runtime project',
      rootPath: secondaryRoot,
      realRootPath: await realpath(secondaryRoot),
      createdAt: '2026-09-22T00:00:00.000Z',
    };

    const database = new SqliteDatabase(path.join(dataPath, 'unified-mpc.sqlite'));
    const workspaceRepository = new SqliteWorkspaceRepository(database);
    await workspaceRepository.insert(primary);
    await workspaceRepository.insert(secondary);
    const goalRepository = new SqliteGoalRepository(database);
    const primaryAcquired = await goalRepository.acquire({
      goalId: 'goal-primary-runtime',
      workspaceId: primary.id,
      goalKey: 'primary-runtime',
      ownerClientId: 'primary-client',
      ownerSessionId: 'primary-session',
      objective: 'Keep primary runtime truth independent from background projects.',
      plan: { steps: [] },
      leaseTokenHash: 'b'.repeat(64),
      leaseSeconds: 600,
      now: '2026-09-22T00:01:00.000Z',
    });
    expect(primaryAcquired.acquired).toBe(true);
    const acquired = await goalRepository.acquire({
      goalId: 'goal-background-runtime',
      workspaceId: secondary.id,
      goalKey: 'background-runtime',
      ownerClientId: 'background-client',
      ownerSessionId: 'background-session',
      objective: 'Keep runtime truth independent from UI selection.',
      plan: { steps: [] },
      leaseTokenHash: 'a'.repeat(64),
      leaseSeconds: 600,
      now: '2026-09-22T00:01:00.000Z',
    });
    expect(acquired.acquired).toBe(true);
    database.close();

    const runtime = createStdioMcpRuntime(dataPath, primary, false, { persistWorkspaceSelection: true });
    try {
      await runtime.recoveryReady;
      const verificationDatabase = new SqliteDatabase(path.join(dataPath, 'unified-mpc.sqlite'));
      try {
        const snapshots = new SqliteGoalRuntimeSnapshotRepository(verificationDatabase);
        const primarySnapshot = await snapshots.getGoalRuntimeSnapshot('goal-primary-runtime');
        const backgroundSnapshot = await snapshots.getGoalRuntimeSnapshot('goal-background-runtime');
        expect(primarySnapshot?.projection).toMatchObject({
          workspaceId: primary.id,
          lifecycleState: 'open',
          runtimeState: 'queued',
          desiredRuntimeState: 'running',
          workspaceState: 'unknown',
          integrationState: 'unknown',
        });
        expect(backgroundSnapshot?.projection).toMatchObject({
          workspaceId: secondary.id,
          lifecycleState: 'open',
          runtimeState: 'queued',
          desiredRuntimeState: 'running',
          workspaceState: 'unknown',
          integrationState: 'unknown',
        });
      } finally {
        verificationDatabase.close();
      }
    } finally {
      await runtime.close();
    }
  });

  it('fails startup readiness when Recovery Trash contains corrupt workspace metadata', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-stdio-recovery-reconcile-'));
    temporaryRoots.push(dataPath);
    const recoveryBase = path.join(dataPath, 'recovery-trash', workspace.id, '11111111-1111-4111-8111-111111111111');
    await mkdir(recoveryBase, { recursive: true });
    await writeFile(path.join(recoveryBase, 'metadata.json'), '{not-json', 'utf8');

    const runtime = createStdioMcpRuntime(dataPath, workspace);
    try {
      await expect(runtime.recoveryReady).rejects.toThrow('Recovery reconciliation found unsafe entries');
    } finally {
      await runtime.close();
    }
  });

  it('observes persisted tool availability writes from another SQLite connection without restart or duplicate unrelated notifications', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-stdio-tool-availability-'));
    temporaryRoots.push(dataPath);
    const runtime = createStdioMcpRuntime(dataPath, workspace);
    const externalDatabase = new SqliteDatabase(path.join(dataPath, 'unified-mpc.sqlite'));
    const externalSettings = new SqliteSettingsRepository(externalDatabase);
    let notifications = 0;
    const unsubscribe = runtime.toolAvailabilityService.subscribe(() => { notifications += 1; });
    try {
      externalSettings.set(USER_SETTING_KEYS.toolAvailability, serializeToolAvailabilitySnapshot({
        version: 1,
        generation: 1,
        overrides: { scheduler: 'disabled' },
      }));
      await waitUntil(() => runtime.toolAvailabilityService.snapshot().overrides.scheduler === 'disabled');
      expect(notifications).toBe(1);

      externalSettings.set(USER_SETTING_KEYS.updateAutoCheck, 'false');
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(notifications).toBe(1);
    } finally {
      unsubscribe();
      externalDatabase.close();
      await runtime.close();
    }
  });

  it('observes persisted extension settings writes from another SQLite connection without restart', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-stdio-extension-settings-'));
    temporaryRoots.push(dataPath);
    const workspaceDatabase = new SqliteDatabase(path.join(dataPath, 'unified-mpc.sqlite'));
    await new SqliteWorkspaceRepository(workspaceDatabase).insert(workspace);
    workspaceDatabase.close();
    const runtime = createStdioMcpRuntime(dataPath, workspace);
    const externalDatabase = new SqliteDatabase(path.join(dataPath, 'unified-mpc.sqlite'));
    const externalSettings = new SqliteSettingsRepository(externalDatabase);
    try {
      const before = await runtime.services.extensions.listMcpServers();
      expect(before.ok).toBe(true);
      if (!before.ok) throw new Error(before.error.message);
      expect(before.value.servers.some((server) => server.name === 'cross-process-mock')).toBe(false);

      externalSettings.set(EXTENSIONS_SETTINGS_KEY, JSON.stringify({
        ...DEFAULT_EXTENSIONS_SETTINGS,
        mandatoryMcpServers: [],
        extraMcpServers: {
          'cross-process-mock': { command: 'node', args: ['mock-server.js'] },
        },
      }));

      const updated = await runtime.services.extensions.listMcpServers();
      expect(updated.ok).toBe(true);
      if (!updated.ok) throw new Error(updated.error.message);
      expect(updated.value.servers).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'cross-process-mock', command: 'node', enabled: true }),
      ]));

      externalSettings.set(EXTENSIONS_SETTINGS_KEY, JSON.stringify({
        ...DEFAULT_EXTENSIONS_SETTINGS,
        mandatoryMcpServers: [],
      }));
      const removed = await runtime.services.extensions.listMcpServers();
      expect(removed.ok).toBe(true);
      if (!removed.ok) throw new Error(removed.error.message);
      expect(removed.value.servers.some((server) => server.name === 'cross-process-mock')).toBe(false);
    } finally {
      externalDatabase.close();
      await runtime.close();
    }
  });

  it('does not overwrite the Desktop permission profile when using full tunnel access', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-stdio-profile-'));
    temporaryRoots.push(dataPath);
    const database = new SqliteDatabase(path.join(dataPath, 'unified-mpc.sqlite'));
    new SqliteSettingsRepository(database).set('permission_profile', 'balanced');
    database.close();

    const runtime = createStdioMcpRuntime(dataPath, workspace);
    await runtime.close();

    const verificationDatabase = new SqliteDatabase(path.join(dataPath, 'unified-mpc.sqlite'));
    const profile = new SqliteSettingsRepository(verificationDatabase).get('permission_profile');
    verificationDatabase.close();
    expect(profile).toBe('balanced');
  });

  it('owns and cleans the tunnel-profile activity snapshot for the direct STDIO runtime', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-stdio-activity-'));
    const profileDirectory = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-stdio-profile-'));
    temporaryRoots.push(dataPath, profileDirectory);
    process.env.TUNNEL_CLIENT_PROFILE_DIR = profileDirectory;

    const runtime = createStdioMcpRuntime(dataPath, workspace);
    await runtime.activityReady;
    const leaseDirectory = sharedActivityLeaseDirectoryPath(profileDirectory);
    const [leaseFile] = await readdir(leaseDirectory);
    expect(leaseFile).toBeDefined();
    const leasePath = path.join(leaseDirectory, leaseFile!);
    const initialized = JSON.parse(await readFile(leasePath, 'utf8')) as Record<string, unknown>;
    expect(initialized).toMatchObject({ version: 2, activeCount: 0, revision: 0, owner: { pid: process.pid } });

    const callId = await runtime.activityTracker.begin('read_file', { path: 'E:\\fixture.txt' });
    expect(JSON.parse(await readFile(leasePath, 'utf8'))).toMatchObject({ activeCount: 1, revision: 1 });
    await runtime.activityTracker.end(callId, 'SUCCESS', 1);
    expect(JSON.parse(await readFile(leasePath, 'utf8'))).toMatchObject({ activeCount: 0, revision: 2 });

    await runtime.close();
    expect((await readdir(leaseDirectory)).filter((name) => name.endsWith('.json'))).toEqual([]);
  });

  it('uses the selected stdio profile and hides broad workspaces when strict roots are enabled', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-stdio-strict-data-'));
    const allowedRaw = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-stdio-strict-allowed-'));
    const outsideRaw = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-stdio-strict-outside-'));
    temporaryRoots.push(dataPath, allowedRaw, outsideRaw);
    const allowed = await realpath(allowedRaw);
    const outside = await realpath(outsideRaw);
    await writeFile(path.join(outside, 'outside.txt'), 'outside', 'utf8');
    const allowedWorkspace = { id: 'allowed-workspace', displayName: 'allowed', rootPath: allowed, realRootPath: allowed, createdAt: '2026-08-22T00:00:00.000Z' };
    const outsideWorkspace = { id: 'outside-workspace', displayName: 'outside', rootPath: outside, realRootPath: outside, createdAt: '2026-08-22T00:00:01.000Z' };
    const database = new SqliteDatabase(path.join(dataPath, 'unified-mpc.sqlite'));
    const repo = new SqliteWorkspaceRepository(database);
    await repo.insert(allowedWorkspace);
    await repo.insert(outsideWorkspace);
    database.close();

    const runtime = createStdioMcpRuntime(dataPath, allowedWorkspace, true, { permissionProfile: 'safe', strictAllowedRoots: [allowed] });
    try {
      expect(runtime.profileProvider()).toEqual(permissionProfiles.safe);
      const listed = await runtime.services.workspaceInfo?.list?.(runtime.actor);
      expect(listed).toMatchObject({ ok: true, value: [expect.objectContaining({ id: 'allowed-workspace' })] });
      const readOutside = await runtime.services.file?.readFile(runtime.actor, undefined, { path: path.join(outside, 'outside.txt') });
      expect(readOutside).toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });
      const shellOutside = await runtime.services.capabilities?.execute('shell', {
        operation: 'run', executable: process.execPath, arguments: ['-e', 'process.exit(0)'], cwd: outside, execution: 'foreground',
      });
      expect(shellOutside).toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });
    } finally {
      await runtime.close();
    }
  });

  it('keeps a shell background task alive across STDIO runtime replacement', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-stdio-durable-'));
    temporaryRoots.push(dataPath);
    const firstRuntime = createStdioMcpRuntime(dataPath, workspace, true);
    const capabilities = firstRuntime.services.capabilities;
    expect(capabilities).toBeDefined();
    if (capabilities === undefined) return;

    const started = await capabilities.execute('shell', {
      operation: 'run',
      executable: process.execPath,
      arguments: ['-e', "setTimeout(() => process.stdout.write('stdio-durable'), 350)"],
      cwd: dataPath,
      execution: 'background',
      timeout_seconds: 30,
      userConfirmed: true,
    });
    expect(started).toMatchObject({ ok: true, value: { task_id: expect.any(String), durable: true } });
    if (!started.ok) {
      await firstRuntime.close();
      return;
    }
    const taskId = String((started.value as Record<string, unknown>).task_id);
    await firstRuntime.close();

    const replacementRuntime = createStdioMcpRuntime(dataPath, workspace, true);
    const replacementCapabilities = replacementRuntime.services.capabilities;
    expect(replacementCapabilities).toBeDefined();
    if (replacementCapabilities === undefined) {
      await replacementRuntime.close();
      return;
    }
    const finished = await replacementCapabilities.execute('shell', { operation: 'wait', task_id: taskId, timeout_seconds: 5 });
    expect(finished).toMatchObject({
      ok: true,
      value: { task_id: taskId, state: 'completed', exit_code: 0, stdout: 'stdio-durable', durable: true },
    });
    await replacementRuntime.close();
  }, 15_000);

  it('reads durable shell task liveness after STDIO runtime replacement without treating another session as absence', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-stdio-goal-liveness-data-'));
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-stdio-goal-liveness-workspace-'));
    temporaryRoots.push(dataPath, workspaceRoot);
    const durableWorkspace = {
      id: 'goal-liveness-workspace',
      displayName: 'goal liveness',
      rootPath: workspaceRoot,
      realRootPath: workspaceRoot,
      createdAt: '2026-08-27T00:00:00.000Z',
    };
    const database = new SqliteDatabase(path.join(dataPath, 'unified-mpc.sqlite'));
    await new SqliteWorkspaceRepository(database).insert(durableWorkspace);
    database.close();

    const ownerMetadata = {
      [CAPABILITY_TASK_OWNER_METADATA_KEY]: {
        clientId: 'cli-mcp-stdio',
        sessionId: 'predecessor-session',
        workspaceId: durableWorkspace.id,
      },
    };
    const firstRuntime = createStdioMcpRuntime(dataPath, durableWorkspace, true);
    const started = await firstRuntime.services.capabilities?.execute('shell', {
      operation: 'run',
      executable: process.execPath,
      arguments: ['-e', 'setTimeout(() => process.exit(0), 10000)'],
      cwd: workspaceRoot,
      workspaceId: durableWorkspace.id,
      execution: 'background',
      timeout_seconds: 30,
      userConfirmed: true,
      metadata: ownerMetadata,
    });
    expect(started).toMatchObject({ ok: true, value: { task_id: expect.any(String), state: 'running', durable: true } });
    if (started === undefined || !started.ok) {
      await firstRuntime.close();
      return;
    }
    const taskId = String((started.value as Record<string, unknown>).task_id);
    const runGoal = await firstRuntime.services.goals?.runGoal(firstRuntime.actor, {
      workspaceId: durableWorkspace.id,
      goalKey: 'runtime-task-state-reader',
      objective: 'Verify task liveness survives a transport replacement.',
      plan: { steps: [] },
      leaseSeconds: 600,
    });
    expect(runGoal).toMatchObject({ ok: true, value: { acquired: true, leaseToken: expect.any(String) } });
    if (runGoal === undefined || !runGoal.ok || runGoal.value.leaseToken === undefined) {
      await firstRuntime.close();
      return;
    }
    const checkpointed = await firstRuntime.services.goals?.checkpointGoal(firstRuntime.actor, {
      goalId: runGoal.value.goalId,
      leaseToken: runGoal.value.leaseToken,
      expectedRevision: runGoal.value.revision,
      currentPhase: 'worker-running',
      summary: 'A durable task is still running.',
      stepUpdates: [],
      nextAction: 'Wait for the task.',
      blockers: [],
      evidence: [],
      activeTaskIds: [taskId],
    });
    expect(checkpointed).toMatchObject({ ok: true, value: { activeTaskIds: [taskId] } });
    await firstRuntime.close();

    const replacementRuntime = createStdioMcpRuntime(dataPath, durableWorkspace, true);
    try {
      const liveness = await replacementRuntime.services.goalMutationFence?.observe(runGoal.value.goalId, [taskId]);
      expect(liveness).toMatchObject({
        trustworthy: true,
        activeTaskStates: [{ taskId, state: 'running' }],
      });
    } finally {
      await replacementRuntime.services.capabilities?.execute('shell', {
        operation: 'cancel',
        task_id: taskId,
        workspaceId: durableWorkspace.id,
        userConfirmed: true,
        metadata: ownerMetadata,
      });
      await replacementRuntime.close();
    }
  }, 15_000);
});
