import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ShellCapabilityBackend,
  type ShellHeavyAdmissionLease,
  type ShellHeavyAdmissionPort,
  type ShellHeavyAdmissionRequest,
} from './shell-backend.js';

const temporaryRoots: string[] = [];

afterAll(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
});

interface FakePort {
  readonly port: ShellHeavyAdmissionPort;
  readonly requests: ShellHeavyAdmissionRequest[];
  readonly settled: Array<{ outcome: 'completed' | 'failed' | 'cancelled'; count: number }>;
  reply: (request: ShellHeavyAdmissionRequest) => Awaited<ReturnType<ShellHeavyAdmissionPort['acquire']>>;
}

/** One-shot lease recorder: a duplicate settle must not release twice. */
function fakePort(): FakePort {
  const requests: ShellHeavyAdmissionRequest[] = [];
  const settled: Array<{ outcome: 'completed' | 'failed' | 'cancelled'; count: number }> = [];
  const state = {
    reply: (): Awaited<ReturnType<ShellHeavyAdmissionPort['acquire']>> => {
      const lease: ShellHeavyAdmissionLease = {
        settle: (outcome): void => {
          const existing = settled.find((entry) => entry.outcome === outcome);
          if (existing === undefined) settled.push({ outcome, count: 1 });
          else existing.count += 1;
        },
      };
      return { admitted: true, lease };
    },
  };
  return {
    port: {
      acquire: async (request): Promise<Awaited<ReturnType<ShellHeavyAdmissionPort['acquire']>>> => {
        requests.push(request);
        return state.reply();
      },
    },
    requests,
    settled,
    get reply(): Awaited<ReturnType<ShellHeavyAdmissionPort['acquire']>> {
      return state.reply;
    },
    set reply(next): void {
      state.reply = next;
    },
  };
}

async function backendWith(port: ShellHeavyAdmissionPort | undefined): Promise<{ root: string; backend: ShellCapabilityBackend }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-heavy-shell-'));
  temporaryRoots.push(root);
  const backend = new ShellCapabilityBackend({
    allowedRoots: [root],
    taskStateDirectory: path.join(root, '.tasks'),
    heavyAdmissionWatchIntervalMs: 15,
    ...(port === undefined ? {} : { heavyAdmission: port }),
  });
  return { root, backend };
}

