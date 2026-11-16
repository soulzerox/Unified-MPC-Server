import { describe, expect, it, vi } from 'vitest';
import type { FileActor, ProcessService } from '@unified-mpc/application';
import type { ManagedProcess } from '@unified-mpc/process';
import { appError, err, ok } from '@unified-mpc/domain';
import { DEFERRED_CLOSURE_OPERATION_KINDS } from '@unified-mpc/storage';
import {
  NO_LIVE_PROCESS_CLOSURE_CODE,
  PROCESS_HANDLE_DEFERRED_KINDS,
  closeObservedDeferredCalls,
} from './deferred-journal-closure.js';

const actor: FileActor = { clientId: 'client', sessionId: 'session' };
const closedAt = '2026-11-16T10:00:00.000Z';
const callIds = ['call-1'];

function process(state: ManagedProcess['state']): ManagedProcess {
  return { processId: 'proc-1', executable: 'node', args: [], cwd: '/w', state, startedAt: closedAt };
}

function journal(): { readonly closeDeferredCalls: ReturnType<typeof vi.fn> } {
  const closeDeferredCalls = vi.fn(() => 1);
  return { closeDeferredCalls };
}

function processes(list: () => Promise<unknown>): Pick<ProcessService, 'list'> {
  return { list: vi.fn(list) } as unknown as Pick<ProcessService, 'list'>;
}

describe('closeObservedDeferredCalls', () => {
  it('closes the call this request opened once no handle is live, and names that call', async () => {
    const store = journal();
    await expect(closeObservedDeferredCalls({
      journal: store, processes: processes(async () => ok([process('exited')])), actor,
      workspaceId: 'ws-1', callIds, closedAt,
    })).resolves.toBe(1);

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

  it('keeps the call pinned while one handle is live, and when the store cannot answer', async () => {
    const store = journal();
    for (const state of ['starting', 'running', 'termination_unverified'] as const) {
      await expect(closeObservedDeferredCalls({
        journal: store, processes: processes(async () => ok([process('exited'), process(state)])), actor,
        workspaceId: 'ws-1', callIds, closedAt,
      })).resolves.toBe(0);
    }
    await expect(closeObservedDeferredCalls({
      journal: store, processes: processes(async () => err(appError('INTERNAL_ERROR', 'unavailable'))), actor,
      workspaceId: 'ws-1', callIds, closedAt,
    })).resolves.toBe(0);
    expect(store.closeDeferredCalls).not.toHaveBeenCalled();
  });

  it('does nothing when the runtime has no process service or no call to close', async () => {
    const store = journal();
    await expect(closeObservedDeferredCalls({
      journal: store, actor, workspaceId: 'ws-1', callIds, closedAt,
    })).resolves.toBe(0);
    await expect(closeObservedDeferredCalls({
      journal: store, processes: processes(async () => ok([])), actor,
      workspaceId: 'ws-1', callIds: [], closedAt,
    })).resolves.toBe(0);
    expect(store.closeDeferredCalls).not.toHaveBeenCalled();
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
