import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SqliteDatabase, SqliteWorkspaceRepository } from '@unified-mpc/storage';
import { createPrivateFdAuthorizedClientFactory } from '@unified-mpc/extensions';
import { createThaiRagPrivateWorkerBootstrap } from './native-thai-rag-private-bootstrap.js';
import { CrossProcessWorkspaceAuthorityWatcher, LocalWorkspaceAuthorityEpoch } from './workspace-authority-epoch.js';

const WS = '14fc20d1-5836-4faf-aed6-0df6a9633a38';

describe('cross-process committed registry epoch watcher', () => {
  it('revokes idle child signals on a remote committed SQL mutation, not rollback; closes without leaking the watcher', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'strict-fd3-watch-sqlite-'));
    const pathToDatabase = path.join(root, 'state.sqlite');
    const host = new SqliteDatabase(pathToDatabase);
    const peer = new SqliteDatabase(pathToDatabase);
    const owner = new SqliteWorkspaceRepository(host);
    const remote = new SqliteWorkspaceRepository(peer);
    const local = new LocalWorkspaceAuthorityEpoch();
    const watch = new CrossProcessWorkspaceAuthorityWatcher((): number => owner.readAuthorityGeneration(), local, 15);
    try {
      await remote.insert({ id: WS, displayName: 'Workspace', rootPath: root, realRootPath: root,
        createdAt: new Date(0).toISOString() });
      const old = watch.signal();
      expect(old.aborted).toBe(false);
      peer.connection.exec('BEGIN IMMEDIATE;');
      peer.connection.prepare('UPDATE workspaces SET display_name = ? WHERE id = ?').run('Rollback', WS);
      peer.connection.exec('ROLLBACK;');
      await new Promise<void>(resolve => setTimeout(resolve, 50));
      expect(old.aborted).toBe(false);
      peer.connection.prepare('UPDATE workspaces SET writer_lease_generation = ? WHERE id = ?').run(2, WS);
      await expect.poll(() => old.aborted, { interval: 10, timeout: 2_000 }).toBe(true);
      const renewed = watch.signal();
      expect(renewed.aborted).toBe(false);
      expect(renewed).not.toBe(old);
      watch.close();
      expect(renewed.aborted).toBe(true);
      expect(() => watch.signal()).toThrow('workspace_authority_watch_closed');
    } finally { watch.close(); peer.close(); host.close(); await rm(root, { recursive: true, force: true }); }
  });

  it('aborts a pending inherited FD3 RPC when a separate SQLite writer revokes authority', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'strict-fd3-watch-pending-'));
    const project = path.join(root, 'project');
    await mkdir(project);
    const host = new SqliteDatabase(path.join(root, 'state.sqlite'));
    const peer = new SqliteDatabase(path.join(root, 'state.sqlite'));
    const hostRegistry = new SqliteWorkspaceRepository(host);
    const writerRegistry = new SqliteWorkspaceRepository(peer);
    const local = new LocalWorkspaceAuthorityEpoch();
    const watch = new CrossProcessWorkspaceAuthorityWatcher((): number => hostRegistry.readAuthorityGeneration(), local, 20);
    const fixture = path.resolve(process.cwd(), '../../packages/extensions/tests/fixtures/private-fd-authorized-mcp-server.mjs');
    try {
      await writerRegistry.insert({ id: WS, displayName: 'Workspace', rootPath: project, realRootPath: project,
        createdAt: new Date(0).toISOString() });
      const factory = createPrivateFdAuthorizedClientFactory({
        createBootstrap: () => createThaiRagPrivateWorkerBootstrap({
          ownerId: 'unified-crossprocess-pending-test', authorityGeneration: local.currentGeneration(),
          revocationSignal: watch.signal(),
          registryGenerationProvider: (): number => hostRegistry.readAuthorityGeneration(),
          workspacesProvider: async () => (await hostRegistry.list()).map(x => ({ id: x.id, realRootPath: x.realRootPath })),
        }),
      });
      const session = await factory.connect({ command: process.execPath, args: [fixture] });
      try {
        expect((await session.listTools()).some(x => x.name === 'recall')).toBe(true);
        const pending = session.callTool('recall', { workspace_id: WS, query: 'pending', delay_ms: 1000 });
        await new Promise<void>(resolve => setTimeout(resolve, 70));
        await writerRegistry.archive(WS);
        await expect(pending).rejects.toThrow('workspace_authority_denied');
        await expect(session.listTools()).rejects.toThrow('workspace_authority_denied');
      } finally { await session.close(); }
    } finally { watch.close(); peer.close(); host.close(); await rm(root, { recursive: true, force: true }); }
  });

  it('fails closed on lost epoch read, without reviving old generations when the reader recovers', () => {
    let epoch = 1;
    let broken = false;
    const local = new LocalWorkspaceAuthorityEpoch();
    const watch = new CrossProcessWorkspaceAuthorityWatcher((): number => {
      if (broken) throw Error('sql_error');
      return epoch;
    }, local, 100);
    try {
      const first = watch.signal();
      broken = true;
      expect(() => watch.checkNow()).toThrow('workspace_authority_epoch_unavailable');
      expect(first.aborted).toBe(true);
      broken = false;
      const recovered = watch.signal();
      expect(recovered.aborted).toBe(false);
      expect(recovered).not.toBe(first);
      epoch += 1;
      watch.checkNow();
      expect(recovered.aborted).toBe(true);
    } finally { watch.close(); }
  });
});
