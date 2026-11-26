import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ok } from '@unified-mpc/domain';
import { PathExecutableResolver, ProcessManager, MAX_RETAINED_TERMINAL_LOG_BYTES, MAX_RETAINED_TERMINAL_RECORDS, MAX_TEE_BUFFER_BYTES, type ExecutableResolver, type ProcessTreeTerminator } from './index.js';

async function waitForState(manager: ProcessManager, processId: string, state: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = manager.status(processId);
    if (result.ok && result.value.state === state) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Process did not reach state ${state}`);
}

describe('ProcessManager', () => {
  it('captures stdout/stderr and retains a managed process handle', async () => {
    const manager = new ProcessManager();
    const started = await manager.start({
      executable: process.execPath,
      args: ['-e', "process.stdout.write('stdout-marker\\n'); process.stderr.write('stderr-marker\\n');"],
      cwd: process.cwd(),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitForState(manager, started.value.processId, 'exited');
    const logs = manager.logs(started.value.processId, {});

    expect(logs.ok).toBe(true);
    if (!logs.ok) return;
    expect(logs.value.entries.map((entry) => `${entry.stream}:${entry.text}`)).toEqual(expect.arrayContaining([
      expect.stringContaining('stdout:stdout-marker'),
      expect.stringContaining('stderr:stderr-marker'),
    ]));
  });

  it('times out a running child and stops only an owned process handle', async () => {
    const manager = new ProcessManager();
    const started = await manager.start({
      executable: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 10000)'],
      cwd: process.cwd(),
      timeoutMs: 100,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitForState(manager, started.value.processId, 'timed_out');
    await expect(manager.stop('not-owned')).resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_NOT_FOUND' } });
    await expect(manager.stop(started.value.processId)).resolves.toMatchObject({ ok: true });
  });

  it('keeps a child alive when the wall-clock cap is disabled', async () => {
    const manager = new ProcessManager();
    const started = await manager.start({
      executable: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 10000)'],
      cwd: process.cwd(),
      timeoutMs: 0,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    expect(manager.status(started.value.processId)).toMatchObject({ ok: true, value: { state: 'running' } });
    await expect(manager.stop(started.value.processId)).resolves.toMatchObject({ ok: true });
  });

  it('rejects a negative wall-clock cap', async () => {
    const result = await new ProcessManager().start({
      executable: process.execPath,
      args: ['-e', 'process.exit(0)'],
      cwd: process.cwd(),
      timeoutMs: -1,
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('reports an unrequested exit once through onExit', async () => {
    const manager = new ProcessManager();
    const started = await manager.start({
      executable: process.execPath,
      args: ['-e', 'setTimeout(() => process.exit(3), 60)'],
      cwd: process.cwd(),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    let notifications = 0;
    manager.onExit(started.value.processId, () => { notifications += 1; });
    await waitForState(manager, started.value.processId, 'exited');
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    expect(notifications).toBe(1);
  });

  it('replays onExit immediately for a process that is already terminal', async () => {
    const manager = new ProcessManager();
    const started = await manager.start({
      executable: process.execPath,
      args: ['-e', 'process.exit(0)'],
      cwd: process.cwd(),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitForState(manager, started.value.processId, 'exited');
    let notifications = 0;
    manager.onExit(started.value.processId, () => { notifications += 1; });

    expect(notifications).toBe(1);
  });

  it('stops reporting an exit after the subscription is released', async () => {
    const manager = new ProcessManager();
    const started = await manager.start({
      executable: process.execPath,
      args: ['-e', 'setTimeout(() => process.exit(0), 80)'],
      cwd: process.cwd(),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    let notifications = 0;
    const unsubscribe = manager.onExit(started.value.processId, () => { notifications += 1; });
    unsubscribe();
    await waitForState(manager, started.value.processId, 'exited');
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    expect(notifications).toBe(0);
  });

  it('returns EXECUTABLE_NOT_FOUND without accepting an arbitrary shell command', async () => {
    const result = await new ProcessManager().start({
      executable: 'unified-mpc-executable-that-does-not-exist',
      args: ['&&', 'whoami'],
      cwd: process.cwd(),
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'EXECUTABLE_NOT_FOUND' } });
  });

  it('runs a Windows command shim without shell true', async () => {
    if (process.platform !== 'win32') return;
    const root = await mkdtemp(path.join(process.cwd(), 'unified-mpc process shim-'));
    try {
      await writeFile(path.join(root, 'unified-mpc-shim.cmd'), '@echo off\r\necho process-shim-marker\r\n', 'utf8');
      const resolver = new PathExecutableResolver({ Path: root, PATHEXT: '.CMD' });
      await expect(resolver.resolve('unified-mpc-shim')).resolves.toMatchObject({ ok: true, value: expect.stringMatching(/\.cmd$/i) });
      const manager = new ProcessManager(undefined, resolver);
      const started = await manager.start({ executable: 'unified-mpc-shim', args: [], cwd: root });
      expect(started.ok).toBe(true);
      if (!started.ok) return;

      await waitForState(manager, started.value.processId, 'exited');
      const logs = manager.logs(started.value.processId, {});
      expect(logs).toMatchObject({ ok: true, value: { entries: [expect.objectContaining({ text: expect.stringContaining('process-shim-marker') })] } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects shell metacharacters in Windows command shim arguments', async () => {
    if (process.platform !== 'win32') return;
    const root = await mkdtemp(path.join(process.cwd(), 'unified-mpc-process-shim-'));
    try {
      await writeFile(path.join(root, 'unified-mpc-shim.cmd'), '@echo off\r\necho process-shim-marker\r\n', 'utf8');
      const resolver = new PathExecutableResolver({ Path: root, PATHEXT: '.CMD' });
      const result = await new ProcessManager(undefined, resolver).start({ executable: 'unified-mpc-shim', args: ['&', 'whoami'], cwd: root });
      expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps stop pending and nonterminal until process-tree termination is verified', async () => {
    let terminationAllowed = false;
    const terminator: ProcessTreeTerminator = {
      async stop(child): Promise<void> {
        if (!terminationAllowed) throw new Error('verification unavailable');
        if (child.exitCode === null && child.signalCode === null) child.kill();
      },
    };
    const manager = new ProcessManager(terminator);
    const started = await manager.start({
      executable: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: process.cwd(),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const stopping = manager.stop(started.value.processId);
    await waitForState(manager, started.value.processId, 'termination_unverified');
    expect(manager.status(started.value.processId)).toMatchObject({
      ok: true,
      value: { state: 'termination_unverified', error: expect.stringContaining('could not be verified') },
    });
    expect((manager.status(started.value.processId) as { ok: true; value: { finishedAt?: string } }).value.finishedAt).toBeUndefined();
    await expect(Promise.race([stopping.then(() => 'settled'), delay(50).then(() => 'pending')])).resolves.toBe('pending');

    terminationAllowed = true;
    await expect(manager.stop(started.value.processId)).resolves.toMatchObject({ ok: true });
    await expect(stopping).resolves.toMatchObject({ ok: true });
    expect(manager.status(started.value.processId)).toMatchObject({ ok: true, value: { state: 'stopped' } });
  });

  it('does not infer verified termination when the root closes before a failed tree stop', async () => {
    let terminationAllowed = false;
    const terminator: ProcessTreeTerminator = {
      async stop(): Promise<void> {
        await delay(50);
        if (!terminationAllowed) throw new Error('tree verification failed after root close');
      },
    };
    const manager = new ProcessManager(terminator);
    const started = await manager.start({
      executable: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 10)'],
      cwd: process.cwd(),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const stopping = manager.stop(started.value.processId);
    await waitForState(manager, started.value.processId, 'termination_unverified');
    await delay(25);
    expect(manager.status(started.value.processId)).toMatchObject({ ok: true, value: { state: 'termination_unverified' } });

    terminationAllowed = true;
    await expect(manager.stop(started.value.processId)).resolves.toMatchObject({ ok: true });
    await expect(stopping).resolves.toMatchObject({ ok: true });
    expect(manager.status(started.value.processId)).toMatchObject({ ok: true, value: { state: 'stopped' } });
  });

  it('keeps timeout termination failures contained and retries until verified', async () => {
    let terminationAllowed = false;
    const terminator: ProcessTreeTerminator = {
      async stop(child): Promise<void> {
        if (!terminationAllowed) throw new Error('verification unavailable');
        if (child.exitCode === null && child.signalCode === null) child.kill();
      },
    };
    const manager = new ProcessManager(terminator);
    const started = await manager.start({
      executable: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: process.cwd(),
      timeoutMs: 25,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitForState(manager, started.value.processId, 'termination_unverified');
    terminationAllowed = true;
    await expect(manager.stop(started.value.processId)).resolves.toMatchObject({ ok: true });
    await waitForState(manager, started.value.processId, 'timed_out');
  });

  it('does not spawn after cancellation wins during executable resolution', async () => {
    const root = await mkdtemp(path.join(process.cwd(), 'unified-mpc-cancelled-process-'));
    const marker = path.join(root, 'late-spawn-marker.txt');
    let releaseResolver!: () => void;
    const resolverGate = new Promise<void>((resolve) => { releaseResolver = resolve; });
    const resolver: ExecutableResolver = {
      async resolve() {
        await resolverGate;
        return ok(process.execPath);
      },
    };
    const controller = new AbortController();
    try {
      const starting = new ProcessManager(undefined, resolver).start({
        executable: 'delayed-node',
        args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`],
        cwd: root,
      }, controller.signal);
      controller.abort();
      releaseResolver();

      await expect(starting).resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
      await delay(100);
      await expect(access(marker)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('captures a restart recovery identity internally without exposing the host pid in ManagedProcess', async () => {
    let observedPid: number | undefined;
    const hostStartedAt = '2026-09-21T00:00:00.000Z';
    const manager = new ProcessManager(undefined, undefined, undefined, undefined, {
      platform: 'linux',
      processStartedAt: async (pid): Promise<string> => {
        observedPid = pid;
        return hostStartedAt;
      },
    });
    const started = await manager.start({
      executable: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: process.cwd(),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    expect(started.value).not.toHaveProperty('pid');
    const identity = await manager.recoveryIdentity(started.value.processId);
    expect(identity).toEqual({
      ok: true,
      value: {
        processId: started.value.processId,
        platform: 'linux',
        pid: observedPid,
        processStartedAt: hostStartedAt,
      },
    });
    expect(observedPid).toEqual(expect.any(Number));

    await expect(manager.stop(started.value.processId)).resolves.toMatchObject({ ok: true });
  });

  it('never captures a restart identity after the managed root is already terminal', async () => {
    let probes = 0;
    const manager = new ProcessManager(undefined, undefined, undefined, undefined, {
      platform: 'linux',
      processStartedAt: async (): Promise<string> => {
        probes += 1;
        return '2026-09-21T00:00:01.000Z';
      },
    });
    const started = await manager.start({
      executable: process.execPath,
      args: ['-e', 'process.exit(0)'],
      cwd: process.cwd(),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitForState(manager, started.value.processId, 'exited');
    await expect(manager.recoveryIdentity(started.value.processId)).resolves.toMatchObject({
      ok: false,
      error: { code: 'CONFLICT', details: { reason: 'process_not_live' } },
    });
    expect(probes).toBe(0);
  });

  it('fails closed when restart identity is requested on an unsupported host platform', async () => {
    const manager = new ProcessManager(undefined, undefined, undefined, undefined, { platform: 'win32' });
    const started = await manager.start({
      executable: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: process.cwd(),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await expect(manager.recoveryIdentity(started.value.processId)).resolves.toMatchObject({
      ok: false,
      error: { code: 'CONFLICT', recoverable: true, details: { reason: 'platform_unsupported' } },
    });

    await expect(manager.stop(started.value.processId)).resolves.toMatchObject({ ok: true });
  });

  it('caps simultaneous managed processes to prevent runaway child-process growth', async () => {
    const manager = new ProcessManager(undefined, undefined, 1);
    const first = await manager.start({
      executable: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: process.cwd(),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await manager.start({
      executable: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: process.cwd(),
    });
    expect(second).toMatchObject({ ok: false, error: { code: 'CONFLICT', recoverable: true } });

    await expect(manager.stop(first.value.processId)).resolves.toMatchObject({ ok: true });
  });

  it('evicts the oldest finished record once the retained logs outgrow their budget', async () => {
    const manager = new ProcessManager();
    const live = await manager.start({
      executable: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: process.cwd(),
    });
    expect(live.ok).toBe(true);
    if (!live.ok) return;

    const writeOnce = async (bytes: number): Promise<string> => {
      const started = await manager.start({
        executable: process.execPath,
        args: ['-e', `process.stdout.write('x'.repeat(${bytes}))`],
        cwd: process.cwd(),
      });
      if (!started.ok) throw new Error(started.error.message);
      await waitForState(manager, started.value.processId, 'exited');
      return started.value.processId;
    };

    // Each finished record keeps more than half the budget, so the second one
    // pushes the first out instead of pinning both ring buffers for the runtime's life.
    const first = await writeOnce(Math.floor(MAX_RETAINED_TERMINAL_LOG_BYTES * 0.6));
    const second = await writeOnce(Math.floor(MAX_RETAINED_TERMINAL_LOG_BYTES * 0.6));

    expect(manager.status(first)).toMatchObject({ ok: false, error: { code: 'PROCESS_NOT_FOUND' } });
    expect(manager.logs(second, { tailLines: 1 }).ok).toBe(true);
    // Retention never touches a process that is still live.
    expect(manager.status(live.value.processId).ok).toBe(true);
    await expect(manager.stop(live.value.processId)).resolves.toMatchObject({ ok: true });
  }, 60_000);

  it('keeps the retained record count bounded even when every log is tiny', async () => {
    const manager = new ProcessManager();
    const processIds: string[] = [];
    for (let index = 0; index < MAX_RETAINED_TERMINAL_RECORDS + 2; index += 1) {
      const started = await manager.start({
        executable: process.execPath,
        args: ['-e', 'process.stdout.write("tiny\\n")'],
        cwd: process.cwd(),
      });
      if (!started.ok) throw new Error(started.error.message);
      await waitForState(manager, started.value.processId, 'exited');
      processIds.push(started.value.processId);
    }

    expect(manager.list()).toHaveLength(MAX_RETAINED_TERMINAL_RECORDS);
    expect(manager.status(processIds[0])).toMatchObject({ ok: false, error: { code: 'PROCESS_NOT_FOUND' } });
    expect(manager.status(processIds[processIds.length - 1]).ok).toBe(true);
  }, 120_000);

  it('evicts a record whose exit listener unsubscribed before the exit', async () => {
    const manager = new ProcessManager();
    const processIds: string[] = [];
    for (let index = 0; index < MAX_RETAINED_TERMINAL_RECORDS + 2; index += 1) {
      const started = await manager.start({
        executable: process.execPath,
        args: ['-e', 'process.stdout.write("tiny\\n")'],
        cwd: process.cwd(),
      });
      if (!started.ok) throw new Error(started.error.message);
      // The supervisor subscribes on spawn and unsubscribes when it stops the
      // worker, leaving an empty set behind. That must not pin the record.
      manager.onExit(started.value.processId, () => {})();
      await waitForState(manager, started.value.processId, 'exited');
      processIds.push(started.value.processId);
    }

    expect(manager.list()).toHaveLength(MAX_RETAINED_TERMINAL_RECORDS);
    expect(manager.status(processIds[0])).toMatchObject({ ok: false, error: { code: 'PROCESS_NOT_FOUND' } });
    expect(manager.status(processIds[processIds.length - 1]).ok).toBe(true);
  }, 120_000);
});

describe('ProcessManager stdio exposure and env', () => {
  it('hands the pipes to onCreated when the spec asks, without losing the log ring buffer', async () => {
    const manager = new ProcessManager();
    let created: import('./index.js').ManagedProcess | undefined;
    const started = await manager.start({
      executable: process.execPath,
      args: ['-e', "process.stdout.write('exposed-marker\\n')"],
      cwd: process.cwd(),
      exposeStdio: true,
    }, undefined, (handle) => { created = handle; });

    expect(started.ok).toBe(true);
    expect(created?.stdout).toBeDefined();
    expect(created?.stderr).toBeDefined();
    if (!started.ok) return;

    const seen: string[] = [];
    created?.stdout?.on('data', (chunk: Buffer) => seen.push(chunk.toString('utf8')));

    await waitForState(manager, started.value.processId, 'exited');
    const logs = manager.logs(started.value.processId, {});
    expect(logs.ok).toBe(true);
    if (!logs.ok) return;
    expect(logs.value.entries.map((entry) => entry.text)).toEqual(expect.arrayContaining([
      expect.stringContaining('exposed-marker'),
    ]));
    expect(seen.join('')).toContain('exposed-marker');

    // The returned handle is a snapshot, never a live handle.
    expect(started.value.stdout).toBeUndefined();
    const afterStatus = manager.status(started.value.processId);
    expect(afterStatus.ok).toBe(true);
    if (afterStatus.ok) expect(afterStatus.value).not.toHaveProperty('stdout');
  });

  // Documents the isolation, not a regression proof: on the pre-fix head a pause
  // taken in `onCreated` was undone by the later `'data'` attach, so this test
  // passes there too. What would prove it is a caller that pauses after the
  // listener exists, which the manager does not expose a hook for.
  it('keeps recording logs for a caller that never reads its copy', async () => {
    const manager = new ProcessManager();
    const started = await manager.start({
      executable: process.execPath,
      args: ['-e', "for (let index = 0; index < 200; index += 1) process.stdout.write(`line-${index}\\n`)"],
      cwd: process.cwd(),
      exposeStdio: true,
    }, undefined, (handle) => {
      // A real transport pauses until it reads; this copy is never read.
      handle.stdout?.pause();
    });

    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitForState(manager, started.value.processId, 'exited');
    const logs = manager.logs(started.value.processId, {});
    expect(logs.ok).toBe(true);
    if (!logs.ok) return;
    expect(logs.value.entries.map((entry) => entry.text).join('')).toContain('line-199');
  });

  it('ends a caller copy that outgrows its buffer instead of holding the whole output', async () => {
    const manager = new ProcessManager();
    const chunks = 192;
    let created: import('./index.js').ManagedProcess | undefined;
    const started = await manager.start({
      executable: process.execPath,
      // 12 MiB while the child stays alive: a consumer that never reads must not be
      // able to make the runtime hold all of it before the process ends.
      args: ['-e', `const chunk = Buffer.alloc(64 * 1024, 120); for (let index = 0; index < ${chunks}; index += 1) process.stdout.write(chunk); setInterval(() => {}, 1000);`],
      cwd: process.cwd(),
      exposeStdio: true,
    }, undefined, (handle) => {
      created = handle;
      handle.stdout?.pause();
    });

    expect(started.ok).toBe(true);
    if (!started.ok) return;

    try {
      const copy = created?.stdout;
      expect(copy).toBeDefined();
      // The copy ends on its own, so a stalled consumer sees EOF instead of silence.
      for (let attempt = 0; attempt < 500 && copy?.writableEnded !== true; attempt += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      expect(copy?.writableEnded).toBe(true);
      const buffered = (copy?.readableLength ?? 0) + (copy?.writableLength ?? 0);
      expect(buffered).toBeLessThanOrEqual(MAX_TEE_BUFFER_BYTES + 64 * 1024);
      // `endTee` also ends the copy when the child exits, so a bare `writableEnded`
      // would pass for a child that died on its own. The child had a live interval
      // and the cap is what stopped it: the record must read `stopped`, not `exited`.
      let terminalState: string | undefined;
      for (let attempt = 0; attempt < 500; attempt += 1) {
        const status = manager.status(started.value.processId);
        terminalState = status.ok ? status.value.state : undefined;
        if (terminalState === 'stopped') break;
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      expect(terminalState).toBe('stopped');
      // The diagnostics ring is unaffected by the copy ending.
      expect(manager.logs(started.value.processId, { tailLines: 1 }).ok).toBe(true);
    } finally {
      await manager.stop(started.value.processId);
    }
  }, 30_000);

  it('holds one buffered ceiling across both caller copies, not one per stream', async () => {
    const manager = new ProcessManager();
    const chunksPerStream = 96;
    let created: import('./index.js').ManagedProcess | undefined;
    const started = await manager.start({
      executable: process.execPath,
      // 6 MiB on each stream: under the per-stream cap, over it together, with
      // neither consumer reading.
      args: ['-e', `const out = Buffer.alloc(64 * 1024, 120); const err = Buffer.alloc(64 * 1024, 101); for (let index = 0; index < ${chunksPerStream}; index += 1) { process.stdout.write(out); process.stderr.write(err); } setInterval(() => {}, 1000);`],
      cwd: process.cwd(),
      exposeStdio: true,
    }, undefined, (handle) => {
      created = handle;
      handle.stdout?.pause();
      handle.stderr?.pause();
    });

    expect(started.ok).toBe(true);
    if (!started.ok) return;

    try {
      const stdout = created?.stdout;
      const stderr = created?.stderr;
      expect(stdout).toBeDefined();
      expect(stderr).toBeDefined();
      for (let attempt = 0; attempt < 500 && (stdout?.writableEnded !== true || stderr?.writableEnded !== true); attempt += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      // Both copies end: a per-stream cap would end neither, since each is only
      // 6 MiB, and the child would stay alive holding 12 MiB of buffered output.
      expect(stdout?.writableEnded).toBe(true);
      expect(stderr?.writableEnded).toBe(true);
      const buffered = (stdout?.readableLength ?? 0) + (stdout?.writableLength ?? 0)
        + (stderr?.readableLength ?? 0) + (stderr?.writableLength ?? 0);
      expect(buffered).toBeLessThanOrEqual(MAX_TEE_BUFFER_BYTES + 64 * 1024);
      let terminalState: string | undefined;
      for (let attempt = 0; attempt < 500; attempt += 1) {
        const status = manager.status(started.value.processId);
        terminalState = status.ok ? status.value.state : undefined;
        if (terminalState === 'stopped') break;
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      expect(terminalState).toBe('stopped');
    } finally {
      await manager.stop(started.value.processId);
    }
  }, 30_000);

  it('carries no streams when the spec does not ask for them', async () => {
    const manager = new ProcessManager();
    let created: import('./index.js').ManagedProcess | undefined;
    const started = await manager.start({
      executable: process.execPath,
      args: ['-e', "process.stdout.write('quiet-marker\\n')"],
      cwd: process.cwd(),
    }, undefined, (handle) => { created = handle; });

    expect(started.ok).toBe(true);
    expect(created?.stdout).toBeUndefined();
    expect(created?.stdin).toBeUndefined();
    if (!started.ok) return;

    await waitForState(manager, started.value.processId, 'exited');
    const logs = manager.logs(started.value.processId, {});
    expect(logs.ok).toBe(true);
    if (!logs.ok) return;
    expect(logs.value.entries.map((entry) => entry.text)).toEqual(expect.arrayContaining([
      expect.stringContaining('quiet-marker'),
    ]));
  });

  it('adds a caller env on top of the sanitized base instead of replacing it', async () => {
    const manager = new ProcessManager();
    const probe = "process.stdout.write(JSON.stringify({named:process.env.THAI_RAG_TEST_KEY??null,stripped:process.env.AWS_SECRET_ACCESS_KEY??null}))";

    const previous = process.env.AWS_SECRET_ACCESS_KEY;
    process.env.AWS_SECRET_ACCESS_KEY = 'ambient-secret';
    try {
      const withEnv = await manager.start({
        executable: process.execPath,
        args: ['-e', probe],
        cwd: process.cwd(),
        env: { THAI_RAG_TEST_KEY: 'caller-value' },
      });
      const withoutEnv = await manager.start({
        executable: process.execPath,
        args: ['-e', probe],
        cwd: process.cwd(),
      });

      expect(withEnv.ok).toBe(true);
      expect(withoutEnv.ok).toBe(true);
      if (!withEnv.ok || !withoutEnv.ok) return;

      await waitForState(manager, withEnv.value.processId, 'exited');
      await waitForState(manager, withoutEnv.value.processId, 'exited');
      const read = (processId: string): string => {
        const logs = manager.logs(processId, {});
        if (!logs.ok) throw new Error('logs unavailable');
        return logs.value.entries.map((entry) => entry.text).join('');
      };

      expect(JSON.parse(read(withEnv.value.processId))).toEqual({ named: 'caller-value', stripped: null });
      expect(JSON.parse(read(withoutEnv.value.processId))).toEqual({ named: null, stripped: null });
    } finally {
      if (previous === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
      else process.env.AWS_SECRET_ACCESS_KEY = previous;
    }
  });

  it('refuses a malformed env or exposeStdio value', async () => {
    const manager = new ProcessManager();
    await expect(manager.start({
      executable: process.execPath,
      args: ['-e', ''],
      cwd: process.cwd(),
      env: { '': 'value' },
    })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    await expect(manager.start({
      executable: process.execPath,
      args: ['-e', ''],
      cwd: process.cwd(),
      env: { 'WITH=EQUALS': 'value' },
    })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    // A Map has no enumerable own entries, so it would silently spawn with no
    // caller env at all instead of failing the contract.
    await expect(manager.start({
      executable: process.execPath,
      args: ['-e', ''],
      cwd: process.cwd(),
      env: new Map([['THAI_RAG_TEST_KEY', 'value']]) as unknown as Record<string, string>,
    })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    // A NUL survives `spawn`'s own checks only by throwing synchronously, so the
    // contract must answer INVALID_INPUT instead of rejecting the promise.
    await expect(manager.start({
      executable: process.execPath,
      args: ['-e', ''],
      cwd: process.cwd(),
      env: { THAI_RAG_TEST_KEY: 'a\0b' },
    })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    await expect(manager.start({
      executable: process.execPath,
      args: ['-e', ''],
      cwd: process.cwd(),
      exposeStdio: 'yes' as unknown as boolean,
    })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });
});

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
