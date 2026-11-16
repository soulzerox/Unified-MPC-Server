import { describe, expect, it } from 'vitest';
import { recordableDeferredHandle } from './deferred-handle-descriptor.js';

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

  it('records nothing for a durable task id no task adapter can resolve', (): void => {
    expect(recordableDeferredHandle('task_create', input, { ...done, structuredContent: { task_id: 'task-1' } })).toBeUndefined();
  });

  it('records nothing for a failed call, a missing handle, or a call with no workspace', (): void => {
    expect(recordableDeferredHandle('process_start', input, { isError: true, structuredContent: { processId: 'proc-4' } })).toBeUndefined();
    expect(recordableDeferredHandle('process_start', input, { ...done, structuredContent: {} })).toBeUndefined();
    expect(recordableDeferredHandle('task_create', {}, { ...done, structuredContent: { task_id: 'task-2' } })).toBeUndefined();
  });
});
