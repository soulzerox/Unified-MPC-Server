import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { appError, err, ok, type Result } from '@unified-mpc/domain';
import type { ManagedProcess, ManagedProcessStart, ManagedProcessState } from '@unified-mpc/process';

import {
  normalizeCapabilityManifest,
  type CapabilityHealth,
  type CapabilityManifest,
  type CapabilityState,
} from './capability-registry.js';
import {
  CapabilitySupervisor,
  type CapabilityLifecyclePort,
  type CapabilityProcessPort,
  type EvictionCandidate,
} from './capability-supervisor.js';

const ROOT = '/home/test/workspace';

function manifest(overrides: Partial<CapabilityManifest> = {}): CapabilityManifest {
  const normalized = normalizeCapabilityManifest({
    id: 'worker',
    provides: ['token'],
    runtimeKind: 'native-worker',
    startupTimeoutMs: 100,
    shutdownTimeoutMs: 100,
    ...overrides,
  });
  if (!normalized.ok) throw new Error('manifest fixture is invalid');
  return normalized.value;
}

interface FakeWorkerState {
  state: CapabilityState;
  leaseCount: number;
}

/** The supervisor's whole lifecycle view, as a scripted fake. */
class FakeLifecycle implements CapabilityLifecyclePort {
  public readonly workers = new Map<string, FakeWorkerState>();

  public readonly failures: Array<{ id: string; reason: string }> = [];

  public readonly reclaimCalls: string[] = [];

  public snapshotValue: readonly EvictionCandidate[] = [];

  public reclaimBehaviour: (id: string) => Promise<void> = async (id) => {
    const worker = this.workers.get(id);
    if (worker !== undefined && worker.leaseCount === 0) worker.state = 'COLD';
  };

  public snapshot(): readonly EvictionCandidate[] {
    return this.snapshotValue;
  }

  public health(id: string): CapabilityHealth | undefined {
    const worker = this.workers.get(id);
    return worker === undefined ? undefined : { id, state: worker.state, leaseCount: worker.leaseCount };
  }

  public async reclaim(id: string): Promise<Result<void>> {
    this.reclaimCalls.push(id);
    await this.reclaimBehaviour(id);
    return ok(undefined);
  }

  public fail(id: string, reason: string): Result<void> {
    this.failures.push({ id, reason });
    const worker = this.workers.get(id);
    if (worker !== undefined) worker.state = 'FAILED';
    return ok(undefined);
  }

  public set(id: string, state: CapabilityState, leaseCount = 0): void {
    this.workers.set(id, { state, leaseCount });
  }

  public stateOf(id: string): CapabilityState | undefined {
    return this.workers.get(id)?.state;
  }
}

interface FakeProcessControl {
  start: (spec: ManagedProcessStart, onCreated?: (process: ManagedProcess) => void) => Promise<Result<ManagedProcess>>;
  stop: (processId: string) => Promise<Result<void>>;
  state: (processId: string) => ManagedProcessState | undefined;
}

function managedProcess(processId: string, state: ManagedProcessState): ManagedProcess {
  return { processId, executable: '/usr/bin/node', args: [], cwd: ROOT, state, startedAt: new Date(0).toISOString() };
}

class FakeProcesses implements CapabilityProcessPort {
  public readonly specs: ManagedProcessStart[] = [];

  public readonly stops: string[] = [];

  public unsubscribes = 0;

  /** Simulates a manager that delivers the notification before the unsubscribe lands. */
  public notifyAfterUnsubscribe = false;

  public lastListener: (() => void) | undefined;

  private readonly exitListeners = new Map<string, () => void>();

  private nextProcess = 0;

  private control: FakeProcessControl = {
    start: async (_spec, onCreated) => {
      const process = managedProcess(`proc-${this.nextProcess}`, 'running');
      this.nextProcess += 1;
      onCreated?.(process);
      return ok(process);
    },
    stop: async () => ok(undefined),
    state: () => 'stopped',
  };

  public configure(control: Partial<FakeProcessControl>): void {
    this.control = { ...this.control, ...control };
  }

  public async start(
    spec: ManagedProcessStart,
    _signal?: AbortSignal,
    onCreated?: (process: ManagedProcess) => void,
  ): Promise<Result<ManagedProcess>> {
    this.specs.push(spec);
    return this.control.start(spec, onCreated);
  }

  public async stop(processId: string, _autoRetry = false): Promise<Result<void>> {
    this.stops.push(processId);
    return this.control.stop(processId);
  }

  public status(processId: string): Result<ManagedProcess> {
    const state = this.control.state(processId);
    return state === undefined
      ? err(appError('PROCESS_NOT_FOUND', 'Process was not found'))
      : ok(managedProcess(processId, state));
  }

