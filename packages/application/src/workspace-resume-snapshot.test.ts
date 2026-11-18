import { describe, expect, it } from 'vitest';
import type { ListWorkspaceJournalRequest, WorkspaceJournalEntry } from '@unified-mpc/storage';
import {
  WORKSPACE_RESUME_MAX_LIMIT,
  createWorkspaceResumeSnapshotReader,
  type WorkspaceResumeJournalReader,
} from './workspace-resume-snapshot.js';

function entry(overrides: Partial<WorkspaceJournalEntry> & { sequence: number }): WorkspaceJournalEntry {
  return {
    eventId: `event-${overrides.sequence}`,
    workspaceId: 'ws-1',
    operationKind: 'process_start',
    callId: `call-${overrides.sequence}`,
    phase: 'completed',
    status: 'completed',
    recordedAt: '2026-11-18T00:00:00.000Z',
    ...overrides,
  } as WorkspaceJournalEntry;
}

/**
 * A journal that answers both reads the way the store does, over the whole entry
 * set — including rows the caller's window cannot see.
 *
 * `handleReturning` is the kinds whose `completed` phase ends the request, not the
 * work; the real store knows them as `DEFERRED_CLOSURE_OPERATION_KINDS`.
 */
function journalOf(entries: readonly WorkspaceJournalEntry[], handleReturning: readonly string[] = []): {
  readonly journal: WorkspaceResumeJournalReader;
  readonly requests: ListWorkspaceJournalRequest[];
  readonly openRequests: { readonly workspaceId: string; readonly callIds: readonly string[] }[];
} {
  const requests: ListWorkspaceJournalRequest[] = [];
  const openRequests: { readonly workspaceId: string; readonly callIds: readonly string[] }[] = [];
  const deferred = new Set(handleReturning);
  const journal: WorkspaceResumeJournalReader = {
    list(request): readonly WorkspaceJournalEntry[] {
      requests.push(request);
      const window = entries
        .filter((candidate) => candidate.workspaceId === request.workspaceId
          && (request.fromNewest === true
            ? candidate.sequence < (request.beforeSequence ?? Number.MAX_SAFE_INTEGER)
            : candidate.sequence > (request.afterSequence ?? 0)))
        // The store orders by `sequence` ascending; the fake must too or the projection
        // would be tested against an order no real journal produces.
        .sort((left, right) => left.sequence - right.sequence);
      // A newest read selects the tail of the journal, still ascending, which is what
      // the store returns after flipping its descending query.
      return request.fromNewest === true
        ? window.slice(-(request.limit ?? window.length))
        : window.slice(0, request.limit ?? window.length);
    },
    openCallIds(request): readonly string[] {
      openRequests.push(request);
      return [...new Set(request.callIds)].filter((callId) => {
        const started = entries.find((candidate) => candidate.workspaceId === request.workspaceId
          && candidate.callId === callId
          && candidate.phase === 'started'
          && candidate.closureCode === undefined);
        if (started === undefined) return false;
        if (deferred.has(started.operationKind)) return true;
        return !entries.some((candidate) => candidate.workspaceId === request.workspaceId
          && candidate.callId === callId
          && candidate.phase === 'completed');
      });
    },
  };
  return { journal, requests, openRequests };
}

const now = (): Date => new Date('2026-11-18T03:00:00.000Z');

