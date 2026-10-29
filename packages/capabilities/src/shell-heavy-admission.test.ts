import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ShellCapabilityBackend,
  type ShellHeavyAdmissionEnqueueResult,
  type ShellHeavyAdmissionGrant,
  type ShellHeavyAdmissionPort,
  type ShellHeavyAdmissionRequest,
} from './shell-backend.js';

const temporaryRoots: string[] = [];

afterAll(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
});

const COST = 8;

/** Queue-shaped fake: enqueue claims a row, pump grants it, settle records once. */
class FakeAdmission implements ShellHeavyAdmissionPort {
  public readonly requests: ShellHeavyAdmissionRequest[] = [];
  public readonly settled: Array<{ operationId: string; outcome: string }> = [];
  public readonly cancelled = new Set<string>();
  /** Durable rows that survived the backend instance; shared across restarts. */
  public readonly rows: Set<string>;
  public full = false;
  public coalesce = false;
  public autoAdmit = false;
  public enqueueFailure = false;
  public grantOnEnqueue = false;
  private readonly admitted = new Set<string>();
  private readonly granted = new Set<string>();
  private readonly listeners = new Set<(grant: ShellHeavyAdmissionGrant) => void>();
  private readonly retiredListeners = new Set<(operationId: string) => void>();

  public constructor(rows: Set<string> = new Set()) {
    this.rows = rows;
  }

  public enqueue(request: ShellHeavyAdmissionRequest): ShellHeavyAdmissionEnqueueResult {
    this.requests.push(request);
    if (this.enqueueFailure) return { status: 'failed', depth: 0, cost: COST };
    if (this.full) return { status: 'full', depth: 16, cost: COST };
    if (this.coalesce) return { status: 'coalesced', depth: 1, cost: COST };
    this.rows.add(request.operationId);
    if (this.autoAdmit) this.admitted.add(request.operationId);
    if (this.grantOnEnqueue) {
      // Deliver the capacity release while the backend is still writing its
      // reservation: the grant must wait, not be mistaken for a stale one.
      queueMicrotask(() => this.grantNow(request.operationId));
    }
    return { status: 'queued', position: this.requests.length, depth: this.requests.length, cost: COST };
  }

  public reattach(
    request: ShellHeavyAdmissionRequest,
  ): ShellHeavyAdmissionEnqueueResult | { status: 'missing'; depth: number; cost: number } {
    this.requests.push(request);
    if (!this.rows.has(request.operationId)) return { status: 'missing', depth: 0, cost: COST };
    if (this.coalesce) return { status: 'coalesced', depth: 1, cost: COST };
    if (this.autoAdmit) this.admitted.add(request.operationId);
    return { status: 'queued', position: this.requests.length, depth: this.requests.length, cost: COST };
  }

  public pump(): readonly ShellHeavyAdmissionGrant[] {
    const grants: ShellHeavyAdmissionGrant[] = [];
    for (const operationId of [...this.admitted]) {
      if (this.granted.has(operationId) || this.cancelled.has(operationId)) continue;
      this.granted.add(operationId);
      grants.push({
        operationId,
        lease: {
          settle: (outcome): void => {
            this.settled.push({ operationId, outcome });
          },
        },
      });
    }
    return grants;
  }

  public cancel(operationId: string): boolean {
    if (this.granted.has(operationId)) return false;
    if (!this.requests.some((request) => request.operationId === operationId)) return false;
    this.cancelled.add(operationId);
    this.admitted.delete(operationId);
    this.rows.delete(operationId);
    return true;
  }

  public position(operationId: string): number | undefined {
    if (this.cancelled.has(operationId) || this.granted.has(operationId)) return undefined;
    const index = this.requests.findIndex((request) => request.operationId === operationId);
    return index === -1 ? undefined : index + 1;
  }

  public onAdmitted(listener: (grant: ShellHeavyAdmissionGrant) => void): () => void {
    this.listeners.add(listener);
    return (): void => {
      this.listeners.delete(listener);
    };
  }

