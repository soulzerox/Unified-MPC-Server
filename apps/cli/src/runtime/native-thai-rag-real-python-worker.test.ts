import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPrivateFdAuthorizedClientFactory } from '@unified-mpc/extensions';
import { SqliteDatabase, SqliteWorkspaceRepository } from '@unified-mpc/storage';
import type { WorkspaceAdmissionReceipt } from '@unified-mpc/domain';
import { CrossProcessWorkspaceAuthorityWatcher, LocalWorkspaceAuthorityEpoch } from './workspace-authority-epoch.js';
import { createThaiRagPrivateWorkerBootstrap } from './native-thai-rag-private-bootstrap.js';
import { createStrictThaiRagGoalAdmissionProvider } from './native-thai-rag-goal-admission.js';

const WS = '14fc20d1-5836-4faf-aed6-0df6a9633a38';
const OTHER = 'ee83c457-0b79-49d7-937e-5c35aa91975d';
const python = process.env.THAI_RAG_REAL_PYTHON;
const source = process.env.THAI_RAG_REAL_SOURCE;
const execFileAsync = promisify(execFile);

describe('real Python strict FD3 worker cross-repository E2E (explicit opt-in)', () => {
  it.skipIf(!python || !source)(
    'verifies the actual Python FastMCP challenge, scopes, and revocation before IPC',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'strict-python-fd3-e2e-'));
      let registered = true;
      try {
        const factory = createPrivateFdAuthorizedClientFactory({
          createBootstrap: () => createThaiRagPrivateWorkerBootstrap({
            ownerId: 'unified-real-python-e2e', authorityGeneration: 23,
            workspacesProvider: async () => registered ? [{ id: WS, realRootPath: root }] : [],
          }),
        });
        const session = await factory.connect({
          command: python!,
          args: ['-m', 'thai_rag.server'],
          env: { PYTHONPATH: source! },
        });
        try {
          const tools = await session.listTools();
          expect(tools.some(tool => tool.name === 'recall')).toBe(true);
          expect(tools.some(tool => tool.name === 'worker_authority_probe')).toBe(false);
          await expect(session.callTool('recall', { workspace_id: OTHER, query: 'forged' }))
            .rejects.toThrow('workspace_authority_denied');
          await expect(session.callTool('recall', { workspace_id: WS, query: 'attack',
            authority_proof: 'forged' })).rejects.toThrow('workspace_authority_denied');
          registered = false;
          // No further operation is required to fence the existing Python child.
          await expect.poll(async () => {
            try { await session.listTools(); return false; } catch { return true; }
          }, { timeout: 3_000, interval: 50 }).toBe(true);
          // Restoring the same registration cannot revive its old secret.
          registered = true;
          await expect(session.callTool('recall', { workspace_id: WS, query: 'revoked' }))
            .rejects.toThrow('workspace_authority_denied');
        } finally {
          await session.close();
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }, 45_000,
  );

  it.skipIf(!python || !source)(
    'fences idle actual Python worker on root symlink swap and refuses restored path',
    async () => {
      const base = await mkdtemp(path.join(os.tmpdir(), 'strict-python-root-swap-'));
      const root = path.join(base, 'root');
      const other = path.join(base, 'other');
      try {
        await mkdir(root);
        await mkdir(other);
        const factory = createPrivateFdAuthorizedClientFactory({
          createBootstrap: () => createThaiRagPrivateWorkerBootstrap({
            ownerId: 'unified-real-python-root-swap', authorityGeneration: 24,
            workspacesProvider: async () => [{ id: WS, realRootPath: root }],
          }),
        });
        const session = await factory.connect({
          command: python!,
          args: ['-m', 'thai_rag.server'],
          env: { PYTHONPATH: source! },
        });
        try {
          expect((await session.listTools()).some(t => t.name === 'recall')).toBe(true);
          await rm(root, { recursive: true });
          await symlink(other, root);
          await expect.poll(async () => {
            try { await session.listTools(); return false; } catch { return true; }
          }, { timeout: 3_000, interval: 50 }).toBe(true);
          await rm(root);
          await mkdir(root);
          await expect(session.callTool('health', {}))
            .rejects.toThrow('workspace_authority_denied');
        } finally { await session.close(); }
      } finally { await rm(base, { recursive: true, force: true }); }
    }, 45_000,
  );

  it.skipIf(!python || !source)(
    'excludes invalidated Goal admission from NEW real Python FD3 worker while preserving ordinary project scope',
    async () => {
      const base = await mkdtemp(path.join(os.tmpdir(), 'strict-python-new-admission-'));
      const goalRoot = path.join(base, 'goal');
      const projectRoot = path.join(base, 'project');
      await mkdir(goalRoot);
      await mkdir(projectRoot);
      const filename = path.join(base, 'state.sqlite');
      const host = new SqliteDatabase(filename);
      const peer = new SqliteDatabase(filename);
      const hostRegistry = new SqliteWorkspaceRepository(host);
      const writer = new SqliteWorkspaceRepository(peer);
      const epoch = new LocalWorkspaceAuthorityEpoch();
      const watcher = new CrossProcessWorkspaceAuthorityWatcher(
        (): number => hostRegistry.readAuthorityGeneration(), epoch, 20,
      );
      try {
        await writer.insert({ id: OTHER, displayName: 'Project', rootPath: projectRoot,
          realRootPath: projectRoot, createdAt: new Date(0).toISOString() });
        await writer.insert({ id: WS, displayName: 'Goal', rootPath: goalRoot,
          realRootPath: goalRoot, createdAt: new Date(0).toISOString(),
          lifecycleKind: 'goal', goalWorkspaceKind: 'snapshot', goalId: 'goal-1' });
        const lease = await writer.acquireGoalWriterLease(
          WS, 'lease-1', 'owner-1', '2026-10-09T08:00:00.000Z', '2026-10-10T08:00:00.000Z',
        );
        expect(lease).not.toBeNull();
        const admission: WorkspaceAdmissionReceipt = {
          admissionId: 'admission-1', projectId: OTHER, workspaceId: WS, goalId: 'goal-1',
          workspaceKind: 'non_git', worktreeIdentity: goalRoot, branchName: 'goal/1',
          expectedWorkspaceHead: '1'.repeat(40), observedWorkspaceHead: '1'.repeat(40),
          dirtyState: 'clean', dirtyFingerprint: 'clean', writeLeaseGeneration: lease!.generation,
          runtimeDeploymentId: 'deploy-1', runtimeGeneration: 'gen-1', runtimeBuildVersion: '4.61.0',
          runtimeBuildDirty: false, runtimeProtocolGeneration: 1,
          runtimeStartedAt: '2026-10-09T08:00:00.000Z', workflowVersion: 1,
          admissionGeneration: 1, createdAt: '2026-10-09T08:00:00.000Z',
        };
        expect(await writer.compareAndSwapAdmissionReceipt(WS, 0, lease!.generation, admission)).toBe(true);
        const allowed = createStrictThaiRagGoalAdmissionProvider(hostRegistry);
        expect((await allowed()).map(x => x.id).sort()).toEqual([OTHER, WS].sort());
        const factory = createPrivateFdAuthorizedClientFactory({
          createBootstrap: () => createThaiRagPrivateWorkerBootstrap({
            ownerId: 'unified-new-worker-admission', authorityGeneration: epoch.currentGeneration(),
            workspacesProvider: allowed, revocationSignal: watcher.signal(),
            registryGenerationProvider: (): number => hostRegistry.readAuthorityGeneration(),
          }),
        });
        const launch = { command: python!, args: ['-m', 'thai_rag.server'], env: { PYTHONPATH: source! } };
        const old = await factory.connect(launch);
        try {
          expect((await old.listTools()).some(x => x.name === 'recall')).toBe(true);
          expect(await writer.invalidateAdmissionReceipt(
            WS, 1, 'goal_admission_revoked', '2026-10-09T09:30:00.000Z',
          )).toBe(true);
          await expect(old.callTool('health', {})).rejects.toThrow('workspace_authority_denied');
          expect((await allowed()).map(x => x.id)).toEqual([OTHER]);
          const renewed = await factory.connect(launch);
          try {
            expect((await renewed.callTool('health', {})).isError).not.toBe(true);
            await expect(renewed.callTool('recall', { workspace_id: WS, query: 'not-admitted' }))
              .rejects.toThrow('workspace_authority_denied');
            // No effect of the invalidation on unrelated ordinary projects.
            await expect(renewed.callTool('recall', { workspace_id: OTHER, query: 'project' }))
              .resolves.toHaveProperty('content');
          } finally { await renewed.close(); }
        } finally { await old.close(); }
      } finally { watcher.close(); peer.close(); host.close(); await rm(base, { recursive: true, force: true }); }
    }, 45_000,
  );

  it.skipIf(!python || !source)(
    'fences real Python FD3 Goal workers on Git HEAD drift without any SQLite mutation while retaining project scope',
    async () => {
      const base = await mkdtemp(path.join(os.tmpdir(), 'strict-python-git-head-drift-'));
      const goalRoot = path.join(base, 'goal');
      const projectRoot = path.join(base, 'project');
      await mkdir(goalRoot);
      await mkdir(projectRoot);
      const git = async (args: readonly string[]): Promise<string> => {
        const command = await execFileAsync('git', [...args], { cwd: goalRoot, timeout: 8_000, windowsHide: true });
        return command.stdout.trim();
      };
      const dbFile = path.join(base, 'authority.sqlite');
      const host = new SqliteDatabase(dbFile);
      const writerDb = new SqliteDatabase(dbFile);
      const hostRegistry = new SqliteWorkspaceRepository(host);
      const writer = new SqliteWorkspaceRepository(writerDb);
      const epoch = new LocalWorkspaceAuthorityEpoch();
      const watcher = new CrossProcessWorkspaceAuthorityWatcher(
        (): number => hostRegistry.readAuthorityGeneration(), epoch, 20,
      );
      try {
        await git(['init', '-b', 'goal/1']);
        await git(['-c', 'user.email=test@example.invalid', '-c', 'user.name=Test',
          'commit', '--allow-empty', '-m', 'admitted']);
        const admittedHead = await git(['rev-parse', '--verify', 'HEAD^{commit}']);
        await writer.insert({ id: OTHER, displayName: 'Project', rootPath: projectRoot,
          realRootPath: projectRoot, createdAt: new Date(0).toISOString() });
        await writer.insert({ id: WS, displayName: 'Git Goal', rootPath: goalRoot,
          realRootPath: goalRoot, createdAt: new Date(0).toISOString(), lifecycleKind: 'goal',
          goalWorkspaceKind: 'git_worktree', goalId: 'goal-1', branchName: 'goal/1' });
        const lease = await writer.acquireGoalWriterLease(
          WS, 'lease-1', 'owner-1', '2026-10-09T08:00:00.000Z', '2026-10-10T08:00:00.000Z',
        );
        expect(lease).not.toBeNull();
        const admission: WorkspaceAdmissionReceipt = {
          admissionId: 'admission-1', projectId: OTHER, workspaceId: WS, goalId: 'goal-1',
          workspaceKind: 'git', worktreeIdentity: goalRoot, branchName: 'goal/1',
          expectedWorkspaceHead: admittedHead, observedWorkspaceHead: admittedHead,
          dirtyState: 'clean', dirtyFingerprint: 'clean', writeLeaseGeneration: lease!.generation,
          runtimeDeploymentId: 'deploy-1', runtimeGeneration: 'gen-1', runtimeBuildVersion: '4.61.0',
          runtimeBuildDirty: false, runtimeProtocolGeneration: 1,
          runtimeStartedAt: '2026-10-09T08:00:00.000Z', workflowVersion: 1,
          admissionGeneration: 1, createdAt: '2026-10-09T08:00:00.000Z',
        };
        expect(await writer.compareAndSwapAdmissionReceipt(WS, 0, lease!.generation, admission)).toBe(true);
        const authorized = createStrictThaiRagGoalAdmissionProvider(hostRegistry);
        expect((await authorized()).map(x => x.id).sort()).toEqual([OTHER, WS].sort());
        const factory = createPrivateFdAuthorizedClientFactory({
          createBootstrap: () => createThaiRagPrivateWorkerBootstrap({
            ownerId: 'unified-git-head-fd3', authorityGeneration: epoch.currentGeneration(),
            workspacesProvider: authorized, revocationSignal: watcher.signal(),
            registryGenerationProvider: (): number => hostRegistry.readAuthorityGeneration(),
          }),
        });
        const launch = { command: python!, args: ['-m', 'thai_rag.server'], env: { PYTHONPATH: source! } };
        const old = await factory.connect(launch);
        try {
          expect((await old.listTools()).some(tool => tool.name === 'recall')).toBe(true);
          const unchangedSqliteEpoch = hostRegistry.readAuthorityGeneration();
          await git(['-c', 'user.email=test@example.invalid', '-c', 'user.name=Test',
            'commit', '--allow-empty', '-m', 'moved-without-registration-update']);
          expect(await git(['rev-parse', 'HEAD'])).not.toBe(admittedHead);
          expect(hostRegistry.readAuthorityGeneration()).toBe(unchangedSqliteEpoch);
          await expect(old.callTool('health', {})).rejects.toThrow('workspace_authority_denied');
          expect((await authorized()).map(x => x.id)).toEqual([OTHER]);
          const renewed = await factory.connect(launch);
          try {
            expect((await renewed.callTool('health', {})).isError).not.toBe(true);
            await expect(renewed.callTool('recall', { workspace_id: WS, query: 'stale-head' }))
              .rejects.toThrow('workspace_authority_denied');
            await expect(renewed.callTool('recall', { workspace_id: OTHER, query: 'project' }))
              .resolves.toHaveProperty('content');
          } finally { await renewed.close(); }
        } finally { await old.close(); }
      } finally { watcher.close(); writerDb.close(); host.close(); await rm(base, { recursive: true, force: true }); }
    }, 45_000,
  );

  it.skipIf(!python || !source)(
    'revokes an idle real Python FD3 child on an external committed workspace admission receipt invalidation',
    async () => {
      const base = await mkdtemp(path.join(os.tmpdir(), 'strict-python-admission-revoke-'));
      const root = path.join(base, 'project');
      await mkdir(root);
      const filename = path.join(base, 'state.sqlite');
      const host = new SqliteDatabase(filename);
      const peer = new SqliteDatabase(filename);
      const hostRegistry = new SqliteWorkspaceRepository(host);
      const peerRegistry = new SqliteWorkspaceRepository(peer);
      const local = new LocalWorkspaceAuthorityEpoch();
      const watcher = new CrossProcessWorkspaceAuthorityWatcher(
        (): number => hostRegistry.readAuthorityGeneration(), local, 20,
      );
      try {
        await peerRegistry.insert({
          id: WS, displayName: 'Admission', rootPath: root, realRootPath: root,
          createdAt: new Date(0).toISOString(), lifecycleKind: 'goal', goalId: 'goal-1',
        });
        const lease = await peerRegistry.acquireGoalWriterLease(
          WS, 'lease-1', 'owner-1', '2026-10-09T09:00:00.000Z', '2026-10-10T00:00:00.000Z',
        );
        expect(lease).not.toBeNull();
        const receipt: WorkspaceAdmissionReceipt = {
          admissionId: 'admission-1', projectId: 'project-1', workspaceId: WS, goalId: 'goal-1',
          workspaceKind: 'git', worktreeIdentity: root, branchName: 'goal/1',
          expectedWorkspaceHead: '1'.repeat(40), observedWorkspaceHead: '1'.repeat(40),
          baseRef: 'origin/main', expectedBaseSha: '2'.repeat(40), resolvedBaseSha: '2'.repeat(40),
          mergeBaseSha: '2'.repeat(40), dirtyState: 'clean', dirtyFingerprint: 'clean',
          checkpointId: 'checkpoint-1', checkpointRevision: 1, writeLeaseGeneration: lease!.generation,
          runtimeDeploymentId: 'deploy-1', runtimeGeneration: 'generation-1', runtimeBuildVersion: '1.0.0',
          runtimeBuildDirty: false, runtimeProtocolGeneration: 1, runtimeStartedAt: '2026-10-09T09:00:00.000Z',
          workflowVersion: 1, admissionGeneration: 1, createdAt: '2026-10-09T09:00:00.000Z',
        };
        expect(await peerRegistry.compareAndSwapAdmissionReceipt(WS, 0, lease!.generation, receipt)).toBe(true);
        const factory = createPrivateFdAuthorizedClientFactory({
          createBootstrap: () => createThaiRagPrivateWorkerBootstrap({
            ownerId: 'unified-real-python-admission', authorityGeneration: local.currentGeneration(),
            registryGenerationProvider: (): number => hostRegistry.readAuthorityGeneration(),
            revocationSignal: watcher.signal(),
            workspacesProvider: async () => (await hostRegistry.list()).map(x => ({ id: x.id, realRootPath: x.realRootPath })),
          }),
        });
        const old = await factory.connect({
          command: python!, args: ['-m', 'thai_rag.server'], env: { PYTHONPATH: source! },
        });
        try {
          expect((await old.listTools()).some(x => x.name === 'health')).toBe(true);
          const oldSignal = watcher.signal();
          const before = hostRegistry.readAuthorityGeneration();
          expect(await peerRegistry.invalidateAdmissionReceipt(
            WS, 1, 'writer_authority_changed', '2026-10-09T09:30:00.000Z',
          )).toBe(true);
          expect(hostRegistry.readAuthorityGeneration()).toBe(before + 1);
          await expect.poll(() => oldSignal.aborted, { interval: 10, timeout: 2_000 }).toBe(true);
          await expect(old.callTool('health', {})).rejects.toThrow('workspace_authority_denied');
          // The registry root itself was never archived or relinked.
          expect((await hostRegistry.get(WS))?.realRootPath).toBe(root);
        } finally { await old.close(); }
      } finally { watcher.close(); peer.close(); host.close(); await rm(base, { recursive: true, force: true }); }
    }, 45_000,
  );

  it.skipIf(!python || !source)(
    'proactively terminates idle real Python FD3 worker after an external writer-lease generation SQL mutation',
    async () => {
      const base = await mkdtemp(path.join(os.tmpdir(), 'strict-python-watch-idle-'));
      const root = path.join(base, 'project');
      await mkdir(root);
      const host = new SqliteDatabase(path.join(base, 'state.sqlite'));
      const webui = new SqliteDatabase(path.join(base, 'state.sqlite'));
      const owner = new SqliteWorkspaceRepository(host);
      const writer = new SqliteWorkspaceRepository(webui);
      const local = new LocalWorkspaceAuthorityEpoch();
      const watcher = new CrossProcessWorkspaceAuthorityWatcher((): number => owner.readAuthorityGeneration(), local, 20);
      try {
        await writer.insert({ id: WS, displayName: 'Live', rootPath: root, realRootPath: root,
          createdAt: new Date(0).toISOString() });
        const factory = createPrivateFdAuthorizedClientFactory({
          createBootstrap: () => createThaiRagPrivateWorkerBootstrap({
            ownerId: 'unified-real-python-idle-watch', authorityGeneration: local.currentGeneration(),
            registryGenerationProvider: (): number => owner.readAuthorityGeneration(),
            workspacesProvider: async () => (await owner.list()).map(x => ({ id: x.id, realRootPath: x.realRootPath })),
            revocationSignal: watcher.signal(),
          }),
        });
        const launch = { command: python!, args: ['-m', 'thai_rag.server'], env: { PYTHONPATH: source! } };
        const old = await factory.connect(launch);
        try {
          expect((await old.listTools()).some(t => t.name === 'health')).toBe(true);
          const oldSignal = watcher.signal();
          webui.connection.prepare('UPDATE workspaces SET writer_lease_generation = ? WHERE id = ?').run(11, WS);
          // No new call to Python: the HOST watcher aborts the existing
          // child signal. Python effects that already ran are not undone.
          await expect.poll(() => oldSignal.aborted, { interval: 10, timeout: 2_000 }).toBe(true);
          await expect(old.listTools()).rejects.toThrow('workspace_authority_denied');
          const renewed = await factory.connect(launch);
          try {
            expect((await renewed.callTool('health', {})).isError).not.toBe(true);
          } finally { await renewed.close(); }
        } finally { await old.close(); }
      } finally { watcher.close(); webui.close(); host.close(); await rm(base, { recursive: true, force: true }); }
    }, 45_000,
  );

  it.skipIf(!python || !source)(
    'denies old Python FD3 child after archive+restore from an independent SQLite connection before a polling interval',
    async () => {
      const base = await mkdtemp(path.join(os.tmpdir(), 'strict-python-crossprocess-'));
      const filename = path.join(base, 'runtime.sqlite');
      const root = path.join(base, 'project');
      await mkdir(root);
      const host = new SqliteDatabase(filename);
      const webui = new SqliteDatabase(filename);
      const hostRegistry = new SqliteWorkspaceRepository(host);
      const webuiRegistry = new SqliteWorkspaceRepository(webui);
      const workspace = { id: WS, displayName: 'Cross-process', rootPath: root, realRootPath: root,
        createdAt: new Date(0).toISOString() };
      try {
        await webuiRegistry.insert(workspace);
        const factory = createPrivateFdAuthorizedClientFactory({
          createBootstrap: () => createThaiRagPrivateWorkerBootstrap({
            ownerId: 'unified-real-crossprocess', authorityGeneration: hostRegistry.readAuthorityGeneration(),
            registryGenerationProvider: () => hostRegistry.readAuthorityGeneration(),
            workspacesProvider: async () => (await hostRegistry.list()).map(x => ({
              id: x.id, realRootPath: x.realRootPath,
            })),
          }),
        });
        const launch = { command: python!, args: ['-m', 'thai_rag.server'], env: { PYTHONPATH: source! } };
        const old = await factory.connect(launch);
        try {
          expect((await old.listTools()).some(x => x.name === 'recall')).toBe(true);
          const prior = hostRegistry.readAuthorityGeneration();
          // WebUI's independent connection knows nothing about STDIO's
          // in-memory AbortSignal. Return the same root before the next call.
          await webuiRegistry.archive(WS);
          await webuiRegistry.restore(WS);
          expect(hostRegistry.readAuthorityGeneration()).toBe(prior + 2);
          await expect(old.callTool('health', {})).rejects.toThrow('workspace_authority_denied');
          const fresh = await factory.connect(launch);
          try {
            const response = await fresh.callTool('health', {});
            expect(response.isError).not.toBe(true);
            await expect(old.listTools()).rejects.toThrow('workspace_authority_denied');
          } finally { await fresh.close(); }
        } finally { await old.close(); }
      } finally {
        webui.close(); host.close();
        await rm(base, { recursive: true, force: true });
      }
    }, 45_000,
  );

  it.skipIf(!python || !source)(
    'SQLite unregister/relink publishes a synchronous host revocation to the real Python worker',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'strict-python-sqlite-revocation-'));
      const epoch = new LocalWorkspaceAuthorityEpoch();
      const database = new SqliteDatabase(':memory:');
      const repository = new SqliteWorkspaceRepository(database, {
        onBeforeAuthorityMutation: epoch.revokeBeforeMutation,
      });
      const workspace = { id: WS, displayName: 'Live SQL workspace', rootPath: root,
        realRootPath: root, createdAt: new Date(0).toISOString() };
      try {
        await repository.insert(workspace);
        const factory = createPrivateFdAuthorizedClientFactory({
          createBootstrap: () => createThaiRagPrivateWorkerBootstrap({
            ownerId: 'unified-real-sqlite-epoch', authorityGeneration: epoch.currentGeneration(),
            workspacesProvider: async () => (await repository.list()).map(x => ({ id: x.id, realRootPath: x.realRootPath })),
            revocationSignal: epoch.signal(),
          }),
        });
        const launch = { command: python!, args: ['-m', 'thai_rag.server'], env: { PYTHONPATH: source! } };
        const old = await factory.connect(launch);
        try {
          expect((await old.listTools()).some(x => x.name === 'recall')).toBe(true);
          const oldEpoch = epoch.currentGeneration();
          await repository.archive(WS);
          expect(epoch.currentGeneration()).toBe(oldEpoch + 1);
          await expect(old.callTool('health', {})).rejects.toThrow('workspace_authority_denied');
          await repository.restore(WS);
          const fresh = await factory.connect(launch);
          try {
            expect((await fresh.listTools()).some(x => x.name === 'health')).toBe(true);
            expect((await fresh.callTool('health', {})).isError).not.toBe(true);
            await expect(old.callTool('health', {})).rejects.toThrow('workspace_authority_denied');
          } finally { await fresh.close(); }
        } finally { await old.close(); }
      } finally { database.close(); await rm(root, { recursive: true, force: true }); }
    }, 45_000,
  );

  it.skipIf(!python || !source)(
    'reacts to a host revocation event and restarts the real Python child under a rotated generation',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'strict-python-revocation-event-'));
      let generation = 31;
      let controller = new AbortController();
      const factory = createPrivateFdAuthorizedClientFactory({
        createBootstrap: () => createThaiRagPrivateWorkerBootstrap({
          ownerId: 'unified-real-python-event', authorityGeneration: generation,
          workspacesProvider: async () => [{ id: WS, realRootPath: root }],
          revocationSignal: controller.signal,
        }),
      });
      const launch = { command: python!, args: ['-m', 'thai_rag.server'], env: { PYTHONPATH: source! } };
      try {
        const old = await factory.connect(launch);
        try {
          expect((await old.listTools()).some(t => t.name === 'health')).toBe(true);
          controller.abort();
          await expect(old.callTool('health', {})).rejects.toThrow('workspace_authority_denied');
          await expect(old.listTools()).rejects.toThrow('workspace_authority_denied');

          generation = 32;
          controller = new AbortController();
          const fresh = await factory.connect(launch);
          try {
            expect((await fresh.listTools()).some(t => t.name === 'health')).toBe(true);
            const result = await fresh.callTool('health', {});
            expect(result.isError).not.toBe(true);
            await expect(old.callTool('health', {})).rejects.toThrow('workspace_authority_denied');
          } finally { await fresh.close(); }
        } finally { await old.close(); }
      } finally { await rm(root, { recursive: true, force: true }); }
    }, 45_000,
  );
});