  public onExit(processId: string, listener: () => void): () => void {
    this.exitListeners.set(processId, listener);
    this.lastListener = listener;
    return () => {
      this.unsubscribes += 1;
      if (!this.notifyAfterUnsubscribe) this.exitListeners.delete(processId);
    };
  }

  public fireLastListener(): void {
    this.lastListener?.();
  }

  public fireExit(processId: string): void {
    this.exitListeners.get(processId)?.();
  }
}

function build(options: {
  lifecycle?: FakeLifecycle;
  processes?: FakeProcesses;
  now?: () => number;
  resolveWorkerCwd?: (requested: string) => Promise<Result<string>>;
  maxCrashRestarts?: number;
  shutdownDeadlineMs?: number;
} = {}): { supervisor: CapabilitySupervisor; lifecycle: FakeLifecycle; processes: FakeProcesses } {
  const lifecycle = options.lifecycle ?? new FakeLifecycle();
  const processes = options.processes ?? new FakeProcesses();
  const supervisor = new CapabilitySupervisor({
    lifecycle,
    processManager: processes,
    now: options.now ?? ((): number => 1_000),
    resolveWorkerCwd: options.resolveWorkerCwd ?? (async (requested): Promise<Result<string>> => ok(`${ROOT}/${requested}`)),
    ...(options.maxCrashRestarts === undefined ? {} : { maxCrashRestarts: options.maxCrashRestarts }),
    ...(options.shutdownDeadlineMs === undefined ? {} : { shutdownDeadlineMs: options.shutdownDeadlineMs }),
  });
  return { supervisor, lifecycle, processes };
}

const spec = { executable: '/usr/bin/node', args: ['--version'], cwd: 'sub' };

