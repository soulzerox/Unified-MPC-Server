import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
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
import { DEFERRED_HANDLE_MIGRATION_SQL } from './migrations/deferred-handle-migration.js';
import { DEFERRED_HANDLE_PROVIDER_MIGRATION_SQL } from './migrations/deferred-handle-provider-migration.js';

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
    // Adding a provider to both lists is *not* enough for a host that already
    // migrated: `DEFERRED_HANDLE_MIGRATION_SQL` is `CREATE TABLE IF NOT EXISTS`,
    // applied once per `schema_migrations` id, so an existing database keeps the old
    // `CHECK` while this test stays green. A provider addition therefore needs a new
    // migration id — or a table rebuild, which is what `049` did and the rebuild test
    // below proves over rows that already exist.
    const { database } = await setup();
    const insert = database.connection.prepare(`
      INSERT INTO deferred_handles (workspace_id, call_id, provider, handle_id, recorded_at)
      VALUES ('ws-1', ?, ?, 'handle-1', '2026-01-01T00:00:00.000Z')
    `);
    // A provider the type allows but the DDL refuses would be a handle its own
    // writer cannot store; one the DDL allows but the type does not would be a row
    // no reader can name. Both directions are the same bug: two lists, one set.
    // The set comparison covers the DDL side (a `CHECK` that grew alone is
    // invisible to an insert test), the inserts cover the behaviour. The DDL is
    // read from the migrated table, not from the first migration's text, so a
    // rebuild that widens the `CHECK` is the schema this test sees. The match is
    // anchored on the `CHECK` so a second `provider IN (...)` clause in the same
    // table cannot be compared instead.
    const ddlProviders = /CHECK\s*\(\s*provider\s+IN\s*\(([^)]*)\)/.exec(String(
      (database.connection.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'deferred_handles'",
      ).get() as { sql?: string } | undefined)?.sql,
    ))?.[1] ?? '';
    expect([...ddlProviders.matchAll(/'([^']+)'/g)].map((match) => match[1]).sort())
      .toEqual([...DEFERRED_HANDLE_PROVIDERS].sort());
    for (const provider of DEFERRED_HANDLE_PROVIDERS) {
      expect(() => insert.run(`call-${provider}`, provider)).not.toThrow();
    }
    expect(() => insert.run('call-unlisted', 'unlisted')).toThrow();
  });

  it('rebuilds a populated 048 table into the widened provider set without losing a row', async () => {
    // 049 is a table rebuild, so the claim that matters is not what the INSERT
    // says but what the migration does to rows that already exist: a handle the
    // host is still correlating must survive verbatim, and the widened CHECK must
    // accept it. Built on a raw connection so the schema really is the 048 one.
    const database = new DatabaseSync(':memory:');
    try {
      database.exec('PRAGMA foreign_keys = ON');
      database.exec('CREATE TABLE workspaces (id TEXT PRIMARY KEY NOT NULL)');
      database.exec("INSERT INTO workspaces (id) VALUES ('ws-1')");
      database.exec(DEFERRED_HANDLE_MIGRATION_SQL);
      const insert = database.prepare(
        'INSERT INTO deferred_handles (workspace_id, call_id, provider, handle_id, recorded_at) VALUES (?, ?, ?, ?, ?)',
      );
      const before = [
        ['ws-1', 'call-process', 'process', 'proc-1', '2026-11-16T10:00:00.000Z'],
        ['ws-1', 'call-task', 'task', 'task-1', '2026-11-16T10:01:00.000Z'],
        ['ws-1', 'call-swarm', 'swarm', 'swarm-1', '2026-11-16T10:02:00.000Z'],
      ] as const;
      for (const row of before) insert.run(...row);

      database.exec(DEFERRED_HANDLE_PROVIDER_MIGRATION_SQL);

      expect(database.prepare(
        'SELECT workspace_id, call_id, provider, handle_id, recorded_at FROM deferred_handles ORDER BY call_id',
      ).all().map((row) => Object.values(row as Record<string, unknown>)))
        .toEqual([...before].map((row) => [...row]).sort((left, right) => left[1].localeCompare(right[1])));
      // The widened set is what the rebuild exists for.
      expect(() => database.prepare(
        'INSERT INTO deferred_handles (workspace_id, call_id, provider, handle_id, recorded_at) VALUES (?, ?, ?, ?, ?)',
      ).run('ws-1', 'call-codex', 'codex', 'codex-1', '2026-11-16T10:03:00.000Z')).not.toThrow();
    } finally {
      database.close();
    }
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

  it('keeps the single foreign key its driver translation assumes', async () => {
    const { database } = await setup();
    // `isForeignKeyViolation` is only allowed to mean "unknown workspace" while
    // `workspace_id` is the table's one and only reference. A second foreign key
    // would silently make it the wrong classifier, so pin the premise itself rather
    // than only the behaviour it produces.
    const keys = database.connection.prepare('PRAGMA foreign_key_list(deferred_handles)').all() as unknown as {
      readonly table: string; readonly from: string; readonly to: string;
    }[];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ table: 'workspaces', from: 'workspace_id', to: 'id' });
  });

  it('reports a handle for a workspace this host does not have as an invalid entry', async () => {
    const { handles } = await setup();
    // The row references `workspaces(id)`, so the driver refuses it. The caller's
    // contract is `invalid_entry` for a bad request, and an unknown workspace is a
    // caller bug like the other ones — not a driver error leaking through.
    let thrown: unknown;
    try {
      handles.record({
        workspaceId: 'ws-missing',
        callId: 'call-1',
        provider: 'process',
        handleId: 'proc-1',
      });
    } catch (error) {
      thrown = error;
    }
    // Pinning the reason and the message: an unconditional relabel of every driver
    // failure would pass a bare `toThrow(DeferredHandleStoreError)`.
    expect(thrown).toBeInstanceOf(DeferredHandleStoreError);
    expect((thrown as DeferredHandleStoreError).reason).toBe('invalid_entry');
    expect((thrown as DeferredHandleStoreError).message).toContain('ws-missing');
  });

  it('lets a driver failure keep its own shape instead of relabelling it', async () => {
    const { database, handles } = await setup();
    database.close();

    // A closed database is a driver failure, not a bad request: relabelling it
    // `invalid_entry` would tell the caller to fix input that was fine.
    expect(() => handles.record({
      workspaceId: 'ws-1',
      callId: 'call-1',
      provider: 'process',
      handleId: 'proc-1',
    })).toThrow(/closed/i);
    expect(() => handles.record({
      workspaceId: 'ws-1',
      callId: 'call-2',
      provider: 'process',
      handleId: 'proc-2',
    })).not.toThrow(DeferredHandleStoreError);
  });
});
