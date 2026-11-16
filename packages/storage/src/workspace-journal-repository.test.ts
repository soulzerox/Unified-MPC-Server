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

    // `git_publish` returns only after the push ended, so its own outcome is the
    // closure; every `project_*` launcher and the benchmark are deferred instead.
    journal.append({ workspaceId: 'ws-goal', operationKind: 'git_publish', phase: 'started', status: 'started', callId: 'call-1' });
    expect(journal.goalDurableReferenceStates(['goal-1']).get('goal-1')).toBe('present');

    journal.append({ workspaceId: 'ws-goal', operationKind: 'git_publish', phase: 'completed', status: 'failed', callId: 'call-1', resultCode: 'publish_failed' });
    expect(journal.goalDurableReferenceStates(['goal-1']).get('goal-1')).toBe('clear');

    journal.append({ workspaceId: 'ws-goal', operationKind: 'project_dev', phase: 'started', status: 'started', callId: 'call-2' });
    expect(journal.goalDurableReferenceStates(['goal-1', 'goal-2'])).toEqual(new Map([['goal-1', 'present'], ['goal-2', 'clear']]));
    expect(journal.goalDurableReferenceStates([]).size).toBe(0);
  });

  it('keeps a handle-returning operation present after its own call returns', async () => {
    const { journal, workspaces, root } = await setup();
    await workspaces.insert({
      id: 'ws-goal', displayName: 'Goal', rootPath: path.join(root, 'goal'), realRootPath: path.join(root, 'goal'),
      createdAt: new Date(0).toISOString(), workspaceKind: 'goal', goalId: 'goal-1',
    });

    // `process_start` returns processId as soon as the child is spawned, so the
    // call's own `completed` phase is not evidence that the process stopped.
    journal.append({ workspaceId: 'ws-goal', operationKind: 'process_start', phase: 'started', status: 'started', callId: 'spawn-1' });
    journal.append({ workspaceId: 'ws-goal', operationKind: 'process_start', phase: 'completed', status: 'completed', callId: 'spawn-1', resultCode: 'ok' });

    expect(journal.goalDurableReferenceStates(['goal-1']).get('goal-1')).toBe('present');
  });

  it('lets a caller opt out of deferred closure for a kind it can prove ended', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'workspace-journal-'));
    temporaryRoots.push(root);
    const database = new SqliteDatabase(path.join(root, 'state.sqlite'));
    const workspaces = new SqliteWorkspaceRepository(database);
    await workspaces.insert({
      id: 'ws-goal', displayName: 'Goal', rootPath: path.join(root, 'goal'), realRootPath: path.join(root, 'goal'),
      createdAt: new Date(0).toISOString(), workspaceKind: 'goal', goalId: 'goal-1',
    });

    const journal = new SqliteWorkspaceJournalRepository(database, { deferredClosureKinds: new Set(['process_start']) });
    journal.append({ workspaceId: 'ws-goal', operationKind: 'process_start', phase: 'started', status: 'started', callId: 'spawn-1' });
    journal.append({ workspaceId: 'ws-goal', operationKind: 'process_start', phase: 'completed', status: 'completed', callId: 'spawn-1', resultCode: 'ok' });
    expect(journal.goalDurableReferenceStates(['goal-1']).get('goal-1')).toBe('present');

    // The same rows read `clear` once the caller says this kind closes on its own
    // call: the deferred set is a policy input, not a second code path.
    const closing = new SqliteWorkspaceJournalRepository(database, { deferredClosureKinds: new Set() });
    expect(closing.goalDurableReferenceStates(['goal-1']).get('goal-1')).toBe('clear');
  });

  it('never lets retention delete the deferred evidence that pins a goal, and keeps the store bounded', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'workspace-journal-'));
    temporaryRoots.push(root);
    const database = new SqliteDatabase(path.join(root, 'state.sqlite'));
    const workspaces = new SqliteWorkspaceRepository(database);
    const kinds = new Set(['process_start']);
    const journal = new SqliteWorkspaceJournalRepository(database, { maxEventsPerWorkspace: 3, deferredClosureKinds: kinds });
    await workspaces.insert({
      id: 'ws-goal', displayName: 'Goal', rootPath: path.join(root, 'goal'), realRootPath: path.join(root, 'goal'),
      createdAt: new Date(0).toISOString(), workspaceKind: 'goal', goalId: 'goal-1',
    });

    // Five calls against a cap of three: one pin plus the retained rows.
    for (const callId of ['spawn-1', 'spawn-2', 'spawn-3', 'spawn-4', 'spawn-5']) {
      journal.append({ workspaceId: 'ws-goal', operationKind: 'process_start', phase: 'started', status: 'started', callId });
      journal.append({ workspaceId: 'ws-goal', operationKind: 'process_start', phase: 'completed', status: 'completed', callId, resultCode: 'ok' });
    }

    // The pin survives retention, because a goal with a live handle must never
    // read `clear` just because its evidence aged out...
    expect(journal.goalDurableReferenceStates(['goal-1']).get('goal-1')).toBe('present');
    // ...and it costs one row per deferred kind, not one per call: retention
    // collapses older calls of the same kind instead of keeping them forever.
    expect(journal.list({ workspaceId: 'ws-goal' }).length).toBeLessThanOrEqual(3 + kinds.size);
  });

  it("does not let one goal's deferred operation pin another goal", async () => {
    const { journal, workspaces, root } = await setup();
    await workspaces.insert({
      id: 'ws-a', displayName: 'A', rootPath: path.join(root, 'a'), realRootPath: path.join(root, 'a'),
      createdAt: new Date(0).toISOString(), workspaceKind: 'goal', goalId: 'goal-1',
    });
    await workspaces.insert({
      id: 'ws-b', displayName: 'B', rootPath: path.join(root, 'b'), realRootPath: path.join(root, 'b'),
      createdAt: new Date(0).toISOString(), workspaceKind: 'goal', goalId: 'goal-2',
    });

    journal.append({ workspaceId: 'ws-a', operationKind: 'process_start', phase: 'started', status: 'started', callId: 'spawn-a' });
    journal.append({ workspaceId: 'ws-a', operationKind: 'process_start', phase: 'completed', status: 'completed', callId: 'spawn-a', resultCode: 'ok' });

    expect(journal.goalDurableReferenceStates(['goal-1', 'goal-2'])).toEqual(
      new Map([['goal-1', 'present'], ['goal-2', 'clear']]),
    );
  });

  it('still ignores a deferred operation that belongs to an archived registration', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'workspace-journal-'));
    temporaryRoots.push(root);
    const database = new SqliteDatabase(path.join(root, 'state.sqlite'));
    const workspaces = new SqliteWorkspaceRepository(database);
    const journal = new SqliteWorkspaceJournalRepository(database);
    await workspaces.insert({
      id: 'ws-goal', displayName: 'Goal', rootPath: path.join(root, 'goal'), realRootPath: path.join(root, 'goal'),
      createdAt: new Date(0).toISOString(), workspaceKind: 'goal', goalId: 'goal-1',
    });

    journal.append({ workspaceId: 'ws-goal', operationKind: 'process_start', phase: 'started', status: 'started', callId: 'spawn-old' });
    expect(journal.goalDurableReferenceStates(['goal-1']).get('goal-1')).toBe('present');
    await workspaces.archive('ws-goal', new Date(1).toISOString());
    expect(journal.goalDurableReferenceStates(['goal-1']).get('goal-1')).toBe('clear');
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
      workspaceId: 'ws-a', operationKind: 'task_create', phase: 'started', status: 'completed', callId: 'call-1',
    })).toThrow(WorkspaceJournalStoreError);
    expect(() => journal.append({
      workspaceId: 'ws-a', operationKind: 'task_create', phase: 'started', status: 'started', callId: '',
    })).toThrow(WorkspaceJournalStoreError);
    expect(() => journal.append({
      workspaceId: 'ws-a', operationKind: 'task_create', phase: 'started', status: 'started', callId: 'call-2', summary: 'x'.repeat(501),
    })).toThrow(WorkspaceJournalStoreError);
    expect(() => journal.append({
      workspaceId: 'ws-a', operationKind: 'task_create', phase: 'started', status: 'started', callId: 'call-3', resultCode: 'x'.repeat(129),
    })).toThrow(WorkspaceJournalStoreError);
    expect(() => journal.append({
      workspaceId: 'ws-a', operationKind: 'task_create', phase: 'completed', status: 'not-a-status' as never, callId: 'call-4',
    })).toThrow(WorkspaceJournalStoreError);
    expect(journal.list({ workspaceId: 'ws-a' })).toHaveLength(0);
  });

  it('retires whole closed calls and never an open row, so no started row is left unclosable', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'workspace-journal-'));
    temporaryRoots.push(root);
    const database = new SqliteDatabase(path.join(root, 'state.sqlite'));
    const workspaces = new SqliteWorkspaceRepository(database);
    const journal = new SqliteWorkspaceJournalRepository(database, { maxEventsPerWorkspace: 3 });
    await workspaces.insert({
      id: 'ws-goal', displayName: 'Goal', rootPath: path.join(root, 'goal'), realRootPath: path.join(root, 'goal'),
      createdAt: new Date(0).toISOString(), workspaceKind: 'goal', goalId: 'goal-1',
    });

    journal.append({ workspaceId: 'ws-goal', operationKind: 'git_publish', phase: 'started', status: 'started', callId: 'open' });
    for (const callId of ['done-1', 'done-2', 'done-3']) {
      journal.append({ workspaceId: 'ws-goal', operationKind: 'git_publish', phase: 'started', status: 'started', callId });
      journal.append({ workspaceId: 'ws-goal', operationKind: 'git_publish', phase: 'completed', status: 'completed', callId, resultCode: 'ok' });
    }
    // `git_publish` returns only after the push ended, so its completion is real
    // closure and the pair is collectable; a deferred kind is covered separately.
    // A completion with no `started` sibling can pin nothing, so it is the one
    // row retention may collect on its own.
    journal.append({ workspaceId: 'ws-goal', operationKind: 'git_publish', phase: 'completed', status: 'completed', callId: 'orphan' });

    const entries = journal.list({ workspaceId: 'ws-goal' });
    const started = entries.filter((entry) => entry.phase === 'started').map((entry) => entry.callId);
    const completed = new Set(entries.filter((entry) => entry.phase === 'completed').map((entry) => entry.callId));
    // Every surviving started row still has its completion: retention never
    // leaves an unclosable row behind, which would pin the goal forever.
    for (const callId of started) {
      if (callId === 'open') continue;
      expect(completed.has(callId)).toBe(true);
    }
    expect(started).toContain('open');
    expect(entries.map((entry) => entry.callId)).not.toContain('done-1');
    expect(entries.map((entry) => entry.callId)).not.toContain('orphan');
    expect(entries.length).toBeLessThanOrEqual(3);
    expect(journal.goalDurableReferenceStates(['goal-1']).get('goal-1')).toBe('present');
  });

  it('ignores an open row that belongs to an archived registration', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'workspace-journal-'));
    temporaryRoots.push(root);
    const database = new SqliteDatabase(path.join(root, 'state.sqlite'));
    const workspaces = new SqliteWorkspaceRepository(database);
    const journal = new SqliteWorkspaceJournalRepository(database);
    const createdAt = new Date(0).toISOString();
    await workspaces.insert({
      id: 'ws-goal', displayName: 'Goal', rootPath: path.join(root, 'goal'), realRootPath: path.join(root, 'goal'),
      createdAt, workspaceKind: 'goal', goalId: 'goal-1',
    });

    journal.append({ workspaceId: 'ws-goal', operationKind: 'task_create', phase: 'started', status: 'started', callId: 'old-open' });
    expect(journal.goalDurableReferenceStates(['goal-1']).get('goal-1')).toBe('present');

    await workspaces.archive('ws-goal', new Date(1).toISOString());

    // The worktree is gone, so its open row cannot be what keeps the goal alive;
    // the archived filter is what keeps it from blocking cleanup forever.
    expect(journal.goalDurableReferenceStates(['goal-1']).get('goal-1')).toBe('clear');
  });
});
