import { describe, expect, it } from 'vitest';
import { recordableDeferredHandle, recordableDeferredSettlement, VERIFICATION_SETTLED_CLOSURE_CODE } from './deferred-handle-descriptor.js';

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

  it('settles nothing for another tool or a call with no workspace', (): void => {
    expect(recordableDeferredSettlement('process_start', input, {
      ...done, structuredContent: { status: 'completed' },
    })).toBeUndefined();
    expect(recordableDeferredSettlement('merge_verification_run', {}, {
      ...done, structuredContent: { status: 'completed' },
    })).toBeUndefined();
  });
});
