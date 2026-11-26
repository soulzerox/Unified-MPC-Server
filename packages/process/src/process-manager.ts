import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { appError, err, ok, type Result } from '@unified-mpc/domain';
import { PathExecutableResolver, type ExecutableResolver } from './executable-resolver.js';
import { LogRingBuffer } from './ring-buffer.js';
import { createProcessTreeTerminator, type ProcessTreeTerminator } from './process-tree.js';
import { createPosixProcessIdentityProbe, type PosixProcessIdentityProbe } from './posix-process-identity.js';
import { createSpawnInvocationFactory, type SpawnInvocationFactory } from './spawn-invocation.js';
import type { LogQuery, ManagedProcess, ManagedProcessRecoveryIdentity, ManagedProcessStart, ManagedProcessState, ProcessLogResult } from './process-types.js';

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_TIMEOUT_MS = 4 * 60 * 60 * 1000;
const START_CANCELLATION_RETRY_MS = 250;

export const DEFAULT_MAX_ACTIVE_MANAGED_PROCESSES = 24;

/**
 * A finished process is kept so its status and logs stay readable after it exits,
 * but only the newest few: the record map is the one structure that would
 * otherwise grow for the life of the runtime, and each entry pins a child handle,
 * its spec and up to `MAX_PROCESS_LOG_BYTES` of ring buffer.
 */
export const MAX_RETAINED_TERMINAL_RECORDS = 64;
export const MAX_RETAINED_TERMINAL_LOG_BYTES = 16 * 1024 * 1024;

/**
 * Cap on what a child's caller-facing `exposeStdio` copies may buffer together
 * while their consumers are not reading. The ceiling is per child, so stdout
 * and stderr share it rather than each getting one. Past it the copies end and
 * the child is stopped: a stalled reader gets EOF instead of the runtime holding
 * the child's whole output, and the next acquire cannot attach to pipes whose
 * buffered prefix it would replay.
 */
export const MAX_TEE_BUFFER_BYTES = 8 * 1024 * 1024;

export interface ProcessManagerRecoveryOptions {
  readonly platform?: NodeJS.Platform;
  readonly processStartedAt?: PosixProcessIdentityProbe;
}

interface ManagedRecord {
  readonly processId: string;
  readonly child: ChildProcess;
  readonly spec: ManagedProcessStart;
  readonly startedAt: string;
  readonly logs: LogRingBuffer;
  state: ManagedProcessState;
  finishedAt?: string;
  exitCode?: number;
  errorMessage?: string;
  timer?: ReturnType<typeof setTimeout>;
  stopRequested?: 'stopped' | 'timed_out';
  terminationAttempt?: Promise<boolean>;
  terminationTarget?: 'stopped' | 'timed_out';
  terminationVerified?: Promise<void>;
  resolveTerminationVerified?: () => void;
  exitListeners?: Set<() => void>;
  /** Caller-facing copies of the pipes, present only for `exposeStdio`. */
  tee?: { readonly stdout: PassThrough; readonly stderr: PassThrough };
}

export class ProcessManager {
  private readonly records = new Map<string, ManagedRecord>();

  private readonly recoveryPlatform: NodeJS.Platform;
  private readonly processStartedAt: PosixProcessIdentityProbe | undefined;

  public constructor(
    private readonly terminator: ProcessTreeTerminator = createProcessTreeTerminator(),
    private readonly executableResolver: ExecutableResolver = new PathExecutableResolver(),
    private readonly maxActiveProcesses: number = DEFAULT_MAX_ACTIVE_MANAGED_PROCESSES,
    private readonly invocationFactory: SpawnInvocationFactory = createSpawnInvocationFactory(),
    recoveryOptions: ProcessManagerRecoveryOptions = {},
  ) {
    this.recoveryPlatform = recoveryOptions.platform ?? process.platform;
    this.processStartedAt = recoveryOptions.processStartedAt
      ?? (isPosixRecoveryPlatform(this.recoveryPlatform)
        ? createPosixProcessIdentityProbe(this.recoveryPlatform)
        : undefined);
  }

