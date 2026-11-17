import { describe, expect, it } from 'vitest';
import { recordableDeferredHandle, recordableDeferredSettlement, SWARM_READ_SETTLED_CLOSURE_CODE, VERIFICATION_SETTLED_CLOSURE_CODE, WORKTREE_PREVIEW_SETTLED_CLOSURE_CODE } from './deferred-handle-descriptor.js';

const input = { workspaceId: 'workspace-1' };
const done = { isError: false };

describe('recordableDeferredHandle', () => {
  it('records the process id a direct process tool returned', (): void => {
    expect(recordableDeferredHandle('process_start', input, { ...done, structuredContent: { processId: 'proc-1' } }))
      .toEqual({ workspaceId: 'workspace-1', provider: 'process', handleId: 'proc-1' });
  });

  it('records the process id a wrapped process tool returned', (): void => {
    expect(recordableDeferredHandle('benchmark_run', input, { ...done, structuredContent: { process: { processId: 'proc-2' } } }))
      .toEqual({ workspaceId: 'workspace-1', provider: 'process', handleId: 'proc-2' });
  });

  it('records nothing for a backgrounded shell, whose child can outlive the shell', (): void => {
    expect(recordableDeferredHandle('shell', input, { ...done, structuredContent: { processId: 'proc-3' } })).toBeUndefined();
  });

  it('records the durable task id task_create returned', (): void => {
    // Carries a processId too, so this fails if `task_create` is ever treated as a
    // process tool: the provider is the tool name, not the extra handle.
    expect(recordableDeferredHandle('task_create', input, { ...done, structuredContent: { task_id: 'task-1', processId: 'proc-1' } }))
      .toEqual({ workspaceId: 'workspace-1', provider: 'task', handleId: 'task-1' });
  });

  it('records nothing for a task_create that returned no task id', (): void => {
    expect(recordableDeferredHandle('task_create', input, { ...done, structuredContent: { processId: 'proc-1' } })).toBeUndefined();
  });

  it('records nothing for a failed call, a missing handle, or a call with no workspace', (): void => {
    expect(recordableDeferredHandle('process_start', input, { isError: true, structuredContent: { processId: 'proc-4' } })).toBeUndefined();
    expect(recordableDeferredHandle('process_start', input, { ...done, structuredContent: {} })).toBeUndefined();
    expect(recordableDeferredHandle('process_start', {}, { ...done, structuredContent: { processId: 'proc-5' } })).toBeUndefined();
  });

  it('records the attempt id a queued merge_verification_run returned', (): void => {
    expect(recordableDeferredHandle('merge_verification_run', input, {
      ...done, structuredContent: { status: 'queued', attemptId: 'attempt-1' },
    })).toEqual({ workspaceId: 'workspace-1', provider: 'verification', handleId: 'attempt-1' });
  });

  it('records nothing for a verification run that already holds its receipt', (): void => {
    // A run that reached a verdict hands back no attempt id: the gate already ran, so
    // there is no live work to ask about. Its own response closes the journal row
    // instead, which is what keeps that call from pinning the goal forever.
    expect(recordableDeferredHandle('merge_verification_run', input, {
      ...done, structuredContent: { status: 'completed', receiptRef: 'receipt-1' },
    })).toBeUndefined();
  });

  it('records the codex task id codex_run returned under its own provider', (): void => {
    // Carries a processId too, and that process lives in the codex adapter's own
    // process manager: recording it under `process` would read "absent from the
    // CLI listing" as gone for a task that is still running.
    expect(recordableDeferredHandle('codex_run', input, {
      ...done, structuredContent: { codexTaskId: 'codex-1', processId: 'proc-1' },
    })).toEqual({ workspaceId: 'workspace-1', provider: 'codex', handleId: 'codex-1' });
  });

  it('records nothing for a codex_run with no task id, or a failed call', (): void => {
    expect(recordableDeferredHandle('codex_run', input, { ...done, structuredContent: { processId: 'proc-1' } })).toBeUndefined();
    expect(recordableDeferredHandle('codex_run', input, {
      isError: true, structuredContent: { codexTaskId: 'codex-1' },
    })).toBeUndefined();
  });

  it('records the swarm id a started agent swarm returned under its own provider', (): void => {
    expect(recordableDeferredHandle('agent_swarm_run', { workspaceId: 'workspace-1', operation: 'start' }, {
      ...done, structuredContent: { swarmId: 'swarm-1', state: 'queued', tasks: [] },
    })).toEqual({ workspaceId: 'workspace-1', provider: 'swarm', handleId: 'swarm-1' });
  });

  it('records nothing for an agent_swarm_run read, which names a swarm it did not start', (): void => {
    // `status`/`result`/`cancel`/`list` answer with the snapshot of some other
    // swarm, so recording its id would let this call's pin be released by work it
    // never started.
    for (const operation of ['status', 'result', 'cancel', 'list']) {
      expect(recordableDeferredHandle('agent_swarm_run', { workspaceId: 'workspace-1', operation }, {
        ...done, structuredContent: { swarmId: 'swarm-9', state: 'running' },
      })).toBeUndefined();
    }
  });

  it('records the swarm id the delegate tools wrapped', (): void => {
    for (const toolName of ['delegate', 'parallel_delegate']) {
      expect(recordableDeferredHandle(toolName, input, {
        ...done, structuredContent: { tool: toolName, delegateId: 'swarm-2', swarm: { swarmId: 'swarm-2', state: 'running' } },
      })).toEqual({ workspaceId: 'workspace-1', provider: 'swarm', handleId: 'swarm-2' });
    }
  });

  it('records nothing for an agent_swarm_run operation nobody classified', (): void => {
    // A sub-action added later must not be read as a start (recording a snapshot as
    // a handle) or as a read (settling a call that may have started work).
    expect(recordableDeferredHandle('agent_swarm_run', { workspaceId: 'workspace-1', operation: 'pause' }, {
      ...done, structuredContent: { swarmId: 'swarm-1', state: 'queued' },
    })).toBeUndefined();
    expect(recordableDeferredSettlement('agent_swarm_run', { workspaceId: 'workspace-1', operation: 'pause' }, {
      ...done, structuredContent: { swarm: { swarmId: 'swarm-1' } },
    })).toBeUndefined();
  });

  it('records nothing for an agent swarm with no id, or a failed call', (): void => {
    expect(recordableDeferredHandle('agent_swarm_run', { workspaceId: 'workspace-1', operation: 'start' }, {
      ...done, structuredContent: { state: 'queued' },
    })).toBeUndefined();
    expect(recordableDeferredHandle('agent_swarm_run', { workspaceId: 'workspace-1', operation: 'start' }, {
      isError: true, structuredContent: { swarmId: 'swarm-1', state: 'queued' },
    })).toBeUndefined();
  });

  it('records nothing for a queued verification with no attempt id, or a failed call', (): void => {
    expect(recordableDeferredHandle('merge_verification_run', input, {
      ...done, structuredContent: { status: 'queued' },
    })).toBeUndefined();
    expect(recordableDeferredHandle('merge_verification_run', input, {
      isError: true, structuredContent: { status: 'queued', attemptId: 'attempt-1' },
    })).toBeUndefined();
  });
});

