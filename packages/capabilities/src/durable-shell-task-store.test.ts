import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ShellCapabilityBackend } from './shell-backend.js';
import { DurableShellTaskStore, DURABLE_WORKER_SOURCE, parsePosixProcessProbe, parseWindowsProcessProbe } from './durable-shell-task-store.js';
import { CAPABILITY_TASK_OWNER_METADATA_KEY } from './task-ownership.js';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
    maxRetries: process.platform === 'win32' ? 5 : 0,
    retryDelay: 100,
  })));
});

describe('durable shell background tasks', () => {
  it('treats an exited POSIX zombie as terminated without trusting a reused live PID', () => {
    expect(parsePosixProcessProbe('Wed Sep  9 14:58:14 2026 Z+')).toEqual({ state: 'gone' });
    expect(parsePosixProcessProbe('Wed Sep  9 14:58:14 2026 Ssl')).toMatchObject({
      state: 'live',
      processStartedAt: expect.any(String),
    });
    expect(parsePosixProcessProbe('not-a-valid-ps-row')).toEqual({ state: 'unverifiable', reason: 'invalid_probe_response' });
  });

  it('reads a Windows identity probe, and a missing process as gone', () => {
    // The script answers `missing` inside PowerShell so a gone process keeps exit 0;
    // a non-zero exit is a real probe failure and must not be read as a stop.
    expect(parseWindowsProcessProbe('missing')).toEqual({ state: 'gone' });
    expect(parseWindowsProcessProbe('2026-11-22T00:00:00.1234567Z')).toEqual({
      state: 'live',
      processStartedAt: '2026-11-22T00:00:00.123Z',
    });
    expect(parseWindowsProcessProbe('not-a-time')).toEqual({ state: 'unverifiable', reason: 'invalid_start_time' });
    expect(parseWindowsProcessProbe('   ')).toEqual({ state: 'unverifiable', reason: 'invalid_probe_response' });
  });

  it.each([
    ['completed', { state: 'completed' as const, exitCode: 0 }, { state: 'completed', exit_code: 0 }],
    ['failed', { state: 'failed' as const, exitCode: 70, error: 'promotion rolled back' }, { state: 'failed', exit_code: 70, error: 'promotion rolled back' }],
    ['running', { state: 'running' as const }, { state: 'running' }],
  ])('reconciles a lost durable worker from an external receipt: %s', async (_label, external, expected) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-durable-external-'));
    temporaryRoots.push(root);
    const taskId = 'promotion-task';
    const taskDir = path.join(root, taskId);
    await mkdir(taskDir, { recursive: true });
    const now = new Date();
    await writeFile(path.join(taskDir, 'task.json'), JSON.stringify({
      version: 1,
      task_id: taskId,
      state: 'running',
      started_at: new Date(now.getTime() - 1_000).toISOString(),
      include_stdout: true,
      include_stderr: true,
      max_output_bytes: 1024,
      deadline_at: new Date(now.getTime() + 60_000).toISOString(),
      external_reconciliation: { kind: 'fixture', key: 'receipt-1' },
    }), 'utf8');
    const reconciler = vi.fn(async () => external);
    const store = new DurableShellTaskStore(root, { externalReconciler: reconciler });

    const snapshot = await store.snapshot(taskId);

    expect(snapshot).toMatchObject({ ok: true, value: expected });
    expect(reconciler).toHaveBeenCalledWith({ kind: 'fixture', key: 'receipt-1' });
  });

  it('restores a prior termination-unverified snapshot to running while the external receipt is still active', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-durable-external-'));
    temporaryRoots.push(root);
    const taskId = 'running-external-task';
    const taskDir = path.join(root, taskId);
    await mkdir(taskDir, { recursive: true });
    const now = new Date();
    await writeFile(path.join(taskDir, 'task.json'), JSON.stringify({
      version: 1,
      task_id: taskId,
      state: 'termination_unverified',
      error: 'Durable task worker exited while its child process is still running',
      started_at: new Date(now.getTime() - 1_000).toISOString(),
      include_stdout: true,
      include_stderr: true,
      max_output_bytes: 1024,
      deadline_at: new Date(now.getTime() + 60_000).toISOString(),
      external_reconciliation: { kind: 'fixture', key: 'still-running' },
    }), 'utf8');
    const store = new DurableShellTaskStore(root, {
      externalReconciler: async (): Promise<{ state: 'running' }> => ({ state: 'running' }),
    });

    await expect(store.snapshot(taskId)).resolves.toMatchObject({
      ok: true,
      value: { state: 'running' },
    });
  });

  it('surfaces an elapsed task deadline as termination-unverified while external work is still running', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-durable-external-'));
    temporaryRoots.push(root);
    const taskId = 'expired-external-task';
    const taskDir = path.join(root, taskId);
    await mkdir(taskDir, { recursive: true });
    const now = new Date();
    await writeFile(path.join(taskDir, 'task.json'), JSON.stringify({
      version: 1,
      task_id: taskId,
      state: 'running',
      started_at: new Date(now.getTime() - 120_000).toISOString(),
      include_stdout: true,
      include_stderr: true,
      max_output_bytes: 1024,
      deadline_at: new Date(now.getTime() - 60_000).toISOString(),
      external_reconciliation: { kind: 'fixture', key: 'still-running-after-deadline' },
    }), 'utf8');
    let externalState: 'running' | 'completed' = 'running';
    const store = new DurableShellTaskStore(root, {
      externalReconciler: async (): Promise<{ state: 'running' } | { state: 'completed'; exitCode: number }> => externalState === 'running'
        ? { state: 'running' }
        : { state: 'completed', exitCode: 0 },
    });

    await expect(store.snapshot(taskId)).resolves.toMatchObject({
      ok: true,
      value: {
        state: 'termination_unverified',
        error: 'Durable task deadline elapsed while externally reconciled work is still running',
      },
    });
    await expect(store.snapshot(taskId)).resolves.toMatchObject({
      ok: true,
      value: {
        state: 'termination_unverified',
        error: 'Durable task deadline elapsed while externally reconciled work is still running',
      },
    });
    externalState = 'completed';
    await expect(store.snapshot(taskId)).resolves.toMatchObject({
      ok: true,
      value: {
        state: 'completed',
        exit_code: 0,
      },
    });
  });

  it('falls back to the historical worker-lost failure when the external receipt cannot be resolved', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-durable-external-'));
    temporaryRoots.push(root);
    const taskId = 'unresolved-task';
    const taskDir = path.join(root, taskId);
    await mkdir(taskDir, { recursive: true });
    const now = new Date();
    await writeFile(path.join(taskDir, 'task.json'), JSON.stringify({
      version: 1,
      task_id: taskId,
      state: 'running',
      started_at: new Date(now.getTime() - 1_000).toISOString(),
      include_stdout: true,
      include_stderr: true,
      max_output_bytes: 1024,
      deadline_at: new Date(now.getTime() + 60_000).toISOString(),
      external_reconciliation: { kind: 'fixture', key: 'missing' },
    }), 'utf8');
    const store = new DurableShellTaskStore(root, { externalReconciler: async (): Promise<undefined> => undefined });

    await expect(store.snapshot(taskId)).resolves.toMatchObject({
      ok: true,
      value: {
        state: 'failed',
        exit_code: -1,
        error: 'Durable task worker exited before recording a final state',
      },
    });
  });

  it.skipIf(process.platform === 'win32')('cancels the detached child group before retiring its durable worker', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-durable-groups-'));
    temporaryRoots.push(root);
    const backend = new ShellCapabilityBackend({ allowedRoots: [root], taskStateDirectory: path.join(root, '.tasks') });
    const started = await backend.execute({
      operation: 'run', executable: process.execPath, arguments: ['-e', 'setTimeout(() => {}, 30000)'],
      cwd: root, execution: 'background', timeout_seconds: 40, userConfirmed: true,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const taskId = String((started.value as Record<string, unknown>).task_id);
    let childPid: number | undefined;
    let childStartedAt: string | undefined;
    try {
      await expect.poll(async () => {
        const status = await backend.execute({ operation: 'status', task_id: taskId });
        if (status.ok) {
          const value = status.value as Record<string, unknown>;
          if (typeof value.child_pid === 'number' && typeof value.child_started_at === 'string') {
            childPid = value.child_pid;
            childStartedAt = value.child_started_at;
            return true;
          }
        }
        return false;
      }, { timeout: 5000 }).toBe(true);
      const cancelled = await backend.execute({ operation: 'cancel', task_id: taskId, userConfirmed: true });
      expect(cancelled).toMatchObject({ ok: true, value: { state: 'cancelled' } });
      expect(() => process.kill(childPid!, 0)).toThrow();
    } finally {
      // Red-phase cleanup is restricted to the exact fixture child identity.
      if (childPid !== undefined && childStartedAt !== undefined) {
        const probe = await promisify(execFile)('ps', ['-p', String(childPid), '-o', 'lstart=']).catch(() => null);
        if (probe && new Date(probe.stdout.trim()).toISOString() === childStartedAt) process.kill(-childPid, 'SIGKILL');
      }
    }
  }, 15000);

  it.skipIf(process.platform === 'win32')('sanitizes the durable task temp environment before IPC child startup', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-durable-env-'));
    temporaryRoots.push(root);
    const backend = new ShellCapabilityBackend({
      allowedRoots: [root],
      taskStateDirectory: path.join(root, '.tasks'),
    });
    const previousTmpdir = process.env.TMPDIR;
    const poisonedTmpdir = path.join(root, 'missing-parent', 'poisoned-tmp');
    const script = [
      "const { spawn } = require('node:child_process');",
      "const { accessSync } = require('node:fs');",
      "const os = require('node:os');",
      "accessSync(os.tmpdir());",
      "const child = spawn(process.execPath, ['-e', \"process.send?.('ipc-ready', () => process.exit(0));\"],",
      "{ stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });",
      "let ready = false;",
      "child.on('message', (message) => { if (message === 'ipc-ready') ready = true; });",
      "child.on('exit', (code) => {",
      "if (ready && code === 0) process.stdout.write('ipc-ready', () => process.exit(0));",
      "else process.exit(2);",
      "});",
    ].join('');

    process.env.TMPDIR = poisonedTmpdir;
    try {
      const foreground = await backend.execute({
        operation: 'run',
        executable: process.execPath,
        arguments: ['-e', script],
        cwd: root,
        execution: 'foreground',
        timeout_seconds: 10,
        userConfirmed: true,
      });
      expect(foreground).toMatchObject({
        ok: true,
        value: { state: 'completed', exit_code: 0, stdout: 'ipc-ready' },
      });

      const started = await backend.execute({
        operation: 'run',
        executable: process.execPath,
        arguments: ['-e', script],
        cwd: root,
        execution: 'background',
        timeout_seconds: 10,
        userConfirmed: true,
      });
      expect(started).toMatchObject({ ok: true, value: { task_id: expect.any(String), durable: true } });
      if (!started.ok) return;
      const taskId = String((started.value as Record<string, unknown>).task_id);
      const durable = await backend.execute({ operation: 'wait', task_id: taskId, timeout_seconds: 5 });
      expect(durable).toMatchObject({
        ok: true,
        value: { state: 'completed', exit_code: 0, stdout: 'ipc-ready', durable: true },
      });
    } finally {
      if (previousTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmpdir;
    }
  }, 20_000);

  it('survives a backend/runtime replacement and returns logs and result by task id', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-durable-shell-'));
    temporaryRoots.push(root);
    const taskStateDirectory = path.join(root, '.tasks');
    const firstRuntime = new ShellCapabilityBackend({ allowedRoots: [root], taskStateDirectory });

    const canonicalRoot = await realpath(root);
    const started = await firstRuntime.execute({
      operation: 'run',
      executable: process.execPath,
      arguments: ['-e', "setTimeout(() => process.stdout.write('durable-done'), 300)"],
      cwd: root,
      execution: 'background',
      timeout_seconds: 30,
      userConfirmed: true,
      metadata: {
        [CAPABILITY_TASK_OWNER_METADATA_KEY]: {
          clientId: 'client-a',
          sessionId: 'session-a',
          workspaceId: 'workspace-a',
        },
      },
    });

    expect(started).toMatchObject({
      ok: true,
      value: { task_id: expect.any(String), durable: true, workspace_id: 'workspace-a', cwd: canonicalRoot },
    });
    if (!started.ok) return;
    const taskId = String((started.value as Record<string, unknown>).task_id);

    const replacementRuntime = new ShellCapabilityBackend({ allowedRoots: [root], taskStateDirectory });
    const waited = await replacementRuntime.execute({
      operation: 'wait',
      task_id: taskId,
      timeout_seconds: 5,
      metadata: {
        [CAPABILITY_TASK_OWNER_METADATA_KEY]: {
          clientId: 'client-a',
          sessionId: 'replacement-session',
          workspaceId: 'workspace-a',
        },
      },
    });
    expect(waited).toMatchObject({
      ok: true,
      value: {
        task_id: taskId,
        state: 'completed',
        exit_code: 0,
        stdout: 'durable-done',
        durable: true,
        workspace_id: 'workspace-a',
        cwd: canonicalRoot,
      },
    });
    await expect(replacementRuntime.execute({
      operation: 'list',
      metadata: {
        [CAPABILITY_TASK_OWNER_METADATA_KEY]: {
          clientId: 'client-a',
          sessionId: 'replacement-session',
          workspaceId: 'workspace-a',
        },
      },
    })).resolves.toMatchObject({
      ok: true,
      value: {
        tasks: expect.arrayContaining([
          expect.objectContaining({
            task_id: taskId,
            state: 'completed',
            durable: true,
            workspace_id: 'workspace-a',
            cwd: canonicalRoot,
          }),
        ]),
      },
    });

    await expect(replacementRuntime.execute({
      operation: 'status',
      task_id: taskId,
      metadata: {
        [CAPABILITY_TASK_OWNER_METADATA_KEY]: {
          clientId: 'client-b',
          sessionId: 'session-b',
          workspaceId: 'workspace-b',
        },
      },
    })).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
  });

  it('does not overwrite a very fast durable completion back to running', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-durable-shell-'));
    temporaryRoots.push(root);
    const backend = new ShellCapabilityBackend({
      allowedRoots: [root],
      taskStateDirectory: path.join(root, '.tasks'),
      autoWaitSeconds: 1,
    });

    const result = await backend.execute({
      operation: 'run',
      executable: process.execPath,
      arguments: ['-e', "process.stdout.write('fast')"],
      cwd: root,
      execution: 'auto',
      timeout_seconds: 30,
      userConfirmed: true,
    });

    expect(result).toMatchObject({ ok: true, value: { task_id: expect.any(String), durable: true } });
    if (!result.ok) return;
    const taskId = String((result.value as Record<string, unknown>).task_id);
    const terminal = (result.value as Record<string, unknown>).state === 'running'
      ? await backend.execute({ operation: 'wait', task_id: taskId, timeout_seconds: 5 })
      : result;
    expect(terminal).toMatchObject({ ok: true, value: { state: 'completed', exit_code: 0, stdout: 'fast', durable: true } });
    if (!terminal.ok) return;
    const workerPid = Number((terminal.value as Record<string, unknown>).worker_pid);
    expect(Number.isInteger(workerPid)).toBe(true);
    await expect.poll(() => {
      try {
        process.kill(workerPid, 0);
        return true;
      } catch {
        return false;
      }
    }, { timeout: 2000, interval: 50 }).toBe(false);

    await expect(backend.execute({ operation: 'status', task_id: taskId })).resolves.toMatchObject({
      ok: true,
      value: { state: 'completed', exit_code: 0, stdout: 'fast', durable: true },
    });
  });

  it('finalizes when the command exits even if a detached descendant keeps inherited stdio open', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-durable-shell-'));
    temporaryRoots.push(root);
    const backend = new ShellCapabilityBackend({
      allowedRoots: [root],
      taskStateDirectory: path.join(root, '.tasks'),
    });
    const script = [
      "const { spawn } = require('node:child_process');",
      "const os = require('node:os');",
      "const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {",
      "cwd: os.tmpdir(), detached: true, stdio: ['ignore', process.stdout, process.stderr] });",
      "grandchild.unref();",
      "process.stdout.write('parent-done');",
    ].join('');

    const started = await backend.execute({
      operation: 'run',
      executable: process.execPath,
      arguments: ['-e', script],
      cwd: root,
      execution: 'background',
      timeout_seconds: 30,
      userConfirmed: true,
    });
    expect(started).toMatchObject({ ok: true, value: { task_id: expect.any(String), durable: true } });
    if (!started.ok) return;
    const taskId = String((started.value as Record<string, unknown>).task_id);

    try {
      const terminal = await backend.execute({ operation: 'wait', task_id: taskId, timeout_seconds: 5 });
      expect(terminal).toMatchObject({
        ok: true,
        value: { state: 'completed', exit_code: 0, stdout: 'parent-done', durable: true },
      });
    } finally {
      const current = await backend.execute({ operation: 'status', task_id: taskId });
      if (current.ok && (current.value as Record<string, unknown>).state === 'running') {
        await backend.execute({ operation: 'wait', task_id: taskId, timeout_seconds: 5 });
      }
    }
  }, 20000);

  it('cancels a durable task from a replacement backend', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-durable-shell-'));
    temporaryRoots.push(root);
    const taskStateDirectory = path.join(root, '.tasks');
    const firstRuntime = new ShellCapabilityBackend({ allowedRoots: [root], taskStateDirectory });
    const started = await firstRuntime.execute({
      operation: 'run',
      executable: process.execPath,
      arguments: ['-e', 'setTimeout(() => {}, 10000)'],
      cwd: root,
      execution: 'background',
      timeout_seconds: 30,
      userConfirmed: true,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const taskId = String((started.value as Record<string, unknown>).task_id);

    const replacementRuntime = new ShellCapabilityBackend({ allowedRoots: [root], taskStateDirectory });
    await waitUntil(async () => {
      const status = await replacementRuntime.execute({ operation: 'status', task_id: taskId });
      return status.ok && typeof (status.value as Record<string, unknown>).worker_pid === 'number';
    }, 1500);
    const cancelled = await replacementRuntime.execute({ operation: 'cancel', task_id: taskId, userConfirmed: true });

    expect(cancelled).toMatchObject({ ok: true, value: { task_id: taskId, state: 'cancelled', durable: true } });
  });

  it('keeps a durable auto task running when the original MCP caller aborts after submission', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-durable-shell-'));
    temporaryRoots.push(root);
    const taskStateDirectory = path.join(root, '.tasks');
    const backend = new ShellCapabilityBackend({
      allowedRoots: [root],
      taskStateDirectory,
      autoWaitSeconds: 0.3,
      maxSynchronousWaitSeconds: 0.3,
    });
    const controller = new AbortController();
    const running = backend.execute({
      operation: 'run',
      executable: process.execPath,
      arguments: ['-e', "setTimeout(() => process.stdout.write('after-abort'), 600)"],
      cwd: root,
      execution: 'auto',
      timeout_seconds: 30,
      userConfirmed: true,
    }, controller.signal);
    setTimeout(() => controller.abort(), 100);

    const submitted = await running;
    expect(submitted).toMatchObject({ ok: true, value: { state: 'running', task_id: expect.any(String), durable: true } });
    if (!submitted.ok) return;
    const taskId = String((submitted.value as Record<string, unknown>).task_id);

    const replacementRuntime = new ShellCapabilityBackend({ allowedRoots: [root], taskStateDirectory });
    const finished = await replacementRuntime.execute({ operation: 'wait', task_id: taskId, timeout_seconds: 5 });
    expect(finished).toMatchObject({ ok: true, value: { state: 'completed', exit_code: 0, stdout: 'after-abort', durable: true } });
  });

  it('caps concurrent durable workers so many chats cannot exhaust a Windows 10/11 machine with child consoles', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-durable-shell-cap-'));
    temporaryRoots.push(root);
    const taskStateDirectory = path.join(root, '.tasks');
    const store = new DurableShellTaskStore(taskStateDirectory, { maxConcurrentTasks: 1 });
    const owner = { clientId: 'chatgpt', sessionId: 'session-a', workspaceId: 'workspace-a' };
    const common = {
      executable: process.execPath,
      arguments: ['-e', 'setTimeout(() => {}, 10000)'],
      cwd: root,
      environment: process.env,
      timeoutSeconds: 30,
      maxOutputBytes: 1024,
      includeStdout: true,
      includeStderr: true,
      owner,
    } as const;

    const first = await store.launch({ taskId: 'task-one', ...common });
    expect(first).toMatchObject({ ok: true, value: { task_id: 'task-one', state: 'running' } });

    try {
      const second = await store.launch({ taskId: 'task-two', ...common });
      expect(second).toMatchObject({
        ok: false,
        error: {
          code: 'CONFLICT',
          recoverable: true,
        },
      });
    } finally {
      if (first.ok) await store.cancel('task-one', owner);
    }
  }, 15_000);
});

