import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import type { CapabilityProcessPort } from '@unified-mpc/capabilities';
import { ok, type Result } from '@unified-mpc/domain';
import type { ManagedProcess, ManagedProcessStart, ManagedProcessState } from '@unified-mpc/process';

import { createMergeGateCommandRunner, MERGE_GATE_CAPABILITY_ID } from './merge-gate-capability.js';

/** The gate's cwd is the exact-head checkout, which is a registered workspace. */
const ROOT = process.cwd();

interface FakeStreams {
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
}

function managedProcess(
  processId: string,
  state: ManagedProcessState,
  streams?: FakeStreams,
): ManagedProcess {
  return {
    processId,
    executable: '/usr/bin/node',
    args: [],
    cwd: ROOT,
    state,
    startedAt: new Date(0).toISOString(),
    ...(streams === undefined ? {} : streams),
  };
}

class FakeProcesses implements CapabilityProcessPort {
  public readonly specs: ManagedProcessStart[] = [];

  public readonly stops: string[] = [];

  /** The code `status` reports once the child is gone. */
  public exitCode: number | undefined = 0;

  public current: FakeStreams | undefined;

  private readonly listeners = new Map<string, () => void>();

  private nextProcess = 0;

  public async start(
    spec: ManagedProcessStart,
    _signal?: AbortSignal,
    onCreated?: (process: ManagedProcess) => void,
  ): Promise<Result<ManagedProcess>> {
    this.specs.push(spec);
    const processId = `proc-${this.nextProcess}`;
    this.nextProcess += 1;
    const streams: FakeStreams = {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    };
    this.current = streams;
    const process = managedProcess(processId, 'running', streams);
    onCreated?.(process);
    return ok(process);
  }

  public async stop(processId: string, _autoRetry = false): Promise<Result<void>> {
    this.stops.push(processId);
    this.listeners.delete(processId);
    return ok(undefined);
  }

  public status(processId: string): Result<ManagedProcess> {
    return ok({
      ...managedProcess(processId, 'stopped'),
      ...(this.exitCode === undefined ? {} : { exitCode: this.exitCode }),
    });
  }

  public onExit(processId: string, listener: () => void): () => void {
    this.listeners.set(processId, listener);
    return (): void => {
      this.listeners.delete(processId);
    };
  }

  /** Resolves once a further attempt has been started, not the previous one. */
  public async waitForStart(): Promise<void> {
    const seen = this.specs.length;
    while (this.specs.length === seen) await tick();
  }

  public fireExit(): void {
    // A real child's streams close with it.
    this.current?.stdout.end();
    this.current?.stderr.end();
    for (const listener of this.listeners.values()) listener();
  }
}

const command = { executable: '/usr/bin/node', args: ['-e', 'process.exit(0)'] } as const;

const temporaryRoots: string[] = [];

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  temporaryRoots.push(root);
  return root;
}