describe('recordableDeferredSettlement', () => {
  it('settles the call a completed verification ran to a verdict inside', (): void => {
    expect(recordableDeferredSettlement('merge_verification_run', input, {
      ...done, structuredContent: { status: 'completed', receiptRef: 'receipt-1' },
    })).toEqual({ workspaceId: 'workspace-1', closureCode: VERIFICATION_SETTLED_CLOSURE_CODE });
  });

  it('leaves a queued attempt to the status port', (): void => {
    // Queued work is still live, so closing here would release the pin while the
    // attempt it named is waiting to run.
    expect(recordableDeferredSettlement('merge_verification_run', input, {
      ...done, structuredContent: { status: 'queued', attemptId: 'attempt-1' },
    })).toBeUndefined();
  });

  it('leaves a failed call pinned, since a cancelled run can still be live', (): void => {
    expect(recordableDeferredSettlement('merge_verification_run', input, {
      isError: true, structuredContent: { status: 'completed', receiptRef: 'receipt-1' },
    })).toBeUndefined();
  });

  it('settles an agent_swarm_run read, which started no work at all', (): void => {
    // The journal treats the tool as deferred by name because a `start` returns
    // while the swarm runs. A read hands back the snapshot of a swarm this call did
    // not start, so no handle may be recorded and the row must close with the call.
    for (const operation of ['status', 'result', 'cancel', 'list']) {
      expect(recordableDeferredSettlement('agent_swarm_run', { workspaceId: 'workspace-1', operation }, {
        ...done, structuredContent: { swarm: { swarmId: 'swarm-9', state: 'running' } },
      })).toEqual({ workspaceId: 'workspace-1', closureCode: SWARM_READ_SETTLED_CLOSURE_CODE });
    }
  });

  it('leaves an agent_swarm_run start to the swarm service', (): void => {
    expect(recordableDeferredSettlement('agent_swarm_run', { workspaceId: 'workspace-1', operation: 'start' }, {
      ...done, structuredContent: { swarmId: 'swarm-1', state: 'queued' },
    })).toBeUndefined();
  });

  it('settles a failed read too, since a read that failed still started nothing', (): void => {
    // Left open, this row could never be closed: a swarm call records no handle,
    // and the process listing cannot speak for a swarm.
    expect(recordableDeferredSettlement('agent_swarm_run', { workspaceId: 'workspace-1', operation: 'cancel' }, {
      isError: true, structuredContent: { error: { code: 'PROCESS_NOT_FOUND' } },
    })).toEqual({ workspaceId: 'workspace-1', closureCode: SWARM_READ_SETTLED_CLOSURE_CODE });
  });

  it('settles a git_worktree_spawn preview, which creates no worktree to pin', (): void => {
    // The tool defaults to a preview: it reports what it would create. Its row is a
    // durable reference, so leaving a preview's row open pins the goal `present` over
    // a worktree that was never made, and the lifecycle authorities have nothing to
    // answer about.
    for (const preview of [{ workspaceId: 'workspace-1' }, { workspaceId: 'workspace-1', dryRun: true }]) {
      expect(recordableDeferredSettlement('git_worktree_spawn', preview, {
        ...done, structuredContent: { dryRun: true, sideEffectsStarted: false },
      })).toEqual({ workspaceId: 'workspace-1', closureCode: WORKTREE_PREVIEW_SETTLED_CLOSURE_CODE });
    }
  });

  it('settles a preview that failed, since a preview creates nothing either way', (): void => {
    expect(recordableDeferredSettlement('git_worktree_spawn', { workspaceId: 'workspace-1', dryRun: true }, {
      isError: true, structuredContent: { error: { code: 'INVALID_INPUT' } },
    })).toEqual({ workspaceId: 'workspace-1', closureCode: WORKTREE_PREVIEW_SETTLED_CLOSURE_CODE });
  });

  it('leaves a real git_worktree_spawn pinned, since a failure can follow the worktree', (): void => {
    // A spawn that really ran keeps its pin whether it answered or errored: it may have
    // created the worktree and then failed, so reading the error as "nothing was
    // created" would release a pin over work that exists.
    for (const response of [done, { isError: true }]) {
      expect(recordableDeferredSettlement('git_worktree_spawn', {
        workspaceId: 'workspace-1', dryRun: false,
      }, response)).toBeUndefined();
    }
  });

  it('settles nothing for a read with no workspace, which nothing could be closed against', (): void => {
    expect(recordableDeferredSettlement('agent_swarm_run', { operation: 'status' }, {
      ...done, structuredContent: { swarm: { swarmId: 'swarm-9' } },
    })).toBeUndefined();
  });

  it('settles nothing for another tool or a call with no workspace', (): void => {
    expect(recordableDeferredSettlement('process_start', input, {
      ...done, structuredContent: { status: 'completed' },
    })).toBeUndefined();
    expect(recordableDeferredSettlement('merge_verification_run', {}, {
      ...done, structuredContent: { status: 'completed' },
    })).toBeUndefined();
  });
});