describe('durable shell task parking (#145)', () => {
  it('reserves a waiting task without spawning, then starts it on admission', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-durable-park-'));
    temporaryRoots.push(root);
    const store = new DurableShellTaskStore(path.join(root, '.tasks'));
    const owner = { clientId: 'client-a', sessionId: 'session-a', workspaceId: 'workspace-a' };
    const request = {
      taskId: 'waiting-one',
      executable: process.execPath,
      arguments: ['-e', ''],
      cwd: root,
      timeoutSeconds: 30,
      maxOutputBytes: 1024,
      includeStdout: true,
      includeStderr: true,
      owner,
      admissionClass: 'verification_heavy',
      admissionCost: 8,
    } as const;

    const reserved = await store.reserve(request);
    expect(reserved).toMatchObject({
      ok: true,
      value: {
        task_id: 'waiting-one',
        state: 'waiting_resource',
        durable: true,
        admission_class: 'verification_heavy',
        admission_cost: 8,
      },
    });
    expect(reserved.ok && (reserved.value as Record<string, unknown>).deadline_at).toBeUndefined();
    expect(await store.list(owner)).toMatchObject([{ task_id: 'waiting-one', state: 'waiting_resource' }]);

    const started = await store.startReserved('waiting-one', process.env);
    expect(started).toMatchObject({ ok: true, value: { state: 'running', deadline_at: expect.any(String) } });

    const waited = await store.wait('waiting-one', 5, undefined, owner);
    expect(waited).toMatchObject({ ok: true, value: { state: 'completed', exit_code: 0 } });
  });

  it('stops the child a failed start already forked', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-durable-orphan-'));
    temporaryRoots.push(root);
    const tasksRoot = path.join(root, '.tasks');
    const store = new DurableShellTaskStore(tasksRoot);
    const marker = path.join(root, 'child-survived.txt');
    const owner = { clientId: 'client-a', sessionId: 'session-a', workspaceId: 'workspace-a' };
    await store.reserve({
      taskId: 'orphan-check',
      executable: process.execPath,
      // The worker forks this command into its own detached group, so the marker
      // is written only if that child outlived the failed start — the worker is
      // not what leaks here.
      arguments: ['-e', `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'alive'), 800)`],
      cwd: root,
      timeoutSeconds: 30,
      maxOutputBytes: 1024,
      includeStdout: true,
      includeStderr: true,
      owner,
    });
    // A directory where the launcher publishes the worker pid makes that write fail
    // after the worker was spawned, which is the leak this pins.
    await mkdir(path.join(tasksRoot, 'orphan-check', 'worker.pid'), { recursive: true });

    const started = await store.startReserved('orphan-check', process.env);

    expect(started).toMatchObject({ ok: false });
    expect(await store.snapshot('orphan-check')).toMatchObject({ ok: true, value: { state: 'failed' } });
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(existsSync(marker)).toBe(false);
  });

  it('stops the worker when a failed start never published its child', async () => {
    if (process.platform === 'win32') return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-durable-no-child-'));
    temporaryRoots.push(root);
    const tasksRoot = path.join(root, '.tasks');
    const store = new DurableShellTaskStore(tasksRoot);
    const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' });
    sleeper.unref();
    const startedAt = await readProcessStartedAt(sleeper.pid);
    try {
      const taskDirectory = path.join(tasksRoot, 'no-child-published');
      await mkdir(taskDirectory, { recursive: true });
      // A settled record with no `child_pid` is the shape the wait gives up on: the
      // worker cannot fork after a terminal write, so there is no child to read.
      await writeFile(path.join(taskDirectory, 'task.json'), JSON.stringify({
        version: 1,
        task_id: 'no-child-published',
        state: 'failed',
      }), 'utf8');

      const stopped = await stopFailedStartOf(store)(sleeper.pid, taskDirectory);

      expect(stopped).toBe(true);
      expect(isProcessAlive(sleeper.pid)).toBe(false);
    } finally {
      await killFixture(sleeper.pid, startedAt);
    }
  });

  it('reports a failed start stopped when taskkill walks the worker tree', async () => {
    if (process.platform === 'win32') return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-durable-win32-stop-'));
    temporaryRoots.push(root);
    const tasksRoot = path.join(root, '.tasks');
    // The platform is what this pins: the Windows branch kills through `taskkill` and
    // trusts its exit status, so the fake stands in for the only part Linux lacks.
    const store = new DurableShellTaskStore(tasksRoot, { platform: 'win32' });
    const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' });
    sleeper.unref();
    const sleeperExited = new Promise<void>((resolve) => sleeper.once('exit', () => resolve()));
    const startedAt = await readProcessStartedAt(sleeper.pid);
    const fakeBin = path.join(root, 'bin');
    await mkdir(fakeBin, { recursive: true });
    // Recording the pid pins which tree `taskkill` was handed. It does not by itself
    // prove this branch ran — a win32 store also reaches `taskkill` through
    // `stopProcessTree` — so the fallback test below is the one that discriminates.
    const taskkillLog = path.join(root, 'taskkill.log');
    await writeFile(
      path.join(fakeBin, 'taskkill'),
      `#!/bin/sh\necho "$2" >> ${JSON.stringify(taskkillLog)}\nkill -9 "$2" 2>/dev/null\nexit 0\n`,
      { mode: 0o755 },
    );
    const realPath = process.env.PATH;
    process.env.PATH = `${fakeBin}${path.delimiter}${realPath ?? ''}`;
    try {
      const stopped = await stopFailedStartOf(store)(sleeper.pid, path.join(tasksRoot, 'win32-stop'));

      expect(stopped).toBe(true);
      expect((await readFile(taskkillLog, 'utf8')).trim()).toBe(String(sleeper.pid));
      // A zombie keeps answering `kill(pid, 0)`, so the exit event is the proof here.
      await sleeperExited;
      expect(isProcessAlive(sleeper.pid)).toBe(false);
    } finally {
      process.env.PATH = realPath;
      await killFixture(sleeper.pid, startedAt);
    }
  });

  it('does not claim a failed start stopped when taskkill fails and the worker lives', async () => {
    if (process.platform === 'win32') return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-durable-win32-unproven-'));
    temporaryRoots.push(root);
    const tasksRoot = path.join(root, '.tasks');
    const store = new DurableShellTaskStore(tasksRoot, { platform: 'win32' });
    const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' });
    sleeper.unref();
    const startedAt = await readProcessStartedAt(sleeper.pid);
    const fakeBin = path.join(root, 'bin');
    await mkdir(fakeBin, { recursive: true });
    const taskkillLog = path.join(root, 'taskkill.log');
    await writeFile(path.join(fakeBin, 'taskkill'), `#!/bin/sh\necho "$2" >> ${JSON.stringify(taskkillLog)}\nexit 1\n`, { mode: 0o755 });
    const realPath = process.env.PATH;
    process.env.PATH = `${fakeBin}${path.delimiter}${realPath ?? ''}`;
    try {
      const stopped = await stopFailedStartOf(store)(sleeper.pid, path.join(tasksRoot, 'win32-unproven'));

      // The worker is still there, so the failed start must not read as a clean stop.
      expect((await readFile(taskkillLog, 'utf8')).trim()).toBe(String(sleeper.pid));
      expect(stopped).toBe(false);
      expect(isProcessAlive(sleeper.pid)).toBe(true);
    } finally {
      process.env.PATH = realPath;
      await killFixture(sleeper.pid, startedAt);
    }
  });

  it('kills the published child after taskkill fails on a worker that is already gone', async () => {
    if (process.platform === 'win32') return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-durable-win32-child-'));
    temporaryRoots.push(root);
    const tasksRoot = path.join(root, '.tasks');
    const store = new DurableShellTaskStore(tasksRoot, { platform: 'win32' });
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' });
    child.unref();
    const childExited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    const childStartedAt = await readProcessStartedAt(child.pid);
    const exited = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    const workerPid = await new Promise<number>((resolve) => exited.once('exit', () => resolve(exited.pid as number)));
    const fakeBin = path.join(root, 'bin');
    await mkdir(fakeBin, { recursive: true });
    const taskkillLog = path.join(root, 'taskkill.log');
    // Only the child's tree is killable here: the worker pid is dead, which is what
    // sends the fallback to the `task.json` the worker published before it died. The
    // log pins that the fallback walked both trees instead of signalling them itself.
    await writeFile(
      path.join(fakeBin, 'taskkill'),
      `#!/bin/sh\necho "$2" >> ${JSON.stringify(taskkillLog)}\n`
        + `if [ "$2" = "${String(child.pid)}" ]; then kill -9 "$2" 2>/dev/null; exit 0; fi\nexit 1\n`,
      { mode: 0o755 },
    );
    const realPath = process.env.PATH;
    process.env.PATH = `${fakeBin}${path.delimiter}${realPath ?? ''}`;
    try {
      const taskDirectory = path.join(tasksRoot, 'win32-child');
      await mkdir(taskDirectory, { recursive: true });
      await writeFile(path.join(taskDirectory, 'task.json'), JSON.stringify({
        version: 1,
        task_id: 'win32-child',
        state: 'running',
        child_pid: child.pid,
      }), 'utf8');

      const stopped = await stopFailedStartOf(store)(workerPid, taskDirectory);

      expect(stopped).toBe(true);
      expect((await readFile(taskkillLog, 'utf8')).trim().split('\n')).toEqual([String(workerPid), String(child.pid)]);
      // The fake kills the child but never reaps it, so its exit event is the proof.
      await childExited;
      expect(isProcessAlive(child.pid)).toBe(false);
    } finally {
      process.env.PATH = realPath;
      await killFixture(child.pid, childStartedAt);
    }
  });

  it('stops a Windows task whose recorded identity is the live process, through taskkill', async () => {
    if (process.platform === 'win32') return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-durable-win32-match-'));
    temporaryRoots.push(root);
    const tasksRoot = path.join(root, '.tasks');
    const store = new DurableShellTaskStore(tasksRoot, { platform: 'win32' });
    const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' });
    sleeper.unref();
    const sleeperExited = new Promise<void>((resolve) => sleeper.once('exit', () => resolve()));
    const startedAt = await readProcessStartedAt(sleeper.pid);
    const identity = '2026-11-22T00:00:00.000Z';
    const fakeBin = path.join(root, 'bin');
    await mkdir(fakeBin, { recursive: true });
    await writeFile(path.join(fakeBin, 'powershell'), `#!/bin/sh\necho "${identity}"\n`, { mode: 0o755 });
    const taskkillLog = path.join(root, 'taskkill.log');
    await writeFile(
      path.join(fakeBin, 'taskkill'),
      `#!/bin/sh\necho "$2" >> ${JSON.stringify(taskkillLog)}\nkill -9 "$2" 2>/dev/null\nexit 0\n`,
      { mode: 0o755 },
    );
    const realPath = process.env.PATH;
    process.env.PATH = `${fakeBin}${path.delimiter}${realPath ?? ''}`;
    try {
      const taskId = 'win32-identity-match';
      await mkdir(path.join(tasksRoot, taskId), { recursive: true });
      await writeFile(path.join(tasksRoot, taskId, 'task.json'), JSON.stringify({
        version: 1,
        task_id: taskId,
        state: 'failed',
        started_at: new Date(Date.now() - 1_000).toISOString(),
        finished_at: new Date(Date.now() - 500).toISOString(),
        include_stdout: false,
        include_stderr: false,
        max_output_bytes: 1024,
        deadline_at: new Date(Date.now() + 60_000).toISOString(),
        error: 'Durable task could not start: publish failed; the worker it forked could not be stopped and may still be running',
        worker_pid: sleeper.pid,
        worker_started_at: identity,
      }), 'utf8');

      const cancelled = await store.cancel(taskId);

      // Before the Windows probe existed this cancel read `no_process`: the identity
      // never matched because it was never read, so the stop was never attempted.
      expect(cancelled).toMatchObject({ ok: true, value: { state: 'failed' } });
      expect(cancelled.ok && cancelled.value.worker_pid).toBeUndefined();
      expect(cancelled.ok && String(cancelled.value.error)).toContain('stopped by a later cancel');
      expect((await readFile(taskkillLog, 'utf8')).trim()).toBe(String(sleeper.pid));
      await sleeperExited;
      expect(isProcessAlive(sleeper.pid)).toBe(false);
    } finally {
      process.env.PATH = realPath;
      await killFixture(sleeper.pid, startedAt);
    }
  });

  it('never signals a Windows task whose recorded identity names another process', async () => {
    if (process.platform === 'win32') return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-durable-win32-mismatch-'));
    temporaryRoots.push(root);
    const tasksRoot = path.join(root, '.tasks');
    const store = new DurableShellTaskStore(tasksRoot, { platform: 'win32' });
    const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' });
    sleeper.unref();
    const startedAt = await readProcessStartedAt(sleeper.pid);
    const fakeBin = path.join(root, 'bin');
    await mkdir(fakeBin, { recursive: true });
    await writeFile(path.join(fakeBin, 'powershell'), '#!/bin/sh\necho "2026-11-22T00:00:00.000Z"\n', { mode: 0o755 });
    const taskkillLog = path.join(root, 'taskkill.log');
    await writeFile(path.join(fakeBin, 'taskkill'), `#!/bin/sh\necho "$2" >> ${JSON.stringify(taskkillLog)}\nexit 0\n`, { mode: 0o755 });
    const realPath = process.env.PATH;
    process.env.PATH = `${fakeBin}${path.delimiter}${realPath ?? ''}`;
    try {
      const taskId = 'win32-identity-mismatch';
      await mkdir(path.join(tasksRoot, taskId), { recursive: true });
      await writeFile(path.join(tasksRoot, taskId, 'task.json'), JSON.stringify({
        version: 1,
        task_id: taskId,
        state: 'failed',
        started_at: new Date(Date.now() - 1_000).toISOString(),
        finished_at: new Date(Date.now() - 500).toISOString(),
        include_stdout: false,
        include_stderr: false,
        max_output_bytes: 1024,
        deadline_at: new Date(Date.now() + 60_000).toISOString(),
        error: 'Durable task could not start: publish failed; the worker it forked could not be stopped and may still be running',
        worker_pid: sleeper.pid,
        // The number now names a different process than the one this record pinned.
        worker_started_at: '2026-01-01T00:00:00.000Z',
      }), 'utf8');

      const cancelled = await store.cancel(taskId);

      expect(cancelled).toMatchObject({ ok: true, value: { state: 'failed' } });
      expect(cancelled.ok && String(cancelled.value.error)).not.toContain('stopped by a later cancel');
      expect(existsSync(taskkillLog)).toBe(false);
      expect(isProcessAlive(sleeper.pid)).toBe(true);
    } finally {
      process.env.PATH = realPath;
      await killFixture(sleeper.pid, startedAt);
    }
  });

  it('never calls a Windows task stopped when the identity probe itself failed', async () => {
    if (process.platform === 'win32') return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-durable-win32-probe-failed-'));
    temporaryRoots.push(root);
    const tasksRoot = path.join(root, '.tasks');
    const store = new DurableShellTaskStore(tasksRoot, { platform: 'win32' });
    const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' });
    sleeper.unref();
    const startedAt = await readProcessStartedAt(sleeper.pid);
    const fakeBin = path.join(root, 'bin');
    await mkdir(fakeBin, { recursive: true });
    // PowerShell exits 1 when the script failed, which is not the same answer as `ps`
    // exiting 1 for "no such process". Reading it as `gone` would report a live pid
    // nobody could see as a proven stop.
    await writeFile(path.join(fakeBin, 'powershell'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const taskkillLog = path.join(root, 'taskkill.log');
    await writeFile(path.join(fakeBin, 'taskkill'), `#!/bin/sh\necho "$2" >> ${JSON.stringify(taskkillLog)}\nexit 0\n`, { mode: 0o755 });
    const realPath = process.env.PATH;
    process.env.PATH = `${fakeBin}${path.delimiter}${realPath ?? ''}`;
    try {
      const taskId = 'win32-probe-failed';
      await mkdir(path.join(tasksRoot, taskId), { recursive: true });
      await writeFile(path.join(tasksRoot, taskId, 'task.json'), JSON.stringify({
        version: 1,
        task_id: taskId,
        state: 'failed',
        started_at: new Date(Date.now() - 1_000).toISOString(),
        finished_at: new Date(Date.now() - 500).toISOString(),
        include_stdout: false,
        include_stderr: false,
        max_output_bytes: 1024,
        deadline_at: new Date(Date.now() + 60_000).toISOString(),
        // Deliberately without the pending sentence: the only way this record can end up
        // carrying it is a cancel that could not read the identity.
        error: 'Durable task could not start: publish failed',
        worker_pid: sleeper.pid,
        worker_started_at: startedAt,
      }), 'utf8');

      const cancelled = await store.cancel(taskId);

      // `no_process` would be the same claim the pre-fix code made from a probe that
      // never ran; an unreadable identity has to leave the pid and the warning in place.
      expect(cancelled).toMatchObject({ ok: true, value: { state: 'failed' } });
      expect(cancelled.ok && cancelled.value.worker_pid).toBe(sleeper.pid);
      expect(cancelled.ok && String(cancelled.value.error)).toContain('may still be running');
      expect(existsSync(taskkillLog)).toBe(false);
      expect(isProcessAlive(sleeper.pid)).toBe(true);
    } finally {
      process.env.PATH = realPath;
      await killFixture(sleeper.pid, startedAt);
    }
  });

  it('stops a Windows task whose record carries both pids, verifying the tree it walks', async () => {
    if (process.platform === 'win32') return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-durable-win32-both-pids-'));
    temporaryRoots.push(root);
    const tasksRoot = path.join(root, '.tasks');
    const store = new DurableShellTaskStore(tasksRoot, { platform: 'win32' });
    const worker = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' });
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' });
    worker.unref();
    child.unref();
    const workerExited = new Promise<void>((resolve) => worker.once('exit', () => resolve()));
    const childExited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    const workerStartedAt = await readProcessStartedAt(worker.pid);
    const childStartedAt = await readProcessStartedAt(child.pid);
    const identity = '2026-11-22T00:00:00.000Z';
    const fakeBin = path.join(root, 'bin');
    await mkdir(fakeBin, { recursive: true });
    await writeFile(path.join(fakeBin, 'powershell'), `#!/bin/sh\necho "${identity}"\n`, { mode: 0o755 });
    const taskkillLog = path.join(root, 'taskkill.log');
    // `taskkill /T` walks the tree from the root, so the fake kills the child only when
    // it is given the worker and the `/T` flag: a dropped flag has to fail the test.
    await writeFile(
      path.join(fakeBin, 'taskkill'),
      `#!/bin/sh\necho "$2 $3" >> ${JSON.stringify(taskkillLog)}\nkill -9 "$2" 2>/dev/null\n`
        + `if [ "$2" = "${String(worker.pid)}" ] && [ "$3" = "/T" ]; then kill -9 "${String(child.pid)}" 2>/dev/null; fi\nexit 0\n`,
      { mode: 0o755 },
    );
    const realPath = process.env.PATH;
    process.env.PATH = `${fakeBin}${path.delimiter}${realPath ?? ''}`;
    try {
      const taskId = 'win32-both-pids';
      await mkdir(path.join(tasksRoot, taskId), { recursive: true });
      await writeFile(path.join(tasksRoot, taskId, 'task.json'), JSON.stringify({
        version: 1,
        task_id: taskId,
        state: 'running',
        started_at: new Date(Date.now() - 1_000).toISOString(),
        include_stdout: false,
        include_stderr: false,
        max_output_bytes: 1024,
        deadline_at: new Date(Date.now() + 60_000).toISOString(),
        worker_pid: worker.pid,
        worker_started_at: identity,
        child_pid: child.pid,
        child_started_at: identity,
      }), 'utf8');

      const cancelled = await store.cancel(taskId);

      // Both pids carry an identity, so the child is a related pid the tree walk verifies
      // instead of a live process with no recorded start time, which blocks the stop.
      expect(cancelled).toMatchObject({ ok: true, value: { state: 'cancelled' } });
      expect((await readFile(taskkillLog, 'utf8')).trim()).toBe(`${String(worker.pid)} /T`);
      await Promise.all([workerExited, childExited]);
      expect(isProcessAlive(worker.pid)).toBe(false);
      expect(isProcessAlive(child.pid)).toBe(false);
    } finally {
      process.env.PATH = realPath;
      await killFixture(worker.pid, workerStartedAt);
      await killFixture(child.pid, childStartedAt);
    }
  });

  it('retries a Windows identity probe that failed once instead of pinning the task', async () => {
    if (process.platform === 'win32') return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-durable-win32-probe-retry-'));
    temporaryRoots.push(root);
    const tasksRoot = path.join(root, '.tasks');
    const store = new DurableShellTaskStore(tasksRoot, { platform: 'win32' });
    const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' });
    sleeper.unref();
    const sleeperExited = new Promise<void>((resolve) => sleeper.once('exit', () => resolve()));
    const startedAt = await readProcessStartedAt(sleeper.pid);
    const identity = '2026-11-22T00:00:00.000Z';
    const fakeBin = path.join(root, 'bin');
    await mkdir(fakeBin, { recursive: true });
    // One cold-start failure per pid, then a normal answer: the identity is captured once
    // per launch, so without a retry this record stays unverifiable for good. The counter
    // is per pid, so a probe of some other process cannot spend the worker's failure.
    await writeFile(
      path.join(fakeBin, 'powershell'),
      `#!/bin/sh\npid=$(printf '%s' "$*" | sed -n 's/.*Get-Process -Id \\([0-9][0-9]*\\).*/\\1/p')\n`
        + `c=${JSON.stringify(root)}/powershell.$pid.count\nn=$(cat "$c" 2>/dev/null || echo 0)\necho $((n+1)) > "$c"\n`
        + `if [ "$n" = "0" ]; then exit 1; fi\necho "${identity}"\n`,
      { mode: 0o755 },
    );
    const taskkillLog = path.join(root, 'taskkill.log');
    await writeFile(
      path.join(fakeBin, 'taskkill'),
      `#!/bin/sh\necho "$2" >> ${JSON.stringify(taskkillLog)}\nkill -9 "$2" 2>/dev/null\nexit 0\n`,
      { mode: 0o755 },
    );
    const realPath = process.env.PATH;
    process.env.PATH = `${fakeBin}${path.delimiter}${realPath ?? ''}`;
    try {
      const taskId = 'win32-probe-retry';
      await mkdir(path.join(tasksRoot, taskId), { recursive: true });
      await writeFile(path.join(tasksRoot, taskId, 'task.json'), JSON.stringify({
        version: 1,
        task_id: taskId,
        state: 'failed',
        started_at: new Date(Date.now() - 1_000).toISOString(),
        finished_at: new Date(Date.now() - 500).toISOString(),
        include_stdout: false,
        include_stderr: false,
        max_output_bytes: 1024,
        deadline_at: new Date(Date.now() + 60_000).toISOString(),
        error: 'Durable task could not start: publish failed',
        worker_pid: sleeper.pid,
        worker_started_at: identity,
      }), 'utf8');

      const cancelled = await store.cancel(taskId);

      expect(cancelled).toMatchObject({ ok: true, value: { state: 'failed' } });
      expect(cancelled.ok && cancelled.value.worker_pid).toBeUndefined();
      expect(cancelled.ok && String(cancelled.value.error)).toContain('stopped by a later cancel');
      expect((await readFile(taskkillLog, 'utf8')).trim()).toBe(String(sleeper.pid));
      await sleeperExited;
      expect(isProcessAlive(sleeper.pid)).toBe(false);
    } finally {
      process.env.PATH = realPath;
      await killFixture(sleeper.pid, startedAt);
    }
  });

  it('reuses a live probe answer for a status read instead of starting a probe per read', async () => {
    if (process.platform === 'win32') return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-durable-probe-cache-'));
    temporaryRoots.push(root);
    const tasksRoot = path.join(root, '.tasks');
    // The clock is injected so neither assertion races a loaded runner: the first pair is
    // one instant, and the expiry is the same entry aged past the TTL.
    let clock = 1_000;
    const store = new DurableShellTaskStore(tasksRoot, { platform: 'linux', now: (): number => clock });
    const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' });
    sleeper.unref();
    const startedAt = await readProcessStartedAt(sleeper.pid);
    // Captured before PATH changes, so the fake answers exactly what a real probe would.
    const { stdout: realRow } = await promisify(execFile)('ps', ['-p', String(sleeper.pid), '-o', 'lstart=', '-o', 'stat='], {
      encoding: 'utf8',
      env: { ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }), LC_ALL: 'C', LANG: 'C' },
    });
    const fakeBin = path.join(root, 'bin');
    await mkdir(fakeBin, { recursive: true });
    const counter = path.join(root, 'ps.count');
    // The fake answers once and fails afterwards: a second probe reads as unverifiable
    // and pins the task, so only a reused answer keeps it running.
    await writeFile(
      path.join(fakeBin, 'ps'),
      `#!/bin/sh\nn=$(cat ${JSON.stringify(counter)} 2>/dev/null || echo 0)\necho $((n+1)) > ${JSON.stringify(counter)}\n`
        // Exit 3, not 1: `ps` exits 1 for "no such process" and that answer is `gone`.
        + `if [ "$n" != "0" ]; then exit 3; fi\ncat <<'ROW'\n${realRow}ROW\n`,
      { mode: 0o755 },
    );
    const realPath = process.env.PATH;
    process.env.PATH = `${fakeBin}${path.delimiter}${realPath ?? ''}`;
    try {
      const taskId = 'probe-cache';
      await mkdir(path.join(tasksRoot, taskId), { recursive: true });
      await writeFile(path.join(tasksRoot, taskId, 'task.json'), JSON.stringify({
        version: 1,
        task_id: taskId,
        state: 'running',
        started_at: new Date(Date.now() - 1_000).toISOString(),
        include_stdout: false,
        include_stderr: false,
        max_output_bytes: 1024,
        deadline_at: new Date(Date.now() + 60_000).toISOString(),
        worker_pid: sleeper.pid,
        worker_started_at: startedAt,
      }), 'utf8');

      const first = await store.snapshot(taskId);
      const second = await store.snapshot(taskId);

      expect(first.ok && first.value.state).toBe('running');
      expect(second.ok && second.value.state).toBe('running');
      expect((await readFile(counter, 'utf8')).trim()).toBe('1');

      // The cache is a bound, not a permanent pin: aged past the TTL the entry is dropped
      // and the probe runs again.
      clock += 501;
      const third = await store.snapshot(taskId);

      expect(third.ok && third.value.state).toBe('termination_unverified');
      expect((await readFile(counter, 'utf8')).trim()).toBe('2');
    } finally {
      process.env.PATH = realPath;
      await killFixture(sleeper.pid, startedAt);
    }
  });

  it('does not replay a cached identity for a record that expects a different start time', async () => {
    if (process.platform === 'win32') return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-durable-probe-cache-pid-'));
    temporaryRoots.push(root);
    const tasksRoot = path.join(root, '.tasks');
    const store = new DurableShellTaskStore(tasksRoot, { platform: 'linux' });
    const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' });
    sleeper.unref();
    const startedAt = await readProcessStartedAt(sleeper.pid);
    // `ps` prints local time, so the identity each row stands for is parsed the same way
    // the probe parses it: a hand-written ISO string would only match in one timezone.
    const identityOf = (row: string): string => {
      const probe = parsePosixProcessProbe(`${row} S`);
      if (probe.state !== 'live') throw new Error(`row is not a live identity: ${row}`);
      return probe.processStartedAt;
    };
    const first = identityOf('2026-11-22 00:00:00');
    const second = identityOf('2026-11-22 00:00:05');
    const fakeBin = path.join(root, 'bin');
    await mkdir(fakeBin, { recursive: true });
    const counter = path.join(root, 'ps.count');
    // Answers `first` once, then `second`: the same pid with two identities, which is what
    // a recycled pid looks like to a cache keyed by pid alone.
    await writeFile(
      path.join(fakeBin, 'ps'),
      `#!/bin/sh\nn=$(cat ${JSON.stringify(counter)} 2>/dev/null || echo 0)\necho $((n+1)) > ${JSON.stringify(counter)}\n`
        + `if [ "$n" = "0" ]; then echo "2026-11-22 00:00:00 S"; else echo "2026-11-22 00:00:05 S"; fi\n`,
      { mode: 0o755 },
    );
    const realPath = process.env.PATH;
    process.env.PATH = `${fakeBin}${path.delimiter}${realPath ?? ''}`;
    try {
      for (const [taskId, identity] of [['cache-first', first], ['cache-second', second]] as const) {
        await mkdir(path.join(tasksRoot, taskId), { recursive: true });
        await writeFile(path.join(tasksRoot, taskId, 'task.json'), JSON.stringify({
          version: 1,
          task_id: taskId,
          state: 'running',
          started_at: new Date(Date.now() - 1_000).toISOString(),
          include_stdout: false,
          include_stderr: false,
          max_output_bytes: 1024,
          deadline_at: new Date(Date.now() + 60_000).toISOString(),
          worker_pid: sleeper.pid,
          worker_started_at: identity,
        }), 'utf8');
      }

      const firstRead = await store.snapshot('cache-first');
      // A pid-only cache would serve `first` here, read it as another process and pin a
      // healthy task `termination_unverified`; the record's own identity has to miss.
      const secondRead = await store.snapshot('cache-second');

      expect(firstRead.ok && firstRead.value.state).toBe('running');
      expect(secondRead.ok && secondRead.value.state).toBe('running');
      expect((await readFile(counter, 'utf8')).trim()).toBe('2');
    } finally {
      process.env.PATH = realPath;
      await killFixture(sleeper.pid, startedAt);
    }
  });

  it('stops a process a terminal record still names, instead of leaving the pid as a note', async () => {
    if (process.platform === 'win32') return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-durable-late-cancel-'));
    temporaryRoots.push(root);
    const tasksRoot = path.join(root, '.tasks');
    const store = new DurableShellTaskStore(tasksRoot);
    const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' });
    sleeper.unref();
    const startedAt = await readProcessStartedAt(sleeper.pid);
    try {
      const taskId = 'failed-start-residue';
      await mkdir(path.join(tasksRoot, taskId), { recursive: true });
      await writeFile(path.join(tasksRoot, taskId, 'task.json'), JSON.stringify({
        version: 1,
        task_id: taskId,
        // What a start that failed after the fork records: the outcome already
        // happened, and the worker pid is the only handle to the tree it could not stop.
        state: 'failed',
        started_at: new Date(Date.now() - 1_000).toISOString(),
        finished_at: new Date(Date.now() - 500).toISOString(),
        include_stdout: false,
        include_stderr: false,
        max_output_bytes: 1024,
        deadline_at: new Date(Date.now() + 60_000).toISOString(),
        error: 'Durable task could not start: publish failed; the worker it forked could not be stopped and may still be running',
        worker_pid: sleeper.pid,
        worker_started_at: startedAt,
      }), 'utf8');

      const cancelled = await store.cancel(taskId);

      expect(cancelled).toMatchObject({ ok: true, value: { state: 'failed' } });
      // The outcome is history and stays; the pid that is no longer live is not evidence.
      expect(cancelled.ok && cancelled.value.worker_pid).toBeUndefined();
      expect(cancelled.ok && String(cancelled.value.error)).toContain('stopped by a later cancel');
      // The fixture's own pending claim is the failed start's wording, not the one this
      // path appends: a proven stop supersedes every sentence that says it may still
      // be running, so none of them may survive.
      expect(cancelled.ok && String(cancelled.value.error)).not.toContain('may still be running');
      expect(isProcessAlive(sleeper.pid)).toBe(false);
    } finally {
      // A failing assertion must not leave the fixture running for a minute.
      await killFixture(sleeper.pid, startedAt);
    }
  });

  it('does not signal a terminal record pid that now names a different process', async () => {
    if (process.platform === 'win32') return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-durable-reused-pid-'));
    temporaryRoots.push(root);
    const tasksRoot = path.join(root, '.tasks');
    const store = new DurableShellTaskStore(tasksRoot);
    const bystander = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' });
    bystander.unref();
    const bystanderStartedAt = await readProcessStartedAt(bystander.pid);
    try {
      const taskId = 'reused-pid';
      await mkdir(path.join(tasksRoot, taskId), { recursive: true });
      await writeFile(path.join(tasksRoot, taskId, 'task.json'), JSON.stringify({
        version: 1,
        task_id: taskId,
        state: 'failed',
        started_at: new Date(Date.now() - 1_000).toISOString(),
        finished_at: new Date(Date.now() - 500).toISOString(),
        include_stdout: false,
        include_stderr: false,
        max_output_bytes: 1024,
        deadline_at: new Date(Date.now() + 60_000).toISOString(),
        error: 'Durable task could not start',
        worker_pid: bystander.pid,
        // A live pid with a different start time is the reused-pid case: the identity is
        // what authorizes a signal, never the number alone.
        worker_started_at: new Date(0).toISOString(),
      }), 'utf8');

      const cancelled = await store.cancel(taskId);

      expect(cancelled).toMatchObject({ ok: true, value: { state: 'failed', error: 'Durable task could not start' } });
      expect(isProcessAlive(bystander.pid)).toBe(true);
    } finally {
      // The fixture is the test's own process and nothing else may share it, so the
      // captured identity is what authorizes the kill, exactly as for a task pid.
      await killFixture(bystander.pid, bystanderStartedAt);
    }
  });

  it('reports a live pid it cannot identify as unproven instead of settled', async () => {
    if (process.platform === 'win32') return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-durable-unidentified-pid-'));
    temporaryRoots.push(root);
    const tasksRoot = path.join(root, '.tasks');
    const store = new DurableShellTaskStore(tasksRoot);
    const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' });
    sleeper.unref();
    const startedAt = await readProcessStartedAt(sleeper.pid);
    try {
      const taskId = 'unidentified-pid';
      await mkdir(path.join(tasksRoot, taskId), { recursive: true });
      await writeFile(path.join(tasksRoot, taskId, 'task.json'), JSON.stringify({
        version: 1,
        task_id: taskId,
        state: 'failed',
        started_at: new Date(Date.now() - 1_000).toISOString(),
        finished_at: new Date(Date.now() - 500).toISOString(),
        include_stdout: false,
        include_stderr: false,
        max_output_bytes: 1024,
        deadline_at: new Date(Date.now() + 60_000).toISOString(),
        error: 'Durable task could not start',
        worker_pid: sleeper.pid,
        // No `worker_started_at`: the pid is live but the record cannot prove it names
        // the process the failed start left behind, so the stop is unproven, not absent.
      }), 'utf8');

      const cancelled = await store.cancel(taskId);

      expect(cancelled).toMatchObject({ ok: true, value: { state: 'failed', worker_pid: sleeper.pid } });
      expect(cancelled.ok && String(cancelled.value.error)).toContain('may still be running');
      expect(isProcessAlive(sleeper.pid)).toBe(true);

      // A later cancel that proves the stop supersedes the pending sentence: the
      // record must not claim both that the process may still be running and that it
      // was stopped.
      const recordPath = path.join(tasksRoot, taskId, 'task.json');
      const record = JSON.parse(await readFile(recordPath, 'utf8'));
      await writeFile(recordPath, JSON.stringify({ ...record, worker_started_at: startedAt }), 'utf8');
      const settled = await store.cancel(taskId);

      expect(settled).toMatchObject({ ok: true, value: { state: 'failed' } });
      const settledError = settled.ok ? String(settled.value.error) : '';
      expect(settledError).toContain('stopped by a later cancel');
      expect(settledError).not.toContain('may still be running');
      expect(isProcessAlive(sleeper.pid)).toBe(false);
    } finally {
      await killFixture(sleeper.pid, startedAt);
    }
  });

  it('reports a pid whose identity probe cannot be read as unproven', async () => {
    if (process.platform === 'win32') return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-durable-unreadable-probe-'));
    temporaryRoots.push(root);
    const tasksRoot = path.join(root, '.tasks');
    const store = new DurableShellTaskStore(tasksRoot);
    const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' });
    sleeper.unref();
    const startedAt = await readProcessStartedAt(sleeper.pid);
    // A fake `ps` reaches the probe-failure branch with the pid provably live. An
    // unparseable row is one way; a non-1 exit status and a timeout land on the same
    // `unverifiable` clause. Only the identity is unknown, which is not proof of a stop.
    const fakeBin = path.join(root, 'bin');
    await mkdir(fakeBin, { recursive: true });
    await writeFile(path.join(fakeBin, 'ps'), '#!/bin/sh\necho "not-a-valid-ps-row"\n', { mode: 0o755 });
    const realPath = process.env.PATH;
    process.env.PATH = `${fakeBin}${path.delimiter}${realPath ?? ''}`;
    try {
      const taskId = 'unreadable-probe';
      await mkdir(path.join(tasksRoot, taskId), { recursive: true });
      await writeFile(path.join(tasksRoot, taskId, 'task.json'), JSON.stringify({
        version: 1,
        task_id: taskId,
        state: 'failed',
        started_at: new Date(Date.now() - 1_000).toISOString(),
        finished_at: new Date(Date.now() - 500).toISOString(),
        include_stdout: false,
        include_stderr: false,
        max_output_bytes: 1024,
        deadline_at: new Date(Date.now() + 60_000).toISOString(),
        error: 'Durable task could not start',
        worker_pid: sleeper.pid,
        worker_started_at: startedAt,
      }), 'utf8');

      const cancelled = await store.cancel(taskId);

      expect(cancelled).toMatchObject({ ok: true, value: { state: 'failed', worker_pid: sleeper.pid } });
      expect(cancelled.ok && String(cancelled.value.error)).toContain('may still be running');
      expect(isProcessAlive(sleeper.pid)).toBe(true);

      // The unproven outcome was the unreadable probe, not the pid: with the real `ps`
      // back, the same record and the same live process settle on the next cancel.
      process.env.PATH = realPath;
      const settled = await store.cancel(taskId);

      expect(settled).toMatchObject({ ok: true, value: { state: 'failed' } });
      const settledError = settled.ok ? String(settled.value.error) : '';
      expect(settledError).toContain('stopped by a later cancel');
      expect(settledError).not.toContain('may still be running');
      expect(isProcessAlive(sleeper.pid)).toBe(false);
    } finally {
      process.env.PATH = realPath;
      await killFixture(sleeper.pid, startedAt);
    }
  });

  it('answers an already-terminal goal task from what the cancel did', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-durable-goal-label-'));
    temporaryRoots.push(root);
    const tasksRoot = path.join(root, '.tasks');
    const store = new DurableShellTaskStore(tasksRoot);
    const taskId = 'terminal-goal-label';
    await mkdir(path.join(tasksRoot, taskId), { recursive: true });
    await writeFile(path.join(tasksRoot, taskId, 'task.json'), JSON.stringify({
      version: 1,
      task_id: taskId,
      // A terminal record with nothing left to stop: the label must still be read from
      // the cancel, not guessed, because the same path cancels a record that moved.
      state: 'failed',
      started_at: new Date(Date.now() - 1_000).toISOString(),
      finished_at: new Date(Date.now() - 500).toISOString(),
      include_stdout: false,
      include_stderr: false,
      max_output_bytes: 1024,
      deadline_at: new Date(Date.now() + 60_000).toISOString(),
      error: 'Durable task could not start',
      owner_client_id: 'client-1',
      owner_session_id: 'session-1',
      owner_workspace_id: 'workspace-1',
    }), 'utf8');

    await expect(store.cancelForGoal(taskId, 'client-1', 'workspace-1')).resolves.toEqual({
      ok: true,
      value: { matched: true, state: 'already_terminal', detail: 'failed' },
    });
  });

  it('reports a command it could not spawn as a failed task, not as a dead worker', async () => {
    // `spawn` reports a missing executable through the child's `error` event, which
    // only a registered listener can turn into `failed`. If the worker awaits a write
    // between the fork and attaching that listener, the event is unhandled and takes
    // the worker down instead, leaving the task `running` until its timeout.
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-durable-spawn-'));
    temporaryRoots.push(root);
    const store = new DurableShellTaskStore(path.join(root, '.tasks'));
    const owner = { clientId: 'client-a', sessionId: 'session-a', workspaceId: 'workspace-a' };
    await store.reserve({
      taskId: 'missing-executable',
      executable: path.join(root, 'no-such-executable'),
      arguments: [],
      cwd: root,
      timeoutSeconds: 30,
      maxOutputBytes: 1024,
      includeStdout: true,
      includeStderr: true,
      owner,
    });

    expect(await store.startReserved('missing-executable', process.env)).toMatchObject({ ok: true });
    const waited = await store.wait('missing-executable', 10, undefined, owner);

    expect(waited).toMatchObject({ ok: true, value: { state: 'failed', exit_code: -1 } });
    expect(String((waited.ok && waited.value.error) ?? '')).toContain('failed to start');
  });

  it('correlates a task with the goal generation that started it, and leaves it absent otherwise', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-durable-goal-'));
    temporaryRoots.push(root);
    const tasksRoot = path.join(root, '.tasks');
    const store = new DurableShellTaskStore(tasksRoot);
    const base = {
      executable: process.execPath,
      arguments: ['-e', ''],
      cwd: root,
      timeoutSeconds: 30,
      maxOutputBytes: 1024,
      includeStdout: true,
      includeStderr: true,
    } as const;
    const workspace = { clientId: 'client-a', sessionId: 'session-a', workspaceId: 'workspace-a' };

    const correlated = await store.reserve({
      ...base,
      taskId: 'goal-task',
      owner: { ...workspace, goalId: 'goal-1', executionGeneration: 4 },
    });
    expect(correlated).toMatchObject({ ok: true, value: { goal_id: 'goal-1', execution_generation: 4 } });

    // A task started outside a goal claims no goal, rather than a default one.
    const plain = await store.reserve({ ...base, taskId: 'plain-task', owner: workspace });
    expect(plain.ok).toBe(true);
    expect(plain.ok && (plain.value as Record<string, unknown>).goal_id).toBeUndefined();
    expect(plain.ok && (plain.value as Record<string, unknown>).execution_generation).toBeUndefined();

    // The correlation is persisted, so a restart reads it back rather than
    // inferring it from whatever generation happens to be current later.
    const reopened = new DurableShellTaskStore(tasksRoot);
    const reread = await reopened.snapshot('goal-task', undefined, workspace);
    expect(reread).toMatchObject({ ok: true, value: { goal_id: 'goal-1', execution_generation: 4 } });
  });

  it('cancels a waiting task without a process and refuses to start it later', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-durable-park-'));
    temporaryRoots.push(root);
    const store = new DurableShellTaskStore(path.join(root, '.tasks'));
    const owner = { clientId: 'client-a', sessionId: 'session-a', workspaceId: 'workspace-a' };
    await store.reserve({
      taskId: 'waiting-two',
      executable: process.execPath,
      arguments: ['-e', ''],
      cwd: root,
      timeoutSeconds: 30,
      maxOutputBytes: 1024,
      includeStdout: true,
      includeStderr: true,
      owner,
    });

    const cancelled = await store.cancel('waiting-two', owner);
    expect(cancelled).toMatchObject({ ok: true, value: { state: 'cancelled', exit_code: -1 } });

    const started = await store.startReserved('waiting-two', process.env);
    expect(started).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  });

  it('waits on a parked task only up to the caller budget', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-durable-park-'));
    temporaryRoots.push(root);
    const store = new DurableShellTaskStore(path.join(root, '.tasks'));
    const owner = { clientId: 'client-a', sessionId: 'session-a', workspaceId: 'workspace-a' };
    await store.reserve({
      taskId: 'waiting-three',
      executable: process.execPath,
      arguments: ['-e', ''],
      cwd: root,
      timeoutSeconds: 30,
      maxOutputBytes: 1024,
      includeStdout: true,
      includeStderr: true,
      owner,
    });

    const waited = await store.wait('waiting-three', 0.05, undefined, owner);
    expect(waited).toMatchObject({ ok: true, value: { state: 'waiting_resource' } });
    await store.cancel('waiting-three', owner);
  });

  it('lists only parked tasks for restart re-attachment', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-durable-park-'));
    temporaryRoots.push(root);
    const store = new DurableShellTaskStore(path.join(root, '.tasks'));
    const owner = { clientId: 'client-a', sessionId: 'session-a', workspaceId: 'workspace-a' };
    await store.reserve({
      taskId: 'parked-one',
      executable: process.execPath,
      arguments: ['-e', ''],
      cwd: root,
      timeoutSeconds: 30,
      maxOutputBytes: 1024,
      includeStdout: true,
      includeStderr: true,
      owner,
      admissionClass: 'verification_heavy',
      admissionCost: 8,
    });
    const running = await store.launch({
      taskId: 'running-one',
      executable: process.execPath,
      arguments: ['-e', 'setTimeout(() => {}, 5000)'],
      cwd: root,
      environment: process.env,
      timeoutSeconds: 30,
      maxOutputBytes: 1024,
      includeStdout: true,
      includeStderr: true,
      owner,
    });
    expect(running.ok).toBe(true);

    const waiting = await store.listWaiting();
    expect(waiting).toMatchObject([{
      task_id: 'parked-one',
      state: 'waiting_resource',
      admission_class: 'verification_heavy',
      admission_cost: 8,
      workspace_id: 'workspace-a',
    }]);

    await store.cancel('parked-one', owner);
    await store.cancel('running-one', owner);
  });

  it('refuses to start a task that is not parked', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-durable-park-'));
    temporaryRoots.push(root);
    const store = new DurableShellTaskStore(path.join(root, '.tasks'));
    const owner = { clientId: 'client-a', sessionId: 'session-a', workspaceId: 'workspace-a' };
    const launched = await store.launch({
      taskId: 'running-one',
      executable: process.execPath,
      arguments: ['-e', 'setTimeout(() => {}, 5000)'],
      cwd: root,
      environment: process.env,
      timeoutSeconds: 30,
      maxOutputBytes: 1024,
      includeStdout: true,
      includeStderr: true,
      owner,
    });
    expect(launched).toMatchObject({ ok: true, value: { state: 'running' } });

    const again = await store.startReserved('running-one', process.env);
    expect(again).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    await store.cancel('running-one', owner);
  }, 15000);
});

