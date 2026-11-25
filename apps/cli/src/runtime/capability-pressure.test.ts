import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
): {
  readonly calls: { tier: PressureTier; snapshot: readonly EvictionCandidate[] }[];
  readonly sweeps: number[];
  readonly registry: {
    snapshot: () => readonly EvictionCandidate[];
    reclaim: (id: string) => Promise<Result<void>>;
    sweep: () => Promise<void>;
  };
  readonly supervisor: { evictionPlan: (tier: PressureTier, snapshot: readonly EvictionCandidate[]) => readonly string[] };
} {
  const calls: { tier: PressureTier; snapshot: readonly EvictionCandidate[] }[] = [];
  const sweeps: number[] = [];
  return {
    calls,
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