describe('workspace resume snapshot', async () => {
  it('projects the oldest rows first and hands back a cursor', async () => {
    const { journal } = journalOf([entry({ sequence: 2 }), entry({ sequence: 1 })]);
    const read = createWorkspaceResumeSnapshotReader({ journal, now });

    const snapshot = await read.read({ workspaceId: 'ws-1' });

    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    expect(snapshot.value.events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(snapshot.value.cursor).toBe(2);
    expect(snapshot.value.truncated).toBe(false);
    expect(snapshot.value.generatedAt).toBe('2026-11-18T03:00:00.000Z');
  });

  it('resumes from the cursor instead of replaying what the caller already read', async () => {
    const { journal, requests } = journalOf([entry({ sequence: 1 }), entry({ sequence: 2 }), entry({ sequence: 3 })]);
    const read = createWorkspaceResumeSnapshotReader({ journal, now });

    const snapshot = await read.read({ workspaceId: 'ws-1', afterSequence: 2 });

    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    expect(snapshot.value.events.map((event) => event.sequence)).toEqual([3]);
    expect(snapshot.value.cursor).toBe(3);
    expect(requests.at(-1)?.afterSequence).toBe(2);
  });

  it('bounds the window and says so instead of silently cutting it', async () => {
    const { journal, requests } = journalOf([1, 2, 3].map((sequence) => entry({ sequence })));
    const read = createWorkspaceResumeSnapshotReader({ journal, now });

    const snapshot = await read.read({ workspaceId: 'ws-1', limit: 2 });

    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    expect(snapshot.value.events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(snapshot.value.cursor).toBe(2);
    expect(snapshot.value.truncated).toBe(true);
    // The extra row is what proves there is more; the caller never sees it.
    expect(requests.at(-1)?.limit).toBe(3);
  });

  it('reports an empty window at the caller cursor rather than at zero', async () => {
    const { journal, openRequests } = journalOf([]);
    const read = createWorkspaceResumeSnapshotReader({ journal, now });

    const snapshot = await read.read({ workspaceId: 'ws-1', afterSequence: 7 });

    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    expect(snapshot.value.events).toEqual([]);
    expect(snapshot.value.cursor).toBe(7);
    expect(snapshot.value.truncated).toBe(false);
    expect(snapshot.value.openReferences).toEqual({ count: 0, latestSequence: null });
    // With no start in the window there is nothing to ask about.
    expect(openRequests).toEqual([]);
  });

  it('counts only the calls whose work may still be running', async () => {
    // A `started` row with no verdict is open; a completed row is not, and neither is a
    // `started` row a settlement already closed.
    const { journal } = journalOf([
      entry({ sequence: 1, phase: 'started', status: 'started' }),
      entry({ sequence: 2, phase: 'started', status: 'started', closureCode: 'process_exited' }),
      entry({ sequence: 3, phase: 'completed', status: 'completed' }),
      entry({ sequence: 4, phase: 'started', status: 'started' }),
    ]);
    const read = createWorkspaceResumeSnapshotReader({ journal, now });

    const snapshot = await read.read({ workspaceId: 'ws-1' });

    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    expect(snapshot.value.openReferences).toEqual({ count: 2, latestSequence: 4 });
    expect(snapshot.value.events.map((event) => event.open)).toEqual([true, false, false, true]);
  });

  it('does not call a call open just because its completion sits past the cursor', async () => {
    // The window ends before `call-a` completes. Judging "open" from the window alone
    // would report a finished call as running; the store answers for the whole journal.
    const { journal, openRequests } = journalOf([
      entry({ sequence: 1, operationKind: 'git_publish', callId: 'call-a', phase: 'started', status: 'started' }),
      entry({ sequence: 2, operationKind: 'git_publish', callId: 'call-b', phase: 'started', status: 'started' }),
      entry({ sequence: 3, operationKind: 'git_publish', callId: 'call-a', phase: 'completed', status: 'completed' }),
    ]);
    const read = createWorkspaceResumeSnapshotReader({ journal, now });

    const snapshot = await read.read({ workspaceId: 'ws-1', limit: 2 });

    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    expect(snapshot.value.events.map((event) => event.open)).toEqual([false, true]);
    expect(snapshot.value.openReferences).toEqual({ count: 1, latestSequence: 2 });
    expect(openRequests).toEqual([{ workspaceId: 'ws-1', callIds: ['call-a', 'call-b'] }]);
  });

  it('keeps a handle-returning call open after its own request completed', async () => {
    // `process_start` returns as soon as the child spawns, so its `completed` row ends
    // the request, not the work; only a `closure_code` ends the pin.
    const { journal } = journalOf([
      entry({ sequence: 1, operationKind: 'process_start', callId: 'spawn-1', phase: 'started', status: 'started' }),
      entry({ sequence: 2, operationKind: 'process_start', callId: 'spawn-1', phase: 'completed', status: 'completed' }),
      entry({ sequence: 3, operationKind: 'process_start', callId: 'spawn-2', phase: 'started', status: 'started', closureCode: 'process_exited' }),
    ], ['process_start']);
    const read = createWorkspaceResumeSnapshotReader({ journal, now });

    const snapshot = await read.read({ workspaceId: 'ws-1' });

    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    // The completion row is open too: it is the same call, and the work it started is
    // still pinned. One call, counted once, at the newest row it owns.
    expect(snapshot.value.events.map((event) => event.open)).toEqual([true, true, false]);
    expect(snapshot.value.openReferences).toEqual({ count: 1, latestSequence: 2 });
  });

  it('reports a handle-returning call open from a window that only holds its completion', async () => {
    // The cursor lands between the two rows, so the window cannot see the `started` row
    // and cannot see that the kind is handle-returning. Reading "open" off the row's own
    // phase would tell a resumed session the spawned work had finished.
    const { journal, openRequests } = journalOf([
      entry({ sequence: 1, operationKind: 'process_start', callId: 'spawn-1', phase: 'started', status: 'started' }),
      entry({ sequence: 2, operationKind: 'process_start', callId: 'spawn-1', phase: 'completed', status: 'completed' }),
      entry({ sequence: 3, operationKind: 'git_publish', callId: 'publish-1', phase: 'completed', status: 'completed' }),
    ], ['process_start']);
    const read = createWorkspaceResumeSnapshotReader({ journal, now });

    const snapshot = await read.read({ workspaceId: 'ws-1', afterSequence: 1, limit: 2 });

    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    expect(snapshot.value.events.map((event) => [event.sequence, event.open])).toEqual([[2, true], [3, false]]);
    expect(snapshot.value.openReferences).toEqual({ count: 1, latestSequence: 2 });
    expect(openRequests).toEqual([{ workspaceId: 'ws-1', callIds: ['spawn-1', 'publish-1'] }]);
  });

  it('asks the store for one workspace only', async () => {
    const { journal, requests } = journalOf([entry({ sequence: 1 }), entry({ sequence: 2, workspaceId: 'ws-2' })]);
    const read = createWorkspaceResumeSnapshotReader({ journal, now });

    const first = await read.read({ workspaceId: 'ws-1' });
    const second = await read.read({ workspaceId: 'ws-2' });

    expect(first.ok && first.value.events.map((event) => event.sequence)).toEqual([1]);
    expect(second.ok && second.value.events.map((event) => event.sequence)).toEqual([2]);
    expect(requests.map((request) => request.workspaceId)).toEqual(['ws-1', 'ws-2']);
  });

  it('refuses a request it cannot answer without guessing', async () => {
    const { journal, requests, openRequests } = journalOf([entry({ sequence: 1 })]);
    const read = createWorkspaceResumeSnapshotReader({ journal, now });

    for (const request of [
      { workspaceId: '   ' },
      { workspaceId: 'ws-1', limit: 0 },
      { workspaceId: 'ws-1', limit: WORKSPACE_RESUME_MAX_LIMIT + 1 },
      { workspaceId: 'ws-1', limit: 1.5 },
      { workspaceId: 'ws-1', afterSequence: -1 },
    ]) {
      const snapshot = await read.read(request);
      expect(snapshot.ok, JSON.stringify(request)).toBe(false);
      if (snapshot.ok) continue;
      expect(snapshot.error.code).toBe('INVALID_INPUT');
    }
    // Nothing was read: a refused request must not spend a store query.
    expect(requests).toEqual([]);
    expect(openRequests).toEqual([]);
  });
});

describe('workspace resume snapshot from the newest end', async () => {
  const rows = Array.from({ length: 25 }, (_, index) => entry({ sequence: index + 1 }));

  it('reads the current end of the journal and pages back through olderCursor', async () => {
    const { journal, requests } = journalOf(rows);
    const reader = createWorkspaceResumeSnapshotReader({ journal });

    const latest = await reader.read({ workspaceId: 'ws-1', window: 'newest', limit: 20 });
    expect(latest.ok).toBe(true);
    if (!latest.ok) return;
    // The rows that describe today's work, not the first 20 ever recorded.
    expect(latest.value.events.map((event) => event.sequence)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 6),
    );
    expect(latest.value.cursor).toBe(25);
    expect(latest.value.truncated).toBe(true);
    expect(latest.value.olderCursor).toBe(6);
    expect(requests[0]).toMatchObject({ fromNewest: true, limit: 21 });

    const older = await reader.read({ workspaceId: 'ws-1', window: 'newest', beforeSequence: 6, limit: 20 });
    expect(older.ok).toBe(true);
    if (!older.ok) return;
    expect(older.value.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5]);
    // Reaching the start is what a null cursor proves: no older row is left to read.
    expect(older.value.truncated).toBe(false);
    expect(older.value.olderCursor).toBeNull();
  });

  it('leaves olderCursor null for a forward window, and for a newest window that fits', async () => {
    const { journal } = journalOf(rows.slice(0, 3));
    const reader = createWorkspaceResumeSnapshotReader({ journal });

    const forward = await reader.read({ workspaceId: 'ws-1', limit: 20 });
    expect(forward.ok).toBe(true);
    if (!forward.ok) return;
    expect(forward.value.olderCursor).toBeNull();

    const newest = await reader.read({ workspaceId: 'ws-1', window: 'newest', limit: 20 });
    expect(newest.ok).toBe(true);
    if (!newest.ok) return;
    expect(newest.value.truncated).toBe(false);
    expect(newest.value.olderCursor).toBeNull();
  });

  it('refuses to read both directions in one request, from either side', async () => {
    const { journal, requests } = journalOf(rows);
    const reader = createWorkspaceResumeSnapshotReader({ journal });
    expect(await reader.read({ workspaceId: 'ws-1', window: 'newest', afterSequence: 4 })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    });
    // A backward cursor on a forward window is refused too: ignoring it would answer a
    // different question than the caller asked, and silently return the oldest rows.
    expect(await reader.read({ workspaceId: 'ws-1', beforeSequence: 4 })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    });
    expect(await reader.read({ workspaceId: 'ws-1', window: 'oldest', beforeSequence: 4 })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    });
    // Neither refusal reached the journal.
    expect(requests).toEqual([]);
  });
});