describe('durable task recovery identity (#170)', () => {
  it('keeps a running task addressable to a new session in the same workspace, with no journal row', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-durable-recovery-'));
    temporaryRoots.push(root);
    const store = new DurableShellTaskStore(path.join(root, '.tasks'));
    const firstSession = { clientId: 'chatgpt', sessionId: 'session-a', workspaceId: 'workspace-a' };

    const launched = await store.launch({
      taskId: 'recoverable-task',
      executable: process.execPath,
      // Outlives the test body: a fixture that expires mid-assertion turns a slow
      // machine into a failure that has nothing to do with recovery.
      arguments: ['-e', 'setTimeout(() => {}, 30000)'],
      cwd: root,
      environment: process.env,
      timeoutSeconds: 30,
      maxOutputBytes: 1024,
      includeStdout: true,
      includeStderr: true,
      owner: firstSession,
    });
    expect(launched).toMatchObject({ ok: true, value: { task_id: 'recoverable-task', state: 'running' } });

    try {
      // The journal is a discovery index, not the identity: a telemetry write can
      // fail after this task started and leave no row naming the call, yet the
      // metadata on disk is what a later session lists and reads by id.
      const replacementSession = { clientId: 'chatgpt', sessionId: 'session-b', workspaceId: 'workspace-a' };
      expect(await store.list(replacementSession)).toMatchObject([
        { task_id: 'recoverable-task', state: 'running' },
      ]);
      expect(await store.snapshot('recoverable-task', undefined, replacementSession)).toMatchObject({
        ok: true,
        value: { task_id: 'recoverable-task', state: 'running' },
      });

      // Recovery is workspace-scoped, not global: another workspace can neither
      // list the task nor address it by id.
      const foreignWorkspace = { clientId: 'chatgpt', sessionId: 'session-c', workspaceId: 'workspace-b' };
      expect(await store.list(foreignWorkspace)).toEqual([]);
      expect(await store.snapshot('recoverable-task', undefined, foreignWorkspace)).toMatchObject({
        ok: false,
        error: { code: 'PERMISSION_DENIED' },
      });
    } finally {
      await store.cancel('recoverable-task', firstSession);
    }
  }, 15_000);
});