  public onRetired(listener: (operationId: string) => void): () => void {
    this.retiredListeners.add(listener);
    return (): void => {
      this.retiredListeners.delete(listener);
    };
  }

  /** Simulate a capacity release that admits one queued operation now. */
  public grantNow(operationId: string): void {
    this.admitted.add(operationId);
    for (const grant of this.pump()) {
      for (const listener of [...this.listeners]) listener(grant);
    }
  }

  /** Simulate durable queue recovery retiring a row this runtime still held. */
  public retire(operationId: string): void {
    this.cancelled.add(operationId);
    this.admitted.delete(operationId);
    this.rows.delete(operationId);
    for (const listener of [...this.retiredListeners]) listener(operationId);
  }

  /** Simulate capacity release: admit everything still queued and notify the backend. */
  public admitAll(): void {
    for (const request of this.requests) {
      if (!this.cancelled.has(request.operationId)) this.admitted.add(request.operationId);
    }
    for (const grant of this.pump()) {
      for (const listener of [...this.listeners]) listener(grant);
    }
  }
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

const LONG_RUN = 'setTimeout(() => {}, 400)';

describe('declared heavy shell admission (#145)', () => {
  it('never asks admission for an undeclared run', async () => {
    const fake = new FakeAdmission();
    const { root, backend } = await backendWith(fake);

    const run = await backend.execute({
      operation: 'run', executable: process.execPath, arguments: ['-e', ''], cwd: root, execution: 'background', userConfirmed: true,
    });

    expect(run.ok).toBe(true);
    expect(fake.requests).toEqual([]);
  });

  it('refuses a declared run when the queue is full, without creating a task', async () => {
    const fake = new FakeAdmission();
    fake.full = true;
    const { root, backend } = await backendWith(fake);

    const run = await backend.execute({
      operation: 'run', executable: process.execPath, arguments: ['-e', ''], cwd: root, execution: 'background', userConfirmed: true,
      admission_class: 'verification_heavy',
    });

    expect(run).toMatchObject({
      ok: false,
      error: {
        code: 'RESOURCE_PRESSURE',
        recoverable: true,
        details: { reason: 'queue_full', resourceClass: 'verification_heavy', depth: 16 },
      },
    });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({ resourceClass: 'verification_heavy' });
    expect(fake.requests[0]?.operationId).toMatch(/^shell:/);
    const listed = await backend.execute({ operation: 'list' });
    expect(listed).toMatchObject({ ok: true, value: { tasks: [] } });
  });

  it('parks a declared run as waiting_resource with its queue position', async () => {
    const fake = new FakeAdmission();
    const { root, backend } = await backendWith(fake);

    const run = await backend.execute({
      operation: 'run', executable: process.execPath, arguments: ['-e', LONG_RUN], cwd: root, execution: 'background', userConfirmed: true,
      admission_class: 'verification_heavy',
    });

    expect(run).toMatchObject({
      ok: true,
      value: {
        state: 'waiting_resource',
        durable: true,
        admission: { class: 'verification_heavy', cost: COST, state: 'queued', position: 1 },
      },
    });
    const listed = await backend.execute({ operation: 'list' });
    expect(listed).toMatchObject({ ok: true, value: { tasks: [{ state: 'waiting_resource' }] } });
    expect(fake.settled).toEqual([]);
  });

  it('starts a parked run when admission grants it and settles on completion', async () => {
    const fake = new FakeAdmission();
    const { root, backend } = await backendWith(fake);

    const run = await backend.execute({
      operation: 'run', executable: process.execPath, arguments: ['-e', ''], cwd: root, execution: 'background', userConfirmed: true,
      admission_class: 'verification_heavy',
    });
    expect(run).toMatchObject({ ok: true, value: { state: 'waiting_resource' } });
    const taskId = String((run as { value: Record<string, unknown> }).value.task_id);

    fake.admitAll();

    await expect.poll(async () => {
      const status = await backend.execute({ operation: 'status', task_id: taskId });
      return status.ok ? (status.value as Record<string, unknown>).state : 'error';
    }, { timeout: 5000 }).toBe('completed');
    await expect.poll(() => fake.settled, { timeout: 5000 })
      .toEqual([{ operationId: `shell:${taskId}`, outcome: 'completed' }]);
  });

  it('starts immediately when the heavy slot is free', async () => {
    const fake = new FakeAdmission();
    fake.autoAdmit = true;
    const { root, backend } = await backendWith(fake);

    const run = await backend.execute({
      operation: 'run', executable: process.execPath, arguments: ['-e', LONG_RUN], cwd: root, execution: 'background', userConfirmed: true,
      admission_class: 'rag_indexing',
    });

    expect(run).toMatchObject({
      ok: true,
      value: { state: 'running', admission: { class: 'rag_indexing', state: 'running' } },
    });
    const taskId = String((run as { value: Record<string, unknown> }).value.task_id);
    await expect.poll(() => fake.settled, { timeout: 5000 })
      .toEqual([{ operationId: `shell:${taskId}`, outcome: 'completed' }]);
  });

  it('starts a run whose grant arrives while its reservation is still being written', async () => {
    const fake = new FakeAdmission();
    fake.grantOnEnqueue = true;
    const { root, backend } = await backendWith(fake);

    const run = await backend.execute({
      operation: 'run', executable: process.execPath, arguments: ['-e', ''], cwd: root, execution: 'background', userConfirmed: true,
      admission_class: 'verification_heavy',
    });

    expect(run.ok).toBe(true);
    const taskId = String((run as { value: Record<string, unknown> }).value.task_id);
    // Without the reservation gate this task would stay `waiting_resource`
    // forever: the early grant would be settled as stale and never re-issued.
    await expect.poll(async () => {
      const status = await backend.execute({ operation: 'status', task_id: taskId });
      return status.ok ? (status.value as Record<string, unknown>).state : 'error';
    }, { timeout: 5000 }).toBe('completed');
    await expect.poll(() => fake.settled, { timeout: 5000 })
      .toEqual([{ operationId: `shell:${taskId}`, outcome: 'completed' }]);
  });

  it('fails a parked run when its queue row is retired before admission', async () => {
    const fake = new FakeAdmission();
    const { root, backend } = await backendWith(fake);

    const run = await backend.execute({
      operation: 'run', executable: process.execPath, arguments: ['-e', LONG_RUN], cwd: root, execution: 'background', userConfirmed: true,
      admission_class: 'verification_heavy',
    });
    expect(run).toMatchObject({ ok: true, value: { state: 'waiting_resource' } });
    const taskId = String((run as { value: Record<string, unknown> }).value.task_id);

    fake.retire(`shell:${taskId}`);

    // The row is gone, so no grant can ever arrive; the durable record must
    // become terminal instead of claiming it is still queued.
    await expect.poll(async () => {
      const status = await backend.execute({ operation: 'status', task_id: taskId });
      return status.ok ? (status.value as Record<string, unknown>).state : 'error';
    }, { timeout: 5000 }).toBe('failed');
    const status = await backend.execute({ operation: 'status', task_id: taskId });
    expect(status).toMatchObject({ ok: true, value: { error: expect.stringContaining('retired') } });
    expect(fake.settled).toEqual([]);
  });

  it('re-attaches a parked run after a restart and starts it on admission', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-heavy-shell-'));
    temporaryRoots.push(root);
    const firstAdmission = new FakeAdmission();
    const first = new ShellCapabilityBackend({
      allowedRoots: [root], taskStateDirectory: path.join(root, '.tasks'), heavyAdmissionWatchIntervalMs: 15, heavyAdmission: firstAdmission,
    });
    const run = await first.execute({
      operation: 'run', executable: process.execPath, arguments: ['-e', ''], cwd: root, execution: 'background', userConfirmed: true,
      admission_class: 'verification_heavy',
    });
    expect(run).toMatchObject({ ok: true, value: { state: 'waiting_resource' } });
    const taskId = String((run as { value: Record<string, unknown> }).value.task_id);

    const fake = new FakeAdmission(firstAdmission.rows);
    const restarted = new ShellCapabilityBackend({
      allowedRoots: [root], taskStateDirectory: path.join(root, '.tasks'), heavyAdmissionWatchIntervalMs: 15, heavyAdmission: fake,
    });
    const recovered = await restarted.recoverParkedHeavy();
    expect(recovered).toEqual({ reattached: 1, failed: 0, skipped: 0 });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({ operationId: `shell:${taskId}`, resourceClass: 'verification_heavy' });

    // A second sweep must not enqueue the same task twice.
    expect(await restarted.recoverParkedHeavy()).toEqual({ reattached: 0, failed: 0, skipped: 1 });
    expect(fake.requests).toHaveLength(1);

    fake.admitAll();
    await expect.poll(async () => {
      const status = await restarted.execute({ operation: 'status', task_id: taskId });
      return status.ok ? (status.value as Record<string, unknown>).state : 'error';
    }, { timeout: 5000 }).toBe('completed');
    await expect.poll(() => fake.settled, { timeout: 5000 })
      .toEqual([{ operationId: `shell:${taskId}`, outcome: 'completed' }]);
  });

  it('fails a parked run that outlived the re-attachment window', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-heavy-shell-'));
    temporaryRoots.push(root);
    const firstAdmission = new FakeAdmission();
    const first = new ShellCapabilityBackend({
      allowedRoots: [root], taskStateDirectory: path.join(root, '.tasks'), heavyAdmissionWatchIntervalMs: 15, heavyAdmission: firstAdmission,
    });
    const run = await first.execute({
      operation: 'run', executable: process.execPath, arguments: ['-e', ''], cwd: root, execution: 'background', userConfirmed: true,
      admission_class: 'verification_heavy',
    });
    const taskId = String((run as { value: Record<string, unknown> }).value.task_id);

    const fake = new FakeAdmission(firstAdmission.rows);
    const restarted = new ShellCapabilityBackend({
      allowedRoots: [root], taskStateDirectory: path.join(root, '.tasks'), heavyAdmissionWatchIntervalMs: 15, heavyAdmission: fake,
    });
    const recovered = await restarted.recoverParkedHeavy({ maxAgeMs: 60_000, now: () => Date.now() + 3_600_000 });

    expect(recovered).toEqual({ reattached: 0, failed: 1, skipped: 0 });
    expect(fake.requests).toHaveLength(1);
    expect(fake.cancelled.has(`shell:${taskId}`)).toBe(true);
    const status = await restarted.execute({ operation: 'status', task_id: taskId });
    expect(status).toMatchObject({ ok: true, value: { state: 'failed', error: expect.stringContaining('expired') } });
  });

