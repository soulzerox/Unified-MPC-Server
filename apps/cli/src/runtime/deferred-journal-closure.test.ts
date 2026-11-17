import { describe, expect, it, vi } from 'vitest';
import type { FileActor } from '@unified-mpc/application';
import { DEFERRED_CLOSURE_OPERATION_KINDS, type DeferredHandle } from '@unified-mpc/storage';
import type { DeferredClosureAuthority, DeferredHandleState } from './deferred-closure-authority.js';
import {
  NO_LIVE_PROCESS_CLOSURE_CODE,
  closeJudgedDeferredCalls,
  settleRememberedCalls,
} from './deferred-journal-closure.js';

const actor: FileActor = { clientId: 'client', sessionId: 'session' };
const closedAt = '2026-11-16T10:00:00.000Z';

function journal(): { readonly closeDeferredCalls: ReturnType<typeof vi.fn> } {
  return { closeDeferredCalls: vi.fn(() => 1) };
}

/** The recorded correlation: which handle each call returned, and who owns it. */
function ledger(handles: readonly Partial<DeferredHandle>[]): {
  readonly take: ReturnType<typeof vi.fn>;
  readonly forget: ReturnType<typeof vi.fn>;
} {
  return {
    take: vi.fn((_workspaceId: string, callIds: readonly string[]) => handles
      .filter((handle) => callIds.includes(handle.callId ?? 'call-1'))
      .map((handle) => ({ provider: 'process', handleId: 'process-1', ...handle }))),
    forget: vi.fn(() => handles.length),
  };
}

function authority(state: DeferredHandleState): Pick<DeferredClosureAuthority, 'handleState'> {
  return { handleState: vi.fn(async () => state) };
}

const operationKinds = [...DEFERRED_CLOSURE_OPERATION_KINDS];

function probe(options: {
  readonly store?: ReturnType<typeof journal>;
  readonly handles?: ReturnType<typeof ledger>;
  readonly authority?: Pick<DeferredClosureAuthority, 'handleState'>;
  readonly callIds?: readonly string[];
  readonly ownedCallIds?: readonly string[];
}): Promise<{ readonly closed: number; readonly settled: boolean }> {
  return closeJudgedDeferredCalls({
    journal: options.store ?? journal(),
    handles: options.handles ?? ledger([]),
    authority: options.authority ?? authority('gone'),
    operationKinds,
    actor,
    workspaceId: 'ws-1',
    callIds: options.callIds ?? ['call-1'],
    ownedCallIds: options.ownedCallIds ?? ['call-1'],
    closedAt,
  });
}

