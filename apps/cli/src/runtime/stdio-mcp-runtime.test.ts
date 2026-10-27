import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
import { appError, err, ok, type ResultBudget } from '@unified-mpc/domain';
import {
  THAI_RAG_DEPLOYMENT_EMBEDDING_PROFILE,
  type ThaiRagProviderDriver,
} from '@unified-mpc/thai-rag';
import { createStdioMcpRuntime, thaiRagProviderLaunchEnv } from './stdio-mcp-runtime.js';
import { sharedActivityLeaseDirectoryPath } from '@unified-mpc/mcp-server';
import {
  DEFAULT_VERIFICATION_HEAVY_ADMISSION_COST,
  sharedProcessResourceAdmissionController,
  tryAdmitVerificationHeavy,
} from '@unified-mpc/workspace';

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
  it('pins an existing unmerged feature branch HEAD when resolving a new Goal Workspace', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'unified-pr-head-data-'));
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'unified-pr-head-source-'));
    temporaryRoots.push(dataPath, rootPath);
    const git = (...args: string[]): string => execFileSync('git', args, { cwd: rootPath, encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Unified Test');
    git('config', 'user.email', 'test@example.invalid');
    await writeFile(path.join(rootPath, 'README.md'), 'base\n');
    git('add', 'README.md');
    git('commit', '-qm', 'base');
    git('checkout', '-qb', 'feature/unmerged-pr');
    await writeFile(path.join(rootPath, 'feature-only.txt'), 'must survive\n');
    git('add', 'feature-only.txt');
    git('commit', '-qm', 'feature-only');
    const pinnedHead = git('rev-parse', 'HEAD');
    const project = { id: 'pr-head-project', displayName: 'PR source', rootPath, realRootPath: rootPath, createdAt: '2026-10-01T00:00:00.000Z' };
    const db = new SqliteDatabase(path.join(dataPath, 'unified-mpc.sqlite'));
    await new SqliteWorkspaceRepository(db).insert(project);
    const runtime = createStdioMcpRuntime(dataPath, project);
    try {
      const result = await runtime.services.goalRunWorkspace?.resolveRunWorkspace(runtime.actor, {
        workspaceId: project.id, goalKey: 'feature-head-preservation',
      });
      expect(result?.ok).toBe(true);
      if (result === undefined || !result.ok) return;
      const registered = await new SqliteWorkspaceRepository(db).get(result.value.workspaceId);
      expect(registered?.baseRevision).toBe(pinnedHead);
      expect(await readFile(path.join(registered!.realRootPath, 'feature-only.txt'), 'utf8')).toBe('must survive\n');
      const acquired = await runtime.services.goals?.runGoal(runtime.actor, {
        workspaceId: registered!.id, goalKey: 'feature-head-preservation',
        objective: 'Verify admission recovery refuses a false lease proof.',
        plan: { steps: [] }, leaseSeconds: 600,
      });
      expect(acquired).toMatchObject({ ok: true, value: { acquired: true, leaseGeneration: 1 } });
      if (acquired === undefined || !acquired.ok) return;
      const invalid = await runtime.services.goalRunWorkspace?.recoverRunWorkspace(runtime.actor, {
        workspaceId: registered!.id, goalId: acquired.value.goalId,
        leaseToken: 'not-the-current-lease', leaseGeneration: acquired.value.leaseGeneration,
      });
      expect(invalid).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    } finally {
      await runtime.close();
      db.close();
    }
  });


  it('recovers an exact already-staged owner delta without accepting hash drift', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'unified-staged-recovery-data-'));
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'unified-staged-recovery-source-'));
    temporaryRoots.push(dataPath, rootPath);
    const gitAt = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    gitAt(rootPath, 'init', '-q', '-b', 'main');
    gitAt(rootPath, 'config', 'user.name', 'Unified Test');
    gitAt(rootPath, 'config', 'user.email', 'test@example.invalid');
    await writeFile(path.join(rootPath, 'README.md'), 'base\n');
    gitAt(rootPath, 'add', 'README.md');
    gitAt(rootPath, 'commit', '-qm', 'base');
    gitAt(rootPath, 'checkout', '-qb', 'feature/staged-recovery');

    const project = { id: 'staged-recovery-project', displayName: 'staged recovery', rootPath, realRootPath: rootPath, createdAt: '2026-10-02T00:00:00.000Z' };
    const db = new SqliteDatabase(path.join(dataPath, 'unified-mpc.sqlite'));
    const workspaces = new SqliteWorkspaceRepository(db);
    await workspaces.insert(project);
    const runtimeAdmissionIdentity = {
      runtimeDeploymentId: 'deploy-staged-recovery',
      runtimeGeneration: '19400000-0000-4000-8000-000000000001',
      runtimeBuildVersion: '4.61.0+194000000001',
      runtimeBuildCommit: '1'.repeat(40),
      runtimeBuildDirty: false,
      runtimeProtocolGeneration: 1,
      runtimeStartedAt: '2026-10-02T00:00:00.000Z',
    };
    const runtime = createStdioMcpRuntime(dataPath, project, false, { runtimeAdmissionIdentity });
    try {
      const resolved = await runtime.services.goalRunWorkspace?.resolveRunWorkspace(runtime.actor, {
        workspaceId: project.id, goalKey: 'staged-recovery-flow',
      });
      expect(resolved?.ok).toBe(true);
      if (resolved === undefined || !resolved.ok) return;
      const goalWorkspace = await workspaces.get(resolved.value.workspaceId);
      expect(goalWorkspace).not.toBeNull();
      if (goalWorkspace === null) return;

      const acquired = await runtime.services.goals?.runGoal(runtime.actor, {
        workspaceId: goalWorkspace.id,
        goalKey: 'staged-recovery-flow',
        objective: 'Recover exact staged state.',
        plan: { steps: [] },
        leaseSeconds: 600,
      });
      expect(acquired?.ok).toBe(true);
      if (acquired === undefined || !acquired.ok || acquired.value.leaseExpiresAt === undefined) return;

      const admitted = await runtime.services.goalRunWorkspace?.admitRunWorkspace(runtime.actor, {
        workspaceId: goalWorkspace.id,
        goalId: acquired.value.goalId,
        leaseGeneration: acquired.value.leaseGeneration,
        leaseExpiresAt: acquired.value.leaseExpiresAt,
      });
      expect(admitted).toMatchObject({ ok: true, value: { admissionGeneration: 1 } });
      if (admitted === undefined || !admitted.ok) return;

      const beforeStage = await workspaces.getAdmissionReceipt(goalWorkspace.id);
      expect(beforeStage).toMatchObject({ admissionGeneration: 1, dirtyState: 'clean' });
      if (beforeStage === null) return;

      // Reproduce the recovery boundary independently of the source-edit fence:
      // an admitted owner delta is already staged while the prior receipt still
      // describes the pre-stage identity.
      await writeFile(path.join(goalWorkspace.realRootPath, 'README.md'), 'base\nchanged\n');
      gitAt(goalWorkspace.realRootPath, 'add', '--', 'README.md');
      const stagedDiff = await runtime.services.git?.diff(runtime.actor, goalWorkspace.id, { staged: true, maxBytes: 1024 * 1024 });
      expect(stagedDiff?.ok).toBe(true);
      if (stagedDiff === undefined || !stagedDiff.ok) return;
      const stagedHash = createHash('sha256').update(stagedDiff.value.patch).digest('hex');

      const rejected = await runtime.services.goalRunWorkspace?.recoverRunWorkspace(runtime.actor, {
        workspaceId: goalWorkspace.id,
        goalId: acquired.value.goalId,
        leaseToken: acquired.value.leaseToken,
        leaseGeneration: acquired.value.leaseGeneration,
        stagedRecovery: {
          expectedAdmissionGeneration: beforeStage.admissionGeneration,
          expectedWorkspaceHead: beforeStage.expectedWorkspaceHead,
          expectedStagedPaths: ['README.md'],
          expectedStagedDiffSha256: '0'.repeat(64),
        },
      });
      expect(rejected).toMatchObject({ ok: false, error: { code: 'WORKSPACE_ADMISSION_STALE' } });

      const recovered = await runtime.services.goalRunWorkspace?.recoverRunWorkspace(runtime.actor, {
        workspaceId: goalWorkspace.id,
        goalId: acquired.value.goalId,
        leaseToken: acquired.value.leaseToken,
        leaseGeneration: acquired.value.leaseGeneration,
        stagedRecovery: {
          expectedAdmissionGeneration: beforeStage.admissionGeneration,
          expectedWorkspaceHead: beforeStage.expectedWorkspaceHead,
          expectedStagedPaths: ['README.md'],
          expectedStagedDiffSha256: stagedHash,
        },
      });
      expect(recovered).toMatchObject({ ok: true, value: { admissionGeneration: 2 } });

      const afterRecovery = await workspaces.getAdmissionReceipt(goalWorkspace.id);
      expect(afterRecovery).toMatchObject({
        admissionGeneration: 2,
        expectedWorkspaceHead: beforeStage.expectedWorkspaceHead,
        dirtyState: 'dirty',
      });
      expect(afterRecovery?.stagedFingerprint).not.toBe(beforeStage.stagedFingerprint);
    } finally {
      await runtime.close();
      db.close();
    }
  });

  it('recovers an exact unstaged owner delta without accepting hash drift', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'unified-unstaged-recovery-data-'));
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'unified-unstaged-recovery-source-'));
    temporaryRoots.push(dataPath, rootPath);
    const gitAt = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    gitAt(rootPath, 'init', '-q', '-b', 'main');
    gitAt(rootPath, 'config', 'user.name', 'Unified Test');
    gitAt(rootPath, 'config', 'user.email', 'test@example.invalid');
    await writeFile(path.join(rootPath, 'README.md'), 'base\n');
    gitAt(rootPath, 'add', 'README.md');
    gitAt(rootPath, 'commit', '-qm', 'base');
    gitAt(rootPath, 'checkout', '-qb', 'feature/unstaged-recovery');

    const project = { id: 'unstaged-recovery-project', displayName: 'unstaged recovery', rootPath, realRootPath: rootPath, createdAt: '2026-10-03T00:00:00.000Z' };
    const db = new SqliteDatabase(path.join(dataPath, 'unified-mpc.sqlite'));
    const workspaces = new SqliteWorkspaceRepository(db);
    await workspaces.insert(project);
    const runtimeAdmissionIdentity = {
      runtimeDeploymentId: 'deploy-unstaged-recovery',
      runtimeGeneration: '20600000-0000-4000-8000-000000000001',
      runtimeBuildVersion: '4.61.0+206000000001',
      runtimeBuildCommit: '2'.repeat(40),
      runtimeBuildDirty: false,
      runtimeProtocolGeneration: 1,
      runtimeStartedAt: '2026-10-03T00:00:00.000Z',
    };
    const runtime = createStdioMcpRuntime(dataPath, project, false, { runtimeAdmissionIdentity });
    try {
      const resolved = await runtime.services.goalRunWorkspace?.resolveRunWorkspace(runtime.actor, {
        workspaceId: project.id, goalKey: 'unstaged-recovery-flow',
      });
      expect(resolved?.ok).toBe(true);
      if (resolved === undefined || !resolved.ok) return;
      const goalWorkspace = await workspaces.get(resolved.value.workspaceId);
      expect(goalWorkspace).not.toBeNull();
      if (goalWorkspace === null) return;

      const acquired = await runtime.services.goals?.runGoal(runtime.actor, {
        workspaceId: goalWorkspace.id,
        goalKey: 'unstaged-recovery-flow',
        objective: 'Recover exact unstaged state.',
        plan: { steps: [] },
        leaseSeconds: 600,
      });
      expect(acquired?.ok).toBe(true);
      if (acquired === undefined || !acquired.ok || acquired.value.leaseExpiresAt === undefined) return;

      const admitted = await runtime.services.goalRunWorkspace?.admitRunWorkspace(runtime.actor, {
        workspaceId: goalWorkspace.id,
        goalId: acquired.value.goalId,
        leaseGeneration: acquired.value.leaseGeneration,
        leaseExpiresAt: acquired.value.leaseExpiresAt,
      });
      expect(admitted).toMatchObject({ ok: true, value: { admissionGeneration: 1 } });
      if (admitted === undefined || !admitted.ok) return;

      const beforeEdit = await workspaces.getAdmissionReceipt(goalWorkspace.id);
      expect(beforeEdit).toMatchObject({ admissionGeneration: 1, dirtyState: 'clean' });
      if (beforeEdit === null) return;

      await writeFile(path.join(goalWorkspace.realRootPath, 'README.md'), 'base\nchanged\n');
      const unstagedDiff = await runtime.services.git?.diff(runtime.actor, goalWorkspace.id, { maxBytes: 1024 * 1024 });
      expect(unstagedDiff?.ok).toBe(true);
      if (unstagedDiff === undefined || !unstagedDiff.ok) return;
      const unstagedHash = createHash('sha256').update(unstagedDiff.value.patch).digest('hex');

      const recoveryPort = runtime.services.goalRunWorkspace;
      expect(recoveryPort).toBeDefined();
      if (recoveryPort === undefined) return;

      const rejected = await recoveryPort.recoverRunWorkspace(runtime.actor, {
        workspaceId: goalWorkspace.id,
        goalId: acquired.value.goalId,
        leaseToken: acquired.value.leaseToken,
        leaseGeneration: acquired.value.leaseGeneration,
        unstagedRecovery: {
          expectedAdmissionGeneration: beforeEdit.admissionGeneration,
          expectedWorkspaceHead: beforeEdit.expectedWorkspaceHead,
          expectedUnstagedPaths: ['README.md'],
          expectedUnstagedDiffSha256: '0'.repeat(64),
        },
      });
      expect(rejected).toMatchObject({ ok: false, error: { code: 'WORKSPACE_ADMISSION_STALE' } });

      gitAt(goalWorkspace.realRootPath, 'add', '--', 'README.md');
      const stagedInstead = await recoveryPort.recoverRunWorkspace(runtime.actor, {
        workspaceId: goalWorkspace.id,
        goalId: acquired.value.goalId,
        leaseToken: acquired.value.leaseToken,
        leaseGeneration: acquired.value.leaseGeneration,
        unstagedRecovery: {
          expectedAdmissionGeneration: beforeEdit.admissionGeneration,
          expectedWorkspaceHead: beforeEdit.expectedWorkspaceHead,
          expectedUnstagedPaths: ['README.md'],
          expectedUnstagedDiffSha256: unstagedHash,
        },
      });
      expect(stagedInstead).toMatchObject({ ok: false, error: { code: 'WORKSPACE_ADMISSION_STALE' } });
      gitAt(goalWorkspace.realRootPath, 'restore', '--staged', '--', 'README.md');

      const recovered = await recoveryPort.recoverRunWorkspace(runtime.actor, {
        workspaceId: goalWorkspace.id,
        goalId: acquired.value.goalId,
        leaseToken: acquired.value.leaseToken,
        leaseGeneration: acquired.value.leaseGeneration,
        unstagedRecovery: {
          expectedAdmissionGeneration: beforeEdit.admissionGeneration,
          expectedWorkspaceHead: beforeEdit.expectedWorkspaceHead,
          expectedUnstagedPaths: ['README.md'],
          expectedUnstagedDiffSha256: unstagedHash,
        },
      });
      expect(recovered).toMatchObject({ ok: true, value: { admissionGeneration: 2 } });

      const afterRecovery = await workspaces.getAdmissionReceipt(goalWorkspace.id);
      expect(afterRecovery).toMatchObject({
        admissionGeneration: 2,
        expectedWorkspaceHead: beforeEdit.expectedWorkspaceHead,
        dirtyState: 'dirty',
        stagedFingerprint: beforeEdit.stagedFingerprint,
      });
      expect(afterRecovery?.dirtyFingerprint).not.toBe(beforeEdit.dirtyFingerprint);
    } finally {
      await runtime.close();
      db.close();
    }
  });

  it('keeps runtime admission provenance attached to the parent-owned runtime', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-stdio-admission-identity-'));
    temporaryRoots.push(dataPath);
    const runtimeAdmissionIdentity = {
      runtimeDeploymentId: 'deploy-test',
      runtimeGeneration: 'f3ff1d58-d2ae-4af3-a52a-7f0b30f0f0a2',
      runtimeBuildVersion: '4.61.0+0123456789ab',
      runtimeBuildCommit: '0123456789abcdef0123456789abcdef01234567',
      runtimeBuildDirty: false,
      runtimeProtocolGeneration: 1,
      runtimeStartedAt: '2026-09-23T00:00:00.000Z',
    };
    const runtime = createStdioMcpRuntime(dataPath, workspace, false, { runtimeAdmissionIdentity });
    try {
      expect(runtime.runtimeAdmissionIdentity).toEqual(runtimeAdmissionIdentity);
    } finally {
      await runtime.close();
    }
  });

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

  it('retries a transient failed Thai-RAG start after the cooldown instead of keeping it for the process lifetime', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-stdio-rag-start-retry-'));
    temporaryRoots.push(dataPath);
    const healthy = { workerReachable: true, sqliteAvailable: true, ftsAvailable: true, vectorStoreAvailable: true, embedderAvailable: true, lexicalRetrievalAvailable: true, semanticRetrievalAvailable: true, activeJobs: [] };
    let startAttempts = 0;
    const driver: ThaiRagProviderDriver = {
      start: async () => {
        startAttempts += 1;
        if (startAttempts === 1) return err(appError('CONFLICT', 'Thai-RAG provider owner is locked but not reachable: connect ENOENT', true));
        return ok(healthy);
      },
      health: async () => ok(healthy),
      call: async () => ok({ retrieval: 'worked' }),
      stop: async () => ok(undefined),
    };
    const runtime = createStdioMcpRuntime(dataPath, workspace, false, { thaiRagDriver: driver, thaiRagStartRetryMs: 20 });
    try {
      const failed = await runtime.services.thaiRag?.call('code_search', { query: 'needle' });
      expect(failed).toMatchObject({ ok: false, error: { message: expect.stringContaining('locked but not reachable') } });
      expect(startAttempts).toBe(1);
      // Still inside the retry cooldown: the failed start stays cached, no new attempt runs.
      expect(await runtime.services.thaiRag?.call('code_search', { query: 'needle' })).toMatchObject({ ok: false });
      expect(startAttempts).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 30));
      const recovered = await runtime.services.thaiRag?.call('code_search', { query: 'needle' });
      expect(recovered).toMatchObject({ ok: true, value: { retrieval: 'worked' } });
      expect(startAttempts).toBe(2);
      // A settled successful start is kept for the process lifetime, like before.
      expect(await runtime.services.thaiRag?.call('code_search', { query: 'needle' })).toMatchObject({ ok: true });
      expect(startAttempts).toBe(2);
    } finally {
      await runtime.close();
    }
  });

  it('shares one in-flight Thai-RAG start across concurrent callers', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-stdio-rag-start-dedupe-'));
    temporaryRoots.push(dataPath);
    const healthy = { workerReachable: true, sqliteAvailable: true, ftsAvailable: true, vectorStoreAvailable: true, embedderAvailable: true, lexicalRetrievalAvailable: true, semanticRetrievalAvailable: true, activeJobs: [] };
    let startCalls = 0;
    const driver: ThaiRagProviderDriver = {
      start: async () => {
        startCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 25));
        return ok(healthy);
      },
      health: async () => ok(healthy),
      call: async () => ok({ once: startCalls }),
      stop: async () => ok(undefined),
    };
    const runtime = createStdioMcpRuntime(dataPath, workspace, false, { thaiRagDriver: driver });
    try {
      const [first, second] = await Promise.all([
        runtime.services.thaiRag?.call('code_search', { query: 'first' }),
        runtime.services.thaiRag?.call('code_search', { query: 'second' }),
      ]);
      expect(first).toMatchObject({ ok: true, value: { once: 1 } });
      expect(second).toMatchObject({ ok: true, value: { once: 1 } });
      expect(startCalls).toBe(1);
    } finally {
      await runtime.close();
    }
  });

  it('wires UNIFIED_THAI_RAG_FORWARD_ONLY into the coordinator so the runtime follows without ever electing (#407)', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-stdio-rag-forward-only-'));
    temporaryRoots.push(dataPath);
    const healthy = { workerReachable: true, sqliteAvailable: true, ftsAvailable: true, vectorStoreAvailable: true, embedderAvailable: true, lexicalRetrievalAvailable: true, semanticRetrievalAvailable: true, activeJobs: [] };
    let startCalls = 0;
    const driver: ThaiRagProviderDriver = {
      start: async () => { startCalls += 1; return ok(healthy); },
      health: async () => ok(healthy),
      call: async () => ok({ election: 'owner' }),
      stop: async () => ok(undefined),
    };
    const previousForwardOnly = process.env.UNIFIED_THAI_RAG_FORWARD_ONLY;
    process.env.UNIFIED_THAI_RAG_FORWARD_ONLY = '1';
    let runtime: ReturnType<typeof createStdioMcpRuntime> | undefined;
    try {
      runtime = createStdioMcpRuntime(dataPath, workspace, false, { thaiRagDriver: driver });
      // Forward-only never translates a healthy driver into an elected owner:
      // it connects to the designated owner socket and, with none around, fails
      // with the forward-only reason while the lock and driver stay untouched.
      const failed = await runtime.services.thaiRag?.call('code_search', { query: 'needle' });
      expect(failed).toMatchObject({
        ok: false,
        error: {
          code: 'CONFLICT',
          details: { reason: 'forward-host-unreachable' },
          message: expect.stringContaining('forward host is unreachable'),
        },
      });
      expect(startCalls).toBe(0);
      expect(existsSync(path.join(dataPath, 'thai-rag', 'provider.lock'))).toBe(false);
    } finally {
      if (previousForwardOnly === undefined) delete process.env.UNIFIED_THAI_RAG_FORWARD_ONLY;
      else process.env.UNIFIED_THAI_RAG_FORWARD_ONLY = previousForwardOnly;
      await runtime?.close();
    }
  });

  it('treats UNIFIED_THAI_RAG_FORWARD_ONLY=0 as the default election path (#407)', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-stdio-rag-forward-default-'));
    temporaryRoots.push(dataPath);
    const healthy = { workerReachable: true, sqliteAvailable: true, ftsAvailable: true, vectorStoreAvailable: true, embedderAvailable: true, lexicalRetrievalAvailable: true, semanticRetrievalAvailable: true, activeJobs: [] };
    let startCalls = 0;
    const driver: ThaiRagProviderDriver = {
      start: async () => { startCalls += 1; return ok(healthy); },
      health: async () => ok(healthy),
      call: async () => ok({ election: 'owner' }),
      stop: async () => ok(undefined),
    };
    const previousForwardOnly = process.env.UNIFIED_THAI_RAG_FORWARD_ONLY;
    process.env.UNIFIED_THAI_RAG_FORWARD_ONLY = '0';
    let runtime: ReturnType<typeof createStdioMcpRuntime> | undefined;
    try {
      runtime = createStdioMcpRuntime(dataPath, workspace, false, { thaiRagDriver: driver });
      await runtime.initializeThaiRag();
      const result = await runtime.services.thaiRag?.call('code_search', { query: 'needle' });
      expect(result).toMatchObject({ ok: true, value: { election: 'owner' } });
      expect(startCalls).toBe(1);
    } finally {
      if (previousForwardOnly === undefined) delete process.env.UNIFIED_THAI_RAG_FORWARD_ONLY;
      else process.env.UNIFIED_THAI_RAG_FORWARD_ONLY = previousForwardOnly;
      await runtime?.close();
    }
  });

  it('forwards the deployment-attested embedding env to the Thai-RAG data-owner launch (#413)', () => {
    const env = thaiRagProviderLaunchEnv({});
    expect(env.THAI_RAG_EMBEDDING_BACKEND).toBe('llamacpp');
    expect(env.THAI_RAG_LLAMACPP_MODEL).toBe(THAI_RAG_DEPLOYMENT_EMBEDDING_PROFILE);
    expect(env.THAI_RAG_DATA_OWNER_CONNECT_TIMEOUT).toBe('900');
    // One index batch embeds a whole file at once, so the deployment default
    // has to outlast the provider's 60s per-request default (#439).
    expect(env.THAI_RAG_LLAMACPP_REQUEST_TIMEOUT).toBe('300');
    // The Python provider already defaults the llama.cpp base URL; the launcher
    // must not duplicate that default, it only passes an explicit one through.
    expect(Object.hasOwn(env, 'THAI_RAG_LLAMACPP_BASE_URL')).toBe(false);
    expect(Object.hasOwn(env, 'THAI_RAG_LLAMACPP_MODEL_PATH')).toBe(false);
    // Server arguments stay the provider's default unless the host tuned them.
    expect(Object.hasOwn(env, 'THAI_RAG_LLAMACPP_SERVER_ARGS')).toBe(false);
  });

  it('forwards tuned llama.cpp server arguments so long chunks are not rejected (#438)', () => {
    // llama.cpp rejects any single input longer than its physical batch, so a
    // host that tuned `-b`/`-ub` must keep that tuning across the data-owner
    // launch; otherwise a cold start regresses to the 512-token default and the
    // vector channel degrades to zero vectors.
    const env = thaiRagProviderLaunchEnv({ THAI_RAG_LLAMACPP_SERVER_ARGS: '-b 2048 -ub 2048 --parallel 1' });
    expect(env.THAI_RAG_LLAMACPP_SERVER_ARGS).toBe('-b 2048 -ub 2048 --parallel 1');
  });

  it('keeps an explicitly configured embedding environment authoritative (#413)', () => {
    const env = thaiRagProviderLaunchEnv({
      THAI_RAG_EMBEDDING_BACKEND: 'ollama',
      THAI_RAG_LLAMACPP_BASE_URL: 'http://127.0.0.1:9999',
      THAI_RAG_LLAMACPP_MODEL_PATH: '/models/custom.gguf',
      THAI_RAG_LLAMACPP_MODEL: 'custom-model',
      THAI_RAG_DATA_OWNER_CONNECT_TIMEOUT: '60',
      THAI_RAG_LLAMACPP_REQUEST_TIMEOUT: '900',
      THAI_RAG_LLAMACPP_SERVER_ARGS: '-b 1024 -ub 1024',
    });
    expect(env.THAI_RAG_EMBEDDING_BACKEND).toBe('ollama');
    expect(env.THAI_RAG_LLAMACPP_BASE_URL).toBe('http://127.0.0.1:9999');
    expect(env.THAI_RAG_LLAMACPP_MODEL_PATH).toBe('/models/custom.gguf');
    expect(env.THAI_RAG_LLAMACPP_MODEL).toBe('custom-model');
    expect(env.THAI_RAG_DATA_OWNER_CONNECT_TIMEOUT).toBe('60');
    expect(env.THAI_RAG_LLAMACPP_REQUEST_TIMEOUT).toBe('900');
    expect(env.THAI_RAG_LLAMACPP_SERVER_ARGS).toBe('-b 1024 -ub 1024');
  });

  it('treats explicitly empty embedding env as unset (#413)', () => {
    const env = thaiRagProviderLaunchEnv({
      THAI_RAG_EMBEDDING_BACKEND: '',
      THAI_RAG_LLAMACPP_BASE_URL: '  ',
      THAI_RAG_LLAMACPP_MODEL_PATH: '',
      THAI_RAG_LLAMACPP_MODEL: '',
      THAI_RAG_DATA_OWNER_CONNECT_TIMEOUT: '',
      THAI_RAG_LLAMACPP_REQUEST_TIMEOUT: '',
      THAI_RAG_LLAMACPP_SERVER_ARGS: '   ',
    });
    expect(env.THAI_RAG_EMBEDDING_BACKEND).toBe('llamacpp');
    expect(env.THAI_RAG_LLAMACPP_MODEL).toBe(THAI_RAG_DEPLOYMENT_EMBEDDING_PROFILE);
    expect(env.THAI_RAG_DATA_OWNER_CONNECT_TIMEOUT).toBe('900');
    expect(env.THAI_RAG_LLAMACPP_REQUEST_TIMEOUT).toBe('300');
    expect(Object.hasOwn(env, 'THAI_RAG_LLAMACPP_BASE_URL')).toBe(false);
    expect(Object.hasOwn(env, 'THAI_RAG_LLAMACPP_MODEL_PATH')).toBe(false);
    expect(Object.hasOwn(env, 'THAI_RAG_LLAMACPP_SERVER_ARGS')).toBe(false);
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
      // #428: the pre-edit gate must be able to say why, not just "no scope".
      await expect(runtime.activeWorkspaceScopeUnavailableProvider()).resolves.toEqual({
        reason: 'workspace-archived',
        workspaceId: registered.id,
      });
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
      await expect(runtime.activeWorkspaceScopeUnavailableProvider()).resolves.toEqual({
        reason: 'workspace-row-missing',
        workspaceId: registered.id,
      });
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

    const registryDir = path.join(dataPath, 'extensions', 'mcp');
    await mkdir(registryDir, { recursive: true });
    await writeFile(path.join(registryDir, 'registry.json'), JSON.stringify({
      mcpServers: {
        'cross-process-mock': { command: 'node', args: ['mock-server.js'] },
      },
    }), 'utf8');

    const runtime = createStdioMcpRuntime(dataPath, workspace);
    const externalDatabase = new SqliteDatabase(path.join(dataPath, 'unified-mpc.sqlite'));
    const externalSettings = new SqliteSettingsRepository(externalDatabase);
    try {
      const before = await runtime.services.extensions.listMcpServers();
      expect(before.ok).toBe(true);
      if (!before.ok) throw new Error(before.error.message);
      expect(before.value.servers).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'cross-process-mock', command: 'node', enabled: true }),
      ]));

      externalSettings.set(EXTENSIONS_SETTINGS_KEY, JSON.stringify({
        ...DEFAULT_EXTENSIONS_SETTINGS,
        mandatoryMcpServers: [],
        disabledServers: ['cross-process-mock'],
      }));

      const updated = await runtime.services.extensions.listMcpServers();
      expect(updated.ok).toBe(true);
      if (!updated.ok) throw new Error(updated.error.message);
      expect(updated.value.servers).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'cross-process-mock', command: 'node', enabled: false }),
      ]));

      externalSettings.set(EXTENSIONS_SETTINGS_KEY, JSON.stringify({
        ...DEFAULT_EXTENSIONS_SETTINGS,
        mandatoryMcpServers: [],
      }));
      const restored = await runtime.services.extensions.listMcpServers();
      expect(restored.ok).toBe(true);
      if (!restored.ok) throw new Error(restored.error.message);
      expect(restored.value.servers).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'cross-process-mock', command: 'node', enabled: true }),
      ]));
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

  it('exposes a live authorization mode provider for Trusted Full Bypass', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-stdio-auth-mode-data-'));
    temporaryRoots.push(dataPath);
    let fullBypass = false;
    const runtime = createStdioMcpRuntime(dataPath, workspace, true, {
      permissionProfile: 'full',
      fullBypassAllProvider: () => fullBypass,
    });
    try {
      expect(runtime.authorizationModeProvider()).toBe('standard');
      fullBypass = true;
      expect(runtime.authorizationModeProvider()).toBe('full_bypass');
      fullBypass = false;
      expect(runtime.authorizationModeProvider()).toBe('standard');
    } finally {
      await runtime.close();
    }
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

  it('admits merge verification through the shared process controller', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'unified-merge-admission-'));
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'unified-merge-admission-project-'));
    temporaryRoots.push(dataPath, rootPath);
    const project = {
      id: 'merge-admission-project',
      displayName: 'Merge admission',
      rootPath,
      realRootPath: rootPath,
      createdAt: '2026-10-27T00:00:00.000Z',
    };
    const db = new SqliteDatabase(path.join(dataPath, 'unified-mpc.sqlite'));
    await new SqliteWorkspaceRepository(db).insert(project);
    const head = '1'.repeat(40);
    const base = '2'.repeat(40);
    const repository = 'soulzerox/Webtrans';
    const github = {
      get: async (): Promise<unknown> => ({
        number: 17,
        state: 'open',
        merged: false,
        head: { sha: head },
        base: { ref: 'main', sha: base, repo: { full_name: repository } },
      }),
    };
    const controller = sharedProcessResourceAdmissionController();
    const runtime = createStdioMcpRuntime(dataPath, project, false, { githubApi: github });
    if (controller.snapshot().pressureState === 'critical') {
      // A critically pressured host denies even the occupant, so the wiring
      // cannot be discriminated without turning this into a pressure test.
      await runtime.close();
      return;
    }
    const occupant = tryAdmitVerificationHeavy(controller, {
      operationId: 'merge-admission-occupant',
      workspaceId: 'merge-admission-occupant',
      cost: DEFAULT_VERIFICATION_HEAVY_ADMISSION_COST,
    });
    expect(occupant.admitted).toBe(true);
    if (!occupant.admitted) {
      await runtime.close();
      return;
    }
    try {
      const result = await runtime.services.mergeVerificationRun?.run({
        policy: {
          repository,
          defaultBranch: 'main',
          verificationMode: 'local_exact_head',
          requiredGates: [{
            name: 'noop',
            source: 'local_command',
            command: { executable: '/usr/bin/env', args: ['true'] },
          }],
          reviewPolicy: { required: true, acceptedOutcomes: ['clean_llm_review'] },
        },
        repository,
        pullRequest: 17,
        workspaceId: project.id,
        review: { outcome: 'clean_llm_review' },
      });
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'RESOURCE_PRESSURE' },
      });
    } finally {
      controller.release(occupant.lease);
      await runtime.close();
    }
  }, 15_000);
});
