import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appError, err, ok, type InvocationAuthorization } from '@unified-mpc/domain';
import type { ManagedProcess } from '@unified-mpc/process';
import { SqliteAgentSwarmRepository, SqliteDatabase, SqliteManagedResourceBindingRepository } from '@unified-mpc/storage';
import { AgentSwarmService, type AgentSwarmCodexPort, type AgentSwarmServiceOptions } from './agent-swarm-service.js';
import type { AgentSwarmStartRequest } from './agent-swarm-types.js';
import type { FileActor } from './file-service.js';
import { ResourceAdmissionController } from '@unified-mpc/workspace';

const temporaryRoots: string[] = [];
const actor: FileActor = { clientId: 'client-a', clientName: 'ChatGPT', sessionId: 'session-a' };
const otherActor: FileActor = { clientId: 'client-a', clientName: 'ChatGPT', sessionId: 'session-b' };
const authorization: InvocationAuthorization = {
  mode: 'standard',
  applicationApproved: true,
  bypassApplicationAuthorization: false,
  source: 'host_approval',
};

function managed(codexTaskId: string, state: ManagedProcess['state'] = 'running'): ManagedProcess {
  return {
    processId: `process-${codexTaskId}`,
    executable: 'codex',
    args: ['exec'],
    cwd: 'E:\\unified-mpc',
    state,
    startedAt: '2026-08-31T00:00:00.000Z',
    ...(state === 'exited' ? { finishedAt: '2026-08-31T00:00:01.000Z', exitCode: 0 } : {}),
  };
}

async function fixture(codex: AgentSwarmCodexPort, options: AgentSwarmServiceOptions = {}): Promise<{ database: SqliteDatabase; repository: SqliteAgentSwarmRepository; service: AgentSwarmService }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-agent-swarm-service-'));
  temporaryRoots.push(root);
  const database = new SqliteDatabase(path.join(root, 'state.sqlite'));
  const repository = new SqliteAgentSwarmRepository(database);
  const service = new AgentSwarmService(repository, codex, () => new Date('2026-08-31T00:00:00.000Z'), () => '11111111-1111-4111-8111-111111111111', options);
  return { database, repository, service };
}

function startRequest(tasks = [{ id: 'inspect', prompt: 'Inspect the repository.' }], maxConcurrency?: number): AgentSwarmStartRequest {
  return {
    workspaceId: 'workspace-a',
    idempotencyKey: '22222222-2222-4222-8222-222222222222',
    accessMode: 'read_only' as const,
    tasks,
    ...(maxConcurrency === undefined ? {} : { maxConcurrency }),
  };
}

