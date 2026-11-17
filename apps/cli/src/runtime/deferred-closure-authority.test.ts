import { describe, expect, it, vi } from 'vitest';
import type { ProcessService } from '@unified-mpc/application';
import type { GoalTaskLiveness } from '@unified-mpc/capabilities';
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

describe('deferred closure authority — durable task adapter', () => {
  const durable = (
    taskLivenessForGoal: (workspaceId: string, taskId: string) => Promise<GoalTaskLiveness>,
  ): NonNullable<Parameters<typeof createDeferredClosureAuthority>[0]['durableTasks']> => ({ taskLivenessForGoal });

  it('takes the durable verdict for a task_create id instead of asking the protocol', async () => {
    for (const verdict of ['live', 'gone'] as const) {
      const getTask = vi.fn(async () => ({ status: 'completed' }));
      const asker = createDeferredClosureAuthority({ tasks: { getTask }, durableTasks: durable(async () => verdict) });
      await expect(asker.handleState({ actor, workspaceId, provider: 'task', handleId: 'task-1' })).resolves.toBe(verdict);
      // A durable task id is not an MCP task id: asking the protocol for it could
      // only ever answer `unknown`, and a `gone` there would release the pin on a
      // task that is still running.
      expect(getTask).not.toHaveBeenCalled();
    }
  });

  it('falls back to the protocol when the durable store never wrote that id', async () => {
    const getTask = vi.fn(async () => ({ status: 'completed' }));
    const asker = createDeferredClosureAuthority({ tasks: { getTask }, durableTasks: durable(async () => 'unknown') });
    await expect(asker.handleState({ actor, workspaceId, provider: 'task', handleId: 't-1' })).resolves.toBe('gone');
    expect(getTask).toHaveBeenCalledWith({ taskId: 't-1' });
  });

  it('keeps the pin when only the durable adapter answers, and it cannot tell', async () => {
    const asker = createDeferredClosureAuthority({ durableTasks: durable(async () => 'unknown') });
    await expect(asker.handleState({ actor, workspaceId, provider: 'task', handleId: 'task-1' }))
      .resolves.toBe('unknown');
  });
});

describe('deferred closure authority — verification adapter', () => {
  const verification = (
    attemptState: (request: { readonly attemptId: string; readonly workspaceId: string })
      => Promise<'live' | 'gone' | 'unknown'>,
  ): ReturnType<typeof createDeferredClosureAuthority> => createDeferredClosureAuthority({
    verification: { attemptState },
  });

  it('takes the status port reading of the queued attempt instead of decoding the row', async () => {
    for (const verdict of ['live', 'gone'] as const) {
      const attemptState = vi.fn(async () => verdict);
      await expect(verification(attemptState)
        .handleState({ actor, workspaceId, provider: 'verification', handleId: 'attempt-1' }))
        .resolves.toBe(verdict);
      // The workspace is part of the question: an attempt row of another workspace
      // is not evidence about this one, so the port must be asked about both.
      expect(attemptState).toHaveBeenCalledWith({ attemptId: 'attempt-1', workspaceId });
    }
  });

  it('keeps a verification pinned when the port throws, cannot tell, or was never given', async () => {
    for (const asker of [
      verification(async () => { throw new Error('row unreadable'); }),
      verification(async () => 'unknown'),
      createDeferredClosureAuthority({}),
    ]) {
      await expect(asker.handleState({ actor, workspaceId, provider: 'verification', handleId: 'attempt-1' }))
        .resolves.toBe('unknown');
    }
  });
});

