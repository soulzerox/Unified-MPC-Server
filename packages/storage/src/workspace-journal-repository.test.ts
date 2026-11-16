import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteDatabase } from './database.js';
import { SqliteWorkspaceRepository } from './workspace-repository.js';
import { SqliteWorkspaceJournalRepository, WorkspaceJournalStoreError } from './workspace-journal-repository.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(): Promise<{
  readonly database: SqliteDatabase;
  readonly workspaces: SqliteWorkspaceRepository;
  readonly journal: SqliteWorkspaceJournalRepository;
  readonly root: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workspace-journal-'));
  temporaryRoots.push(root);
  const database = new SqliteDatabase(path.join(root, 'state.sqlite'));
  const workspaces = new SqliteWorkspaceRepository(database);
  return { database, workspaces, journal: new SqliteWorkspaceJournalRepository(database), root };
}

describe('SqliteWorkspaceJournalRepository', () => {
  it('orders entries by a durable sequence per workspace and never leaks one workspace into another', async () => {
    const { journal, workspaces, root } = await setup();
    await workspaces.insert({ id: 'ws-a', displayName: 'A', rootPath: path.join(root, 'a'), realRootPath: path.join(root, 'a'), createdAt: new Date(0).toISOString() });
    await workspaces.insert({ id: 'ws-b', displayName: 'B', rootPath: path.join(root, 'b'), realRootPath: path.join(root, 'b'), createdAt: new Date(0).toISOString() });

    const first = journal.append({ workspaceId: 'ws-a', operationKind: 'task_create', phase: 'started', status: 'started', callId: 'call-1' });
    const second = journal.append({ workspaceId: 'ws-a', operationKind: 'task_create', phase: 'completed', status: 'completed', callId: 'call-1', resultCode: 'ok' });
    const other = journal.append({ workspaceId: 'ws-b', operationKind: 'task_create', phase: 'started', status: 'started', callId: 'call-2' });

    expect(first).not.toBeNull();
    expect(second!).toBeGreaterThan(first!);
    expect(other).not.toBeNull();

    const entries = journal.list({ workspaceId: 'ws-a' });
    expect(entries.map((entry) => entry.callId)).toEqual(['call-1', 'call-1']);
    expect(entries.map((entry) => entry.phase)).toEqual(['started', 'completed']);
    expect(journal.list({ workspaceId: 'ws-a', afterSequence: first! }).map((entry) => entry.phase)).toEqual(['completed']);
    expect(journal.list({ workspaceId: 'ws-b' }).map((entry) => entry.workspaceId)).toEqual(['ws-b']);
  });

  it('is idempotent on a retried (workspace, callId, phase) write', async () => {
    const { journal, workspaces, root } = await setup();
    await workspaces.insert({ id: 'ws-a', displayName: 'A', rootPath: path.join(root, 'a'), realRootPath: path.join(root, 'a'), createdAt: new Date(0).toISOString() });

    const first = journal.append({ workspaceId: 'ws-a', operationKind: 'process_start', phase: 'started', status: 'started', callId: 'call-1' });
    const retried = journal.append({ workspaceId: 'ws-a', operationKind: 'process_start', phase: 'started', status: 'started', callId: 'call-1' });

    expect(first).not.toBeNull();
    expect(retried).toBeNull();
    expect(journal.list({ workspaceId: 'ws-a' })).toHaveLength(1);
  });

  it('pins a goal only while an operation is open, and clears it once the call completes', async () => {
    const { journal, workspaces, root } = await setup();
    await workspaces.insert({
      id: 'ws-goal', displayName: 'Goal', rootPath: path.join(root, 'goal'), realRootPath: path.join(root, 'goal'),
      createdAt: new Date(0).toISOString(), workspaceKind: 'goal', goalId: 'goal-1',
    });
    await workspaces.insert({ id: 'ws-other', displayName: 'Other', rootPath: path.join(root, 'other'), realRootPath: path.join(root, 'other'), createdAt: new Date(0).toISOString() });

    expect(journal.goalDurableReferenceStates(['goal-1', 'goal-2']).get('goal-1')).toBe('clear');

    journal.append({ workspaceId: 'ws-goal', operationKind: 'task_create', phase: 'started', status: 'started', callId: 'call-1' });
    expect(journal.goalDurableReferenceStates(['goal-1']).get('goal-1')).toBe('present');

    journal.append({ workspaceId: 'ws-goal', operationKind: 'task_create', phase: 'completed', status: 'failed', callId: 'call-1', resultCode: 'task_failed' });
    expect(journal.goalDurableReferenceStates(['goal-1']).get('goal-1')).toBe('clear');

    journal.append({ workspaceId: 'ws-goal', operationKind: 'process_start', phase: 'started', status: 'started', callId: 'call-2' });
    expect(journal.goalDurableReferenceStates(['goal-1', 'goal-2'])).toEqual(new Map([['goal-1', 'present'], ['goal-2', 'clear']]));
    expect(journal.goalDurableReferenceStates([]).size).toBe(0);
  });

  it('does not let a completion written against another workspace close an open row', async () => {
    const { journal, workspaces, root } = await setup();
    await workspaces.insert({
      id: 'ws-goal', displayName: 'Goal', rootPath: path.join(root, 'goal'), realRootPath: path.join(root, 'goal'),
      createdAt: new Date(0).toISOString(), workspaceKind: 'goal', goalId: 'goal-1',
    });
    await workspaces.insert({ id: 'ws-other', displayName: 'Other', rootPath: path.join(root, 'other'), realRootPath: path.join(root, 'other'), createdAt: new Date(0).toISOString() });

    journal.append({ workspaceId: 'ws-goal', operationKind: 'task_create', phase: 'started', status: 'started', callId: 'shared-call' });
    journal.append({ workspaceId: 'ws-other', operationKind: 'task_create', phase: 'completed', status: 'completed', callId: 'shared-call' });

    expect(journal.goalDurableReferenceStates(['goal-1']).get('goal-1')).toBe('present');
  });

  it('rejects an unbounded entry instead of persisting it', async () => {
    const { journal, workspaces, root } = await setup();
    await workspaces.insert({ id: 'ws-a', displayName: 'A', rootPath: path.join(root, 'a'), realRootPath: path.join(root, 'a'), createdAt: new Date(0).toISOString() });

    expect(() => journal.append({
      workspaceId: 'ws-a', operationKind: 'task_create', phase: 'started', status: 'completed',
    })).toThrow(WorkspaceJournalStoreError);
    expect(() => journal.append({
      workspaceId: 'ws-a', operationKind: 'task_create', phase: 'started', status: 'started', summary: 'x'.repeat(501),
    })).toThrow(WorkspaceJournalStoreError);
    expect(journal.list({ workspaceId: 'ws-a' })).toHaveLength(0);
  });

  it('trims terminal history but never an open row', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'workspace-journal-'));
    temporaryRoots.push(root);
    const database = new SqliteDatabase(path.join(root, 'state.sqlite'));
    const workspaces = new SqliteWorkspaceRepository(database);
    const journal = new SqliteWorkspaceJournalRepository(database, { maxEventsPerWorkspace: 3 });
    await workspaces.insert({ id: 'ws-a', displayName: 'A', rootPath: path.join(root, 'a'), realRootPath: path.join(root, 'a'), createdAt: new Date(0).toISOString() });

    journal.append({ workspaceId: 'ws-a', operationKind: 'task_create', phase: 'started', status: 'started', callId: 'open' });
    for (const callId of ['done-1', 'done-2', 'done-3']) {
      journal.append({ workspaceId: 'ws-a', operationKind: 'task_create', phase: 'completed', status: 'completed', callId });
    }

    const callIds = journal.list({ workspaceId: 'ws-a' }).map((entry) => entry.callId);
    expect(callIds).toContain('open');
    expect(callIds.length).toBeLessThanOrEqual(3);
    expect(callIds).not.toContain('done-1');
  });
});
