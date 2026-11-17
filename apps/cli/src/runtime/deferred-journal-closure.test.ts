import { describe, expect, it, vi } from 'vitest';
import type { FileActor } from '@unified-mpc/application';
import { AGENT_SWARM_TOOLS, CODEX_TASK_TOOLS, DIRECT_PROCESS_TOOLS, DURABLE_TASK_TOOLS, MERGE_VERIFICATION_TOOLS, WRAPPED_PROCESS_TOOLS } from '@unified-mpc/mcp-server';
import { DEFERRED_CLOSURE_OPERATION_KINDS, type DeferredHandle } from '@unified-mpc/storage';
import type { DeferredClosureAuthority, DeferredHandleState } from './deferred-closure-authority.js';
import {
  NO_LIVE_CODEX_CLOSURE_CODE,
  NO_LIVE_PROCESS_CLOSURE_CODE,
  NO_LIVE_SWARM_CLOSURE_CODE,
  NO_LIVE_TASK_CLOSURE_CODE,
  NO_LIVE_VERIFICATION_CLOSURE_CODE,
  closeJudgedDeferredCalls,
  settleRememberedCalls,
} from './deferred-journal-closure.js';

const actor: FileActor = { clientId: 'client', sessionId: 'session' };
const closedAt = '2026-11-16T10:00:00.000Z';