  public async start(
    spec: ManagedProcessStart,
    signal?: AbortSignal,
    onCreated?: (process: ManagedProcess) => void,
  ): Promise<Result<ManagedProcess>> {
    const activeProcesses = this.activeProcessCount();
    if (activeProcesses >= this.maxActiveProcesses) {
      return err(appError('CONFLICT', `Too many managed processes are already active (${activeProcesses}/${this.maxActiveProcesses}); wait for existing work or stop a process before starting another.`, true));
    }
    const validation = this.validateSpec(spec);
    if (!validation.ok) return validation;
    if (isAborted(signal)) return cancelledStart();
    const resolvedExecutable = await this.executableResolver.resolve(spec.executable);
    if (isAborted(signal)) return cancelledStart();
    if (!resolvedExecutable.ok) return resolvedExecutable;
    const invocation = this.invocationFactory.create(resolvedExecutable.value, spec.args);
    if (!invocation.ok) return invocation;
    if (isAborted(signal)) return cancelledStart();
    const processId = randomUUID();
    const child = spawn(invocation.value.executable, [...invocation.value.args], {
      cwd: spec.cwd,
      env: { ...createSafeEnvironment(process.env), ...(spec.env ?? {}) },
      shell: false,
      detached: process.platform !== 'win32',
      windowsHide: true,
      ...(invocation.value.windowsVerbatimArguments === undefined ? {} : { windowsVerbatimArguments: invocation.value.windowsVerbatimArguments }),
    });
    const record: ManagedRecord = {
      processId,
      child,
      spec,
      startedAt: new Date().toISOString(),
      logs: new LogRingBuffer(),
      state: 'starting',
    };
    // The pipes are read here, once, before any caller can see them: the ring
    // buffer and the tee are fed from the same chunk, so a caller that pauses
    // its copy cannot stall diagnostics.
    const tee = spec.exposeStdio === true
      ? { stdout: new PassThrough(), stderr: new PassThrough() }
      : undefined;
    if (tee !== undefined) record.tee = tee;
    // Reached through `record.tee` rather than the captured `tee`: a chunk that
    // lands after `endTee` would otherwise be written into an ended stream and
    // throw `ERR_STREAM_WRITE_AFTER_END` inside a `'data'` handler.
    child.stdout?.on('data', (chunk: Buffer) => {
      record.logs.append('stdout', chunk.toString('utf8'));
      if (record.tee !== undefined) this.teeChunk(record, record.tee.stdout, chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      record.logs.append('stderr', chunk.toString('utf8'));
      if (record.tee !== undefined) this.teeChunk(record, record.tee.stderr, chunk);
    });
    this.records.set(processId, record);
    onCreated?.(this.snapshot(record, tee));
    child.once('error', (error: Error & { code?: string }) => this.handleError(record, error));
    child.once('close', (exitCode: number | null) => this.handleClose(record, exitCode));

    return new Promise((resolve) => {
      let settled = false;
      let cancellationRequested = false;
      let cancellationInProgress = false;
      const settle = (result: Result<ManagedProcess>): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        resolve(result);
      };
      const onAbort = (): void => {
        if (settled) return;
        cancellationRequested = true;
        if (cancellationInProgress) return;
        const pid = record.child.pid;
        if (pid === undefined) return;
        cancellationInProgress = true;
        void (async (): Promise<void> => {
          let verified = false;
          while (!verified) {
            verified = await this.tryTerminate(record, 'stopped');
            if (!verified) {
              if (!isChildLive(record.child)) await this.waitForVerifiedTermination(record);
              await delay(START_CANCELLATION_RETRY_MS);
            }
          }
          settle(cancelledStart());
        })();
      };
      child.once('spawn', () => {
        if (cancellationRequested || isAborted(signal)) {
          onAbort();
          return;
        }
        if (record.state === 'starting') record.state = 'running';
        const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        // `0` is "no wall-clock cap": no timer, so nothing schedules a kill.
        if (timeoutMs > 0) record.timer = setTimeout(() => { void this.timeout(record); }, timeoutMs);
        settle(ok(this.snapshot(record)));
      });
      child.once('error', (error: Error & { code?: string }) => {
        if (cancellationRequested) {
          settle(cancelledStart());
          return;
        }
        settle(err(error.code === 'ENOENT' ? appError('EXECUTABLE_NOT_FOUND', 'Executable was not found') : appError('INTERNAL_ERROR', 'Process could not start')));
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      if (isAborted(signal)) onAbort();
    });
  }

  public status(processId: string): Result<ManagedProcess> {
    const record = this.records.get(processId);
    return record === undefined ? err(appError('PROCESS_NOT_FOUND', 'Process was not found')) : ok(this.snapshot(record));
  }

  /**
   * Report an exit the caller did not order. `handleClose` also runs for a kill
   * this manager was asked to perform, so the listener is a reporter: it does
   * not decide whether the exit was wanted, and it must not be able to break the
   * manager's bookkeeping. One notification per process, and a subscribe to a
   * process that is already terminal replays immediately — a worker that dies
   * inside the start window would otherwise be invisible without a poll. An
   * unknown id keeps the caller's no-op unsubscribe rather than inventing a
   * subscription that can never fire.
   */
  public onExit(processId: string, listener: () => void): () => void {
    const record = this.records.get(processId);
    if (record === undefined) return () => {};
    if (isTerminal(record.state)) {
      try {
        listener();
      } catch {
        // Replay is a report; a throwing listener is the caller's bug.
      }
      return () => {};
    }
    const listeners = record.exitListeners ?? new Set<() => void>();
    record.exitListeners = listeners;
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  public async recoveryIdentity(processId: string): Promise<Result<ManagedProcessRecoveryIdentity>> {
    const record = this.records.get(processId);
    if (record === undefined) return err(appError('PROCESS_NOT_FOUND', 'Process was not found'));
    if (isVerifiedTerminal(record.state) || !isChildLive(record.child)) {
      return err(appError('CONFLICT', 'Managed process is no longer live enough to capture a restart identity', true, {
        reason: 'process_not_live',
        processId,
      }));
    }
    if (!isPosixRecoveryPlatform(this.recoveryPlatform) || this.processStartedAt === undefined) {
      return err(appError('CONFLICT', 'Managed process restart identity is unavailable on this platform', true, {
        reason: 'platform_unsupported',
        platform: this.recoveryPlatform,
      }));
    }
    const pid = record.child.pid;
    if (!Number.isSafeInteger(pid) || (pid ?? 0) <= 0) {
      return err(appError('CONFLICT', 'Managed process host identity is not available yet', true, {
        reason: 'pid_unavailable',
        processId,
      }));
    }
    try {
      const processStartedAt = await this.processStartedAt(pid as number);
      if (processStartedAt === null) {
        return err(appError('CONFLICT', 'Managed process host identity can no longer be verified', true, {
          reason: 'identity_unavailable',
          processId,
        }));
      }
      return ok({
        processId,
        platform: this.recoveryPlatform,
        pid: pid as number,
        processStartedAt,
      });
    } catch {
      return err(appError('CONFLICT', 'Managed process host identity probe failed', true, {
        reason: 'probe_failed',
        processId,
      }));
    }
  }

  public list(): readonly ManagedProcess[] {
    return [...this.records.values()].map((record) => this.snapshot(record));
  }

  public logs(processId: string, query: LogQuery): Result<ProcessLogResult> {
    const record = this.records.get(processId);
    if (record === undefined) return err(appError('PROCESS_NOT_FOUND', 'Process was not found'));
    if (query.tailLines !== undefined && (!Number.isInteger(query.tailLines) || query.tailLines < 1 || query.tailLines > 10000)) {
      return err(appError('INVALID_INPUT', 'Log tail limit is invalid'));
    }
    if (query.sinceSequence !== undefined && (!Number.isInteger(query.sinceSequence) || query.sinceSequence < 0)) {
      return err(appError('INVALID_INPUT', 'Log sequence cursor is invalid'));
    }
    return ok(record.logs.read(query));
  }

  public async stop(processId: string, autoRetry = false): Promise<Result<void>> {
    const record = this.records.get(processId);
    if (record === undefined) return err(appError('PROCESS_NOT_FOUND', 'Process was not found'));
    if (record.state !== 'termination_unverified' && isTerminal(record.state)) return ok(undefined);
    const targetState = record.terminationTarget ?? 'stopped';
    let verified = await this.tryTerminate(record, targetState);
    while (!verified && autoRetry && isChildLive(record.child)) {
      await delay(START_CANCELLATION_RETRY_MS);
      verified = await this.tryTerminate(record, targetState);
    }
    if (!verified) await this.waitForVerifiedTermination(record);
    return ok(undefined);
  }

  private activeProcessCount(): number {
    return [...this.records.values()].filter((record) => (
      record.state === 'starting' || record.state === 'running' || record.state === 'termination_unverified'
    )).length;
  }

  private validateSpec(spec: ManagedProcessStart): Result<void> {
    if (typeof spec.executable !== 'string' || spec.executable.trim().length === 0 || !Array.isArray(spec.args) || !spec.args.every((arg) => typeof arg === 'string')) {
      return err(appError('INVALID_INPUT', 'Executable and args are required'));
    }
    if (typeof spec.cwd !== 'string' || !path.isAbsolute(spec.cwd)) {
      return err(appError('INVALID_INPUT', 'Process cwd must be an absolute path'));
    }
    const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_TIMEOUT_MS) {
      return err(appError('INVALID_INPUT', 'Process timeout is invalid'));
    }
    if (spec.exposeStdio !== undefined && typeof spec.exposeStdio !== 'boolean') {
      return err(appError('INVALID_INPUT', 'Process exposeStdio must be a boolean'));
    }
    if (spec.env !== undefined) {
      // A NUL in a name or in a value makes `spawn` throw synchronously
      // (`ERR_INVALID_ARG_VALUE`), and a name holding `=` cannot be expressed in
      // a POSIX environment at all, so both must fail here as a Result instead of
      // escaping the contract.
      // A `Map`, a `Date` or a class instance has no enumerable own entries, so it
      // would silently spawn with no caller env at all: refuse it instead.
      const prototype = typeof spec.env === 'object' && spec.env !== null ? Object.getPrototypeOf(spec.env) : undefined;
      const isPlain = prototype === Object.prototype || prototype === null;
      const valid = isPlain
        && Object.entries(spec.env).every(([key, value]) => key.trim().length > 0
          && !key.includes('=')
          && !key.includes('\0')
          && typeof value === 'string'
          && !value.includes('\0'));
      if (!valid) return err(appError('INVALID_INPUT', 'Process env must be a plain object mapping non-empty names to NUL-free strings'));
    }
    return ok(undefined);
  }

  private handleError(record: ManagedRecord, error: Error & { code?: string }): void {
    if (record.stopRequested === undefined && !isTerminal(record.state)) this.finish(record, 'failed');
    if (error.code !== 'ENOENT') record.exitCode = -1;
    this.endTee(record);
  }

  private handleClose(record: ManagedRecord, exitCode: number | null): void {
    if (record.stopRequested === undefined && !isTerminal(record.state)) this.finish(record, 'exited');
    if (record.exitCode === undefined && exitCode !== null) record.exitCode = exitCode;
    this.endTee(record);
    this.notifyExit(record);
  }

  /** A dead child cannot produce more output, so the caller's copies must end too. */
  private endTee(record: ManagedRecord): void {
    const tee = record.tee;
    if (tee === undefined) return;
    delete record.tee;
    tee.stdout.end();
    tee.stderr.end();
  }

  /**
   * Feed one caller-facing copy, bounded. A consumer that stops reading would
   * otherwise buffer the child's whole output in the `PassThrough`; past the cap
   * the copies end so the consumer sees EOF rather than the runtime growing
   * without a ceiling. The log ring keeps the output either way.
   *
   * The ceiling is per child: stdout and stderr are summed, so a worker writing
   * both cannot pin twice the budget. Ending one copy and leaving the other to
   * keep filling would make the aggregate cap a per-stream one in disguise.
   *
   * The child is stopped too. Ending only the copy would leave a live worker
   * whose pipes no session can use: the next consumer replays the buffered
   * prefix, then reaches EOF while the child keeps writing. A stop is observable
   * (the supervisor records `worker-exited` and the capability is `FAILED`, so a
   * caller recycles it) instead of handing out pipes that fail a handshake.
   */
  private teeChunk(record: ManagedRecord, stream: PassThrough, chunk: Buffer): void {
    if (stream.writableEnded || stream.destroyed) return;
    stream.write(chunk);
    const tee = record.tee;
    if (tee === undefined) return;
    // A paused Transform keeps its readable side near the high-water mark and queues
    // the rest on the writable side, so both sides make up what a stalled consumer
    // would otherwise pin.
    const buffered = tee.stdout.readableLength + tee.stdout.writableLength
      + tee.stderr.readableLength + tee.stderr.writableLength;
    if (buffered <= MAX_TEE_BUFFER_BYTES) return;
    tee.stdout.end();
    tee.stderr.end();
    void this.stop(record.processId);
  }

  private notifyExit(record: ManagedRecord): void {
    const listeners = record.exitListeners;
    if (listeners === undefined || listeners.size === 0) return;
    delete record.exitListeners;
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // A reporter must not be able to break the manager's own bookkeeping.
      }
    }
  }

