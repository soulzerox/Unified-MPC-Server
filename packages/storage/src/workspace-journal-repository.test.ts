import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteDatabase } from './database.js';
import { SqliteWorkspaceRepository } from './workspace-repository.js';
import { DEFERRED_CLOSURE_OPERATION_KINDS, SqliteWorkspaceJournalRepository, WorkspaceJournalStoreError } from './workspace-journal-repository.js';

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

  it('selects the newest rows on request, still ascending, and pages back by sequence', async () => {
    const { journal, workspaces, root } = await setup();
    await workspaces.insert({ id: 'ws-a', displayName: 'A', rootPath: path.join(root, 'a'), realRootPath: path.join(root, 'a'), createdAt: new Date(0).toISOString() });

    const sequences = Array.from({ length: 5 }, (_, index) =>
      journal.append({ workspaceId: 'ws-a', operationKind: 'file_read', phase: 'completed', status: 'completed', callId: `call-${index + 1}` })!);

    // Newest three, oldest first, so a caller replays the window in order.
    expect(journal.list({ workspaceId: 'ws-a', fromNewest: true, limit: 3 }).map((entry) => entry.sequence))
      .toEqual([sequences[2], sequences[3], sequences[4]]);
    // The boundary is exclusive, exactly like `afterSequence`: page with the first sequence returned.
    expect(journal.list({ workspaceId: 'ws-a', fromNewest: true, beforeSequence: sequences[2], limit: 3 }).map((entry) => entry.sequence))
      .toEqual([sequences[0], sequences[1]]);
    // A newest read stays inside its workspace.
    expect(journal.list({ workspaceId: 'ws-b', fromNewest: true, limit: 3 })).toEqual([]);
  });

  it('keeps two sessions writing two workspaces interleaved on separate streams', async () => {
    const { journal, workspaces, root } = await setup();
    await workspaces.insert({ id: 'ws-a', displayName: 'A', rootPath: path.join(root, 'a'), realRootPath: path.join(root, 'a'), createdAt: new Date(0).toISOString() });
    await workspaces.insert({ id: 'ws-b', displayName: 'B', rootPath: path.join(root, 'b'), realRootPath: path.join(root, 'b'), createdAt: new Date(0).toISOString() });

    // Two MCP sessions attached at once, each writing its own workspace. The
    // append is synchronous, so interleaving is the concurrency that matters:
    // no write may borrow the other stream's sequence, cursor or pin.
    const writes = Array.from({ length: 20 }, (_, index) => Promise.resolve().then(() => {
      const odd = index % 2 === 1;
      return journal.append({
        workspaceId: odd ? 'ws-b' : 'ws-a',
        sessionId: odd ? 'session-b' : 'session-a',
        operationKind: 'process_start',
        phase: 'started',
        status: 'started',
        callId: `call-${index}`,
      });
    }));
    const sequences = await Promise.all(writes);
    expect(new Set(sequences).size).toBe(20);

    const streamA = journal.list({ workspaceId: 'ws-a' });
    const streamB = journal.list({ workspaceId: 'ws-b' });
    expect(streamA).toHaveLength(10);
    expect(streamB).toHaveLength(10);
    expect(streamA.every((entry) => entry.workspaceId === 'ws-a' && entry.sessionId === 'session-a')).toBe(true);
    expect(streamB.every((entry) => entry.workspaceId === 'ws-b' && entry.sessionId === 'session-b')).toBe(true);
    // Each stream is ordered on its own: global autoincrement interleaves, but a
    // caller replaying one workspace never sees the other's rows or a gap.
    expect(streamA.map((entry) => entry.sequence)).toEqual([...streamA.map((entry) => entry.sequence)].sort((left, right) => left - right));
    expect(streamA.map((entry) => entry.sequence)).not.toEqual(streamB.map((entry) => entry.sequence));

    // A cursor taken from one stream pages only inside it.
    const cursorA = streamA[0]!.sequence;
    expect(journal.list({ workspaceId: 'ws-a', afterSequence: cursorA }).map((entry) => entry.workspaceId))
      .toEqual(Array.from({ length: 9 }, () => 'ws-a'));
    // The pin rule is per workspace too: ws-a's open calls are not visible as
    // ws-b's, even when the reader asks with every call id it has seen.
    const everyCall = [...streamA, ...streamB].map((entry) => entry.callId);
    expect(journal.openCallIds({ workspaceId: 'ws-b', callIds: everyCall }).sort())
      .toEqual(streamB.map((entry) => entry.callId).sort());
    expect(journal.openCallIds({ workspaceId: 'ws-a', callIds: everyCall }).sort())
      .toEqual(streamA.map((entry) => entry.callId).sort());
  });

  it('keeps the record of work whose session disappeared mid-call', async () => {
    const { journal, workspaces, root } = await setup();
    await workspaces.insert({ id: 'ws-a', displayName: 'A', rootPath: path.join(root, 'a'), realRootPath: path.join(root, 'a'), createdAt: new Date(0).toISOString() });

    // Session A starts a build, an index and a terminal, then its tool call is
    // interrupted: none of them ever writes a completion row. The rows are not
    // held by the MCP session, so what it lost mid-flight is still the truth a
    // later session reads.
    const interrupted = ['verification_run', 'code_index', 'process_start'];
    for (const kind of interrupted) {
      journal.append({
        workspaceId: 'ws-a',
        operationKind: kind,
        phase: 'started',
        status: 'started',
        callId: `${kind}-1`,
        sessionId: 'session-a',
      });
    }
    journal.append({ workspaceId: 'ws-a', operationKind: 'verification_run', phase: 'started', status: 'started', callId: 'build-done', sessionId: 'session-a' });
    journal.append({ workspaceId: 'ws-a', operationKind: 'verification_run', phase: 'completed', status: 'completed', callId: 'build-done', sessionId: 'session-a', resultCode: 'ok' });

    // Session B selects the same workspace and knows no call id in advance.
    const window = journal.list({ workspaceId: 'ws-a', fromNewest: true });
    expect(window.map((entry) => entry.sessionId)).toEqual([
      'session-a', 'session-a', 'session-a', 'session-a', 'session-a',
    ]);
    const open = journal.openCallIds({ workspaceId: 'ws-a', callIds: window.map((entry) => entry.callId) });
    // The interrupted calls read as still running, the finished build does not:
    // session identity is provenance, not ownership, so another session sees both.
    expect(open.sort()).toEqual(['code_index-1', 'process_start-1', 'verification_run-1']);
  });

  it('keeps an interrupted call open across a restart, so the next process does not rerun it blind', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'workspace-journal-'));
    temporaryRoots.push(root);
    const databasePath = path.join(root, 'state.sqlite');
    const first = new SqliteDatabase(databasePath);
    const workspaces = new SqliteWorkspaceRepository(first);
    await workspaces.insert({ id: 'ws-a', displayName: 'A', rootPath: path.join(root, 'a'), realRootPath: path.join(root, 'a'), createdAt: new Date(0).toISOString() });
    new SqliteWorkspaceJournalRepository(first).append({
      workspaceId: 'ws-a',
      operationKind: 'process_start',
      phase: 'started',
      status: 'started',
      callId: 'spawn-before-restart',
      sessionId: 'session-a',
    });
    first.close();

    // Unified restarts while the spawned work is still running.
    const second = new SqliteDatabase(databasePath);
    temporaryRoots.push(root);
    const reopened = new SqliteWorkspaceJournalRepository(second);
    expect(reopened.list({ workspaceId: 'ws-a' }).map((entry) => entry.callId)).toEqual(['spawn-before-restart']);
    expect(reopened.openCallIds({ workspaceId: 'ws-a', callIds: ['spawn-before-restart'] })).toEqual(['spawn-before-restart']);
    second.close();
  });

  it('returns work that finished before any client read it after a restart', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'workspace-journal-'));
    temporaryRoots.push(root);
    const databasePath = path.join(root, 'state.sqlite');
    const first = new SqliteDatabase(databasePath);
    const workspaces = new SqliteWorkspaceRepository(first);
    await workspaces.insert({ id: 'ws-a', displayName: 'A', rootPath: path.join(root, 'a'), realRootPath: path.join(root, 'a'), createdAt: new Date(0).toISOString() });
    const journal = new SqliteWorkspaceJournalRepository(first);
    journal.append({ workspaceId: 'ws-a', operationKind: 'verification_run', phase: 'started', status: 'started', callId: 'build-1', sessionId: 'session-a' });
    journal.append({ workspaceId: 'ws-a', operationKind: 'verification_run', phase: 'completed', status: 'completed', callId: 'build-1', sessionId: 'session-a', resultCode: 'ok' });
    first.close();

    // Nobody read the result before the restart; the reader after it is the first.
    const second = new SqliteDatabase(databasePath);
    const reopened = new SqliteWorkspaceJournalRepository(second);
    const window = reopened.list({ workspaceId: 'ws-a' });
    expect(window.map((entry) => entry.phase)).toEqual(['started', 'completed']);
    expect(window.map((entry) => entry.resultCode)).toEqual([undefined, 'ok']);
    // A completion written before the restart settles the call: no closure probe
    // is needed to explain work the journal already saw finish.
    expect(reopened.openCallIds({ workspaceId: 'ws-a', callIds: ['build-1'] })).toEqual([]);
    second.close();
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

  it('answers which named calls are open by the pin rule, not by the closure code alone', async () => {
    const { journal, workspaces, root } = await setup();
    await workspaces.insert({ id: 'ws-a', displayName: 'A', rootPath: path.join(root, 'a'), realRootPath: path.join(root, 'a'), createdAt: new Date(0).toISOString() });

    // A plain call ends at its own `completed` row; its `started` row keeps
    // `closure_code` NULL forever, so a reader that only looked at the code would
    // report finished work as running.
    journal.append({ workspaceId: 'ws-a', operationKind: 'git_publish', phase: 'started', status: 'started', callId: 'publish-1' });
    journal.append({ workspaceId: 'ws-a', operationKind: 'git_publish', phase: 'completed', status: 'completed', callId: 'publish-1', resultCode: 'ok' });
    journal.append({ workspaceId: 'ws-a', operationKind: 'git_publish', phase: 'started', status: 'started', callId: 'publish-2' });

    // A handle-returning call stays open past its own `completed` row until a
    // freshness probe writes the closure code.
    journal.append({ workspaceId: 'ws-a', operationKind: 'process_start', phase: 'started', status: 'started', callId: 'spawn-1' });
    journal.append({ workspaceId: 'ws-a', operationKind: 'process_start', phase: 'completed', status: 'completed', callId: 'spawn-1', resultCode: 'ok' });
    journal.append({ workspaceId: 'ws-a', operationKind: 'process_start', phase: 'started', status: 'started', callId: 'spawn-2' });
    journal.closeDeferredCalls({ workspaceId: 'ws-a', operationKinds: ['process_start'], callIds: ['spawn-2'], closureCode: 'no_live_process' });

    const callIds = ['publish-1', 'publish-2', 'spawn-1', 'spawn-2', 'never-started'];
    expect(journal.openCallIds({ workspaceId: 'ws-a', callIds }).sort()).toEqual(['publish-2', 'spawn-1']);
    // A read of another workspace never sees these rows, and an empty ask costs nothing.
    expect(journal.openCallIds({ workspaceId: 'ws-b', callIds })).toEqual([]);
    expect(journal.openCallIds({ workspaceId: 'ws-a', callIds: [] })).toEqual([]);
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
    // The same policy also removes the kind clause from the open-call read: with no
    // deferred kinds the statement must still bind in the right order and answer.
    expect(closing.openCallIds({ workspaceId: 'ws-goal', callIds: ['spawn-1'] })).toEqual([]);
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

  it('keeps every open reference whose newest row can settle itself', async () => {
    // Each kind has an older open row for work that still runs, then a newer row of
    // the same kind that ends inside its own call. The per-kind collapse used to
    // delete the older row and keep the newer one, which then closed itself: the
    // kind was left with nothing open while the work it stood for still ran.
    const kinds = [
      ['git_worktree_spawn', 'worktree_preview_settled'],
      ['agent_swarm_run', 'swarm_read_settled'],
      ['merge_verification_run', 'verification_settled'],
    ] as const;
    for (const [kind, selfSettledCode] of kinds) {
      const root = await mkdtemp(path.join(os.tmpdir(), 'workspace-journal-'));
      temporaryRoots.push(root);
      const database = new SqliteDatabase(path.join(root, 'state.sqlite'));
      const workspaces = new SqliteWorkspaceRepository(database);
      await workspaces.insert({
        id: 'ws-goal', displayName: 'Goal', rootPath: path.join(root, 'goal'), realRootPath: path.join(root, 'goal'),
        createdAt: new Date(0).toISOString(), workspaceKind: 'goal', goalId: 'goal-1',
      });
      const journal = new SqliteWorkspaceJournalRepository(database, { maxEventsPerWorkspace: 3 });

      journal.append({ workspaceId: 'ws-goal', operationKind: kind, phase: 'started', status: 'started', callId: 'work' });
      journal.append({ workspaceId: 'ws-goal', operationKind: kind, phase: 'started', status: 'started', callId: 'self-settling' });
      // Overflow the cap with an ordinary deferred kind, which still collapses.
      for (const callId of ['run-1', 'run-2', 'run-3']) {
        journal.append({ workspaceId: 'ws-goal', operationKind: 'process_start', phase: 'started', status: 'started', callId });
      }

      expect(journal.openDeferredCallIds({ workspaceId: 'ws-goal', callIds: ['work', 'self-settling'] }).sort())
        .toEqual(['self-settling', 'work']);

      // Close the launch rows first, so every later pin is decided by a reference
      // row rather than by a launcher the overflow happened to leave open.
      journal.closeDeferredCalls({
        workspaceId: 'ws-goal',
        operationKinds: ['process_start'],
        callIds: ['run-1', 'run-2', 'run-3'],
        closureCode: 'no_live_process',
      });

      expect(journal.closeDeferredCalls({
        workspaceId: 'ws-goal',
        operationKinds: [kind],
        callIds: ['self-settling'],
        closureCode: selfSettledCode,
      })).toBe(1);
      // With the launchers closed first, these two reads are decided by the reference
      // rows alone: the survivor is still physically open and still pins the goal.
      // Under the old ordering the leftover `run-3` row answered both reads, so a
      // regression in the exemption would not have moved them.
      expect(journal.goalDurableReferenceStates(['goal-1']).get('goal-1')).toBe('present');
      expect(journal.openDeferredCallIds({ workspaceId: 'ws-goal', callIds: ['work', 'self-settling'] }))
        .toEqual(['work']);

      expect(journal.closeDeferredCalls({
        workspaceId: 'ws-goal',
        operationKinds: [kind],
        callIds: ['work'],
        closureCode: 'work_ended',
      })).toBe(1);
      expect(journal.goalDurableReferenceStates(['goal-1']).get('goal-1')).toBe('clear');
    }
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

  it('redacts credentials in the summary before the row is stored', async () => {
    const { journal, workspaces, root } = await setup();
    await workspaces.insert({ id: 'ws-a', displayName: 'A', rootPath: path.join(root, 'a'), realRootPath: path.join(root, 'a'), createdAt: new Date(0).toISOString() });

    journal.append({
      workspaceId: 'ws-a', operationKind: 'task_create', phase: 'completed', status: 'completed', callId: 'call-1',
      summary: 'deploy failed with sk-live-abcdef123456 and PASSWORD=hunter2',
    });

    // The row is replayed to sessions that were never present, so a credential
    // pasted into a summary must not survive the write.
    const [entry] = journal.list({ workspaceId: 'ws-a' });
    expect(entry?.summary).toBe('deploy failed with [REDACTED] and PASSWORD=[REDACTED]');
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

  it('closes the deferred calls a freshness probe proved finished, and keeps the row', async () => {
    const { journal, workspaces, root } = await setup();
    await workspaces.insert({
      id: 'ws-goal', displayName: 'Goal', rootPath: path.join(root, 'goal'), realRootPath: path.join(root, 'goal'),
      createdAt: new Date(0).toISOString(), workspaceKind: 'goal', goalId: 'goal-1',
    });

    journal.append({ workspaceId: 'ws-goal', operationKind: 'process_start', phase: 'started', status: 'started', callId: 'spawn-1' });
    journal.append({ workspaceId: 'ws-goal', operationKind: 'process_start', phase: 'completed', status: 'completed', callId: 'spawn-1', resultCode: 'ok' });
    expect(journal.goalDurableReferenceStates(['goal-1']).get('goal-1')).toBe('present');

    expect(journal.closeDeferredCalls({
      workspaceId: 'ws-goal', operationKinds: ['process_start'], callIds: ['spawn-1'], closureCode: 'no_live_handle',
    })).toBe(1);
    expect(journal.goalDurableReferenceStates(['goal-1']).get('goal-1')).toBe('clear');

    const closed = journal.list({ workspaceId: 'ws-goal' }).filter((entry) => entry.phase === 'started');
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({ closureCode: 'no_live_handle', status: 'started' });

    // A retried probe is a no-op, and it cannot rewrite the first verdict.
    expect(journal.closeDeferredCalls({
      workspaceId: 'ws-goal', operationKinds: ['process_start'], callIds: ['spawn-1'], closureCode: 'other_reason',
    })).toBe(0);
    expect(journal.list({ workspaceId: 'ws-goal' }).filter((entry) => entry.phase === 'started')[0]?.closureCode).toBe('no_live_handle');
  });

  it('closes a worktree preview row, so a spawn that created nothing stops pinning', async () => {
    const { journal, workspaces, root } = await setup();
    await workspaces.insert({
      id: 'ws-goal', displayName: 'Goal', rootPath: path.join(root, 'goal'), realRootPath: path.join(root, 'goal'),
      createdAt: new Date(0).toISOString(), workspaceKind: 'goal', goalId: 'goal-1',
    });
    // A preview creates nothing, but its row is a durable reference, so it pins the goal
    // until the call's own verdict closes it. The kind has to be one this store will
    // close: a kind outside the set answers 0 and pins forever.
    expect(DEFERRED_CLOSURE_OPERATION_KINDS.has('git_worktree_spawn')).toBe(true);

    journal.append({ workspaceId: 'ws-goal', operationKind: 'git_worktree_spawn', phase: 'started', status: 'started', callId: 'preview-1' });
    journal.append({ workspaceId: 'ws-goal', operationKind: 'git_worktree_spawn', phase: 'completed', status: 'completed', callId: 'preview-1', resultCode: 'ok' });
    expect(journal.goalDurableReferenceStates(['goal-1']).get('goal-1')).toBe('present');

    expect(journal.closeDeferredCalls({
      workspaceId: 'ws-goal', operationKinds: [...DEFERRED_CLOSURE_OPERATION_KINDS], callIds: ['preview-1'], closureCode: 'worktree_preview_settled',
    })).toBe(1);
    expect(journal.goalDurableReferenceStates(['goal-1']).get('goal-1')).toBe('clear');
  });

  it('reads back which calls are still open, so a no-op close is not a refused one', async () => {
    const { journal, workspaces, root } = await setup();
    await workspaces.insert({
      id: 'ws-goal', displayName: 'Goal', rootPath: path.join(root, 'goal'), realRootPath: path.join(root, 'goal'),
      createdAt: new Date(0).toISOString(), workspaceKind: 'goal', goalId: 'goal-1',
    });
    for (const callId of ['closed-call', 'open-call']) {
      journal.append({ workspaceId: 'ws-goal', operationKind: 'process_start', phase: 'started', status: 'started', callId });
    }
    journal.closeDeferredCalls({
      workspaceId: 'ws-goal', operationKinds: ['process_start'], callIds: ['closed-call'], closureCode: 'no_live_handle',
    });

    // `closeDeferredCalls` answers 0 for both "already closed" and "out of reach";
    // this is the read that tells a sweeper which one it is looking at.
    expect(journal.openDeferredCallIds({ workspaceId: 'ws-goal', callIds: ['closed-call', 'open-call'] }))
      .toEqual(['open-call']);
    expect(journal.openDeferredCallIds({ workspaceId: 'ws-goal', callIds: ['closed-call'] })).toEqual([]);
    expect(journal.openDeferredCallIds({ workspaceId: 'ws-goal', callIds: [] })).toEqual([]);
  });

  it('names the kind that owns each still-open call, so a coarser answer is asked of the right ones', async () => {
    const { journal, workspaces, root } = await setup();
    await workspaces.insert({
      id: 'ws-goal', displayName: 'Goal', rootPath: path.join(root, 'goal'), realRootPath: path.join(root, 'goal'),
      createdAt: new Date(0).toISOString(), workspaceKind: 'goal', goalId: 'goal-1',
    });
    for (const [callId, operationKind] of [['spawn-1', 'process_start'], ['task-1', 'task_create']] as const) {
      journal.append({ workspaceId: 'ws-goal', operationKind, phase: 'started', status: 'started', callId });
    }
    journal.closeDeferredCalls({
      workspaceId: 'ws-goal', operationKinds: ['process_start'], callIds: ['spawn-1'], closureCode: 'no_live_handle',
    });

    // A closed call is not open, so it has no kind to report: a probe that asked
    // about it has already had its answer.
    const kinds = journal.openDeferredCallKinds({ workspaceId: 'ws-goal', callIds: ['spawn-1', 'task-1'] });
    expect([...kinds]).toEqual([['task-1', 'task_create']]);
    expect(journal.openDeferredCallKinds({ workspaceId: 'ws-goal', callIds: [] }).size).toBe(0);
  });

  it('closes only the calls a probe names, so one host cannot answer for another', async () => {
    const { journal, workspaces, root } = await setup();
    await workspaces.insert({
      id: 'ws-goal', displayName: 'Goal', rootPath: path.join(root, 'goal'), realRootPath: path.join(root, 'goal'),
      createdAt: new Date(0).toISOString(), workspaceKind: 'goal', goalId: 'goal-1',
    });
    for (const callId of ['own-call', 'other-host-call']) {
      journal.append({ workspaceId: 'ws-goal', operationKind: 'project_dev', phase: 'started', status: 'started', callId });
      journal.append({ workspaceId: 'ws-goal', operationKind: 'project_dev', phase: 'completed', status: 'completed', callId, resultCode: 'ok' });
    }

    // The process list a runtime can read only holds its own handles, so the
    // probe names the one call it can speak for. The sibling keeps pinning.
    expect(journal.closeDeferredCalls({
      workspaceId: 'ws-goal', operationKinds: ['project_dev'], callIds: ['own-call'], closureCode: 'no_live_handle',
    })).toBe(1);
    expect(journal.goalDurableReferenceStates(['goal-1']).get('goal-1')).toBe('present');

    const started = new Map(journal.list({ workspaceId: 'ws-goal' })
      .filter((entry) => entry.phase === 'started')
      .map((entry) => [entry.callId, entry.closureCode]));
    expect(started.get('own-call')).toBe('no_live_handle');
    expect(started.get('other-host-call')).toBeUndefined();

    // An empty scope closes nothing at all: "no call to speak for" is not "all clear".
    expect(journal.closeDeferredCalls({
      workspaceId: 'ws-goal', operationKinds: ['project_dev'], callIds: [], closureCode: 'no_live_handle',
    })).toBe(0);
    expect(journal.goalDurableReferenceStates(['goal-1']).get('goal-1')).toBe('present');

    expect(journal.closeDeferredCalls({
      workspaceId: 'ws-goal', operationKinds: ['project_dev'], callIds: ['other-host-call'], closureCode: 'no_live_handle',
    })).toBe(1);
    expect(journal.goalDurableReferenceStates(['goal-1']).get('goal-1')).toBe('clear');
  });

  it('leaves calls a probe could not have observed open, and refuses kinds it may not close', async () => {
    const { journal, workspaces, root } = await setup();
    await workspaces.insert({
      id: 'ws-goal', displayName: 'Goal', rootPath: path.join(root, 'goal'), realRootPath: path.join(root, 'goal'),
      createdAt: new Date(0).toISOString(), workspaceKind: 'goal', goalId: 'goal-1',
    });
    const recordedAt = '2026-11-16T10:00:00.000Z';
    journal.append({ workspaceId: 'ws-goal', operationKind: 'process_start', phase: 'started', status: 'started', callId: 'older', recordedAt });
    journal.append({ workspaceId: 'ws-goal', operationKind: 'git_publish', phase: 'started', status: 'started', callId: 'live-call', recordedAt });
    journal.append({ workspaceId: 'ws-goal', operationKind: 'process_start', phase: 'started', status: 'started', callId: 'newer', recordedAt: '2026-11-16T11:00:00.000Z' });

    // The floor is the runtime's own start: `older` predates it, so this runtime
    // cannot claim the handle behind it is gone.
    expect(journal.closeDeferredCalls({
      workspaceId: 'ws-goal', operationKinds: ['process_start', 'git_publish'],
      callIds: ['older', 'live-call', 'newer'],
      recordedAtOrAfter: '2026-11-16T10:30:00.000Z', closureCode: 'no_live_handle',
    })).toBe(1);
    const byCall = new Map(journal.list({ workspaceId: 'ws-goal' }).map((entry) => [`${entry.callId}/${entry.phase}`, entry]));
    expect(byCall.get('older/started')?.closureCode).toBeUndefined();
    expect(byCall.get('newer/started')?.closureCode).toBe('no_live_handle');
    // `git_publish` is not a deferred kind: its own outcome closes it, and a probe
    // must not be able to answer the different "owner died mid-call" question.
    expect(byCall.get('live-call/started')?.closureCode).toBeUndefined();
    expect(journal.goalDurableReferenceStates(['goal-1']).get('goal-1')).toBe('present');
  });

  it('keeps a git_worktree_spawn call pinning after it completed, where a closable kind clears', async () => {
    const { journal, workspaces, root } = await setup();
    await workspaces.insert({
      id: 'ws-goal', displayName: 'Goal', rootPath: path.join(root, 'goal'), realRootPath: path.join(root, 'goal'),
      createdAt: new Date(0).toISOString(), workspaceKind: 'goal', goalId: 'goal-1',
    });

    journal.append({ workspaceId: 'ws-goal', operationKind: 'git_worktree_spawn', phase: 'started', status: 'started', callId: 'spawn-1' });
    journal.append({ workspaceId: 'ws-goal', operationKind: 'git_worktree_spawn', phase: 'completed', status: 'completed', callId: 'spawn-1', resultCode: 'ok' });

    // The completed row ends the request; the worktree it created outlives it, so
    // the goal must stay present or cleanup would delete the worktree.
    expect(journal.goalDurableReferenceStates(['goal-1']).get('goal-1')).toBe('present');

    // An ordinary completed call in the same workspace closes its own row and is
    // not evidence about the worktree, so it cannot settle the pin either.
    journal.append({ workspaceId: 'ws-goal', operationKind: 'git_publish', phase: 'started', status: 'started', callId: 'publish-1' });
    journal.append({ workspaceId: 'ws-goal', operationKind: 'git_publish', phase: 'completed', status: 'completed', callId: 'publish-1', resultCode: 'ok' });
    expect(journal.goalDurableReferenceStates(['goal-1']).get('goal-1')).toBe('present');

    // Contrast with the kinds that do have a probe route: closing the only
    // process_start row clears the same projection.
    await workspaces.insert({
      id: 'ws-other', displayName: 'Other', rootPath: path.join(root, 'other'), realRootPath: path.join(root, 'other'),
      createdAt: new Date(0).toISOString(), workspaceKind: 'goal', goalId: 'goal-2',
    });
    journal.append({ workspaceId: 'ws-other', operationKind: 'process_start', phase: 'started', status: 'started', callId: 'process-1' });
    journal.append({ workspaceId: 'ws-other', operationKind: 'process_start', phase: 'completed', status: 'completed', callId: 'process-1', resultCode: 'ok' });
    expect(journal.goalDurableReferenceStates(['goal-2']).get('goal-2')).toBe('present');
    expect(journal.closeDeferredCalls({
      workspaceId: 'ws-other', operationKinds: ['process_start'], callIds: ['process-1'], closureCode: 'no_live_process',
    })).toBe(1);
    expect(journal.goalDurableReferenceStates(['goal-2']).get('goal-2')).toBe('clear');
    // ...while the worktree row survived all of it.
    expect(journal.goalDurableReferenceStates(['goal-1']).get('goal-1')).toBe('present');
  });

  it('collects a closed deferred call but never the open one, under the same cap', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'workspace-journal-'));
    temporaryRoots.push(root);
    const database = new SqliteDatabase(path.join(root, 'state.sqlite'));
    const workspaces = new SqliteWorkspaceRepository(database);
    const journal = new SqliteWorkspaceJournalRepository(database, { maxEventsPerWorkspace: 3 });
    await workspaces.insert({
      id: 'ws-goal', displayName: 'Goal', rootPath: path.join(root, 'goal'), realRootPath: path.join(root, 'goal'),
      createdAt: new Date(0).toISOString(), workspaceKind: 'goal', goalId: 'goal-1',
    });

    journal.append({ workspaceId: 'ws-goal', operationKind: 'process_start', phase: 'started', status: 'started', callId: 'open-1' });
    journal.append({ workspaceId: 'ws-goal', operationKind: 'process_start', phase: 'completed', status: 'completed', callId: 'open-1', resultCode: 'ok' });
    journal.closeDeferredCalls({ workspaceId: 'ws-goal', operationKinds: ['process_start'], callIds: ['open-1'], closureCode: 'no_live_handle' });
    for (const callId of ['spawn-2', 'spawn-3']) {
      journal.append({ workspaceId: 'ws-goal', operationKind: 'project_test', phase: 'started', status: 'started', callId });
      journal.append({ workspaceId: 'ws-goal', operationKind: 'project_test', phase: 'completed', status: 'completed', callId, resultCode: 'ok' });
    }

    // The closed pair is ordinary evidence now, so retention may collect it...
    expect(journal.list({ workspaceId: 'ws-goal' }).map((entry) => entry.callId)).not.toContain('open-1');
    // ...while the unclosed `project_test` call keeps pinning the goal.
    expect(journal.goalDurableReferenceStates(['goal-1']).get('goal-1')).toBe('present');
    expect(journal.list({ workspaceId: 'ws-goal' }).length).toBeLessThanOrEqual(3);
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