function journal(
  closed: number | ((callId: string) => number) = 1,
  stillOpen: readonly string[] = [],
  kinds: Readonly<Record<string, string>> = {},
): {
  readonly closeDeferredCalls: ReturnType<typeof vi.fn>;
  readonly openDeferredCallIds: ReturnType<typeof vi.fn>;
  readonly openDeferredCallKinds: ReturnType<typeof vi.fn>;
} {
  return {
    closeDeferredCalls: vi.fn((request: { readonly callIds: readonly string[] }) => (
      typeof closed === 'function' ? closed(request.callIds[0] ?? '') : closed
    )),
    // A zero from `closeDeferredCalls` can mean "already closed" or "out of reach".
    // The list is what tells them apart, so it is asserted, not defaulted away.
    openDeferredCallIds: vi.fn(() => stillOpen),
    // The journal is the only place that still knows a call's kind, and it decides
    // whether the coarser process answer may speak for it. Default to a process
    // kind so the fixtures that predate kinds keep their meaning.
    openDeferredCallKinds: vi.fn((request: { readonly callIds: readonly string[] }) => new Map(
      request.callIds.map((callId) => [callId, kinds[callId] ?? 'process_start']),
    )),
  };
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
/** The kinds a managed-process listing can speak for, as the runtime passes them. */
const PROCESS_HANDLE_TOOLS: ReadonlySet<string> = new Set([...DIRECT_PROCESS_TOOLS, ...WRAPPED_PROCESS_TOOLS]);

function probe(options: {
  readonly store?: ReturnType<typeof journal>;
  readonly handles?: ReturnType<typeof ledger>;
  readonly authority?: Pick<DeferredClosureAuthority, 'handleState' | 'workspaceProcessState'>;
  readonly ownedCallIds?: readonly string[];
}): Promise<{ readonly closed: number; readonly accountedCallIds: readonly string[] }> {
  return closeJudgedDeferredCalls({
    journal: options.store ?? journal(),
    handles: options.handles ?? ledger([]),
    authority: options.authority ?? authority('gone'),
    operationKinds,
    workspaceFallbackKinds: PROCESS_HANDLE_TOOLS,
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

    await expect(probe({ store, handles, authority: asker })).resolves.toEqual({ closed: 1, accountedCallIds: ['call-1'] });

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
        .resolves.toEqual({ closed: 0, accountedCallIds: [] });
      expect(store.closeDeferredCalls).not.toHaveBeenCalled();
      expect(handles.forget).not.toHaveBeenCalled();
    }
  });

  it('closes a durable task by its id under the task code, not the process code', async () => {
    const store = journal();
    const handles = ledger([{ callId: 'call-1', provider: 'task', handleId: 'task-1' }]);
    const asker = authority('gone');

    await expect(probe({ store, handles, authority: asker })).resolves.toEqual({ closed: 1, accountedCallIds: ['call-1'] });

    expect(asker.handleState).toHaveBeenCalledWith({
      actor, workspaceId: 'ws-1', provider: 'task', handleId: 'task-1',
    });
    const call = store.closeDeferredCalls.mock.calls[0]?.[0] as unknown as { closureCode: string };
    expect(call.closureCode).toBe(NO_LIVE_TASK_CLOSURE_CODE);
    // A task with a handle is judged by that handle; asking whether some process
    // is live in the workspace would answer a different question.
    expect(asker.workspaceProcessState).not.toHaveBeenCalled();
    expect(handles.forget).toHaveBeenCalledWith('ws-1', ['call-1']);
  });

  it('never answers a durable task that recorded no handle with the process listing', async () => {
    // Reachable when the ledger write threw: the row is best-effort, so the call
    // is journaled but has no handle. A live durable task is not in the process
    // listing, so that answer would release the pin on running work.
    const store = journal(1, ['call-1'], { 'call-1': 'task_create' });
    const asker = authority('gone', 'gone');

    // The row is still open, so the pin and the retry both stay.
    await expect(probe({ store, handles: ledger([]), authority: asker }))
      .resolves.toEqual({ closed: 0, accountedCallIds: [] });
    expect(asker.workspaceProcessState).not.toHaveBeenCalled();
    expect(store.closeDeferredCalls).not.toHaveBeenCalled();
  });

  it('still closes a process call that recorded no handle once nothing is live', async () => {
    // The same shape for a kind the listing can speak for: the fix must not
    // suspend the release path for foreground-free launches that never started.
    const store = journal();
    const asker = authority('gone', 'gone');

    await expect(probe({ store, handles: ledger([]), authority: asker }))
      .resolves.toEqual({ closed: 1, accountedCallIds: ['call-1'] });
    expect(asker.workspaceProcessState).toHaveBeenCalledWith({ actor, workspaceId: 'ws-1' });
  });

  it('keeps a still-running durable task pinned and re-asks it next sweep', async () => {
    const store = journal();
    const handles = ledger([{ callId: 'call-1', provider: 'task', handleId: 'task-1' }]);

    await expect(probe({ store, handles, authority: authority('live', 'gone') }))
      .resolves.toEqual({ closed: 0, accountedCallIds: [] });
    expect(store.closeDeferredCalls).not.toHaveBeenCalled();
    expect(handles.forget).not.toHaveBeenCalled();
  });

  it('closes a queued verification by its attempt id under the verification code', async () => {
    const store = journal();
    const handles = ledger([{ callId: 'call-1', provider: 'verification', handleId: 'attempt-1' }]);
    const asker = authority('gone');

    await expect(probe({ store, handles, authority: asker })).resolves.toEqual({ closed: 1, accountedCallIds: ['call-1'] });

    expect(asker.handleState).toHaveBeenCalledWith({
      actor, workspaceId: 'ws-1', provider: 'verification', handleId: 'attempt-1',
    });
    const call = store.closeDeferredCalls.mock.calls[0]?.[0] as unknown as { closureCode: string };
    expect(call.closureCode).toBe(NO_LIVE_VERIFICATION_CLOSURE_CODE);
    // A queued verification never appears in the process listing, so that answer
    // would say nothing about whether the gate it queued is still coming.
    expect(asker.workspaceProcessState).not.toHaveBeenCalled();
    expect(handles.forget).toHaveBeenCalledWith('ws-1', ['call-1']);
  });

  it('keeps a queued verification pinned while its attempt can still run', async () => {
    const store = journal();
    const handles = ledger([{ callId: 'call-1', provider: 'verification', handleId: 'attempt-1' }]);

    await expect(probe({ store, handles, authority: authority('live', 'gone') }))
      .resolves.toEqual({ closed: 0, accountedCallIds: [] });
    expect(store.closeDeferredCalls).not.toHaveBeenCalled();
    expect(handles.forget).not.toHaveBeenCalled();
  });

  it('closes a codex_run by its codex task id under the codex code', async () => {
    const store = journal();
    const handles = ledger([{ callId: 'call-1', provider: 'codex', handleId: 'codex-1' }]);
    const asker = authority('gone');

    await expect(probe({ store, handles, authority: asker })).resolves.toEqual({ closed: 1, accountedCallIds: ['call-1'] });

    expect(asker.handleState).toHaveBeenCalledWith({
      actor, workspaceId: 'ws-1', provider: 'codex', handleId: 'codex-1',
    });
    const call = store.closeDeferredCalls.mock.calls[0]?.[0] as unknown as { closureCode: string };
    expect(call.closureCode).toBe(NO_LIVE_CODEX_CLOSURE_CODE);
    // A codex task is in the codex adapter's own process manager, so the CLI
    // listing answering for it could only ever call a live run gone.
    expect(asker.workspaceProcessState).not.toHaveBeenCalled();
    expect(handles.forget).toHaveBeenCalledWith('ws-1', ['call-1']);
  });

  it('keeps a running codex task pinned and re-asks it next sweep', async () => {
    const store = journal();
    const handles = ledger([{ callId: 'call-1', provider: 'codex', handleId: 'codex-1' }]);

    await expect(probe({ store, handles, authority: authority('live', 'gone') }))
      .resolves.toEqual({ closed: 0, accountedCallIds: [] });
    expect(store.closeDeferredCalls).not.toHaveBeenCalled();
    expect(handles.forget).not.toHaveBeenCalled();
  });

  it('never answers a codex_run that recorded no handle with the process listing', async () => {
    // A codex_run whose ledger write failed records nothing, and its process is
    // invisible to the CLI listing, so that answer would release a live pin.
    const store = journal(1, ['call-1'], { 'call-1': 'codex_run' });
    const asker = authority('gone', 'gone');

    await expect(probe({ store, handles: ledger([]), authority: asker }))
      .resolves.toEqual({ closed: 0, accountedCallIds: [] });
    expect(asker.workspaceProcessState).not.toHaveBeenCalled();
    expect(store.closeDeferredCalls).not.toHaveBeenCalled();
  });

  it('closes a started agent swarm by its swarm id under the codex-swarm code', async () => {
    const store = journal();
    const handles = ledger([{ callId: 'call-1', provider: 'swarm', handleId: 'swarm-1' }]);
    const asker = authority('gone');

    await expect(probe({ store, handles, authority: asker })).resolves.toEqual({ closed: 1, accountedCallIds: ['call-1'] });

    expect(asker.handleState).toHaveBeenCalledWith({
      actor, workspaceId: 'ws-1', provider: 'swarm', handleId: 'swarm-1',
    });
    const call = store.closeDeferredCalls.mock.calls[0]?.[0] as unknown as { closureCode: string };
    expect(call.closureCode).toBe(NO_LIVE_SWARM_CLOSURE_CODE);
    // A swarm runs in its own runtime, so nothing in the process listing speaks for it.
    expect(asker.workspaceProcessState).not.toHaveBeenCalled();
    expect(handles.forget).toHaveBeenCalledWith('ws-1', ['call-1']);
  });

  it('keeps a running swarm pinned and re-asks it next sweep', async () => {
    const store = journal();
    const handles = ledger([{ callId: 'call-1', provider: 'swarm', handleId: 'swarm-1' }]);

    await expect(probe({ store, handles, authority: authority('live', 'gone') }))
      .resolves.toEqual({ closed: 0, accountedCallIds: [] });
    expect(store.closeDeferredCalls).not.toHaveBeenCalled();
    expect(handles.forget).not.toHaveBeenCalled();
  });

  it('never answers a swarm call that recorded no handle with the process listing', async () => {
    const store = journal(1, ['call-1'], { 'call-1': 'agent_swarm_run' });
    const asker = authority('gone', 'gone');

    await expect(probe({ store, handles: ledger([]), authority: asker }))
      .resolves.toEqual({ closed: 0, accountedCallIds: [] });
    expect(asker.workspaceProcessState).not.toHaveBeenCalled();
    expect(store.closeDeferredCalls).not.toHaveBeenCalled();
  });

  it('accounts a handle-less call its own response already closed instead of retrying it forever', async () => {
    // An `agent_swarm_run` read settles its own row under `swarm_read_settled`.
    // The kind is not one the listing can answer, so before this the call would be
    // remembered forever, filling the bounded retry map with calls nothing can
    // account for and evicting live ones whose rows then stay pinned.
    const store = journal(1, [], { 'call-1': 'agent_swarm_run' });
    const handles = ledger([]);
    const asker = authority('gone', 'gone');

    await expect(probe({ store, handles, authority: asker }))
      .resolves.toEqual({ closed: 0, accountedCallIds: ['call-1'] });
    expect(asker.workspaceProcessState).not.toHaveBeenCalled();
    // Nothing was closed here: the row was already closed by the call itself.
    expect(store.closeDeferredCalls).not.toHaveBeenCalled();
    expect(handles.forget).not.toHaveBeenCalled();
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
    })).resolves.toEqual({ closed: 1, accountedCallIds: ['call-1'] });

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

    await expect(probe({ store, handles, authority: asker })).resolves.toEqual({ closed: 1, accountedCallIds: ['call-1'] });

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
        .resolves.toEqual({ closed: 0, accountedCallIds: [] });
    }
    expect(store.closeDeferredCalls).not.toHaveBeenCalled();
    expect(handles.forget).not.toHaveBeenCalled();
  });

  it('never judges a recorded handle this runtime did not journal', async () => {
    const store = journal();
    // A shared ledger can answer with another host's row: it is not evidence here.
    const handles = ledger([{ callId: 'another-hosts-call', handleId: 'process-9' }], { shared: true });
    const asker = authority('gone', 'gone');

    await expect(probe({ store, handles, authority: asker })).resolves.toEqual({ closed: 1, accountedCallIds: ['call-1'] });

    expect(asker.handleState).not.toHaveBeenCalled();
    expect(store.closeDeferredCalls.mock.calls[0]?.[0]?.callIds).toEqual(['call-1']);
    expect(handles.forget).toHaveBeenCalledWith('ws-1', ['call-1']);
  });

  it('does not ask a provider no adapter can answer for', async () => {
    const store = journal();
    const handles = ledger([{ callId: 'call-1', provider: 'worktree', handleId: 'worktree-1' }]);
    const asker = authority('gone');

    // The authority saying `gone` is not enough: a provider with no route has no
    // vocabulary to write the verdict in, so the pin stays — and there is nothing
    // to retry, so the call is not remembered again.
    await expect(probe({ store, handles, authority: asker })).resolves.toEqual({ closed: 0, accountedCallIds: ['call-1'] });
    expect(asker.handleState).not.toHaveBeenCalled();
    expect(asker.workspaceProcessState).not.toHaveBeenCalled();
    expect(store.closeDeferredCalls).not.toHaveBeenCalled();
  });

  it('keeps a call whose close the store refused, and forgets only the one that landed', async () => {
    // One close per call is what makes this judgeable: a shared bucket would let a
    // landed row hide a refused one, and only the landed row may be settled.
    const store = journal((callId) => (callId === 'call-1' ? 1 : 0), ['call-2']);
    const handles = ledger([{ callId: 'call-1' }, { callId: 'call-2', handleId: 'process-2' }]);

    await expect(probe({
      store, handles, authority: authority('gone'), ownedCallIds: ['call-1', 'call-2'],
    })).resolves.toEqual({ closed: 1, accountedCallIds: ['call-1'] });

    expect(handles.forget).toHaveBeenCalledWith('ws-1', ['call-1']);
    expect(handles.forget).not.toHaveBeenCalledWith('ws-1', ['call-2']);
  });

  it('keeps the correlation and the retry while the row is still open', async () => {
    const store = journal(0, ['call-1']);
    const handles = ledger([{ callId: 'call-1' }]);

    // The close did not land and the row is still open: dropping the call here
    // would drop the only path that can still ask about it.
    await expect(probe({ store, handles, authority: authority('gone') }))
      .resolves.toEqual({ closed: 0, accountedCallIds: [] });
    expect(store.openDeferredCallIds).toHaveBeenCalledWith({ workspaceId: 'ws-1', callIds: ['call-1'] });
    expect(handles.forget).not.toHaveBeenCalled();
  });

  it('accounts for a row an earlier sweep already closed', async () => {
    // Every later attempt gets a zero from `closeDeferredCalls` because the row
    // already carries a closure code. Reading that zero as "refused" would keep
    // the call in memory for good and re-probe a row that pins nothing.
    const store = journal(0, []);
    const handles = ledger([{ callId: 'call-1' }]);

    await expect(probe({ store, handles, authority: authority('gone') }))
      .resolves.toEqual({ closed: 0, accountedCallIds: ['call-1'] });
    expect(handles.forget).toHaveBeenCalledWith('ws-1', ['call-1']);
  });

  it('does nothing when there is no call to judge', async () => {
    const store = journal();
    const handles = ledger([{ callId: 'call-1' }]);
    const asker = authority('gone');

    await expect(probe({ store, handles, authority: asker, ownedCallIds: [] }))
      .resolves.toEqual({ closed: 0, accountedCallIds: [] });
    // No call means no question: asking anyway would cost a store read per
    // completion event in every workspace.
    expect(handles.take).not.toHaveBeenCalled();
    expect(asker.handleState).not.toHaveBeenCalled();
    expect(store.closeDeferredCalls).not.toHaveBeenCalled();
  });

  // The store silently drops kinds outside its deferred set, so a tool the recorder
  // writes a handle for but the closure kinds omit turns the sweep into a no-op for
  // that tool without failing anything else.
  it('accepts a closure for every tool that records a handle', () => {
    for (const toolName of [
      ...DIRECT_PROCESS_TOOLS, ...WRAPPED_PROCESS_TOOLS, ...DURABLE_TASK_TOOLS, ...MERGE_VERIFICATION_TOOLS,
      ...CODEX_TASK_TOOLS, ...AGENT_SWARM_TOOLS,
    ]) {
      expect(DEFERRED_CLOSURE_OPERATION_KINDS.has(toolName)).toBe(true);
    }
  });
});

