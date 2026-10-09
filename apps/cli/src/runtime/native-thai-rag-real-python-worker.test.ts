import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPrivateFdAuthorizedClientFactory } from '@unified-mpc/extensions';
import { SqliteDatabase, SqliteWorkspaceRepository } from '@unified-mpc/storage';
import { LocalWorkspaceAuthorityEpoch } from './workspace-authority-epoch.js';
import { createThaiRagPrivateWorkerBootstrap } from './native-thai-rag-private-bootstrap.js';

const WS = '14fc20d1-5836-4faf-aed6-0df6a9633a38';
const OTHER = 'ee83c457-0b79-49d7-937e-5c35aa91975d';
const python = process.env.THAI_RAG_REAL_PYTHON;
const source = process.env.THAI_RAG_REAL_SOURCE;

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
