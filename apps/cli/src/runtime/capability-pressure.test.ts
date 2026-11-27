import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { appError, err, ok, type Result } from '@unified-mpc/domain';
import type { CapabilityProcessPort, EvictionCandidate, PressureTier } from '@unified-mpc/capabilities';
import type { ResourcePressureProbe, ResourcePressureState } from '@unified-mpc/workspace';
import {
  CAPABILITY_PRESSURE_INTERVAL_MS,
  THAI_RAG_WORKER_ID,
  canRecycleDeadWorker,
  createCapabilityPressureDriver,
  createThaiRagCapabilityRuntime,
  createWorkerCwdResolver,
  wireThaiRagCapability,
} from './capability-pressure.js';

const created: string[] = [];

async function dir(): Promise<string> {
  const value = await realpath(await mkdtemp(path.join(os.tmpdir(), 'capability-pressure-')));
  created.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

function probeReturning(state: ResourcePressureState): ResourcePressureProbe {
  return {
    sample: () => ({
      state,
      totalMemoryBytes: 1,
      availableMemoryBytes: 1,
      availableRatio: 1,
      processRssBytes: 1,
      sampledAtMs: 0,
    }),
  };
}

/**
 * A supervised worker that answers `initialize` over its pipes: enough for the
 * client handshake the capability factory performs before a session exists.
 */
function fakeWorkerPipes(): { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough } {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let buffered = '';
  stdin.on('data', (chunk: Buffer) => {
    buffered += chunk.toString('utf8');
    let newline = buffered.indexOf('\n');
    while (newline >= 0) {
      const frame = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf('\n');
      if (frame.length === 0) continue;
      const message = JSON.parse(frame) as { id?: number; method?: string; params?: { protocolVersion?: string } };
      if (message.id === undefined) continue;
      const result = message.method === 'initialize'
        ? {
          protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
          capabilities: {},
          serverInfo: { name: 'fake-worker', version: '1.0.0' },
        }
        : {};
      stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
    }
  });
  return { stdin, stdout, stderr: new PassThrough() };
}

const candidate: EvictionCandidate = {
  id: THAI_RAG_WORKER_ID,
  state: 'WARM_IDLE',
  leaseCount: 0,
  idleSince: 0,
  idleTtlMs: 5_000,
  recyclable: true,
};

function sweepPort(
  plan: readonly string[],
  reclaim: (id: string) => Promise<Result<void>>,
  pendingPlan: readonly string[] = [],
): {
  readonly calls: { tier: PressureTier; snapshot: readonly EvictionCandidate[] }[];
  readonly pendingCalls: { tier: PressureTier; snapshot: readonly EvictionCandidate[] }[];
  readonly sweeps: number[];
  readonly registry: {
    snapshot: () => readonly EvictionCandidate[];
    reclaim: (id: string) => Promise<Result<void>>;
    sweep: () => Promise<void>;
  };
  readonly supervisor: {
    evictionPlan: (tier: PressureTier, snapshot: readonly EvictionCandidate[]) => readonly string[];
    pendingEvictionPlan: (tier: PressureTier, snapshot: readonly EvictionCandidate[]) => readonly string[];
  };
} {
  const calls: { tier: PressureTier; snapshot: readonly EvictionCandidate[] }[] = [];
  const pendingCalls: { tier: PressureTier; snapshot: readonly EvictionCandidate[] }[] = [];
  const sweeps: number[] = [];
  return {
    calls,
    pendingCalls,
    sweeps,
    registry: {
      snapshot: (): readonly EvictionCandidate[] => [candidate],
      reclaim,
      sweep: async (): Promise<void> => {
        sweeps.push(Date.now());
      },
    },
    supervisor: {
      evictionPlan: (tier: PressureTier, snapshot: readonly EvictionCandidate[]): readonly string[] => {
        calls.push({ tier, snapshot });
        return plan;
      },
      pendingEvictionPlan: (tier: PressureTier, snapshot: readonly EvictionCandidate[]): readonly string[] => {
        pendingCalls.push({ tier, snapshot });
        return pendingPlan;
      },
    },
  };
}

describe('capability pressure driver', () => {
  it('reclaims nothing on a normal sample', async () => {
    const reclaimed: string[] = [];
    const port = sweepPort([THAI_RAG_WORKER_ID], async (id) => {
      reclaimed.push(id);
      return ok(undefined);
    });
    const driver = createCapabilityPressureDriver({ ...port, probe: probeReturning('normal') });

    await driver.tick();

    expect(reclaimed).toEqual([]);
    expect(port.calls).toEqual([]);
  });

  it('sweeps warm workers even on a normal sample', async () => {
    const reclaimed: string[] = [];
    const port = sweepPort([THAI_RAG_WORKER_ID], async (id) => {
      reclaimed.push(id);
      return ok(undefined);
    });
    const driver = createCapabilityPressureDriver({ ...port, probe: probeReturning('normal') });

    await driver.tick();

    // An idle TTL is time, not a symptom: a healthy host still reclaims.
    expect(port.sweeps).toHaveLength(1);
    expect(port.calls).toEqual([]);
    expect(reclaimed).toEqual([]);
  });

  it('plans and reclaims at the sampled tier', async () => {
    const reclaimed: string[] = [];
    const port = sweepPort([THAI_RAG_WORKER_ID], async (id) => {
      reclaimed.push(id);
      return ok(undefined);
    });
    const driver = createCapabilityPressureDriver({ ...port, probe: probeReturning('elevated') });

    await driver.tick();

    expect(port.calls).toEqual([{ tier: 'elevated', snapshot: [candidate] }]);
    expect(reclaimed).toEqual([THAI_RAG_WORKER_ID]);
  });

  it('reports a rejected reclaim and keeps sweeping the rest', async () => {
    const seen: string[] = [];
    const errors: unknown[] = [];
    const port = sweepPort(['a', 'b'], async (id) => {
      seen.push(id);
      return id === 'a'
        ? { ok: false, error: { code: 'CONFLICT', message: 'stop in flight' } } as unknown as Result<void>
        : ok(undefined);
    });
    const driver = createCapabilityPressureDriver({
      ...port,
      probe: probeReturning('critical'),
      onError: (error) => errors.push(error),
    });

    await driver.tick();

    expect(seen).toEqual(['a', 'b']);
    expect(errors).toHaveLength(1);
  });

  it('asks for the lease to be released only at critical, and only when a reclaim left a mark', async () => {
    const nudged: string[] = [];
    const port = sweepPort([THAI_RAG_WORKER_ID], async () => ok(undefined));
    const driver = createCapabilityPressureDriver({
      ...port,
      registry: {
        ...port.registry,
        // A leased id: `reclaim` only marked it, so the stop is waiting on the holder.
        health: (): { pendingStop?: string } => ({ pendingStop: 'reclaimed while leased' }),
      },
      probe: probeReturning('critical'),
      requestEviction: async (id: string): Promise<boolean> => {
        nudged.push(id);
        return true;
      },
    });

    await driver.tick();

    expect(nudged).toEqual([THAI_RAG_WORKER_ID]);
  });

  it('reclaims a leased id at critical so the mark the nudge follows is written', async () => {
    const reclaimed: string[] = [];
    const nudged: string[] = [];
    // `evictionPlan` refuses a leased id; only the pending plan can name it.
    const port = sweepPort([], async (id) => {
      reclaimed.push(id);
      return ok(undefined);
    }, [THAI_RAG_WORKER_ID]);
    const driver = createCapabilityPressureDriver({
      ...port,
      registry: {
        ...port.registry,
        health: (): { pendingStop?: string } => ({ pendingStop: 'reclaimed while leased' }),
      },
      probe: probeReturning('critical'),
      requestEviction: async (id: string): Promise<boolean> => {
        nudged.push(id);
        return true;
      },
      ownsLeasedWorker: (): boolean => true,
    });

    await driver.tick();

    expect(port.pendingCalls).toEqual([{ tier: 'critical', snapshot: [candidate] }]);
    expect(reclaimed).toEqual([THAI_RAG_WORKER_ID]);
    expect(nudged).toEqual([THAI_RAG_WORKER_ID]);
  });

  it('never marks a leased id it cannot release or cannot read the mark back from', async () => {
    const reclaimed: string[] = [];
    const port = sweepPort([], async (id) => {
      reclaimed.push(id);
      return ok(undefined);
    }, [THAI_RAG_WORKER_ID]);
    // No `health` read: the nudge could never see the mark it caused.
    const unreadable = createCapabilityPressureDriver({
      ...port,
      probe: probeReturning('critical'),
      requestEviction: async (): Promise<boolean> => true,
      ownsLeasedWorker: (): boolean => true,
    });
    await unreadable.tick();
    expect(reclaimed).toEqual([]);

    // A leased id this runtime does not own: its lane has no releaser here.
    const foreign = createCapabilityPressureDriver({
      ...port,
      registry: {
        ...port.registry,
        health: (): { pendingStop?: string } => ({ pendingStop: 'reclaimed while leased' }),
      },
      probe: probeReturning('critical'),
      requestEviction: async (): Promise<boolean> => true,
      ownsLeasedWorker: (): boolean => false,
    });
    await foreign.tick();
    expect(reclaimed).toEqual([]);
  });

  it('never plans a leased id below critical, or when no callback can release the lane', async () => {
    const reclaimed: string[] = [];
    const port = sweepPort([], async (id) => {
      reclaimed.push(id);
      return ok(undefined);
    }, [THAI_RAG_WORKER_ID]);
    const elevated = createCapabilityPressureDriver({
      ...port,
      probe: probeReturning('elevated'),
      requestEviction: async (): Promise<boolean> => true,
    });
    await elevated.tick();
    expect(reclaimed).toEqual([]);
    expect(port.pendingCalls).toEqual([]);

    const unreleasable = createCapabilityPressureDriver({ ...port, probe: probeReturning('critical') });
    await unreleasable.tick();
    // No callback means the mark would outlive this tick with nobody to honour it.
    expect(reclaimed).toEqual([]);
  });

  it('never ends a live session on an elevated sample', async () => {
    const nudged: string[] = [];
    const port = sweepPort([THAI_RAG_WORKER_ID], async () => ok(undefined));
    const driver = createCapabilityPressureDriver({
      ...port,
      registry: {
        ...port.registry,
        health: (): { pendingStop?: string } => ({ pendingStop: 'reclaimed while leased' }),
      },
      probe: probeReturning('elevated'),
      requestEviction: async (id: string): Promise<boolean> => {
        nudged.push(id);
        return true;
      },
    });

    await driver.tick();

    expect(nudged).toEqual([]);
  });

  it('does not nudge a worker the reclaim actually stopped', async () => {
    const nudged: string[] = [];
    const port = sweepPort([THAI_RAG_WORKER_ID], async () => ok(undefined));
    const driver = createCapabilityPressureDriver({
      ...port,
      registry: { ...port.registry, health: (): { pendingStop?: string } => ({}) },
      probe: probeReturning('critical'),
      requestEviction: async (id: string): Promise<boolean> => {
        nudged.push(id);
        return true;
      },
    });

    await driver.tick();

    expect(nudged).toEqual([]);
  });

  it('reports a nudge that could not release the lane, and one that throws', async () => {
    const errors: unknown[] = [];
    const port = sweepPort([THAI_RAG_WORKER_ID], async () => ok(undefined));
    const driver = createCapabilityPressureDriver({
      ...port,
      registry: {
        ...port.registry,
        health: (): { pendingStop?: string } => ({ pendingStop: 'reclaimed while leased' }),
      },
      probe: probeReturning('critical'),
      onError: (error) => errors.push(error),
      requestEviction: async (): Promise<boolean> => false,
    });
    await driver.tick();

    const throwing = createCapabilityPressureDriver({
      ...port,
      registry: {
        ...port.registry,
        health: (): { pendingStop?: string } => ({ pendingStop: 'reclaimed while leased' }),
      },
      probe: probeReturning('critical'),
      onError: (error) => errors.push(error),
      requestEviction: async (): Promise<boolean> => {
        throw new Error('lane close refused');
      },
    });
    await throwing.tick();

    // Both stay inside the interval: one reported refusal, one reported throw.
    expect(errors).toHaveLength(2);
  });

  it('does not stack ticks while a reclaim is still running', async () => {
    let release: (() => void) | undefined;
    const reclaimed: string[] = [];
    const port = sweepPort([THAI_RAG_WORKER_ID], async (id) => {
      reclaimed.push(id);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return ok(undefined);
    });
    const driver = createCapabilityPressureDriver({ ...port, probe: probeReturning('elevated') });

    const first = driver.tick();
    await driver.tick();
    expect(reclaimed).toEqual([THAI_RAG_WORKER_ID]);
    release?.();
    await first;
  });

  it('keeps the interval unref-ed and clears it on close', () => {
    let scheduled: (() => void) | undefined;
    let cleared: unknown;
    let unrefCalled = false;
    const timers = {
      setInterval: ((handler: () => void) => {
        scheduled = handler;
        return { unref: () => { unrefCalled = true; }, id: 1 } as unknown as ReturnType<typeof setInterval>;
      }) as unknown as typeof setInterval,
      clearInterval: ((timer: unknown) => { cleared = timer; }) as unknown as typeof clearInterval,
    };
    const port = sweepPort([], async () => ok(undefined));
    const driver = createCapabilityPressureDriver({
      ...port,
      probe: probeReturning('normal'),
      timers,
    });

    driver.start();
    driver.start();
    expect(scheduled).toBeTypeOf('function');
    expect(unrefCalled).toBe(true);
    driver.close();
    expect(cleared).toBeDefined();
    driver.close();
    expect(CAPABILITY_PRESSURE_INTERVAL_MS).toBe(30_000);
  });
});

describe('capability worker cwd', () => {
  it('accepts the canonical install root and canonical workspace roots only', async () => {
    const installRoot = await dir();
    const workspaceRoot = await dir();
    const foreign = await dir();
    const resolve = createWorkerCwdResolver({
      installRoot,
      workspaceRoots: async () => [workspaceRoot],
    });

    expect((await resolve(installRoot)).ok).toBe(true);
    expect((await resolve(workspaceRoot)).ok).toBe(true);
    expect((await resolve(foreign)).ok).toBe(false);
    expect((await resolve(path.join(installRoot, 'venv'))).ok).toBe(false);
    expect((await resolve(path.join(installRoot, 'does-not-exist'))).ok).toBe(false);
  });

  it('accepts a runtime-owned extra root, and only that root', async () => {
    const installRoot = await dir();
    const sourcesRoot = await dir();
    const foreign = await dir();
    const resolve = createWorkerCwdResolver({
      installRoot,
      workspaceRoots: async () => [],
      extraRoots: [sourcesRoot],
    });

    expect((await resolve(sourcesRoot)).ok).toBe(true);
    expect((await resolve(path.join(sourcesRoot, 'nested'))).ok).toBe(false);
    expect((await resolve(foreign)).ok).toBe(false);
  });
});

describe('thai-rag capability runtime', () => {
  it('closes a real capability session so the marked stop runs', async () => {
    const installRoot = await dir();
    const stops: string[] = [];
    let starts = 0;
    const processes: CapabilityProcessPort = {
      start: async (spec, _signal, onCreated) => {
        starts += 1;
        const pipes = fakeWorkerPipes();
        const spawned = {
          processId: `proc-${starts}`,
          executable: spec.executable,
          args: spec.args,
          cwd: spec.cwd,
          state: 'running' as const,
          startedAt: new Date(0).toISOString(),
          stdin: pipes.stdin,
          stdout: pipes.stdout,
          stderr: pipes.stderr,
        };
        onCreated?.(spawned);
        return ok(spawned);
      },
      stop: async (processId) => {
        stops.push(processId);
        return ok(undefined);
      },
      status: (processId) => ok({
        processId,
        executable: '/usr/bin/node',
        args: [],
        cwd: installRoot,
        state: stops.includes(processId) ? 'stopped' : 'running',
        startedAt: new Date(0).toISOString(),
      }),
      onExit: () => () => {},
    };
    const launch = {
      executable: path.join(installRoot, 'venv', 'bin', 'python3'),
      args: [path.join(installRoot, 'thai_rag_context_mcp.py')],
      cwd: installRoot,
    };
    const runtime = await createThaiRagCapabilityRuntime({
      installRoot,
      workspaceRoots: async () => [],
      launch,
      processManager: processes,
    });
    expect(runtime.ok).toBe(true);
    if (!runtime.ok) return;

    // The lease a lane takes is the registry's, not the factory's.
    const config = { command: launch.executable, args: [...launch.args], cwd: launch.cwd };
    const session = await runtime.value.factory.connect(config);
    expect(runtime.value.registry.snapshot()[0]).toMatchObject({ state: 'ACTIVE', leaseCount: 1 });
    expect((await runtime.value.registry.reclaim(THAI_RAG_WORKER_ID)).ok).toBe(true);
    expect(runtime.value.registry.health(THAI_RAG_WORKER_ID)?.pendingStop).toBe('reclaimed while leased');

    // Closing the session is what a lane drop does; the last release runs the mark.
    await session.close();
    for (let attempt = 0; attempt < 50 && runtime.value.registry.snapshot()[0]?.state !== 'COLD'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(stops).toEqual(['proc-1']);
    expect(runtime.value.registry.health(THAI_RAG_WORKER_ID)?.pendingStop).toBeUndefined();
    expect(runtime.value.registry.snapshot()[0]).toMatchObject({ state: 'COLD', leaseCount: 0 });
    await runtime.value.close();
  });

  it('registers the provider worker with a resolvable spec', async () => {
    const installRoot = await dir();
    await mkdir(path.join(installRoot, 'venv'));
    const runtime = await createThaiRagCapabilityRuntime({
      installRoot,
      workspaceRoots: async () => [],
      launch: {
        executable: path.join(installRoot, 'venv', 'bin', 'python3'),
        args: [path.join(installRoot, 'thai_rag_context_mcp.py')],
        cwd: installRoot,
        env: { THAI_RAG_EMBEDDING_BACKEND: 'llamacpp' },
      },
    });

    expect(runtime.ok).toBe(true);
    if (!runtime.ok) return;
    expect(runtime.value.registry.health(THAI_RAG_WORKER_ID)?.state).toBe('COLD');
    expect(runtime.value.manifest.recyclable).toBe(true);
    await runtime.value.close();
  });

  it('boots with no heavy worker resident, and spawns one only for a lease', async () => {
    const installRoot = await dir();
    await mkdir(path.join(installRoot, 'venv'));
    const spawns: string[] = [];
    const processes: CapabilityProcessPort = {
      start: async (spec, _signal, onCreated) => {
        spawns.push(spec.executable);
        const pipes = fakeWorkerPipes();
        const spawned = {
          processId: `proc-${spawns.length}`,
          executable: spec.executable,
          args: spec.args,
          cwd: spec.cwd,
          state: 'running' as const,
          startedAt: new Date(0).toISOString(),
          stdin: pipes.stdin,
          stdout: pipes.stdout,
          stderr: pipes.stderr,
        };
        onCreated?.(spawned);
        return ok(spawned);
      },
      stop: async () => ok(undefined),
      status: (processId) => ok({
        processId,
        executable: '/usr/bin/node',
        args: [],
        cwd: installRoot,
        state: 'running',
        startedAt: new Date(0).toISOString(),
      }),
      onExit: () => () => {},
    };
    const launch = {
      executable: path.join(installRoot, 'venv', 'bin', 'python3'),
      args: [path.join(installRoot, 'thai_rag_context_mcp.py')],
      cwd: installRoot,
    };
    const runtime = await createThaiRagCapabilityRuntime({
      installRoot,
      workspaceRoots: async () => [],
      launch,
      processManager: processes,
    });
    expect(runtime.ok).toBe(true);
    if (!runtime.ok) return;

    // Registration is boot work; residency is not. Nothing is spawned, so a core
    // that boots with the provider configured still pays no worker RSS.
    expect(spawns).toHaveLength(0);
    expect(runtime.value.registry.health(THAI_RAG_WORKER_ID)).toMatchObject({ state: 'COLD', leaseCount: 0 });

    const session = await runtime.value.factory.connect({ command: launch.executable, args: [...launch.args], cwd: launch.cwd });
    expect(spawns).toEqual([launch.executable]);
    expect(runtime.value.registry.health(THAI_RAG_WORKER_ID)).toMatchObject({ state: 'ACTIVE', leaseCount: 1 });

    await session.close();
    for (let attempt = 0; attempt < 50 && runtime.value.registry.snapshot()[0]?.state !== 'WARM_IDLE'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // The lane dropping its lease leaves a warm worker, not a cold one. Three
    // things reclaim it: the idle TTL sweep, a memory-pressure reclaim, or a
    // shutdown. `close()` is the one that must not leave a child behind, so it
    // is asserted here.
    expect(runtime.value.registry.snapshot()[0]).toMatchObject({ state: 'WARM_IDLE', leaseCount: 0 });
    await runtime.value.close();
    expect(runtime.value.registry.health(THAI_RAG_WORKER_ID)?.state).toBe('COLD');
  });

  it('refuses a registration whose cwd is outside the allowlist', async () => {
    const installRoot = await dir();
    const foreign = await dir();
    const runtime = await createThaiRagCapabilityRuntime({
      installRoot,
      workspaceRoots: async () => [],
      launch: {
        executable: path.join(installRoot, 'venv', 'bin', 'python3'),
        args: [path.join(installRoot, 'thai_rag_context_mcp.py')],
        cwd: foreign,
      },
    });

    expect(runtime.ok).toBe(false);
  });

  it('states no wall-clock cap on the provider spec, so a serving worker is not killed hourly', async () => {
    const installRoot = await dir();
    await mkdir(path.join(installRoot, 'venv'));
    const specs: { timeoutMs?: number }[] = [];
    const processes: CapabilityProcessPort = {
      start: async (startSpec, _signal, onCreated) => {
        specs.push(startSpec);
        const spawned = {
          processId: `proc-${specs.length}`,
          executable: startSpec.executable,
          args: startSpec.args,
          cwd: startSpec.cwd,
          state: 'running' as const,
          startedAt: new Date(0).toISOString(),
        };
        onCreated?.(spawned);
        return ok(spawned);
      },
      stop: async () => ok(undefined),
      status: () => err(appError('PROCESS_NOT_FOUND', 'Process was not found')),
      onExit: () => () => {},
    };
    const runtime = await createThaiRagCapabilityRuntime({
      installRoot,
      workspaceRoots: async () => [],
      launch: {
        executable: path.join(installRoot, 'venv', 'bin', 'python3'),
        args: [path.join(installRoot, 'thai_rag_context_mcp.py')],
        cwd: installRoot,
      },
      processManager: processes,
    });

    expect(runtime.ok).toBe(true);
    if (!runtime.ok) return;
    const lease = await runtime.value.registry.acquire(THAI_RAG_WORKER_ID);
    expect(lease.ok).toBe(true);
    // The literal is the fix's whole production effect: without this assertion,
    // deleting it restores the hourly SIGKILL with every other test still green.
    expect(specs.map((spec) => spec.timeoutMs)).toEqual([0]);
    if (lease.ok) lease.value.release();
    await runtime.value.close();
  });

  it('turns a refused registration into a connection failure, not a boot failure', async () => {
    const installRoot = await dir();
    const foreign = await dir();
    const wiring = wireThaiRagCapability({
      installRoot,
      workspaceRoots: async () => [],
      launch: {
        executable: path.join(installRoot, 'venv', 'bin', 'python3'),
        args: [path.join(installRoot, 'thai_rag_context_mcp.py')],
        cwd: foreign,
      },
    });

    const ready = await wiring.ready;
    expect(ready.ok).toBe(false);
    await expect(wiring.factory.connect({ command: 'python3' })).rejects.toThrow(/unavailable/);
    await wiring.close();
  });
});

describe('a dead supervised worker', () => {
  it('is recycled only when nothing is alive or unverified', () => {
    expect(canRecycleDeadWorker({ state: 'FAILED' }, {})).toBe(true);
    expect(canRecycleDeadWorker({ state: 'FAILED' }, undefined)).toBe(true);
    expect(canRecycleDeadWorker({ state: 'FAILED' }, { processId: '123' })).toBe(false);
    expect(canRecycleDeadWorker({ state: 'FAILED' }, { stopUnverified: true })).toBe(false);
    expect(canRecycleDeadWorker({ state: 'WARM_IDLE' }, {})).toBe(false);
    expect(canRecycleDeadWorker(undefined, {})).toBe(false);
  });
});