describe('workspace resume stale-generation projection', () => {
  const staleStarted = entry({
    sequence: 1, callId: 'old-call', phase: 'started', status: 'started', goalId: 'goal-1', executionGeneration: 4,
  });
  const liveStarted = entry({
    sequence: 2, callId: 'live-call', phase: 'started', status: 'started', goalId: 'goal-1', executionGeneration: 6,
  });

  it('does not report a dead generation\'s open call as work still running', async () => {
    const { journal } = journalOf([staleStarted, liveStarted], ['process_start']);
    const reader = createWorkspaceResumeSnapshotReader({ journal, now });

    const snapshot = await reader.read({
      workspaceId: 'ws-1',
      currentGoal: { goalId: 'goal-1', executionGeneration: 6 },
    });

    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    // The stale call's row keeps its own generation, so a caller can see *why* it is not
    // open; treating it as silently finished would be a different lie.
    expect(snapshot.value.events.map((event) => [event.sequence, event.open, event.superseded, event.executionGeneration])).toEqual([
      [1, false, true, 4],
      [2, true, false, 6],
    ]);
    // Only the current generation's call counts as open work.
    expect(snapshot.value.openReferences).toEqual({ count: 1, latestSequence: 2 });
  });

  it('leaves calls unjudged when no current generation is known', async () => {
    const { journal } = journalOf([staleStarted, liveStarted], ['process_start']);
    const reader = createWorkspaceResumeSnapshotReader({ journal, now });

    const snapshot = await reader.read({ workspaceId: 'ws-1' });

    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    // Unknown, not stale: the journal window cannot know which generation is live, and
    // guessing would retire work that may still be running.
    expect(snapshot.value.events.map((event) => [event.open, event.superseded])).toEqual([[true, false], [true, false]]);
    expect(snapshot.value.openReferences.count).toBe(2);
  });

  it('judges a call by its newest correlated row and takes the scope from the reader', async () => {
    const started = entry({ sequence: 1, callId: 'mixed-call', phase: 'started', status: 'started' });
    const completed = entry({
      sequence: 2, callId: 'mixed-call', phase: 'completed', status: 'completed', resultCode: 'ok',
      goalId: 'goal-1', executionGeneration: 3,
    });
    const { journal } = journalOf([started, completed], ['process_start']);
    const reader = createWorkspaceResumeSnapshotReader({
      journal,
      now,
      // Wired once by the runtime from the mutation fence, so every caller judges alike.
      currentGoal: async () => ({ goalId: 'goal-1', executionGeneration: 5 }),
    });

    const snapshot = await reader.read({ workspaceId: 'ws-1' });

    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    // The admission correlation landed on the completion only; the call is still adjudicated.
    expect(snapshot.value.events.map((event) => [event.sequence, event.open, event.superseded])).toEqual([
      [1, false, true],
      [2, false, true],
    ]);
    expect(snapshot.value.openReferences).toEqual({ count: 0, latestSequence: null });
  });
});