  private async timeout(record: ManagedRecord): Promise<void> {
    if (record.state !== 'running' || record.stopRequested !== undefined) return;
    await this.tryTerminate(record, 'timed_out');
  }

  private async tryTerminate(record: ManagedRecord, targetState: 'stopped' | 'timed_out'): Promise<boolean> {
    if (isVerifiedTerminal(record.state)) return true;
    if (record.terminationAttempt !== undefined) return record.terminationAttempt;
    const attempt = this.performTermination(record, targetState);
    record.terminationAttempt = attempt;
    try {
      return await attempt;
    } finally {
      if (record.terminationAttempt === attempt) delete record.terminationAttempt;
    }
  }

  private async performTermination(record: ManagedRecord, targetState: 'stopped' | 'timed_out'): Promise<boolean> {
    record.terminationTarget = targetState;
    record.stopRequested = targetState;
    if (record.timer !== undefined) clearTimeout(record.timer);
    const pid = record.child.pid;
    if (pid === undefined) {
      delete record.stopRequested;
      this.markTerminationUnverified(record, targetState === 'timed_out'
        ? 'Timed-out process termination could not be verified'
        : 'Process termination could not be verified');
      return false;
    }
    try {
      await this.terminator.stop(record.child, pid);
      this.finish(record, targetState);
      return true;
    } catch {
      delete record.stopRequested;
      this.markTerminationUnverified(record, targetState === 'timed_out'
        ? 'Timed-out process termination could not be verified'
        : 'Process termination could not be verified');
      return false;
    }
  }