describe('closeJudgedDeferredCalls', () => {
  it('closes a call by the handle the ledger recorded, and forgets the verdict', async () => {
    const store = journal();
    const handles = ledger([{ callId: 'call-1', provider: 'process', handleId: 'process-1' }]);
    const asker = authority('gone');

    await expect(probe({ store, handles, authority: asker })).resolves.toEqual({ closed: 1, settled: true });

    expect(asker.handleState).toHaveBeenCalledWith({
      actor, workspaceId: 'ws-1', provider: 'process', handleId: 'process-1',
    });
    const call = store.closeDeferredCalls.mock.calls[0]?.[0] as unknown as {
      operationKinds: readonly string[]; recordedAtOrAfter: string; closureCode: string;
      closedAt: string; callIds: readonly string[];
    };
    expect(call.callIds).toEqual(['call-1']);
    expect(call.closureCode).toBe(NO_LIVE_PROCESS_CLOSURE_CODE);
    expect(call.closedAt).toBe(closedAt);
    // The floor is the runtime's own start: a same-id row from a previous host
    // could hold a handle this store never saw.
    expect(Date.parse(call.recordedAtOrAfter)).not.toBeNaN();
    expect(handles.forget).toHaveBeenCalledWith('ws-1', ['call-1']);
  });

  it('keeps a call pinned while its handle is live, and when the authority cannot answer', async () => {
    for (const state of ['live', 'unknown'] as const) {
      const store = journal();
      const handles = ledger([{ callId: 'call-1' }]);
      await expect(probe({ store, handles, authority: authority(state) }))
        .resolves.toEqual({ closed: 0, settled: false });
      expect(store.closeDeferredCalls).not.toHaveBeenCalled();
      expect(handles.forget).not.toHaveBeenCalled();
    }
  });

  it('never lets a live call in the same probe settle the ones that are gone', async () => {
    const store = journal();
    const handles = ledger([{ callId: 'call-1' }, { callId: 'call-2', handleId: 'process-2' }]);
    const asker = {
      handleState: vi.fn(async ({ handleId }: { readonly handleId: string }) => (
        handleId === 'process-1' ? 'gone' : 'live'
      )),
    } as unknown as Pick<DeferredClosureAuthority, 'handleState'>;

    await expect(probe({
      store, handles, authority: asker, callIds: ['call-1', 'call-2'], ownedCallIds: ['call-1', 'call-2'],
    })).resolves.toEqual({ closed: 1, settled: false });

    expect(store.closeDeferredCalls.mock.calls[0]?.[0]?.callIds).toEqual(['call-1']);
    // Only the settled handle is forgotten; the live one is re-asked next time.
    expect(handles.forget).toHaveBeenCalledWith('ws-1', ['call-1']);
  });

  it('leaves a call with no recorded handle pinned instead of guessing', async () => {
    const store = journal();
    const asker = authority('gone');

    // Settled, because nothing is left to ask: the pin stays (fail-closed) and the
    // call stops costing a lookup on every later completion.
    await expect(probe({ store, handles: ledger([]), authority: asker }))
      .resolves.toEqual({ closed: 0, settled: true });
    expect(asker.handleState).not.toHaveBeenCalled();
    expect(store.closeDeferredCalls).not.toHaveBeenCalled();
  });

  it('does not ask a provider no adapter can answer for', async () => {
    const store = journal();
    const handles = ledger([{ callId: 'call-1', provider: 'swarm', handleId: 'swarm-1' }]);
    const asker = authority('gone');

    // The authority saying `gone` is not enough: a provider with no closure code
    // has no vocabulary to write the verdict in, so the pin stays — and there is
    // nothing to retry, so the call is not remembered again.
    await expect(probe({ store, handles, authority: asker })).resolves.toEqual({ closed: 0, settled: true });
    expect(asker.handleState).not.toHaveBeenCalled();
    expect(store.closeDeferredCalls).not.toHaveBeenCalled();
  });

  it('does nothing when there is no call to judge', async () => {
    const store = journal();
    const handles = ledger([{ callId: 'call-1' }]);
    const asker = authority('gone');

    await expect(probe({ store, handles, authority: asker, callIds: [], ownedCallIds: [] }))
      .resolves.toEqual({ closed: 0, settled: false });
    // No call means no question: asking anyway would cost a store read per
    // completion event in every workspace.
    expect(handles.take).toHaveBeenCalledWith('ws-1', []);
    expect(asker.handleState).not.toHaveBeenCalled();
    expect(store.closeDeferredCalls).not.toHaveBeenCalled();
  });

  // The store silently drops kinds outside its deferred set, so a kind removed
  // from `DEFERRED_CLOSURE_OPERATION_KINDS` would turn the sweep into a no-op
  // without failing anything else.
  it('only probes kinds the store will accept', () => {
    for (const kind of operationKinds) {
      expect(DEFERRED_CLOSURE_OPERATION_KINDS.has(kind)).toBe(true);
    }
  });
});

describe('settleRememberedCalls', () => {
  it('forgets the calls the probe covered, and keeps one that started during the probe', async () => {
    // The regression this forbids: forgetting every entry for the workspace drops
    // a launcher whose `started` row landed during the awaited store read. No
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
    const probed: { callIds: readonly string[]; ownedCallIds: readonly string[] }[] = [];
    await settleRememberedCalls({
      remembered,
      workspaceId: 'ws-1',
      callId: 'completed-now',
      probe: async (callIds, ownedCallIds) => {
        probed.push({ callIds: [...callIds], ownedCallIds: [...ownedCallIds] });
        remembered.set('landed-during-probe', 'ws-1');
        return { closed: 3, settled: true };
      },
    });
    expect(probed).toEqual([{
      callIds: ['completed-now', 'probed-1', 'probed-2'],
      // Only the snapshot may be called settled: the completing call is judged
      // too, but it is not what the caller asked this probe to account for.
      ownedCallIds: ['probed-1', 'probed-2', 'completed-now'],
    }]);
    expect([...remembered]).toEqual([
      ['foreign', 'ws-2'],
      ['landed-during-probe', 'ws-1'],
    ]);
  });

  it('forgets nothing when the probe could not settle the calls it owned', async () => {
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
