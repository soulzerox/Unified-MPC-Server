import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ShellCapabilityBackend } from './shell-backend.js';
import { DurableShellTaskStore, parsePosixProcessProbe } from './durable-shell-task-store.js';
import { CAPABILITY_TASK_OWNER_METADATA_KEY } from './task-ownership.js';
import { execFile } from 'node:child_process';
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

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Condition was not met before timeout');
}
