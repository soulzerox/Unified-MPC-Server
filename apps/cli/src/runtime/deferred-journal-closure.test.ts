import { describe, expect, it, vi } from 'vitest';
import type { FileActor } from '@unified-mpc/application';
import { DIRECT_PROCESS_TOOLS, WRAPPED_PROCESS_TOOLS } from '@unified-mpc/mcp-server';
import { DEFERRED_CLOSURE_OPERATION_KINDS, type DeferredHandle } from '@unified-mpc/storage';
import type { DeferredClosureAuthority, DeferredHandleState } from './deferred-closure-authority.js';
import {
  NO_LIVE_PROCESS_CLOSURE_CODE,
  closeJudgedDeferredCalls,
  settleRememberedCalls,
} from './deferred-journal-closure.js';

const actor: FileActor = { clientId: 'client', sessionId: 'session' };
const closedAt = '2026-11-16T10:00:00.000Z';

function journal(closedPerCall = 1): { readonly closeDeferredCalls: ReturnType<typeof vi.fn> } {
  return { closeDeferredCalls: vi.fn(() => closedPerCall) };
}

/**
 * The recorded correlation: which handle each call returned, and who owns it.
 *
 * `take` honours the `callIds` list unless `shared` is set, which models the
 * ledger being shared by every host on the database: it may answer with rows this
 * runtime never journaled.
 */
function ledger(handles: readonly Partial<DeferredHandle>[], options: { shared?: boolean } = {}): {
  readonly take: ReturnType<typeof vi.fn>;
  readonly forget: ReturnType<typeof vi.fn>;
} {
  return {
    take: vi.fn((_workspaceId: string, callIds: readonly string[]) => handles
      .filter((handle) => options.shared === true || callIds.includes(handle.callId ?? 'call-1'))
      .map((handle) => ({ provider: 'process', handleId: 'process-1', ...handle }))),
    forget: vi.fn(() => handles.length),
  };
}

function authority(
  handle: DeferredHandleState,
  workspace: DeferredHandleState = handle,
): {
  readonly handleState: ReturnType<typeof vi.fn>;
  readonly workspaceProcessState: ReturnType<typeof vi.fn>;
} {
  return {
    handleState: vi.fn(async () => handle),
    workspaceProcessState: vi.fn(async () => workspace),
  };
}

const operationKinds = [...DEFERRED_CLOSURE_OPERATION_KINDS];