describe('deferred closure authority — codex adapter', () => {
  type CodexState = 'starting' | 'running' | 'termination_unverified' | 'exited' | 'failed' | 'stopped' | 'timed_out';

  function process(state: CodexState): ReturnType<typeof ok> {
    return ok({ processId: 'codex-proc-1', executable: 'codex', args: [], cwd: '/w', state, startedAt: at });
  }

  const codex = (
    statusForGoalLiveness: (ws: string, taskId: string) => ReturnType<typeof ok> | ReturnType<typeof err>,
  ): ReturnType<typeof createDeferredClosureAuthority> => createDeferredClosureAuthority({
    codex: { statusForGoalLiveness } as unknown as NonNullable<
      Parameters<typeof createDeferredClosureAuthority>[0]['codex']
    >,
  });

  it('takes the codex service probe, live states staying pinned', async () => {
    for (const state of ['starting', 'running', 'termination_unverified'] as const) {
      await expect(codex(() => process(state))
        .handleState({ actor, workspaceId, provider: 'codex', handleId: 'codex-1' })).resolves.toBe('live');
    }
    for (const state of ['exited', 'failed', 'stopped', 'timed_out'] as const) {
      await expect(codex(() => process(state))
        .handleState({ actor, workspaceId, provider: 'codex', handleId: 'codex-1' })).resolves.toBe('gone');
    }
  });

  it('asks the service about this workspace and task', async () => {
    const statusForGoalLiveness = vi.fn(() => process('exited'));
    await codex(statusForGoalLiveness)
      .handleState({ actor, workspaceId, provider: 'codex', handleId: 'codex-1' });
    // A codex task of another workspace is not evidence about this one, so the
    // workspace travels with the id.
    expect(statusForGoalLiveness).toHaveBeenCalledWith(workspaceId, 'codex-1');
  });

  it('keeps a codex task pinned when the service errors, throws, cannot tell, or was never given', async () => {
    for (const asker of [
      // `PROCESS_NOT_FOUND` is what a restarted host answers for a task it no
      // longer owns, and that must never read as gone.
      codex(() => err(appError('PROCESS_NOT_FOUND', 'missing'))),
      codex(() => { throw new Error('adapter exploded'); }),
      codex(() => ok({
        processId: 'p', executable: 'codex', args: [], cwd: '/w', state: 'parked', startedAt: at,
      }) as unknown as ReturnType<typeof ok>),
      createDeferredClosureAuthority({}),
    ]) {
      await expect(asker.handleState({ actor, workspaceId, provider: 'codex', handleId: 'codex-1' }))
        .resolves.toBe('unknown');
    }
  });
});

describe('deferred closure authority — swarm adapter', () => {
  type SwarmState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'termination_unverified';

  function snapshot(state: SwarmState): ReturnType<typeof ok> {
    return ok({ swarmId: 'swarm-1', workspaceId, state, maxConcurrency: 1, createdAt: at, updatedAt: at, tasks: [] });
  }

  const swarm = (
    statusForGoalLiveness: (ws: string, swarmId: string) => ReturnType<typeof ok> | ReturnType<typeof err>,
  ): ReturnType<typeof createDeferredClosureAuthority> => createDeferredClosureAuthority({
    swarm: { statusForGoalLiveness } as unknown as NonNullable<
      Parameters<typeof createDeferredClosureAuthority>[0]['swarm']
    >,
  });

  it('reads the swarm service probe, with only a terminal swarm releasing the pin', async () => {
    for (const state of ['queued', 'running', 'termination_unverified'] as const) {
      await expect(swarm(() => snapshot(state))
        .handleState({ actor, workspaceId, provider: 'swarm', handleId: 'swarm-1' })).resolves.toBe('live');
    }
    for (const state of ['completed', 'failed', 'cancelled'] as const) {
      await expect(swarm(() => snapshot(state))
        .handleState({ actor, workspaceId, provider: 'swarm', handleId: 'swarm-1' })).resolves.toBe('gone');
    }
  });

  it('asks the service about this workspace and swarm', async () => {
    const statusForGoalLiveness = vi.fn(() => snapshot('cancelled'));
    await swarm(statusForGoalLiveness)
      .handleState({ actor, workspaceId, provider: 'swarm', handleId: 'swarm-1' });
    // A swarm of another workspace is not evidence about this one.
    expect(statusForGoalLiveness).toHaveBeenCalledWith(workspaceId, 'swarm-1');
  });

  it('keeps a swarm pinned when the service errors, throws, cannot tell, or was never given', async () => {
    for (const asker of [
      swarm(() => err(appError('PROCESS_NOT_FOUND', 'missing'))),
      swarm(() => { throw new Error('swarm store exploded'); }),
      swarm(() => ok({
        swarmId: 'swarm-1', workspaceId, state: 'paused', maxConcurrency: 1, createdAt: at, updatedAt: at, tasks: [],
      }) as unknown as ReturnType<typeof ok>),
      createDeferredClosureAuthority({}),
    ]) {
      await expect(asker.handleState({ actor, workspaceId, provider: 'swarm', handleId: 'swarm-1' }))
        .resolves.toBe('unknown');
    }
  });
});
