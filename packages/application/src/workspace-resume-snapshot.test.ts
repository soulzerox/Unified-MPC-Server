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
      return entries
        .filter((candidate) => candidate.workspaceId === request.workspaceId
          && candidate.sequence > (request.afterSequence ?? 0))
        // The store orders by `sequence` ascending; the fake must too or the projection
        // would be tested against an order no real journal produces.
        .sort((left, right) => left.sequence - right.sequence)
        .slice(0, request.limit ?? entries.length);
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

describe('workspace resume snapshot', () => {
  it('projects the oldest rows first and hands back a cursor', () => {
    const { journal } = journalOf([entry({ sequence: 2 }), entry({ sequence: 1 })]);
    const read = createWorkspaceResumeSnapshotReader({ journal, now });

    const snapshot = read.read({ workspaceId: 'ws-1' });

    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    expect(snapshot.value.events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(snapshot.value.cursor).toBe(2);
    expect(snapshot.value.truncated).toBe(false);
    expect(snapshot.value.generatedAt).toBe('2026-11-18T03:00:00.000Z');
  });

  it('resumes from the cursor instead of replaying what the caller already read', () => {
    const { journal, requests } = journalOf([entry({ sequence: 1 }), entry({ sequence: 2 }), entry({ sequence: 3 })]);
    const read = createWorkspaceResumeSnapshotReader({ journal, now });

    const snapshot = read.read({ workspaceId: 'ws-1', afterSequence: 2 });

    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    expect(snapshot.value.events.map((event) => event.sequence)).toEqual([3]);
    expect(snapshot.value.cursor).toBe(3);
    expect(requests.at(-1)?.afterSequence).toBe(2);
  });

  it('bounds the window and says so instead of silently cutting it', () => {
    const { journal, requests } = journalOf([1, 2, 3].map((sequence) => entry({ sequence })));
    const read = createWorkspaceResumeSnapshotReader({ journal, now });

    const snapshot = read.read({ workspaceId: 'ws-1', limit: 2 });

    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    expect(snapshot.value.events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(snapshot.value.cursor).toBe(2);
    expect(snapshot.value.truncated).toBe(true);
    // The extra row is what proves there is more; the caller never sees it.
    expect(requests.at(-1)?.limit).toBe(3);
  });

  it('reports an empty window at the caller cursor rather than at zero', () => {
    const { journal, openRequests } = journalOf([]);
    const read = createWorkspaceResumeSnapshotReader({ journal, now });

    const snapshot = read.read({ workspaceId: 'ws-1', afterSequence: 7 });

    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    expect(snapshot.value.events).toEqual([]);
    expect(snapshot.value.cursor).toBe(7);
    expect(snapshot.value.truncated).toBe(false);
    expect(snapshot.value.openReferences).toEqual({ count: 0, latestSequence: null });
    // With no start in the window there is nothing to ask about.
    expect(openRequests).toEqual([]);
  });

  it('counts only the calls whose work may still be running', () => {
    // A `started` row with no verdict is open; a completed row is not, and neither is a
    // `started` row a settlement already closed.
    const { journal } = journalOf([
      entry({ sequence: 1, phase: 'started', status: 'started' }),
      entry({ sequence: 2, phase: 'started', status: 'started', closureCode: 'process_exited' }),
      entry({ sequence: 3, phase: 'completed', status: 'completed' }),
      entry({ sequence: 4, phase: 'started', status: 'started' }),
    ]);
    const read = createWorkspaceResumeSnapshotReader({ journal, now });

    const snapshot = read.read({ workspaceId: 'ws-1' });

    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    expect(snapshot.value.openReferences).toEqual({ count: 2, latestSequence: 4 });
    expect(snapshot.value.events.map((event) => event.open)).toEqual([true, false, false, true]);
  });

  it('does not call a call open just because its completion sits past the cursor', () => {
    // The window ends before `call-a` completes. Judging "open" from the window alone
    // would report a finished call as running; the store answers for the whole journal.
    const { journal, openRequests } = journalOf([
      entry({ sequence: 1, operationKind: 'git_publish', callId: 'call-a', phase: 'started', status: 'started' }),
      entry({ sequence: 2, operationKind: 'git_publish', callId: 'call-b', phase: 'started', status: 'started' }),
      entry({ sequence: 3, operationKind: 'git_publish', callId: 'call-a', phase: 'completed', status: 'completed' }),
    ]);
    const read = createWorkspaceResumeSnapshotReader({ journal, now });

    const snapshot = read.read({ workspaceId: 'ws-1', limit: 2 });

    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    expect(snapshot.value.events.map((event) => event.open)).toEqual([false, true]);
    expect(snapshot.value.openReferences).toEqual({ count: 1, latestSequence: 2 });
    expect(openRequests).toEqual([{ workspaceId: 'ws-1', callIds: ['call-a', 'call-b'] }]);
  });

  it('keeps a handle-returning call open after its own request completed', () => {
    // `process_start` returns as soon as the child spawns, so its `completed` row ends
    // the request, not the work; only a `closure_code` ends the pin.
    const { journal } = journalOf([
      entry({ sequence: 1, operationKind: 'process_start', callId: 'spawn-1', phase: 'started', status: 'started' }),
      entry({ sequence: 2, operationKind: 'process_start', callId: 'spawn-1', phase: 'completed', status: 'completed' }),
      entry({ sequence: 3, operationKind: 'process_start', callId: 'spawn-2', phase: 'started', status: 'started', closureCode: 'process_exited' }),
    ], ['process_start']);
    const read = createWorkspaceResumeSnapshotReader({ journal, now });

    const snapshot = read.read({ workspaceId: 'ws-1' });

    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    // The completion row is open too: it is the same call, and the work it started is
    // still pinned. One call, counted once, at the newest row it owns.
    expect(snapshot.value.events.map((event) => event.open)).toEqual([true, true, false]);
    expect(snapshot.value.openReferences).toEqual({ count: 1, latestSequence: 2 });
  });

  it('reports a handle-returning call open from a window that only holds its completion', () => {
    // The cursor lands between the two rows, so the window cannot see the `started` row
    // and cannot see that the kind is handle-returning. Reading "open" off the row's own
    // phase would tell a resumed session the spawned work had finished.
    const { journal, openRequests } = journalOf([
      entry({ sequence: 1, operationKind: 'process_start', callId: 'spawn-1', phase: 'started', status: 'started' }),
      entry({ sequence: 2, operationKind: 'process_start', callId: 'spawn-1', phase: 'completed', status: 'completed' }),
      entry({ sequence: 3, operationKind: 'git_publish', callId: 'publish-1', phase: 'completed', status: 'completed' }),
    ], ['process_start']);
    const read = createWorkspaceResumeSnapshotReader({ journal, now });

    const snapshot = read.read({ workspaceId: 'ws-1', afterSequence: 1, limit: 2 });

    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    expect(snapshot.value.events.map((event) => [event.sequence, event.open])).toEqual([[2, true], [3, false]]);
    expect(snapshot.value.openReferences).toEqual({ count: 1, latestSequence: 2 });
    expect(openRequests).toEqual([{ workspaceId: 'ws-1', callIds: ['spawn-1', 'publish-1'] }]);
  });

  it('asks the store for one workspace only', () => {
    const { journal, requests } = journalOf([entry({ sequence: 1 }), entry({ sequence: 2, workspaceId: 'ws-2' })]);
    const read = createWorkspaceResumeSnapshotReader({ journal, now });

    const first = read.read({ workspaceId: 'ws-1' });
    const second = read.read({ workspaceId: 'ws-2' });

    expect(first.ok && first.value.events.map((event) => event.sequence)).toEqual([1]);
    expect(second.ok && second.value.events.map((event) => event.sequence)).toEqual([2]);
    expect(requests.map((request) => request.workspaceId)).toEqual(['ws-1', 'ws-2']);
  });

  it('refuses a request it cannot answer without guessing', () => {
    const { journal, requests, openRequests } = journalOf([entry({ sequence: 1 })]);
    const read = createWorkspaceResumeSnapshotReader({ journal, now });

    for (const request of [
      { workspaceId: '   ' },
      { workspaceId: 'ws-1', limit: 0 },
      { workspaceId: 'ws-1', limit: WORKSPACE_RESUME_MAX_LIMIT + 1 },
      { workspaceId: 'ws-1', limit: 1.5 },
      { workspaceId: 'ws-1', afterSequence: -1 },
    ]) {
      const snapshot = read.read(request);
      expect(snapshot.ok, JSON.stringify(request)).toBe(false);
      if (snapshot.ok) continue;
      expect(snapshot.error.code).toBe('INVALID_INPUT');
    }
    // Nothing was read: a refused request must not spend a store query.
    expect(requests).toEqual([]);
    expect(openRequests).toEqual([]);
  });
});