describe('declared heavy shell admission (#145)', () => {
  it('never asks admission for an undeclared run', async () => {
    const fake = fakePort();
    const { root, backend } = await backendWith(fake.port);

    const run = await backend.execute({
      operation: 'run', executable: process.execPath, arguments: ['-e', ''], cwd: root, execution: 'background', userConfirmed: true,
    });

    expect(run.ok).toBe(true);
    expect(fake.requests).toEqual([]);
  });

  it('refuses a declared run that admission denies, without creating a task', async () => {
    const fake = fakePort();
    fake.reply = (): Awaited<ReturnType<ShellHeavyAdmissionPort['acquire']>> => ({ admitted: false, reason: 'heavy_capacity_exhausted', position: 1 });
    const { root, backend } = await backendWith(fake.port);

    const run = await backend.execute({
      operation: 'run', executable: process.execPath, arguments: ['-e', ''], cwd: root, execution: 'background', userConfirmed: true,
      admission_class: 'verification_heavy',
    });

    expect(run).toMatchObject({
      ok: false,
      error: {
        code: 'RESOURCE_PRESSURE',
        recoverable: true,
        details: { reason: 'heavy_capacity_exhausted', resourceClass: 'verification_heavy', position: 1 },
      },
    });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({ resourceClass: 'verification_heavy', waitMs: 0 });
    expect(fake.requests[0]?.operationId).toMatch(/^shell:/);
    const listed = await backend.execute({ operation: 'list' });
    expect(listed).toMatchObject({ ok: true, value: { tasks: [] } });
    expect(fake.settled).toEqual([]);
  });

  it('starts an admitted declared run and settles the slot on completion', async () => {
    const fake = fakePort();
    const { root, backend } = await backendWith(fake.port);

    const run = await backend.execute({
      operation: 'run', executable: process.execPath, arguments: ['-e', ''], cwd: root, execution: 'background', userConfirmed: true,
      admission_class: 'verification_heavy',
    });

    expect(run).toMatchObject({ ok: true, value: { state: 'running' } });
    await expect.poll(() => fake.settled, { timeout: 5000 }).toEqual([{ outcome: 'completed', count: 1 }]);
  });

  it('settles a failed run as failed so the slot is not leaked', async () => {
    const fake = fakePort();
    const { root, backend } = await backendWith(fake.port);

    const run = await backend.execute({
      operation: 'run', executable: process.execPath, arguments: ['-e', 'process.exit(3)'], cwd: root, execution: 'background', userConfirmed: true,
      admission_class: 'rag_indexing',
    });

    expect(fake.requests[0]).toMatchObject({ resourceClass: 'rag_indexing' });
    expect(run.ok).toBe(true);
    await expect.poll(() => fake.settled, { timeout: 5000 }).toEqual([{ outcome: 'failed', count: 1 }]);
  });

  it('settles exactly once even though the watcher may tick again', async () => {
    const fake = fakePort();
    const { root, backend } = await backendWith(fake.port);

    const run = await backend.execute({
      operation: 'run', executable: process.execPath, arguments: ['-e', ''], cwd: root, execution: 'background', userConfirmed: true,
      admission_class: 'verification_heavy',
    });
    expect(run.ok).toBe(true);
    await expect.poll(() => fake.settled, { timeout: 5000 }).toEqual([{ outcome: 'completed', count: 1 }]);

    const taskId = String((run as { value: Record<string, unknown> }).value.task_id);
    const status = await backend.execute({ operation: 'status', task_id: taskId });
    expect(status).toMatchObject({ ok: true, value: { state: 'completed' } });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(fake.settled).toEqual([{ outcome: 'completed', count: 1 }]);
  });

  it('settles a cancelled declared run as cancelled', async () => {
    const fake = fakePort();
    const { root, backend } = await backendWith(fake.port);

    const run = await backend.execute({
      operation: 'run', executable: process.execPath, arguments: ['-e', 'setTimeout(() => {}, 30000)'], cwd: root,
      execution: 'background', timeout_seconds: 40, userConfirmed: true, admission_class: 'verification_heavy',
    });
    expect(run.ok).toBe(true);
    const taskId = String((run as { value: Record<string, unknown> }).value.task_id);

    const cancelled = await backend.execute({ operation: 'cancel', task_id: taskId, userConfirmed: true });
    expect(cancelled).toMatchObject({ ok: true, value: { state: 'cancelled' } });
    await expect.poll(() => fake.settled, { timeout: 5000 }).toEqual([{ outcome: 'cancelled', count: 1 }]);
  }, 15000);

  it('fails closed when the runtime has no admission port', async () => {
    const { root, backend } = await backendWith(undefined);

    const run = await backend.execute({
      operation: 'run', executable: process.execPath, arguments: ['-e', ''], cwd: root, execution: 'background', userConfirmed: true,
      admission_class: 'verification_heavy',
    });

    expect(run).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', recoverable: false } });
    const listed = await backend.execute({ operation: 'list' });
    expect(listed).toMatchObject({ ok: true, value: { tasks: [] } });
  });

  it('rejects an undeclared or unsupported class before any side effect', async () => {
    const fake = fakePort();
    const { root, backend } = await backendWith(fake.port);

    const unknown = await backend.execute({
      operation: 'run', executable: process.execPath, arguments: ['-e', ''], cwd: root, userConfirmed: true,
      admission_class: 'goal_process',
    });
    const foreground = await backend.execute({
      operation: 'run', executable: process.execPath, arguments: ['-e', ''], cwd: root, execution: 'foreground',
      userConfirmed: true, admission_class: 'verification_heavy',
    });

    expect(unknown).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(foreground).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(fake.requests).toEqual([]);
  });

  it('does not take a slot for a dry run', async () => {
    const fake = fakePort();
    const { root, backend } = await backendWith(fake.port);

    const preview = await backend.execute({
      operation: 'run', executable: process.execPath, arguments: ['-e', ''], cwd: root, dry_run: true, userConfirmed: true,
      admission_class: 'verification_heavy',
    });

    expect(preview).toMatchObject({ ok: true, value: { dry_run: true } });
    expect(fake.requests).toEqual([]);
  });
});