  private finish(record: ManagedRecord, state: ManagedProcessState): void {
    record.state = state;
    // A verified stop can land without a `close` event of its own, and a caller
    // waiting on the copy must not wait forever.
    this.endTee(record);
    delete record.stopRequested;
    delete record.errorMessage;
    delete record.terminationTarget;
    record.finishedAt = new Date().toISOString();
    if (record.timer !== undefined) clearTimeout(record.timer);
    record.resolveTerminationVerified?.();
    delete record.resolveTerminationVerified;
    delete record.terminationVerified;
    this.pruneTerminalRecords(record);
  }

  /**
   * Evict the oldest finished records once the retained set outgrows its bounds.
   *
   * Candidates are records in a verified terminal state with no exit listener
   * still waiting; an empty set is what an unsubscribed listener leaves behind,
   * and it must not pin the record. The record that just finished is kept even
   * when it alone exceeds the budget. A live record is never a candidate, and neither is one in
   * `termination_unverified`: `stop` may still be waiting on it, so evicting it
   * would strand that waiter. Such a record stays until a later stop attempt
   * resolves it, which means a host that keeps failing verification without
   * retrying retains one record per failed attempt — known, and left alone here
   * because bounding it needs a resolver-aware rule rather than this ordering.
   *
   * A caller that kept only the id of an evicted process gets
   * `PROCESS_NOT_FOUND`, the same answer a restarted host gives. A live log tee
   * is not tracked on the record either, so an evicted id also stops answering
   * `logs`; the stream the caller already holds keeps working.
   */
  private pruneTerminalRecords(newest: ManagedRecord): void {
    const evictable = [...this.records.values()]
      .filter((record) => record !== newest
        && isVerifiedTerminal(record.state)
        // A listener that unsubscribed leaves an empty set; treating it as
        // "someone is still waiting" would retain one record per activation.
        && (record.exitListeners === undefined || record.exitListeners.size === 0))
      .sort((left, right) => (left.finishedAt ?? '').localeCompare(right.finishedAt ?? ''));
    let count = evictable.length + 1;
    let bytes = newest.logs.byteLength
      + evictable.reduce((total, record) => total + record.logs.byteLength, 0);
    for (const record of evictable) {
      if (count <= MAX_RETAINED_TERMINAL_RECORDS && bytes <= MAX_RETAINED_TERMINAL_LOG_BYTES) return;
      this.records.delete(record.processId);
      count -= 1;
      bytes -= record.logs.byteLength;
    }
  }