afterEach(async (): Promise<void> => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitUntil(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await tick();
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe('merge gate capability runner', () => {
  it('runs the gate as a burst worker and returns its exit code and output', async () => {
    const processes = new FakeProcesses();
    const runner = createMergeGateCommandRunner({ workspaceRoots: async () => [ROOT], processManager: processes });

    const run = runner.run(command, ROOT);
    await processes.waitForStart();
    // The lease is held while the worker runs: nothing may be stopped under it.
    processes.current?.stdout.write('gate output\n');
    await tick();
    processes.fireExit();

    await expect(run).resolves.toMatchObject({ exitCode: 0, stdout: 'gate output\n' });
    expect(processes.specs).toHaveLength(1);
    expect(processes.specs[0]).toMatchObject({ executable: '/usr/bin/node', cwd: ROOT, exposeStdio: true });
  });

  it('reports a non-zero exit as the verdict rather than as a crash', async () => {
    const processes = new FakeProcesses();
    const runner = createMergeGateCommandRunner({ workspaceRoots: async () => [ROOT], processManager: processes });

    const run = runner.run(command, ROOT);
    await processes.waitForStart();
    processes.exitCode = 7;
    processes.current?.stderr.write('gate failed\n');
    await tick();
    processes.fireExit();

    await expect(run).resolves.toMatchObject({ exitCode: 7, stderr: 'gate failed\n' });
  });

  it('starts a fresh attempt for each run, so an earlier verdict is not reused', async () => {
    const processes = new FakeProcesses();
    const runner = createMergeGateCommandRunner({ workspaceRoots: async () => [ROOT], processManager: processes });

    const first = runner.run(command, ROOT);
    await processes.waitForStart();
    // A worker that exits inside the start window is a failed start, not a
    // verdict, so let the attempt reach `ACTIVE` first.
    await tick();
    processes.exitCode = 0;
    processes.fireExit();
    await expect(first).resolves.toMatchObject({ exitCode: 0 });

    const second = runner.run(command, ROOT);
    await processes.waitForStart();
    await tick();
    processes.exitCode = 3;
    processes.fireExit();
    await expect(second).resolves.toMatchObject({ exitCode: 3 });

    expect(processes.specs).toHaveLength(2);
  });

  it('reclaims the worker and reports unavailable when the gate exceeds its deadline', async () => {
    const processes = new FakeProcesses();
    const runner = createMergeGateCommandRunner({
      workspaceRoots: async () => [ROOT],
      processManager: processes,
      timeoutMs: 20,
    });

    const result = await runner.run(command, ROOT);

    expect(result.unavailable).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.stderr).toContain('timeout');
    // The lease is held for the whole run, so the release is what stops the worker.
    await waitUntil(() => processes.stops.length === 1, 'the gate worker to be stopped');
  });

  it('refuses a cwd that is not a registered workspace', async () => {
    const processes = new FakeProcesses();
    const runner = createMergeGateCommandRunner({ workspaceRoots: async () => [], processManager: processes });

    const result = await runner.run(command, ROOT);

    expect(result.unavailable).toBe(true);
    expect(result.stderr).toContain('capability worker cwd');
    expect(processes.specs).toHaveLength(0);
  });

  it('resolves a PATH-provided executable, which execFile used to resolve too', async () => {
    const root = await temporaryRoot('gate-workspaces-');
    const scripts = await temporaryRoot('gate-path-');
    await writeFile(path.join(scripts, 'fake-gate'), '#!/bin/sh\nexit 0\n');
    await chmod(path.join(scripts, 'fake-gate'), 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${scripts}${path.delimiter}${previousPath ?? ''}`;
    const processes = new FakeProcesses();
    const runner = createMergeGateCommandRunner({ workspaceRoots: async () => [root], processManager: processes });
    try {
      const run = runner.run({ executable: 'fake-gate', args: [] }, root);
      await processes.waitForStart();
      await tick();
      processes.fireExit();
      await expect(run).resolves.toMatchObject({ exitCode: 0 });
      expect(processes.specs[0]?.executable).toBe(path.join(scripts, 'fake-gate'));
    } finally {
      process.env.PATH = previousPath;
    }
  });

  it('reports unavailable when a bare executable is not on PATH', async () => {
    const processes = new FakeProcesses();
    const runner = createMergeGateCommandRunner({ workspaceRoots: async () => [ROOT], processManager: processes });

    const result = await runner.run({ executable: 'gate-that-does-not-exist', args: [] }, ROOT);

    expect(result.unavailable).toBe(true);
    expect(result.stderr).toContain('could not be resolved on PATH');
    expect(processes.specs).toHaveLength(0);
  });

  it('accepts a nested cwdRelative inside the workspace, as the policy allows', async () => {
    const root = await temporaryRoot('gate-nested-');
    const nested = path.join(root, 'apps', 'cli');
    await mkdir(nested, { recursive: true });
    const processes = new FakeProcesses();
    const runner = createMergeGateCommandRunner({ workspaceRoots: async () => [root], processManager: processes });

    const run = runner.run(command, nested);
    await processes.waitForStart();
    await tick();
    processes.fireExit();
    await expect(run).resolves.toMatchObject({ exitCode: 0 });
    expect(processes.specs[0]?.cwd).toBe(await realpath(nested));
  });

  it('refuses a sibling root that only shares a prefix with the workspace', async () => {
    const root = await temporaryRoot('gate-root-');
    const sibling = await temporaryRoot('gate-root-sibling-');
    const processes = new FakeProcesses();
    const runner = createMergeGateCommandRunner({ workspaceRoots: async () => [root], processManager: processes });

    const result = await runner.run(command, sibling);

    expect(result.unavailable).toBe(true);
    expect(processes.specs).toHaveLength(0);
  });

  it('aborts an in-flight gate on close so the worker does not outlive the runtime', async () => {
    const processes = new FakeProcesses();
    const runner = createMergeGateCommandRunner({ workspaceRoots: async () => [ROOT], processManager: processes });

    const run = runner.run(command, ROOT);
    await processes.waitForStart();
    await tick();
    await runner.close();

    const result = await run;
    expect(result.unavailable).toBe(true);
    expect(result.stderr).toContain('aborted');
    await waitUntil(() => processes.stops.length === 1, 'the aborted gate to be stopped');
  });

  it('is registered under one id with a burst manifest', async () => {
    const processes = new FakeProcesses();
    const runner = createMergeGateCommandRunner({ workspaceRoots: async () => [ROOT], processManager: processes });

    const run = runner.run(command, ROOT);
    await processes.waitForStart();
    await tick();
    processes.fireExit();
    await run;

    expect(MERGE_GATE_CAPABILITY_ID).toBe('merge-verification-gate');
  });
});