  it('fails a parked run whose queue row is gone instead of starting a new generation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-heavy-shell-'));
    temporaryRoots.push(root);
    const firstAdmission = new FakeAdmission();
    const first = new ShellCapabilityBackend({
      allowedRoots: [root], taskStateDirectory: path.join(root, '.tasks'), heavyAdmissionWatchIntervalMs: 15, heavyAdmission: firstAdmission,
    });
    const run = await first.execute({
      operation: 'run', executable: process.execPath, arguments: ['-e', ''], cwd: root, execution: 'background', userConfirmed: true,
      admission_class: 'verification_heavy',
    });
    expect(run).toMatchObject({ ok: true, value: { state: 'waiting_resource' } });
    const taskId = String((run as { value: Record<string, unknown> }).value.task_id);

    // The queue row was retired while no runtime held it: the durable task is
    // the only surviving record, and the admission generation that would have
    // run it is gone. Re-enqueueing would silently start a new generation, so
    // the parked task must become terminal instead.
    const fake = new FakeAdmission();
    const restarted = new ShellCapabilityBackend({
      allowedRoots: [root], taskStateDirectory: path.join(root, '.tasks'), heavyAdmissionWatchIntervalMs: 15, heavyAdmission: fake,
    });
    expect(await restarted.recoverParkedHeavy()).toEqual({ reattached: 0, failed: 1, skipped: 0 });
    expect(fake.rows.has(`shell:${taskId}`)).toBe(false);

    const status = await restarted.execute({ operation: 'status', task_id: taskId });
    expect(status).toMatchObject({ ok: true, value: { state: 'failed', error: expect.stringContaining('interrupted') } });
    expect(fake.settled).toEqual([]);
  });

  it('leaves a parked run to a live foreign runtime instead of double-queuing it', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-heavy-shell-'));
    temporaryRoots.push(root);
    const firstAdmission = new FakeAdmission();
    const first = new ShellCapabilityBackend({
      allowedRoots: [root], taskStateDirectory: path.join(root, '.tasks'), heavyAdmissionWatchIntervalMs: 15, heavyAdmission: firstAdmission,
    });
    const run = await first.execute({
      operation: 'run', executable: process.execPath, arguments: ['-e', ''], cwd: root, execution: 'background', userConfirmed: true,
      admission_class: 'verification_heavy',
    });
    const taskId = String((run as { value: Record<string, unknown> }).value.task_id);

    const fake = new FakeAdmission(firstAdmission.rows);
    fake.coalesce = true;
    const restarted = new ShellCapabilityBackend({
      allowedRoots: [root], taskStateDirectory: path.join(root, '.tasks'), heavyAdmissionWatchIntervalMs: 15, heavyAdmission: fake,
    });
    // Even far past the age window, a row owned by a live foreign runtime is
    // never expired by this process.
    expect(await restarted.recoverParkedHeavy({ maxAgeMs: 60_000, now: () => Date.now() + 3_600_000 }))
      .toEqual({ reattached: 0, failed: 0, skipped: 1 });
    const status = await restarted.execute({ operation: 'status', task_id: taskId });
    expect(status).toMatchObject({ ok: true, value: { state: 'waiting_resource' } });
  });

  it('does not revive a parked run outside its allowed roots', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-heavy-shell-'));
    const otherRoot = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-heavy-shell-'));
    temporaryRoots.push(root, otherRoot);
    const first = new ShellCapabilityBackend({
      allowedRoots: [root], taskStateDirectory: path.join(root, '.tasks'), heavyAdmissionWatchIntervalMs: 15, heavyAdmission: new FakeAdmission(),
    });
    const run = await first.execute({
      operation: 'run', executable: process.execPath, arguments: ['-e', ''], cwd: root, execution: 'background', userConfirmed: true,
      admission_class: 'verification_heavy',
    });
    const taskId = String((run as { value: Record<string, unknown> }).value.task_id);

    // A workspace-scoped profile sharing the task root must not spawn work
    // whose cwd its own resolveCwd would reject.
    const fake = new FakeAdmission();
    const scoped = new ShellCapabilityBackend({
      allowedRoots: [otherRoot], taskStateDirectory: path.join(root, '.tasks'), heavyAdmissionWatchIntervalMs: 15, heavyAdmission: fake,
    });
    expect(await scoped.recoverParkedHeavy()).toEqual({ reattached: 0, failed: 0, skipped: 1 });
    expect(fake.requests).toEqual([]);
    const status = await scoped.execute({ operation: 'status', task_id: taskId });
    expect(status).toMatchObject({ ok: true, value: { state: 'waiting_resource' } });
  });

  it('settles a failed run as failed so the slot is not leaked', async () => {
    const fake = new FakeAdmission();
    fake.autoAdmit = true;
    const { root, backend } = await backendWith(fake);

    const run = await backend.execute({
      operation: 'run', executable: process.execPath, arguments: ['-e', 'process.exit(3)'], cwd: root, execution: 'background', userConfirmed: true,
      admission_class: 'rag_indexing',
    });

    expect(fake.requests[0]).toMatchObject({ resourceClass: 'rag_indexing' });
    expect(run.ok).toBe(true);
    const taskId = String((run as { value: Record<string, unknown> }).value.task_id);
    await expect.poll(() => fake.settled, { timeout: 5000 })
      .toEqual([{ operationId: `shell:${taskId}`, outcome: 'failed' }]);
  });

  it('cancels a parked run without starting a process and without a lease', async () => {
    const fake = new FakeAdmission();
    const { root, backend } = await backendWith(fake);

    const run = await backend.execute({
      operation: 'run', executable: process.execPath, arguments: ['-e', LONG_RUN], cwd: root, execution: 'background', userConfirmed: true,
      admission_class: 'verification_heavy',
    });
    expect(run).toMatchObject({ ok: true, value: { state: 'waiting_resource' } });
    const taskId = String((run as { value: Record<string, unknown> }).value.task_id);

    const cancelled = await backend.execute({ operation: 'cancel', task_id: taskId, userConfirmed: true });
    expect(cancelled).toMatchObject({ ok: true, value: { state: 'cancelled', admission: { state: 'cancelled' } } });
    expect(fake.cancelled.has(`shell:${taskId}`)).toBe(true);

    // A late capacity release must not revive the cancelled task.
    fake.admitAll();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const status = await backend.execute({ operation: 'status', task_id: taskId });
    expect(status).toMatchObject({ ok: true, value: { state: 'cancelled' } });
    expect(fake.settled).toEqual([]);
  });

  it('settles a cancelled running run as cancelled', async () => {
    const fake = new FakeAdmission();
    fake.autoAdmit = true;
    const { root, backend } = await backendWith(fake);

    const run = await backend.execute({
      operation: 'run', executable: process.execPath, arguments: ['-e', 'setTimeout(() => {}, 30000)'], cwd: root,
      execution: 'background', timeout_seconds: 40, userConfirmed: true, admission_class: 'verification_heavy',
    });
    expect(run.ok).toBe(true);
    const taskId = String((run as { value: Record<string, unknown> }).value.task_id);

    const cancelled = await backend.execute({ operation: 'cancel', task_id: taskId, userConfirmed: true });
    expect(cancelled).toMatchObject({ ok: true, value: { state: 'cancelled' } });
    await expect.poll(() => fake.settled, { timeout: 5000 })
      .toEqual([{ operationId: `shell:${taskId}`, outcome: 'cancelled' }]);
  }, 15000);

  it('settles exactly once even though the watcher may tick again', async () => {
    const fake = new FakeAdmission();
    fake.autoAdmit = true;
    const { root, backend } = await backendWith(fake);

    const run = await backend.execute({
      operation: 'run', executable: process.execPath, arguments: ['-e', ''], cwd: root, execution: 'background', userConfirmed: true,
      admission_class: 'verification_heavy',
    });
    expect(run.ok).toBe(true);
    await expect.poll(() => fake.settled, { timeout: 5000 })
      .toEqual([{ operationId: `shell:${(run as { value: Record<string, unknown> }).value.task_id as string}`, outcome: 'completed' }]);

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(fake.settled).toHaveLength(1);
  });

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

  it('reports an unavailable queue without creating a task', async () => {
    const fake = new FakeAdmission();
    fake.enqueueFailure = true;
    const { root, backend } = await backendWith(fake);

    const run = await backend.execute({
      operation: 'run', executable: process.execPath, arguments: ['-e', ''], cwd: root, execution: 'background', userConfirmed: true,
      admission_class: 'verification_heavy',
    });

    expect(run).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR', details: { reason: 'queue_unavailable' } } });
    const listed = await backend.execute({ operation: 'list' });
    expect(listed).toMatchObject({ ok: true, value: { tasks: [] } });
  });

  it('rejects an undeclared or unsupported class before any side effect', async () => {
    const fake = new FakeAdmission();
    const { root, backend } = await backendWith(fake);

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

  it('does not take a queue row for a dry run', async () => {
    const fake = new FakeAdmission();
    const { root, backend } = await backendWith(fake);

    const preview = await backend.execute({
      operation: 'run', executable: process.execPath, arguments: ['-e', ''], cwd: root, dry_run: true, userConfirmed: true,
      admission_class: 'verification_heavy',
    });

    expect(preview).toMatchObject({ ok: true, value: { dry_run: true } });
    expect(fake.requests).toEqual([]);
  });
});