  private markTerminationUnverified(record: ManagedRecord, errorMessage: string): void {
    record.state = 'termination_unverified';
    record.errorMessage = errorMessage;
    delete record.finishedAt;
    if (record.timer !== undefined) clearTimeout(record.timer);
    if (record.terminationVerified === undefined) {
      record.terminationVerified = new Promise<void>((resolve) => { record.resolveTerminationVerified = resolve; });
    }
  }

  private waitForVerifiedTermination(record: ManagedRecord): Promise<void> {
    if (isVerifiedTerminal(record.state)) return Promise.resolve();
    if (record.terminationVerified === undefined) {
      record.terminationVerified = new Promise<void>((resolve) => { record.resolveTerminationVerified = resolve; });
    }
    return record.terminationVerified;
  }

  private snapshot(record: ManagedRecord, tee?: { readonly stdout: PassThrough; readonly stderr: PassThrough }): ManagedProcess {
    const { stdin } = record.child;
    return {
      processId: record.processId,
      executable: record.spec.executable,
      args: [...record.spec.args],
      cwd: record.spec.cwd,
      state: record.state,
      startedAt: record.startedAt,
      ...(record.finishedAt === undefined ? {} : { finishedAt: record.finishedAt }),
      ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }),
      ...(record.errorMessage === undefined ? {} : { error: record.errorMessage }),
      ...(tee === undefined || stdin === null ? {} : { stdin }),
      ...(tee === undefined ? {} : { stdout: tee.stdout, stderr: tee.stderr }),
    };
  }
}

