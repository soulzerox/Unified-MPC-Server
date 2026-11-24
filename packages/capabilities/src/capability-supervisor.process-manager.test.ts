import { ok, type Result } from '@unified-mpc/domain';
import { ProcessManager } from '@unified-mpc/process';
import { describe, expect, it } from 'vitest';

import { CapabilityRegistry, type CapabilityManifest } from './capability-registry.js';
import { CapabilitySupervisor, type CapabilityWorkerSpec } from './capability-supervisor.js';

/**
 * The spec's integration acceptance item: the supervisor wired to the real
 * `ProcessManager` and a real `node -e` child. The fake manager proves the timed
 * paths (a start timeout, the abandoned late spawn, the spawn bound), because
 * racing a real `spawn` against a zero-millisecond deadline is scheduling
 * dependent and would be flaky; this proves the spawn, the log, the verified
 * stop and an unrequested exit reach the manager production uses.
 */
function build(): {
  readonly registry: CapabilityRegistry;
  readonly supervisor: CapabilitySupervisor;
  readonly processes: ProcessManager;
} {
  const processes = new ProcessManager();
  // The registry's hooks are the supervisor's; the supervisor's lifecycle port is
  // the same registry, so the holder names it after construction.
  const holder: { supervisor?: CapabilitySupervisor } = {};
  const registry = new CapabilityRegistry({
    start: (manifest): Promise<Result<void>> => holder.supervisor!.start(manifest),
    stop: (manifest): Promise<Result<void>> => holder.supervisor!.stop(manifest),
  });
  holder.supervisor = new CapabilitySupervisor({
    lifecycle: registry,
    processManager: processes,
    resolveWorkerCwd: (requested): Promise<Result<string>> => Promise.resolve(ok(requested)),
    shutdownDeadlineMs: 5_000,
  });
  return { registry, supervisor: holder.supervisor, processes };
}

const CHILD = "console.log('capability worker up'); setTimeout(() => {}, 60_000);";

function manifest(id: string, extra: Partial<CapabilityManifest> = {}): CapabilityManifest {
  return { id, provides: [id], runtimeKind: 'external-process', idleTtlMs: 0, ...extra };
}

function workerSpec(script: string): CapabilityWorkerSpec {
  return { executable: process.execPath, args: ['-e', script], cwd: process.cwd() };
}

describe('capability supervisor with the real ProcessManager', () => {
  it('starts a child, reads its log line and stops it with a verified termination', async () => {
    const { registry, supervisor, processes } = build();
    // A warm window, because `shutdown()` never kills a leased id: the lease is
    // released first so the sweep reclaims a `WARM_IDLE` worker.
    const spec = manifest('worker', { idleTtlMs: 60_000 });
    expect((await supervisor.register(spec, workerSpec(CHILD))).ok).toBe(true);
    expect((await registry.register(spec)).ok).toBe(true);

    const lease = await registry.acquire('worker');
    if (!lease.ok) throw new Error('expected a lease');
    const processId = supervisor.health()[0]?.processId;
    expect(processId).toBeDefined();
    // The child's stdout reached the manager's ring buffer: the spawned process
    // is the one this capability owns, not merely a spawn that returned `ok`.
    await new Promise<void>((resolve) => { setTimeout(resolve, 300); });
    const logs = processes.logs(processId!, { tailLines: 10 });
    expect(logs.ok && logs.value.entries.some((entry) => entry.text.includes('capability worker up'))).toBe(true);

    // A held lease forbids the kill, so the release has to come first.
    expect(lease.value.release().ok).toBe(true);
    expect(registry.health('worker')?.state).toBe('WARM_IDLE');

    await supervisor.shutdown();

    expect(registry.health('worker')?.state).toBe('COLD');
    // The manager keeps the record for its log, so the verified outcome is the
    // state it carries, not the record's absence.
    const final = processes.status(processId!);
    expect(final.ok && final.value.state).toBe('stopped');
  });

  it('reports an unrequested exit through the real onExit notification', async () => {
    const { registry, supervisor } = build();
    const spec = manifest('worker');
    expect((await supervisor.register(spec, workerSpec("console.log('bye');"))).ok).toBe(true);
    expect((await registry.register(spec)).ok).toBe(true);

    expect((await registry.acquire('worker')).ok).toBe(true);
    await new Promise<void>((resolve) => { setTimeout(resolve, 1_000); });

    expect(registry.health('worker')?.state).toBe('FAILED');
    expect(registry.health('worker')?.lastTransition?.reason).toBe('worker-exited');
  });

});