function probe(options: {
  readonly store?: ReturnType<typeof journal>;
  readonly handles?: ReturnType<typeof ledger>;
  readonly authority?: Pick<DeferredClosureAuthority, 'handleState' | 'workspaceProcessState'>;
  readonly ownedCallIds?: readonly string[];
}): Promise<{ readonly closed: number; readonly settled: boolean }> {
  return closeJudgedDeferredCalls({
    journal: options.store ?? journal(),
    handles: options.handles ?? ledger([]),
    authority: options.authority ?? authority('gone'),
    operationKinds,
    actor,
    workspaceId: 'ws-1',
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
      workspaceProcessState: vi.fn(async () => 'live' as const),
    } as unknown as Pick<DeferredClosureAuthority, 'handleState' | 'workspaceProcessState'>;

    await expect(probe({
      store, handles, authority: asker, ownedCallIds: ['call-1', 'call-2'],
    })).resolves.toEqual({ closed: 1, settled: false });

    expect(store.closeDeferredCalls.mock.calls[0]?.[0]?.callIds).toEqual(['call-1']);
    // Only the settled handle is forgotten; the live one is re-asked next time.
    expect(handles.forget).toHaveBeenCalledWith('ws-1', ['call-1']);
  });

  it('closes a call that recorded no handle once the workspace has nothing live', async () => {
    const store = journal();
    const handles = ledger([]);
    // The handle question has no subject, so the workspace question is the only
    // evidence left: nothing live here means the launch never produced work.
    const asker = authority('live', 'gone');

    await expect(probe({ store, handles, authority: asker })).resolves.toEqual({ closed: 1, settled: true });

    expect(asker.workspaceProcessState).toHaveBeenCalledWith({ actor, workspaceId: 'ws-1' });
    expect(asker.handleState).not.toHaveBeenCalled();
    const call = store.closeDeferredCalls.mock.calls[0]?.[0] as unknown as { callIds: readonly string[]; closureCode: string };
    expect(call.callIds).toEqual(['call-1']);
    expect(call.closureCode).toBe(NO_LIVE_PROCESS_CLOSURE_CODE);
    expect(handles.forget).toHaveBeenCalledWith('ws-1', ['call-1']);
  });

  it('keeps a handle-less call pinned while the workspace still has a live process', async () => {
    const store = journal();
    const handles = ledger([]);

    for (const state of ['live', 'unknown'] as const) {
      await expect(probe({ store, handles, authority: authority('live', state) }))
        .resolves.toEqual({ closed: 0, settled: false });
    }
    expect(store.closeDeferredCalls).not.toHaveBeenCalled();
    expect(handles.forget).not.toHaveBeenCalled();
  });

  it('never judges a recorded handle this runtime did not journal', async () => {
    const store = journal();
    // A shared ledger can answer with another host's row: it is not evidence here.
    const handles = ledger([{ callId: 'another-hosts-call', handleId: 'process-9' }], { shared: true });
    const asker = authority('gone', 'gone');

    await expect(probe({ store, handles, authority: asker })).resolves.toEqual({ closed: 1, settled: true });

    expect(asker.handleState).not.toHaveBeenCalled();
    expect(store.closeDeferredCalls.mock.calls[0]?.[0]?.callIds).toEqual(['call-1']);
    expect(handles.forget).toHaveBeenCalledWith('ws-1', ['call-1']);
  });

  it('does not ask a provider no adapter can answer for', async () => {
    const store = journal();
    const handles = ledger([{ callId: 'call-1', provider: 'swarm', handleId: 'swarm-1' }]);
    const asker = authority('gone');

    // The authority saying `gone` is not enough: a provider with no route has no
    // vocabulary to write the verdict in, so the pin stays — and there is nothing
    // to retry, so the call is not remembered again.
    await expect(probe({ store, handles, authority: asker })).resolves.toEqual({ closed: 0, settled: true });
    expect(asker.handleState).not.toHaveBeenCalled();
    expect(asker.workspaceProcessState).not.toHaveBeenCalled();
    expect(store.closeDeferredCalls).not.toHaveBeenCalled();
  });

  it('keeps the correlation when the store closes nothing', async () => {
    const store = journal(0);
    const handles = ledger([{ callId: 'call-1' }]);

    await expect(probe({ store, handles, authority: authority('gone') }))
      .resolves.toEqual({ closed: 0, settled: true });
    // A row the store refused (already closed, or older than this runtime) must
    // keep its ledger entry: forgetting it would drop the correlation a later
    // sweep needs to ask again.
    expect(handles.forget).not.toHaveBeenCalled();
  });

  it('does nothing when there is no call to judge', async () => {
    const store = journal();
    const handles = ledger([{ callId: 'call-1' }]);
    const asker = authority('gone');

    await expect(probe({ store, handles, authority: asker, ownedCallIds: [] }))
      .resolves.toEqual({ closed: 0, settled: false });
    // No call means no question: asking anyway would cost a store read per
    // completion event in every workspace.
    expect(handles.take).not.toHaveBeenCalled();
    expect(asker.handleState).not.toHaveBeenCalled();
    expect(store.closeDeferredCalls).not.toHaveBeenCalled();
  });

  // The store silently drops kinds outside its deferred set, so a process tool the
  // recorder writes a handle for but the closure kinds omit turns the sweep into a
  // no-op for that tool without failing anything else.
  it('accepts a closure for every tool that records a process handle', () => {
    for (const toolName of [...DIRECT_PROCESS_TOOLS, ...WRAPPED_PROCESS_TOOLS]) {
      expect(DEFERRED_CLOSURE_OPERATION_KINDS.has(toolName)).toBe(true);
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
    // pin.
    const remembered = new Map([
      ['probed-1', 'ws-1'],
      ['probed-2', 'ws-1'],
      ['foreign', 'ws-2'],
    ]);
    const probed: (readonly string[])[] = [];
    await settleRememberedCalls({
      remembered,
      workspaceId: 'ws-1',
      probe: async (ownedCallIds) => {
        probed.push([...ownedCallIds]);
        remembered.set('landed-during-probe', 'ws-1');
        return { closed: 2, settled: true };
      },
    });
    expect(probed).toEqual([['probed-1', 'probed-2']]);
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
      probe: async () => ({ closed: 0, settled: false }),
    });
    expect([...remembered]).toEqual([['probed-1', 'ws-1']]);
  });

  it('asks nothing when this workspace remembers no call', async () => {
    const remembered = new Map([['other-workspace-call', 'ws-2']]);
    const probe = vi.fn(async () => ({ closed: 0, settled: false }));
    await settleRememberedCalls({ remembered, workspaceId: 'ws-1', probe });
    expect(probe).not.toHaveBeenCalled();
  });
});