describe('settleRememberedCalls', () => {
  it('forgets only the accounted calls, and keeps one that started during the probe', async () => {
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
        return { closed: 2, accountedCallIds: ['probed-1', 'probed-2'] };
      },
    });
    expect(probed).toEqual([['probed-1', 'probed-2']]);
    expect([...remembered]).toEqual([
      ['foreign', 'ws-2'],
      ['landed-during-probe', 'ws-1'],
    ]);
  });

  it('drops a call closed next to a live sibling instead of probing it again', async () => {
    // A landed close is a fact about one call. Gating the prune on the whole sweep
    // would re-probe that closed call on every later completion — the exact cost
    // the map exists to avoid — until the cap evicted a live in-flight call.
    const remembered = new Map([['closed-1', 'ws-1'], ['live-1', 'ws-1']]);
    const probed: (readonly string[])[] = [];
    const probe = async (ownedCallIds: readonly string[]): Promise<{
      readonly closed: number;
      readonly accountedCallIds: readonly string[];
    }> => {
      probed.push([...ownedCallIds]);
      return probed.length === 1
        ? { closed: 1, accountedCallIds: ['closed-1'] }
        : { closed: 0, accountedCallIds: ['closed-1'] };
    };

    await settleRememberedCalls({ remembered, workspaceId: 'ws-1', probe });
    expect([...remembered]).toEqual([['live-1', 'ws-1']]);

    await settleRememberedCalls({ remembered, workspaceId: 'ws-1', probe });
    // The second sweep asks about the live call only.
    expect(probed[1]).toEqual(['live-1']);
  });

  it('keeps a call the probe could not account for', async () => {
    const remembered = new Map([['probed-1', 'ws-1']]);
    await settleRememberedCalls({
      remembered,
      workspaceId: 'ws-1',
      probe: async () => ({ closed: 0, accountedCallIds: [] }),
    });
    expect([...remembered]).toEqual([['probed-1', 'ws-1']]);
  });

  it('asks nothing when this workspace remembers no call', async () => {
    const remembered = new Map([['other-workspace-call', 'ws-2']]);
    const probe = vi.fn(async () => ({ closed: 0, accountedCallIds: [] }));
    await settleRememberedCalls({ remembered, workspaceId: 'ws-1', probe });
    expect(probe).not.toHaveBeenCalled();
  });

  it('still judges a call the bounded map no longer holds, and retries it', async () => {
    // The memory cap may evict an in-flight call; its own `started` event is still
    // where the ownership came from, so its completion gets a verdict. If that
    // verdict does not account for it, nothing else can retry it, so it goes back
    // in the map — bounded, so re-remembering cannot outgrow the cap.
    const remembered = new Map([['probed-1', 'ws-1']]);
    const probed: (readonly string[])[] = [];
    await settleRememberedCalls({
      remembered,
      workspaceId: 'ws-1',
      additionalOwnedCallIds: ['evicted'],
      maxRemembered: 2,
      probe: async (ownedCallIds) => {
        probed.push([...ownedCallIds]);
        return { closed: 0, accountedCallIds: ['probed-1'] };
      },
    });
    expect(probed).toEqual([['probed-1', 'evicted']]);
    expect([...remembered]).toEqual([['evicted', 'ws-1']]);
  });
});