function runningCodex(): { codex: AgentSwarmCodexPort; run: AgentSwarmCodexPort['run']; stop: AgentSwarmCodexPort['stop'] } {
  let sequence = 0;
  const run = vi.fn<AgentSwarmCodexPort['run']>(async (_actor, _workspaceId, _instruction, _signal, _userConfirmed, _authorization, sandboxMode) => {
    sequence += 1;
    expect(sandboxMode).toBe('read-only');
    return ok({ codexTaskId: `codex-${sequence}`, processId: `process-${sequence}` });
  });
  const stop = vi.fn<AgentSwarmCodexPort['stop']>(async () => ok(undefined));
  const codex: AgentSwarmCodexPort = {
    run,
    taskStatus: async (_actor, _workspaceId, codexTaskId) => ok(managed(codexTaskId)),
    taskLogs: async () => ok({ entries: [], truncated: false, nextSequence: 0 }),
    stop,
  };
  return { codex, run, stop };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('AgentSwarmService', () => {
  it('requires host approval, rejects write mode, and validates dependency cycles', async () => {
    const fake = runningCodex();
    const { database, service } = await fixture(fake.codex);
    try {
      const denied = await service.start(actor, startRequest(), undefined, undefined);
      expect(denied).toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });

      const writeMode = await service.start(actor, { ...startRequest(), accessMode: 'workspace_write' as never }, undefined, authorization);
      expect(writeMode).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });

      const cycle = await service.start(actor, startRequest([
        { id: 'a', prompt: 'A', dependsOn: ['b'] },
        { id: 'b', prompt: 'B', dependsOn: ['a'] },
      ]), undefined, authorization);
      expect(cycle).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
      expect(fake.run).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  it('launches each queued task at most once and scopes status to the owner session', async () => {
    const fake = runningCodex();
    const { database, service } = await fixture(fake.codex);
    try {
      const started = await service.start(actor, startRequest(), undefined, authorization);
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      expect(fake.run).toHaveBeenCalledTimes(1);
      expect(await service.status(otherActor, 'workspace-a', started.value.swarmId)).toMatchObject({ ok: false, error: { code: 'PROCESS_NOT_FOUND' } });
      await service.cancel(actor, 'workspace-a', started.value.swarmId, authorization);
    } finally {
      database.close();
    }
  });

  it('lets durable Goal ownership observe and cancel a live swarm without transient session authority', async () => {
    const fake = runningCodex();
    const { database, service } = await fixture(fake.codex);
    try {
      const started = await service.start(actor, startRequest(), undefined, authorization);
      expect(started.ok).toBe(true);
      if (!started.ok) return;

      expect(service.statusForGoalLiveness('workspace-a', started.value.swarmId)).toMatchObject({
        ok: true,
        value: { state: 'running' },
      });

      const cancelled = await service.cancelForGoal(actor.clientId, 'workspace-a', started.value.swarmId);
      expect(cancelled).toMatchObject({
        ok: true,
        value: { matched: true, state: 'cancelled' },
      });
      expect(fake.stop).toHaveBeenCalledTimes(1);
      expect(service.statusForGoalLiveness('workspace-a', started.value.swarmId)).toMatchObject({
        ok: true,
        value: { state: 'cancelled' },
      });
      await expect(service.cancelForGoal('different-client', 'workspace-a', started.value.swarmId)).resolves.toMatchObject({
        ok: true,
        value: { matched: false, state: 'not_found' },
      });
    } finally {
      database.close();
    }
  });

  it('redacts terminal Codex output before persistence and result reads', async () => {
    const codex: AgentSwarmCodexPort = {
      run: async () => ok({ codexTaskId: 'codex-secret', processId: 'process-secret' }),
      taskStatus: async () => ok(managed('codex-secret', 'exited')),
      taskLogs: async () => ok({
        entries: [
          { sequence: 0, stream: 'stdout', text: 'token=plain-secret sk-test-secret\n' },
          { sequence: 1, stream: 'stderr', text: 'Authorization: Bearer bearer-secret\n' },
        ],
        truncated: false,
        nextSequence: 2,
      }),
      stop: async () => ok(undefined),
    };
    const { database, service } = await fixture(codex);
    try {
      const started = await service.start(actor, startRequest(), undefined, authorization);
      expect(started.ok).toBe(true);
      if (!started.ok) return;

      await vi.waitFor(async () => {
        const status = await service.status(actor, 'workspace-a', started.value.swarmId);
        expect(status).toMatchObject({ ok: true, value: { state: 'completed' } });
      });

      const result = await service.result(actor, 'workspace-a', started.value.swarmId, 'inspect');
      expect(result).toMatchObject({ ok: true });
      if (!result.ok) return;
      expect(result.value.text).toContain('[REDACTED]');
      expect(result.value.text).not.toContain('plain-secret');
      expect(result.value.text).not.toContain('sk-test-secret');
      expect(result.value.text).not.toContain('bearer-secret');

      const cancelledAfterCompletion = await service.cancel(actor, 'workspace-a', started.value.swarmId, authorization);
      expect(cancelledAfterCompletion).toMatchObject({ ok: true, value: { state: 'completed' } });
    } finally {
      database.close();
    }
  });

  it('holds shared delegated-worker capacity for the real child lifetime and retries queued siblings after release', async () => {
    let firstTerminal = false;
    let sequence = 0;
    const stop = vi.fn<AgentSwarmCodexPort['stop']>(async () => ok(undefined));
    const run = vi.fn<AgentSwarmCodexPort['run']>(async () => {
      sequence += 1;
      return ok({ codexTaskId: `codex-${sequence}`, processId: `process-${sequence}` });
    });
    const codex: AgentSwarmCodexPort = {
      run,
      taskStatus: async (_actor, _workspaceId, codexTaskId) => {
        if (codexTaskId === 'codex-1' && firstTerminal) return ok(managed(codexTaskId, 'exited'));
        return ok(managed(codexTaskId));
      },
      taskLogs: async () => ok({ entries: [], truncated: false, nextSequence: 0 }),
      stop,
    };
    const resourceAdmissionController = new ResourceAdmissionController({
      globalCost: 16,
      workspaceCost: 8,
      sessionCost: 8,
      maxOperations: 4,
      resourceClassCost: { delegated_agent: 16 },
    });
    const { database, service } = await fixture(codex, { resourceAdmissionController });
    try {
      const started = await service.start(actor, startRequest([
        { id: 'first', prompt: 'first task' },
        { id: 'second', prompt: 'second task' },
      ], 2), undefined, authorization);
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      expect(run).toHaveBeenCalledTimes(1);
      expect(started.value.tasks.map((task) => task.state)).toEqual(['running', 'queued']);
      expect(resourceAdmissionController.snapshot()).toMatchObject({
        activeCost: 8,
        activeOperations: 1,
        activeCostByClass: { delegated_agent: 8 },
      });

      firstTerminal = true;
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
      expect(resourceAdmissionController.snapshot()).toMatchObject({
        activeCost: 8,
        activeOperations: 1,
        activeCostByClass: { delegated_agent: 8 },
      });

      const cancelled = await service.cancel(actor, 'workspace-a', started.value.swarmId, authorization);
      expect(cancelled).toMatchObject({ ok: true, value: { state: 'cancelled' } });
      expect(resourceAdmissionController.snapshot()).toMatchObject({
        activeCost: 0,
        activeOperations: 0,
        activeCostByClass: { delegated_agent: 0 },
      });
    } finally {
      database.close();
    }
  });

  it('isolates a child launch failure while keeping running and independent siblings alive', async () => {
    let sequence = 0;
    const stop = vi.fn<AgentSwarmCodexPort['stop']>(async () => ok(undefined));
    const codex: AgentSwarmCodexPort = {
      run: vi.fn<AgentSwarmCodexPort['run']>(async (_actor, _workspaceId, instruction) => {
        sequence += 1;
        if (instruction.includes('second')) return err(appError('CODEX_NOT_AVAILABLE', 'second launch failed'));
        return ok({ codexTaskId: `codex-${sequence}`, processId: `process-${sequence}` });
      }),
      taskStatus: async (_actor, _workspaceId, codexTaskId) => ok(managed(codexTaskId)),
      taskLogs: async () => ok({ entries: [], truncated: false, nextSequence: 0 }),
      stop,
    };
    const { database, service } = await fixture(codex);
    try {
      const started = await service.start(actor, startRequest([
        { id: 'first', prompt: 'first task' },
        { id: 'second', prompt: 'second task' },
        { id: 'third', prompt: 'third task' },
      ], 2), undefined, authorization);
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      expect(stop).not.toHaveBeenCalled();
      expect(codex.run).toHaveBeenCalledTimes(3);
      const states = new Map(started.value.tasks.map((task) => [task.id, task.state]));
      expect(states.get('first')).toBe('running');
      expect(states.get('second')).toBe('failed');
      expect(states.get('third')).toBe('running');
      expect(started.value.state).toBe('running');
      await service.cancel(actor, 'workspace-a', started.value.swarmId, authorization);
    } finally {
      database.close();
    }
  });
  it('persists delegated child resource ownership and durably releases it after verified stop', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-agent-swarm-binding-'));
    temporaryRoots.push(root);
    const database = new SqliteDatabase(path.join(root, 'state.sqlite'));
    const repository = new SqliteAgentSwarmRepository(database);
    const bindings = new SqliteManagedResourceBindingRepository(database);
    const controller = new ResourceAdmissionController({
      globalCost: 16,
      workspaceCost: 16,
      sessionCost: 16,
      maxOperations: 4,
    });
    const codex: AgentSwarmCodexPort = {
      run: async () => ok({ codexTaskId: 'codex-durable', processId: 'process-durable' }),
      taskStatus: async () => ok(managed('codex-durable')),
      taskLogs: async () => ok({ entries: [], truncated: false, nextSequence: 0 }),
      stop: async () => ok(undefined),
      recoveryIdentityForGoal: async () => ok({
        processId: 'process-durable',
        platform: 'linux',
        pid: 5050,
        processStartedAt: '2026-08-31T00:00:00.000Z',
      }),
    };
    const service = new AgentSwarmService(
      repository,
      codex,
      () => new Date('2026-08-31T00:00:00.000Z'),
      () => '11111111-1111-4111-8111-111111111111',
      { resourceAdmissionController: controller, managedResourceBindings: bindings },
    );

    try {
      const started = await service.start(actor, startRequest(), undefined, authorization);
      expect(started).toMatchObject({ ok: true, value: { state: 'running' } });
      expect(bindings.listUnreleased()).toEqual([
        expect.objectContaining({
          operationId: 'agent-swarm:11111111-1111-4111-8111-111111111111:inspect',
          workspaceId: 'workspace-a',
          sessionId: 'session-a',
          resourceClass: 'delegated_agent',
          logicalHandle: 'codex-durable',
          pid: 5050,
          state: 'active',
        }),
      ]);

      if (!started.ok) return;
      expect(await service.cancel(actor, 'workspace-a', started.value.swarmId, authorization))
        .toMatchObject({ ok: true, value: { state: 'cancelled' } });
      expect(bindings.listUnreleased()).toEqual([]);
      expect(controller.snapshot()).toMatchObject({ activeCost: 0, activeOperations: 0 });
    } finally {
      database.close();
    }
  });

  it('retains durable delegated debt when child termination cannot be verified', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-agent-swarm-unverified-'));
    temporaryRoots.push(root);
    const database = new SqliteDatabase(path.join(root, 'state.sqlite'));
    const repository = new SqliteAgentSwarmRepository(database);
    const bindings = new SqliteManagedResourceBindingRepository(database);
    const controller = new ResourceAdmissionController({
      globalCost: 16,
      workspaceCost: 16,
      sessionCost: 16,
      maxOperations: 4,
    });
    const codex: AgentSwarmCodexPort = {
      run: async () => ok({ codexTaskId: 'codex-unverified', processId: 'process-unverified' }),
      taskStatus: async () => ok(managed('codex-unverified')),
      taskLogs: async () => ok({ entries: [], truncated: false, nextSequence: 0 }),
      stop: async () => err(appError('PROCESS_TIMEOUT', 'stop could not be verified', true)),
      recoveryIdentityForGoal: async () => ok({
        processId: 'process-unverified',
        platform: 'linux',
        pid: 6060,
        processStartedAt: '2026-08-31T00:00:00.000Z',
      }),
    };
    const service = new AgentSwarmService(
      repository,
      codex,
      () => new Date('2026-08-31T00:00:00.000Z'),
      () => '11111111-1111-4111-8111-111111111111',
      { resourceAdmissionController: controller, managedResourceBindings: bindings },
    );

    try {
      const started = await service.start(actor, startRequest(), undefined, authorization);
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      expect(await service.cancel(actor, 'workspace-a', started.value.swarmId, authorization))
        .toMatchObject({ ok: true, value: { state: 'termination_unverified' } });
      expect(bindings.listUnreleased()).toEqual([
        expect.objectContaining({
          resourceClass: 'delegated_agent',
          state: 'termination_unverified',
        }),
      ]);
      expect(controller.snapshot()).toMatchObject({ activeCost: 8, activeOperations: 1 });
    } finally {
      database.close();
    }
  });

});