function isTerminal(state: ManagedProcessState): boolean {
  return state === 'exited' || state === 'failed' || state === 'stopped' || state === 'timed_out' || state === 'termination_unverified';
}

function isVerifiedTerminal(state: ManagedProcessState): boolean {
  return state === 'exited' || state === 'failed' || state === 'stopped' || state === 'timed_out';
}

function cancelledStart(): Result<never> {
  return err(appError('PROCESS_TIMEOUT', 'Process start was cancelled before launch completed', true));
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isChildLive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}



function isPosixRecoveryPlatform(platform: NodeJS.Platform): platform is 'linux' | 'darwin' {
  return platform === 'linux' || platform === 'darwin';
}


function createSafeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = new Set([
    'PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
    'HOME', 'LANG', 'LC_ALL', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)',
    // Preserve non-secret POSIX desktop-session handles for UI processes.
    'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'XDG_SESSION_TYPE', 'DBUS_SESSION_BUS_ADDRESS',
    'XDG_CURRENT_DESKTOP', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'PULSE_SERVER', 'PIPEWIRE_REMOTE', 'AT_SPI_BUS_ADDRESS',
    'GDK_BACKEND', 'QT_QPA_PLATFORM',
  ].map((key) => process.platform === 'win32' ? key.toLowerCase() : key));
  return Object.fromEntries(Object.entries(source).filter(([key, value]) => {
    const normalizedKey = process.platform === 'win32' ? key.toLowerCase() : key;
    return allowed.has(normalizedKey) && value !== undefined;
  }));
}
