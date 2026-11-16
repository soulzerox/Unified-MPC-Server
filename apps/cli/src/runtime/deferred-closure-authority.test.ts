import { describe, expect, it, vi } from 'vitest';
import type { ProcessService } from '@unified-mpc/application';
import { appError, err, ok } from '@unified-mpc/domain';
import { createDeferredClosureAuthority } from './deferred-closure-authority.js';

const actor = { clientId: 'client', sessionId: 'session' };
const at = '2026-11-16T10:00:00.000Z';
const workspaceId = 'ws-1';

type ProcessState = 'starting' | 'running' | 'termination_unverified' | 'exited' | 'failed';

function processes(entries: () => Promise<unknown>): Pick<ProcessService, 'list'> {
  return { list: vi.fn(entries) } as unknown as Pick<ProcessService, 'list'>;
}

function listed(states: readonly ProcessState[], processId = 'proc-1'): ReturnType<typeof ok> {
  return ok(states.map((state) => ({
    processId, executable: 'node', args: [], cwd: '/w', state, startedAt: at,
  })));
}

describe('deferred closure authority — process adapter', () => {
  it('proves the workspace is gone only when the store answered with no live process', async () => {
    for (const state of ['starting', 'running', 'termination_unverified'] as const) {
      await expect(createDeferredClosureAuthority({ processes: processes(async () => listed(['exited', state])) })
        .workspaceProcessState({ actor, workspaceId })).resolves.toBe('live');
    }
    await expect(createDeferredClosureAuthority({ processes: processes(async () => listed(['exited'])) })
      .workspaceProcessState({ actor, workspaceId })).resolves.toBe('gone');
  });

  it('answers unknown when the store cannot answer, or was never given', async () => {
    await expect(createDeferredClosureAuthority({ processes: processes(async () => err(appError('INTERNAL_ERROR', 'unavailable'))) })
      .workspaceProcessState({ actor, workspaceId })).resolves.toBe('unknown');
    await expect(createDeferredClosureAuthority({})
      .workspaceProcessState({ actor, workspaceId })).resolves.toBe('unknown');
  });

  it('reads one process handle out of the same workspace listing', async () => {
    const authority = createDeferredClosureAuthority({ processes: processes(async () => listed(['running'])) });
    await expect(authority.handleState({ actor, workspaceId, provider: 'process', handleId: 'proc-1' })).resolves.toBe('live');
    // Absent from the listing is evidence only because the store lists every
    // handle this runtime registered for the workspace.
    await expect(authority.handleState({ actor, workspaceId, provider: 'process', handleId: 'proc-9' })).resolves.toBe('gone');
  });
});

describe('deferred closure authority — task adapter', () => {
  const task = (
    getTask: () => Promise<{ readonly status: string }>,
  ): ReturnType<typeof createDeferredClosureAuthority> =>
    createDeferredClosureAuthority({ tasks: { getTask } });

  it('treats only a terminal task status as gone', async () => {
    for (const status of ['completed', 'failed', 'cancelled']) {
      await expect(task(async () => ({ status }))
        .handleState({ actor, workspaceId, provider: 'task', handleId: 't-1' })).resolves.toBe('gone');
    }
    for (const status of ['working', 'input_required']) {
      await expect(task(async () => ({ status }))
        .handleState({ actor, workspaceId, provider: 'task', handleId: 't-1' })).resolves.toBe('live');
    }
  });

  it('keeps a task pinned when the store throws, has no adapter, or reports an unknown status', async () => {
    for (const authority of [
      task(async () => { throw new Error('task not found'); }),
      task(async () => ({ status: 'interrupted' })),
      createDeferredClosureAuthority({}),
    ]) {
      await expect(authority.handleState({ actor, workspaceId, provider: 'task', handleId: 't-1' }))
        .resolves.toBe('unknown');
    }
  });
});
