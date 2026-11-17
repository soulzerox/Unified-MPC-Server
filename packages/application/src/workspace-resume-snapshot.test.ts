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

function journalOf(entries: readonly WorkspaceJournalEntry[]): {
  readonly journal: WorkspaceResumeJournalReader;
  readonly requests: ListWorkspaceJournalRequest[];
} {
  const requests: ListWorkspaceJournalRequest[] = [];
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
  };
  return { journal, requests };
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
    const { journal } = journalOf([]);
    const read = createWorkspaceResumeSnapshotReader({ journal, now });

    const snapshot = read.read({ workspaceId: 'ws-1', afterSequence: 7 });

    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    expect(snapshot.value.events).toEqual([]);
    expect(snapshot.value.cursor).toBe(7);
    expect(snapshot.value.truncated).toBe(false);
    expect(snapshot.value.openReferences).toEqual({ count: 0, latestSequence: null });
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
    const { journal, requests } = journalOf([entry({ sequence: 1 })]);
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
  });
});