describe('durable worker identity capture (#876)', () => {
  it('captures the child identity through the worker\'s Windows probe branch', async () => {
    if (process.platform === 'win32') return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-durable-worker-identity-'));
    temporaryRoots.push(root);
    const identity = '2026-11-22T00:00:00.000Z';
    const fakeBin = path.join(root, 'bin');
    await mkdir(fakeBin, { recursive: true });
    // Only `powershell` exists on this PATH. A worker that fell through to the POSIX
    // `ps` branch would find no probe at all, so a captured identity can only have come
    // from the win32 branch — deleting that branch leaves the task with no identity.
    await writeFile(path.join(fakeBin, 'powershell'), `#!/bin/sh\necho "${identity}"\n`, { mode: 0o755 });

    const workerPath = path.join(root, 'worker.mjs');
    await writeFile(workerPath, DURABLE_WORKER_SOURCE, 'utf8');
    // The worker branches on the real `process.platform`, which no option can reach, so
    // the property is redefined before the module loads.
    const harnessPath = path.join(root, 'harness.mjs');
    await writeFile(harnessPath, [
      "Object.defineProperty(process, 'platform', { value: 'win32' });",
      'await import(process.env.DURABLE_WORKER_PATH);',
      '',
    ].join('\n'), 'utf8');

    const metadataPath = path.join(root, 'task.json');
    await writeFile(metadataPath, JSON.stringify({
      version: 1,
      task_id: 'worker-identity',
      state: 'running',
      started_at: new Date(Date.now() - 1_000).toISOString(),
      include_stdout: false,
      include_stderr: false,
      max_output_bytes: 1024,
      deadline_at: new Date(Date.now() + 60_000).toISOString(),
    }), 'utf8');
    const specPath = path.join(root, 'spec.json');
    await writeFile(specPath, JSON.stringify({
      metadataPath,
      stdoutPath: path.join(root, 'stdout.log'),
      stderrPath: path.join(root, 'stderr.log'),
      maxOutputBytes: 1024,
      executable: process.execPath,
      arguments: ['-e', 'setTimeout(() => {}, 30000)'],
      cwd: root,
      timeoutMs: 60_000,
    }), 'utf8');

    const harness = spawn(process.execPath, [harnessPath, specPath], {
      cwd: root,
      stdio: 'ignore',
      env: { ...process.env, PATH: fakeBin, DURABLE_WORKER_PATH: workerPath },
    });
    const harnessExited = new Promise<void>((resolve) => harness.once('exit', () => resolve()));
    let childPid: number | undefined;
    try {
      await waitUntil(async () => {
        // The worker writes the metadata file while this polls it, so a read can land on a
        // torn write. That is not the condition under test: keep polling instead of throwing
        // a parse error out of the wait.
        const metadata = await readPublishedMetadata(metadataPath);
        return metadata?.child_started_at !== undefined;
      }, 15_000);
      const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as { child_pid?: number; child_started_at?: string };
      childPid = metadata.child_pid;
      // The exact identity the fake PowerShell printed, normalised the way the probe parses it.
      expect(metadata.child_started_at).toBe(identity);
      expect(childPid).toBeGreaterThan(0);
    } finally {
      // The recorded identity is the fake one, so the real-start-time helper would decline
      // to signal this child: it is killed by the pid the worker published. That pid is read
      // again here because a failing wait never reached the assignment above, and a leaked
      // fixture would keep running for the rest of its own timeout.
      const published = childPid ?? await readPublishedChildPid(metadataPath);
      if (published !== undefined) {
        try {
          process.kill(published, 'SIGKILL');
        } catch {
          // Gone already.
        }
      }
      harness.kill('SIGKILL');
      await harnessExited;
    }
  }, 30_000);
});

