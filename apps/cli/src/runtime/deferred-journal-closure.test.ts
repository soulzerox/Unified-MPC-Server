import { describe, expect, it, vi } from 'vitest';
import type { FileActor } from '@unified-mpc/application';
import { DEFERRED_CLOSURE_OPERATION_KINDS } from '@unified-mpc/storage';
import type { DeferredClosureAuthority, DeferredHandleState } from './deferred-closure-authority.js';
import {
  NO_LIVE_PROCESS_CLOSURE_CODE,
  PROCESS_HANDLE_DEFERRED_KINDS,
  closeObservedDeferredCalls,
  settleRememberedCalls,
} from './deferred-journal-closure.js';

const actor: FileActor = { clientId: 'client', sessionId: 'session' };
const closedAt = '2026-11-16T10:00:00.000Z';
const callIds = ['call-1'];

function journal(): { readonly closeDeferredCalls: ReturnType<typeof vi.fn> } {
  const closeDeferredCalls = vi.fn(() => 1);
  return { closeDeferredCalls };
}

function authority(state: DeferredHandleState): Pick<DeferredClosureAuthority, 'workspaceProcessState'> {
  return { workspaceProcessState: vi.fn(async () => state) };
}

describe('closeObservedDeferredCalls', () => {
  it('closes the call this request opened once the authority says no handle is live, and names that call', async () => {
    const store = journal();
    await expect(closeObservedDeferredCalls({
      journal: store, authority: authority('gone'), actor,
      workspaceId: 'ws-1', callIds, closedAt,
    })).resolves.toEqual({ closed: 1, settled: true });

    const call = store.closeDeferredCalls.mock.calls[0]?.[0] as unknown as {
      operationKinds: readonly string[]; recordedAtOrAfter: string; closureCode: string;
      closedAt: string; callIds: readonly string[];
    };
    expect(call.operationKinds).toEqual([...PROCESS_HANDLE_DEFERRED_KINDS]);
    expect(call.closureCode).toBe(NO_LIVE_PROCESS_CLOSURE_CODE);
    expect(call.closedAt).toBe(closedAt);
    // Scope is the request that just finished: the journal is shared between
    // stdio hosts, while the process list only holds this runtime's handles.
    expect(call.callIds).toEqual(['call-1']);
    // The floor is the runtime's own start: a call from a previous host could
    // hold a handle this store never saw.
    expect(Date.parse(call.recordedAtOrAfter)).not.toBeNaN();
    expect(call.operationKinds).not.toContain('shell');
    expect(call.operationKinds).not.toContain('task_create');
  });

  it('keeps the call pinned while a handle is live, and when the authority cannot answer', async () => {
    const store = journal();
    for (const state of ['live', 'unknown'] as const) {
      await expect(closeObservedDeferredCalls({
        journal: store, authority: authority(state), actor,
        workspaceId: 'ws-1', callIds, closedAt,
      })).resolves.toEqual({ closed: 0, settled: false });
    }
    expect(store.closeDeferredCalls).not.toHaveBeenCalled();
  });

  it('does nothing when there is no call to close', async () => {
    const store = journal();
    const probe = authority('gone');
    await expect(closeObservedDeferredCalls({
      journal: store, authority: probe, actor, workspaceId: 'ws-1', callIds: [], closedAt,
    })).resolves.toEqual({ closed: 0, settled: false });
    expect(store.closeDeferredCalls).not.toHaveBeenCalled();
    // No call means no question: asking anyway would cost a store read per
    // completion event in every workspace.
    expect(probe.workspaceProcessState).not.toHaveBeenCalled();
  });

  // The store silently drops kinds outside its deferred set, so a kind removed
  // from `DEFERRED_CLOSURE_OPERATION_KINDS` would turn the sweep into a no-op
  // without failing anything else.
  it('only probes kinds the store will accept', () => {
    for (const kind of PROCESS_HANDLE_DEFERRED_KINDS) {
      expect(DEFERRED_CLOSURE_OPERATION_KINDS.has(kind)).toBe(true);
    }
  });
});

describe('settleRememberedCalls', () => {
  it('forgets the calls the probe covered, and keeps one that started during the probe', async () => {
    // The regression this forbids: forgetting every entry for the workspace drops
    // a launcher whose `started` row landed during the awaited process read. No
    // verdict covers it, so nothing retries it and the goal stays `present`.
    // `foreign` predates the snapshot, so it pins the workspace filter: a snapshot
    // that took every remembered call would probe and forget another workspace's
    // pin. `completed-now` predates it too, so it pins the dedupe.
    const remembered = new Map([
      ['probed-1', 'ws-1'],
      ['probed-2', 'ws-1'],
      ['foreign', 'ws-2'],
      ['completed-now', 'ws-1'],
    ]);
    const probed: string[][] = [];
    await settleRememberedCalls({
      remembered,
      workspaceId: 'ws-1',
      callId: 'completed-now',
      probe: async (callIds) => {
        probed.push([...callIds]);
        remembered.set('landed-during-probe', 'ws-1');
        return { closed: 3, settled: true };
      },
    });
    expect(probed).toEqual([['completed-now', 'probed-1', 'probed-2']]);
    expect([...remembered]).toEqual([
      ['foreign', 'ws-2'],
      ['landed-during-probe', 'ws-1'],
    ]);
  });

  it('forgets nothing when the probe could not settle the workspace', async () => {
    const remembered = new Map([['probed-1', 'ws-1']]);
    await settleRememberedCalls({
      remembered,
      workspaceId: 'ws-1',
      callId: 'completed-now',
      probe: async () => ({ closed: 0, settled: false }),
    });
    expect([...remembered]).toEqual([['probed-1', 'ws-1']]);
  });
});