describe('capability supervisor registration', () => {
  it('refuses a non-in-process manifest with no spec, and replaces a registration only while idle', async () => {
    const { supervisor, lifecycle, processes } = build();
    const worker = manifest();

    const missing = await supervisor.register(worker);
    expect(missing.ok).toBe(false);
    expect(missing.ok ? '' : missing.error.message).toContain('needs a worker spec');

    expect((await supervisor.register(worker, spec)).ok).toBe(true);
    // A second registration of an idle id replaces the spec: a gate check's argv is
    // the host's per run, and a fresh id per run would leak records instead.
    expect((await supervisor.register(worker, { ...spec, args: ['--version', '--help'] })).ok).toBe(true);

    lifecycle.set('worker', 'STARTING');
    await supervisor.start(worker);

    expect(processes.specs.at(-1)?.args).toEqual(['--version', '--help']);
  });

  it('refuses to replace the spec of a worker that is live or possibly live', async () => {
    const { supervisor, lifecycle } = build();
    await supervisor.register(manifest(), spec);
    lifecycle.set('worker', 'ACTIVE');
    await supervisor.start(manifest());

    const refused = await supervisor.register(manifest(), { ...spec, args: ['--other'] });

    expect(refused.ok).toBe(false);
    expect(refused.ok ? '' : refused.error.message).toContain('already has a worker registration');
  });

  it('refuses a replacement while a start is still resolving its executable', async () => {
    const { supervisor, lifecycle, processes } = build();
    await supervisor.register(manifest(), spec);
    lifecycle.set('worker', 'STARTING');

    // Real `ProcessManager.start` awaits executable resolution before it calls
    // `onCreated`, so no process id or subscription exists yet at this point.
    let release: (() => void) | undefined;
    processes.configure({
      start: (_spec, onCreated): Promise<Result<ManagedProcess>> => new Promise((resolve): void => {
        release = (): void => {
          const process = managedProcess('proc-1', 'running');
          onCreated?.(process);
          resolve(ok(process));
        };
      }),
    });
    const pending = supervisor.start(manifest());

    const refused = await supervisor.register(manifest(), { ...spec, args: ['--other'] });
    expect(refused.ok).toBe(false);

    release?.();
    expect((await pending).ok).toBe(true);
  });

  it('refuses a replacement whose cwd resolution outlived a start', async () => {
    let awaited = 0;
    let release: (() => void) | undefined;
    const { supervisor, lifecycle } = build({
      resolveWorkerCwd: async (requested) => {
        awaited += 1;
        if (awaited === 2) await new Promise<void>((resolve) => { release = resolve; });
        return ok(`${ROOT}/${requested}`);
      },
    });
    await supervisor.register(manifest(), spec);
    lifecycle.set('worker', 'STARTING');

    const replacement = supervisor.register(manifest(), { ...spec, args: ['--other'] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await supervisor.start(manifest());
    release?.();

    expect((await replacement).ok).toBe(false);
  });

  it('refuses a replacement while a spawn that timed out still owns a subscription', async () => {
    const { supervisor, lifecycle, processes } = build();
    await supervisor.register(manifest({ startupTimeoutMs: 5 }), spec);
    lifecycle.set('worker', 'STARTING');

    // `onCreated` arrives before the start promise settles, so a timeout leaves a
    // live, subscribed child behind with no `processId` and no in-flight start.
    processes.configure({
      start: (_spec, onCreated): Promise<Result<ManagedProcess>> => new Promise((): void => {
        onCreated?.(managedProcess('proc-stuck', 'running'));
      }),
    });
    expect((await supervisor.start(manifest({ startupTimeoutMs: 5 }))).ok).toBe(false);

    const refused = await supervisor.register(manifest(), { ...spec, args: ['--other'] });

    expect(refused.ok).toBe(false);
  });

  it('carries the crash window across a replacement so a per-run argv cannot launder a crash loop', async () => {
    const { supervisor, processes } = build({ maxCrashRestarts: 1 });
    await supervisor.register(manifest(), spec);
    processes.configure({ start: async () => err(appError('CONFLICT', 'spawn refused')) });
    expect((await supervisor.start(manifest())).ok).toBe(false);

    // Replacing the record is allowed — nothing of it can still run — but the
    // failure still counts against the capability.
    expect((await supervisor.register(manifest(), { ...spec, args: ['--other'] })).ok).toBe(true);
    const refused = await supervisor.start(manifest());

    expect(refused.ok).toBe(false);
    expect(refused.ok ? '' : refused.error.message).toContain('crash loop');
  });

  it('does not let a spawn an abandoned attempt still owes fail the replaced record', async () => {
    const { supervisor, lifecycle, processes } = build();
    await supervisor.register(manifest({ startupTimeoutMs: 5 }), spec);

    // A start that never settles leaves an abandoned attempt behind; the late
    // spawn it still owes arrives after the id has a new spec, and dies inside
    // the same tick, before the supervisor's own discard runs.
    const late: ManagedProcess[] = [];
    processes.configure({
      start: (_spec, onCreated) => new Promise((resolve) => {
        setTimeout(() => {
          const process = managedProcess('proc-late', 'running');
          late.push(process);
          onCreated?.(process);
          processes.fireExit('proc-late');
          resolve(ok(process));
        }, 20);
      }),
    });
    expect((await supervisor.start(manifest({ startupTimeoutMs: 5 }))).ok).toBe(false);

    expect((await supervisor.register(manifest(), { ...spec, args: ['--help'] })).ok).toBe(true);
    lifecycle.set('worker', 'ACTIVE');

    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(late).toHaveLength(1);
    // The death is reported against a record that no longer owns the id.
    expect(lifecycle.failures).toEqual([]);
  });

  it('refuses an in-process manifest that carries a spec', async () => {
    const { supervisor } = build();

    const registered = await supervisor.register(manifest({ runtimeKind: 'in-process' }), spec);

    expect(registered.ok).toBe(false);
  });

  it('keeps the conflict for a second in-process registration', async () => {
    const { supervisor } = build();

    expect((await supervisor.register(manifest({ runtimeKind: 'in-process' }))).ok).toBe(true);
    expect((await supervisor.register(manifest({ runtimeKind: 'in-process' }))).ok).toBe(false);
  });

  it('refuses a blank argv element, a relative executable and a rejected cwd', async () => {
    const relative = build();
    expect((await relative.supervisor.register(manifest(), { ...spec, executable: 'node' })).ok).toBe(false);
    expect((await relative.supervisor.register(manifest(), { ...spec, args: [' '] })).ok).toBe(false);

    const rejected = build({
      resolveWorkerCwd: async () => err(appError('PATH_OUTSIDE_WORKSPACE', 'outside every root')),
    });
    const refused = await rejected.supervisor.register(manifest(), { ...spec, cwd: '../etc' });

    expect(refused.ok).toBe(false);
    expect(refused.ok ? '' : refused.error.code).toBe('PATH_OUTSIDE_WORKSPACE');
    expect(rejected.processes.specs).toHaveLength(0);
  });

  it('stores the resolved cwd rather than the requested one', async () => {
    const { supervisor, processes, lifecycle } = build();
    await supervisor.register(manifest(), spec);
    lifecycle.set('worker', 'STARTING');

    await supervisor.start(manifest());

    expect(processes.specs[0]?.cwd).toBe(`${ROOT}/sub`);
  });

  it('makes start and stop a no-op for an in-process capability', async () => {
    const { supervisor, processes } = build();
    const inProcess = manifest({ runtimeKind: 'in-process' });
    await supervisor.register(inProcess);

    expect((await supervisor.start(inProcess)).ok).toBe(true);
    expect((await supervisor.stop(inProcess)).ok).toBe(true);
    expect(processes.specs).toHaveLength(0);
  });
});

describe('capability supervisor start', () => {
  it('reports a failed spawn and counts it', async () => {
    const { supervisor, lifecycle, processes } = build();
    await supervisor.register(manifest(), spec);
    lifecycle.set('worker', 'STARTING');
    processes.configure({ start: async () => err(appError('EXECUTABLE_NOT_FOUND', 'missing')) });

    const started = await supervisor.start(manifest());

    expect(started.ok).toBe(false);
    expect(supervisor.health()[0]?.lastFailure).toBe('start-failed');
  });

  it('abandons a spawn that exceeds startupTimeoutMs and stops the late process', async () => {
    const { supervisor, lifecycle, processes } = build();
    await supervisor.register(manifest({ startupTimeoutMs: 5 }), spec);
    lifecycle.set('worker', 'STARTING');
    processes.configure({
      start: (_spec, onCreated) => new Promise((resolve) => {
        setTimeout(() => {
          onCreated?.(managedProcess('late', 'running'));
          resolve(ok(managedProcess('late', 'running')));
        }, 30);
      }),
    });

    const started = await supervisor.start(manifest({ startupTimeoutMs: 5 }));

    expect(started.ok).toBe(false);
    expect(started.ok ? '' : started.error.code).toBe('PROCESS_TIMEOUT');
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    expect(processes.stops).toEqual(['late']);
    expect(supervisor.health()[0]?.processId).toBeUndefined();
  });

  it('drops the manager cap only for a resident worker', async () => {
    const { supervisor, lifecycle, processes } = build();
    await supervisor.register(manifest({ recyclable: true }), spec);
    await supervisor.register(manifest({ id: 'resident', recyclable: false }), spec);
    lifecycle.set('worker', 'STARTING');
    lifecycle.set('resident', 'STARTING');

    await supervisor.start(manifest({ recyclable: true }));
    await supervisor.start(manifest({ id: 'resident', recyclable: false }));

    expect(processes.specs[0]?.timeoutMs).toBeUndefined();
    expect(processes.specs[1]?.timeoutMs).toBe(0);
  });

  it('lets the spec state its own wall-clock cap, over the manifest default', async () => {
    const { supervisor, lifecycle, processes } = build();
    await supervisor.register(manifest({ recyclable: true }), { ...spec, timeoutMs: 0 });
    await supervisor.register(manifest({ id: 'resident', recyclable: false }), { ...spec, timeoutMs: 5_000 });
    lifecycle.set('worker', 'STARTING');
    lifecycle.set('resident', 'STARTING');

    await supervisor.start(manifest({ recyclable: true }));
    await supervisor.start(manifest({ id: 'resident', recyclable: false }));

    expect(processes.specs[0]?.timeoutMs).toBe(0);
    expect(processes.specs[1]?.timeoutMs).toBe(5_000);
  });
});

describe('capability supervisor worker exit', () => {
  it('reports an unrequested exit as FAILED while ACTIVE and while WARM_IDLE', async () => {
    const { supervisor, lifecycle, processes } = build();
    await supervisor.register(manifest(), spec);
    lifecycle.set('worker', 'STARTING');
    await supervisor.start(manifest());

    lifecycle.set('worker', 'ACTIVE');
    processes.fireExit('proc-0');
    expect(lifecycle.failures).toEqual([{ id: 'worker', reason: 'worker-exited' }]);
    expect(supervisor.health()[0]?.lastFailure).toBe('worker-exited');

    lifecycle.set('worker', 'WARM_IDLE');
    lifecycle.set('worker', 'STARTING');
    await supervisor.start(manifest());
    lifecycle.set('worker', 'WARM_IDLE');
    processes.fireExit('proc-1');

    expect(lifecycle.failures).toEqual([
      { id: 'worker', reason: 'worker-exited' },
      { id: 'worker', reason: 'worker-exited' },
    ]);
    expect(supervisor.health()[0]?.restarts).toBe(1);
  });

  it('turns a death inside the STARTING window into a refused start instead of ACTIVE', async () => {
    const { supervisor, lifecycle, processes } = build();
    await supervisor.register(manifest(), spec);
    lifecycle.set('worker', 'STARTING');
    processes.configure({
      start: async (_spec, onCreated) => {
        const process = managedProcess('proc-dies', 'exited');
        onCreated?.(process);
        processes.fireExit(process.processId);
        return ok(process);
      },
    });

    const started = await supervisor.start(manifest());

    expect(started.ok).toBe(false);
    expect(lifecycle.failures).toEqual([]);
    expect(supervisor.health()[0]?.lastFailure).toBe('worker-exited');
  });

  it('ignores an exit for the kill it ordered itself, and drops the subscription first', async () => {
    const { supervisor, lifecycle, processes } = build();
    await supervisor.register(manifest(), spec);
    lifecycle.set('worker', 'STARTING');
    await supervisor.start(manifest());
    lifecycle.set('worker', 'ACTIVE');

    // The manager here delivers the exit even though the subscription was
    // already dropped, so the state guard — not the ordering — is what the test
    // proves: an exit for a stop in flight writes no FAILED and counts no crash.
    processes.notifyAfterUnsubscribe = true;
    processes.configure({
      stop: async () => {
        lifecycle.set('worker', 'STOPPING');
        processes.fireLastListener();
        return ok(undefined);
      },
      state: () => 'stopped',
    });
    await supervisor.stop(manifest());

    expect(lifecycle.failures).toEqual([]);
    expect(processes.unsubscribes).toBeGreaterThan(0);
    expect(supervisor.health()[0]?.crashLoop).toBe(false);
  });
});

describe('capability supervisor eviction plan', () => {
  const candidate = (overrides: Partial<EvictionCandidate>): EvictionCandidate => ({
    id: 'a',
    state: 'WARM_IDLE',
    leaseCount: 0,
    idleSince: 0,
    idleTtlMs: 60_000,
    recyclable: true,
    ...overrides,
  });

  it('lists nothing at normal pressure', () => {
    const { supervisor } = build();

    expect(supervisor.evictionPlan('normal', [candidate({})])).toEqual([]);
  });

  it('clamps to five seconds at elevated pressure, oldest first, and never a lease', () => {
    const { supervisor } = build({ now: () => 10_000 });
    const snapshot = [
      candidate({ id: 'recent', idleSince: 9_500, idleTtlMs: 60_000 }),
      candidate({ id: 'old-default', idleSince: 4_000 }),
      candidate({ id: 'leased', idleSince: 0, leaseCount: 1 }),
      candidate({ id: 'active', idleSince: 0, state: 'ACTIVE' }),
      candidate({ id: 'resident', idleSince: 0, recyclable: false }),
    ];

    expect(supervisor.evictionPlan('elevated', snapshot)).toEqual(['old-default']);
  });

  it('lists every unleased warm id at critical pressure, ignoring its TTL', () => {
    const { supervisor } = build({ now: () => 10_000 });
    const snapshot = [
      candidate({ id: 'a', idleSince: 9_999 }),
      candidate({ id: 'b', idleSince: 9_000 }),
      candidate({ id: 'leased', leaseCount: 2 }),
    ];

    expect(supervisor.evictionPlan('critical', snapshot)).toEqual(['b', 'a']);
  });

  it('lists only leased, recyclable live ids at critical, oldest first', () => {
    const { supervisor } = build({ now: () => 10_000 });
    const snapshot = [
      // The production case: a live lease keeps the record ACTIVE, never WARM_IDLE.
      candidate({ id: 'leased-old', leaseCount: 1, idleSince: 1_000, state: 'ACTIVE' }),
      candidate({ id: 'leased-warm', leaseCount: 1, idleSince: 2_000, state: 'WARM_IDLE' }),
      candidate({ id: 'unleased', idleSince: 0 }),
      candidate({ id: 'leased-resident', leaseCount: 1, recyclable: false }),
      candidate({ id: 'leased-cold', leaseCount: 1, state: 'COLD' }),
    ];

    expect(supervisor.pendingEvictionPlan('critical', snapshot)).toEqual(['leased-old', 'leased-warm']);
  });

  it('never marks a leased id below critical pressure', () => {
    const { supervisor } = build({ now: () => 10_000 });
    const snapshot = [candidate({ id: 'leased', leaseCount: 1 })];

    expect(supervisor.pendingEvictionPlan('normal', snapshot)).toEqual([]);
    expect(supervisor.pendingEvictionPlan('elevated', snapshot)).toEqual([]);
  });
});

describe('capability supervisor crash loop', () => {
  it('refuses to start once the window is exhausted and reports crashLoop', async () => {
    const { supervisor, lifecycle, processes } = build({ maxCrashRestarts: 2 });
    await supervisor.register(manifest(), spec);
    lifecycle.set('worker', 'STARTING');
    processes.configure({ start: async () => err(appError('INTERNAL_ERROR', 'nope')) });

    await supervisor.start(manifest());
    await supervisor.start(manifest());
    const refused = await supervisor.start(manifest());

    expect(refused.ok).toBe(false);
    expect(refused.ok ? '' : refused.error.details?.['reason']).toBe('crash_loop');
    expect(processes.specs).toHaveLength(2);
    expect(supervisor.health()[0]?.crashLoop).toBe(true);
  });

  it('lets the capability start again once the oldest failure leaves the window', async () => {
    let now = 1_000;
    const { supervisor, lifecycle, processes } = build({ maxCrashRestarts: 2, now: (): number => now });
    await supervisor.register(manifest(), spec);
    lifecycle.set('worker', 'STARTING');
    processes.configure({ start: async () => err(appError('INTERNAL_ERROR', 'nope')) });

    await supervisor.start(manifest());
    await supervisor.start(manifest());
    expect((await supervisor.start(manifest())).ok).toBe(false);

    now += 60_001;
    processes.configure({ start: async () => ok(managedProcess('proc-after-window', 'running')) });
    expect(supervisor.health()[0]?.crashLoop).toBe(false);
    expect((await supervisor.start(manifest())).ok).toBe(true);
  });
});

describe('capability supervisor late spawn', () => {
  it('ignores the onCreated of an attempt that already timed out', async () => {
    const { supervisor, lifecycle, processes } = build();
    await supervisor.register(manifest({ startupTimeoutMs: 5 }), spec);
    let lateCreated: ((process: ManagedProcess) => void) | undefined;
    let liveCreated: ((process: ManagedProcess) => void) | undefined;
    let settleLate: ((value: Result<ManagedProcess>) => void) | undefined;
    let calls = 0;
    processes.configure({
      start: (_spec, onCreated) => {
        calls += 1;
        if (calls === 1) {
          lateCreated = onCreated;
          // Settles only when the test says so: this is an attempt the
          // supervisor already abandoned on its deadline.
          return new Promise((resolve) => { settleLate = resolve; });
        }
        liveCreated = onCreated;
        return Promise.resolve(ok(managedProcess('proc-live', 'running')));
      },
    });
    lifecycle.set('worker', 'STARTING');

    expect((await supervisor.start(manifest({ startupTimeoutMs: 5 }))).ok).toBe(false);
    expect((await supervisor.start(manifest({ startupTimeoutMs: 5 }))).ok).toBe(true);
    liveCreated?.(managedProcess('proc-live', 'running'));

    // The abandoned attempt reports its process after the live one subscribed;
    // it must neither take the subscription over nor drop it.
    lateCreated?.(managedProcess('proc-late', 'running'));
    settleLate?.(ok(managedProcess('proc-late', 'running')));
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    lifecycle.set('worker', 'ACTIVE');
    processes.fireExit('proc-live');

    expect(lifecycle.stateOf('worker')).toBe('FAILED');
    expect(processes.stops).toContain('proc-late');
  });

  it('drops the listener of a start that failed after its process was created', async () => {
    const { supervisor, lifecycle, processes } = build();
    await supervisor.register(manifest(), spec);
    let calls = 0;
    let liveCreated: ((process: ManagedProcess) => void) | undefined;
    let settleLive: ((value: Result<ManagedProcess>) => void) | undefined;
    processes.configure({
      // `onCreated` runs before the start promise settles, so this is the real
      // ordering of a spawn that fails after the process record exists.
      start: (_spec, onCreated) => {
        calls += 1;
        if (calls === 1) {
          onCreated?.(managedProcess('proc-dead', 'running'));
          return Promise.resolve(err(appError('EXECUTABLE_NOT_FOUND', 'Executable was not found')));
        }
        // A real manager resolves its executable before reporting the process,
        // which leaves the next attempt's start window open to the stale close.
        liveCreated = onCreated;
        return new Promise((resolve) => { settleLive = resolve; });
      },
    });

    lifecycle.set('worker', 'STARTING');
    expect((await supervisor.start(manifest())).ok).toBe(false);

    lifecycle.set('worker', 'STARTING');
    const second = supervisor.start(manifest());
    // The dead attempt's close lands while the new attempt is still starting.
    processes.fireExit('proc-dead');
    liveCreated?.(managedProcess('proc-live', 'running'));
    settleLive?.(ok(managedProcess('proc-live', 'running')));

    expect((await second).ok).toBe(true);
    lifecycle.set('worker', 'ACTIVE');
    processes.fireExit('proc-live');

    expect(lifecycle.stateOf('worker')).toBe('FAILED');
    expect(lifecycle.failures).toEqual([{ id: 'worker', reason: 'worker-exited' }]);
    expect(processes.stops).not.toContain('proc-live');
  });

  it('ignores an exit delivered to a listener that outlived its attempt', async () => {
    const { supervisor, lifecycle, processes } = build();
    await supervisor.register(manifest(), spec);
    // A manager that notifies before the unsubscribe lands leaves the dead
    // attempt's listener callable, so only the attempt guard can reject it.
    processes.notifyAfterUnsubscribe = true;
    let calls = 0;
    let liveCreated: ((process: ManagedProcess) => void) | undefined;
    let settleLive: ((value: Result<ManagedProcess>) => void) | undefined;
    processes.configure({
      start: (_spec, onCreated) => {
        calls += 1;
        if (calls === 1) {
          onCreated?.(managedProcess('proc-dead', 'running'));
          return Promise.resolve(err(appError('EXECUTABLE_NOT_FOUND', 'Executable was not found')));
        }
        liveCreated = onCreated;
        return new Promise((resolve) => { settleLive = resolve; });
      },
    });

    lifecycle.set('worker', 'STARTING');
    expect((await supervisor.start(manifest())).ok).toBe(false);

    lifecycle.set('worker', 'STARTING');
    const second = supervisor.start(manifest());
    processes.fireExit('proc-dead');
    liveCreated?.(managedProcess('proc-live', 'running'));
    settleLive?.(ok(managedProcess('proc-live', 'running')));

    expect((await second).ok).toBe(true);
    expect(processes.stops).not.toContain('proc-live');
  });
});

describe('capability supervisor registration race', () => {
  it('lets exactly one of two concurrent registrations of the same id win', async () => {
    const { supervisor } = build({
      resolveWorkerCwd: async (requested): Promise<Result<string>> => {
        await new Promise((resolve) => { setTimeout(resolve, 5); });
        return ok(`${ROOT}/${requested}`);
      },
    });

    const [first, second] = await Promise.all([
      supervisor.register(manifest(), spec),
      supervisor.register(manifest(), spec),
    ]);

    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
  });
});

describe('capability supervisor stop', () => {
  it('never reports COLD for a stop whose termination could not be verified', async () => {
    const { supervisor, lifecycle, processes } = build();
    await supervisor.register(manifest({ shutdownTimeoutMs: 5 }), spec);
    lifecycle.set('worker', 'STARTING');
    await supervisor.start(manifest());
    lifecycle.set('worker', 'ACTIVE');
    processes.configure({
      stop: () => new Promise(() => { /* a kill that never verifies */ }),
      state: () => 'termination_unverified',
    });

    const stopped = await supervisor.stop(manifest({ shutdownTimeoutMs: 5 }));

    expect(stopped.ok).toBe(false);
    expect(lifecycle.failures).toEqual([{ id: 'worker', reason: 'stop-unverified' }]);
    expect(lifecycle.stateOf('worker')).toBe('FAILED');
    expect(supervisor.health()[0]?.stopUnverified).toBe(true);
  });
});

describe('capability supervisor shutdown', () => {
  it('reclaims warm ids, marks a leased id for a pending stop and returns inside the deadline', async () => {
    const { supervisor, lifecycle } = build({ shutdownDeadlineMs: 200 });
    await supervisor.register(manifest({ id: 'warm' }), spec);
    await supervisor.register(manifest({ id: 'leased' }), spec);
    lifecycle.set('warm', 'WARM_IDLE');
    lifecycle.set('leased', 'ACTIVE', 1);
    lifecycle.set('cold', 'COLD');
    lifecycle.snapshotValue = [
      { id: 'warm', state: 'WARM_IDLE', leaseCount: 0, idleSince: 0, idleTtlMs: 0, recyclable: true },
      { id: 'leased', state: 'ACTIVE', leaseCount: 1, idleSince: 0, idleTtlMs: 0, recyclable: true },
      { id: 'cold', state: 'COLD', leaseCount: 0, idleSince: 0, idleTtlMs: 0, recyclable: true },
      { id: 'resident', state: 'ACTIVE', leaseCount: 0, idleSince: 0, idleTtlMs: 0, recyclable: false },
    ];
    lifecycle.reclaimBehaviour = async (id): Promise<void> => {
      if (id === 'warm') lifecycle.set('warm', 'COLD');
      // A lease forbids `STOPPING`: the registry only marks a pending stop and
      // the release completes it, so the fake must not pretend otherwise.
    };

    const startedAt = Date.now();
    const sweep = supervisor.shutdown();
    setTimeout(() => { lifecycle.set('leased', 'COLD'); }, 20);
    await sweep;

    expect(lifecycle.reclaimCalls).toEqual(['warm', 'leased']);
    expect(lifecycle.stateOf('warm')).toBe('COLD');
    expect(lifecycle.stateOf('leased')).toBe('COLD');
    expect(lifecycle.failures).toEqual([]);
    expect(Date.now() - startedAt).toBeLessThan(200);
  });

  it('fails only the id that reached STOPPING and leaves a still-leased id alone', async () => {
    const { supervisor, lifecycle } = build({ shutdownDeadlineMs: 30 });
    await supervisor.register(manifest({ id: 'stuck' }), spec);
    await supervisor.register(manifest({ id: 'leased' }), spec);
    lifecycle.set('stuck', 'WARM_IDLE');
    lifecycle.set('leased', 'ACTIVE', 1);
    lifecycle.snapshotValue = [
      { id: 'stuck', state: 'WARM_IDLE', leaseCount: 0, idleSince: 0, idleTtlMs: 0, recyclable: true },
      { id: 'leased', state: 'ACTIVE', leaseCount: 1, idleSince: 0, idleTtlMs: 0, recyclable: true },
    ];
    lifecycle.reclaimBehaviour = async (id): Promise<void> => {
      if (id === 'stuck') lifecycle.set('stuck', 'STOPPING');
    };

    const startedAt = Date.now();
    await supervisor.shutdown();
    const elapsed = Date.now() - startedAt;

    // One capability ignored its grace period, so the sweep must still return,
    // and it must not overshoot the single deadline it owns.
    expect(elapsed).toBeGreaterThanOrEqual(20);
    expect(elapsed).toBeLessThan(300);
    expect(lifecycle.failures).toEqual([{ id: 'stuck', reason: 'stop-unverified' }]);
    expect(lifecycle.stateOf('leased')).toBe('ACTIVE');
    const leasedHealth = supervisor.health().find((entry) => entry.id === 'leased');
    expect(leasedHealth?.stopUnverified).toBeUndefined();
  });
});

describe('capability supervisor worker pipes', () => {
  it('hands a supervised worker\'s pipes out and forgets them on stop', async () => {
    const { supervisor, lifecycle, processes } = build();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    processes.configure({
      start: async (_spec, onCreated) => {
        const process = { ...managedProcess('proc-pipes', 'running'), stdin, stdout, stderr };
        onCreated?.(process);
        return ok(process);
      },
    });
    await supervisor.register(manifest(), { ...spec, exposeStdio: true, env: { THAI_RAG_TEST_KEY: 'value' } });
    lifecycle.set('worker', 'STARTING');

    await supervisor.start(manifest());

    // The spec reaches the process manager unchanged: the supervisor does not
    // reinterpret the two fields it only forwards.
    expect(processes.specs[0]).toMatchObject({ exposeStdio: true, env: { THAI_RAG_TEST_KEY: 'value' } });
    expect(supervisor.pipes('worker')).toEqual({ stdin, stdout, stderr });

    await supervisor.stop(manifest());
    expect(supervisor.pipes('worker')).toBeUndefined();
  });

  it('never asks for pipes a plain worker does not need', async () => {
    const { supervisor, lifecycle, processes } = build();
    await supervisor.register(manifest(), spec);
    lifecycle.set('worker', 'STARTING');

    await supervisor.start(manifest());

    expect(processes.specs[0]?.exposeStdio).toBeUndefined();
    expect(supervisor.pipes('worker')).toBeUndefined();
  });

  it('drops the pipes of an attempt that failed or timed out after spawning', async () => {
    const pipesOf = (): { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough } =>
      ({ stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    const withSpec = { ...spec, exposeStdio: true };

    const failed = build();
    await failed.supervisor.register(manifest(), withSpec);
    failed.processes.configure({
      start: async (_spec, onCreated) => {
        const pipes = pipesOf();
        onCreated?.({ ...managedProcess('dead-on-arrival', 'running'), ...pipes });
        return err(appError('EXECUTABLE_NOT_FOUND', 'missing'));
      },
    });
    expect((await failed.supervisor.start(manifest())).ok).toBe(false);
    expect(failed.supervisor.pipes('worker')).toBeUndefined();

    const late = build();
    await late.supervisor.register(manifest({ startupTimeoutMs: 5 }), withSpec);
    late.processes.configure({
      start: (_spec, onCreated) => new Promise((resolve) => {
        setTimeout(() => {
          const pipes = pipesOf();
          onCreated?.({ ...managedProcess('late-pipes', 'running'), ...pipes });
          resolve(ok(managedProcess('late-pipes', 'running')));
        }, 30);
      }),
    });
    expect((await late.supervisor.start(manifest({ startupTimeoutMs: 5 }))).ok).toBe(false);
    expect(late.supervisor.pipes('worker')).toBeUndefined();
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    expect(late.supervisor.pipes('worker')).toBeUndefined();
  });
});