/**
 * The worker rewrites the metadata file while a test polls it, so a read can land on a
 * half-written or absent file. Such a read has published nothing yet, which is not the
 * condition under test.
 */
async function readPublishedMetadata(
  metadataPath: string,
): Promise<{ child_pid?: number; child_started_at?: string } | undefined> {
  try {
    return JSON.parse(await readFile(metadataPath, 'utf8')) as { child_pid?: number; child_started_at?: string };
  } catch {
    return undefined;
  }
}

/**
 * The worker persists `child_pid` before it probes the start time, so a wait that failed
 * still leaves a pid to clean up. A read that lands on a half-written or absent file has
 * published nothing to kill, and must not replace the failure the test is reporting.
 */
async function readPublishedChildPid(metadataPath: string): Promise<number | undefined> {
  return (await readPublishedMetadata(metadataPath))?.child_pid;
}

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Condition was not met before timeout');
}

function isProcessAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readProcessStartedAt(pid: number | undefined): Promise<string> {
  if (pid === undefined) throw new Error('fixture process has no pid');
  const { stdout } = await promisify(execFile)('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'stat='], {
    encoding: 'utf8',
    env: { ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }), LC_ALL: 'C', LANG: 'C' },
  });
  const probe = parsePosixProcessProbe(stdout);
  if (probe.state !== 'live') throw new Error(`fixture process identity is ${probe.state}`);
  return probe.processStartedAt;
}

/**
 * Kills a fixture only while it is still the process the test spawned, and never lets
 * the cleanup replace the assertion failure it exists to preserve: a fixture that
 * exited between the probe and the signal throws `ESRCH`, and that is the good case.
 */
async function killFixture(pid: number | undefined, expectedStartedAt: string): Promise<void> {
  if (pid === undefined) return;
  const stillOurs = await readProcessStartedAt(pid).then((current) => current === expectedStartedAt, () => false);
  if (!stillOurs) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Gone between the probe and the signal.
  }
}

/**
 * Reaches the private failed-start stop so the branch can be driven without racing a
 * real fork: a `start` that fails after the fork is the only other caller, and the
 * child it published is the one thing a test cannot make deterministic.
 */
function stopFailedStartOf(store: DurableShellTaskStore): (workerPid: number, taskDirectory: string) => Promise<boolean> {
  const internal = store as unknown as { stopFailedStart(workerPid: number, taskDirectory: string): Promise<boolean> };
  return internal.stopFailedStart.bind(store);
}
