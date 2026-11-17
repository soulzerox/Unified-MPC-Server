import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteDatabase } from './database.js';
import {
  DEFERRED_HANDLE_PROVIDERS,
  DeferredHandleStoreError,
  SqliteDeferredHandleRepository,
} from './deferred-handle-repository.js';
import { SqliteWorkspaceRepository } from './workspace-repository.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(): Promise<{
  readonly database: SqliteDatabase;
  readonly handles: SqliteDeferredHandleRepository;
  readonly root: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'deferred-handles-'));
  temporaryRoots.push(root);
  const database = new SqliteDatabase(path.join(root, 'state.sqlite'));
  // `deferred_handles.workspace_id` references workspaces(id), so the host that
  // journaled the call has to exist first.
  await new SqliteWorkspaceRepository(database).insert({
    id: 'ws-1',
    displayName: 'one',
    rootPath: path.join(root, 'one'),
    realRootPath: path.join(root, 'one'),
    createdAt: new Date(0).toISOString(),
  });
  return { database, handles: new SqliteDeferredHandleRepository(database), root };
}

describe('SqliteDeferredHandleRepository', () => {
  it('remembers the handle a call returned, scoped to its workspace', async () => {
    const { handles } = await setup();
    handles.record({ workspaceId: 'ws-1', callId: 'call-1', provider: 'task', handleId: 'task-1' });
    handles.record({ workspaceId: 'ws-1', callId: 'call-2', provider: 'process', handleId: 'proc-1' });

    expect(handles.take('ws-1', ['call-1'])).toEqual([
      expect.objectContaining({ callId: 'call-1', provider: 'task', handleId: 'task-1' }),
    ]);
    expect(handles.take('ws-1', ['call-1', 'call-2', 'never-recorded'])).toHaveLength(2);
    // Another workspace asking for the same call ids learns nothing: the handle
    // belongs to the host that created it, and quoting it elsewhere would let one
    // workspace's verdict speak for another's work.
    expect(handles.take('ws-2', ['call-1', 'call-2'])).toEqual([]);
  });

  it('keeps the first handle for a call instead of overwriting it', async () => {
    const { handles } = await setup();
    handles.record({ workspaceId: 'ws-1', callId: 'call-1', provider: 'task', handleId: 'task-1' });
    handles.record({ workspaceId: 'ws-1', callId: 'call-1', provider: 'task', handleId: 'task-2' });

    expect(handles.take('ws-1', ['call-1'])).toEqual([
      expect.objectContaining({ handleId: 'task-1' }),
    ]);
  });

  it('forgets settled calls and leaves the rest alone', async () => {
    const { handles } = await setup();
    handles.record({ workspaceId: 'ws-1', callId: 'call-1', provider: 'task', handleId: 'task-1' });
    handles.record({ workspaceId: 'ws-1', callId: 'call-2', provider: 'task', handleId: 'task-2' });

    expect(handles.forget('ws-1', ['call-1'])).toBe(1);
    expect(handles.take('ws-1', ['call-1', 'call-2'])).toEqual([
      expect.objectContaining({ callId: 'call-2' }),
    ]);
  });

  it('refuses a provider no adapter can answer, so its call stays pinned', async () => {
    const { database, handles } = await setup();
    expect(() => handles.record({
      workspaceId: 'ws-1',
      callId: 'call-1',
      provider: 'telepathy' as never,
      handleId: 'x',
    })).toThrow(DeferredHandleStoreError);
    expect(handles.take('ws-1', ['call-1'])).toEqual([]);
    // The DDL holds the same closed set, so a writer that skips the repository
    // still cannot make an unanswerable provider look answerable.
    expect(() => database.connection.prepare(`
      INSERT INTO deferred_handles (workspace_id, call_id, provider, handle_id, recorded_at)
      VALUES ('ws-1', 'call-2', 'telepathy', 'x', '2026-01-01T00:00:00.000Z')
    `).run()).toThrow();
  });

  it('keeps the DDL provider set and DEFERRED_HANDLE_PROVIDERS the same set', async () => {
    const { database } = await setup();
    const insert = database.connection.prepare(`
      INSERT INTO deferred_handles (workspace_id, call_id, provider, handle_id, recorded_at)
      VALUES ('ws-1', ?, ?, 'handle-1', '2026-01-01T00:00:00.000Z')
    `);
    // A provider the type allows but the DDL refuses would be a handle its own
    // writer cannot store; one the DDL allows but the type does not would be a row
    // no reader can name. Both directions are the same bug: two lists, one set.
    for (const provider of DEFERRED_HANDLE_PROVIDERS) {
      expect(() => insert.run(`call-${provider}`, provider)).not.toThrow();
    }
    expect(() => insert.run('call-unlisted', 'unlisted')).toThrow();
  });

  it('never lets one workspace forget another workspace\'s handle', async () => {
    const { handles } = await setup();
    handles.record({ workspaceId: 'ws-1', callId: 'call-1', provider: 'process', handleId: 'proc-1' });

    // `settleRememberedCalls` filters by workspace before it gets here, so this is
    // the store's own guarantee: a verdict on one workspace's work cannot delete
    // the correlation another host still needs.
    expect(handles.forget('ws-2', ['call-1'])).toBe(0);
    expect(handles.take('ws-1', ['call-1'])).toEqual([expect.objectContaining({ handleId: 'proc-1' })]);
  });

  it('reports a handle for a workspace this host does not have as an invalid entry', async () => {
    const { handles } = await setup();
    // The row references `workspaces(id)`, so the driver refuses it. The caller's
    // contract is `invalid_entry` for a bad request, and an unknown workspace is a
    // caller bug like the other ones — not a driver error leaking through.
    expect(() => handles.record({
      workspaceId: 'ws-missing',
      callId: 'call-1',
      provider: 'process',
      handleId: 'proc-1',
    })).toThrow(DeferredHandleStoreError);
  });
});
