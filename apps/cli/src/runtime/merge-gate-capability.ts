import { constants as fsConstants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';

import {
  CapabilityRegistry,
  CapabilitySupervisor,
  type CapabilityManifest,
  type CapabilityManifestInput,
  type CapabilityProcessPort,
  type CapabilityWorkerSpec,
  type ResolveWorkerCwd,
} from '@unified-mpc/capabilities';
import { appError, err, ok, type Result } from '@unified-mpc/domain';
import type { ResourcePressureProbe } from '@unified-mpc/workspace';

import { createCapabilityPressureDriver, type CapabilityPressureDriver } from './capability-pressure.js';
import {
  LOCAL_GATE_TIMEOUT_MS,
  MAX_COMMAND_OUTPUT_BYTES,
  type VerificationCommandResult,
  type VerificationCommandRunner,
} from './merge-verification-runner.js';

/**
 * The local merge gate as a supervised `burst` capability (#133 phase 4, #142).
 *
 * The gate used to be an `execFile` call beside the capability runtime, so a heavy
 * check held none of the runtime's accounting: not the registry's state, not the
 * supervisor's crash window, not the pipes. It is now a worker whose own exit is
 * the verdict — the supervisor routes it through `complete(id, exitCode)`, the
 * registry keeps the code in `health().lastExitCode`, and this module reads it
 * through `waitForExit`.
 *
 * Rules that decide whether this is safe, and are tested in
 * `merge-gate-capability.test.ts`:
 *
 * - the lease is held for the whole run, so a pressure mark can only complete
 *   after this caller lets go, never under a running gate;
 * - the gate's own command shape is preserved: a PATH-resolved executable is
 *   resolved to the absolute path the supervisor requires, and a nested
 *   `cwdRelative` is accepted as long as it stays inside a registered workspace;
 * - a non-zero exit is a *verdict*, not a crash: it never counts toward the crash
 *   loop, so a failing gate stays runnable;
 * - capture is bounded and non-destructive: reading past the limit stops
 *   appending but keeps draining, so a chatty gate cannot block on a full pipe;
 * - a timeout or a client abort returns `unavailable` and lets the lease go in
 *   `finally`; with `idleTtlMs: 0` that release *is* the stop, which is the only
 *   order the registry allows — a lease forbids a kill while it is held;
 * - `close()` aborts any run still in flight, because a detached worker must not
 *   outlive the runtime and keep writing into a checkout the next verification is
 *   about to inspect;
 * - `critical` pressure may ask for this lane's eviction: the sweep marks the
 *   leased id, `requestEviction` aborts the running gate, and the gate settles as
 *   `unavailable` — a closed gate, not a killed receipt;
 * - one gate at a time is deliberate. `verification_heavy` admits a single
 *   exact-head verification, so a second concurrent lane reports `unavailable`
 *   instead of starting a second worker on the one id;
 * - evidence can be empty for a gate so fast that it exits between `acquire` and
 *   the pipes read: the exit code is still its verdict, and the supervisor clears
 *   `record.pipes` on exit, so there is no stream left to drain.
 */

export const MERGE_GATE_CAPABILITY_ID = 'merge-verification-gate';

export const MERGE_GATE_MANIFEST: CapabilityManifestInput = {
  id: MERGE_GATE_CAPABILITY_ID,
  provides: ['merge_verification_gate'],
  runtimeKind: 'native-worker',
  activation: 'burst',
  costClass: 'large',
  // A burst worker ends with its own run, so there is no window in which it is
  // warm and reclaimable.
  idleTtlMs: 0,
  startupTimeoutMs: 30_000,
  shutdownTimeoutMs: 10_000,
  recyclable: true,
  generationFenced: false,
};

export interface MergeGateCommandRunnerOptions {
  /**
   * Every workspace root a gate may run in. A gate's cwd is always a root the
   * exact-head verifier could have accepted, or a directory inside one.
   */
  readonly workspaceRoots: () => Promise<readonly string[]>;
  readonly timeoutMs?: number;
  /** Injected only so a test can avoid spawning a real child. */
  readonly processManager?: CapabilityProcessPort;
  /** Injected only so a test can drive the pressure tier without real memory. */
  readonly probe?: ResourcePressureProbe;
  /** Injected only so a test can keep the sweep off the real clock. */
  readonly pressureIntervalMs?: number;
  /** A release the registry refused has no caller to return to. */
  readonly onError?: (error: unknown) => void;
}

/** A gate runner that can also stop the worker it owns at host shutdown. */
export interface MergeGateCommandRunner extends VerificationCommandRunner {
  /**
   * One pressure sweep, the same tick the interval runs: warm-idle reclaim, then
   * a `critical` mark on this lane's leased id, which settles as a closed gate.
   */
  sweepPressure(): Promise<void>;
  /** Aborts in-flight gates, waits briefly for their leases, then sweeps. */
  close(): Promise<void>;
}

interface MergeGateRuntime {
  readonly registry: CapabilityRegistry;
  readonly supervisor: CapabilitySupervisor;
  readonly manifest: CapabilityManifest;
  readonly driver: CapabilityPressureDriver;
}

export function createMergeGateCommandRunner(options: MergeGateCommandRunnerOptions): MergeGateCommandRunner {
  const timeoutMs = options.timeoutMs ?? LOCAL_GATE_TIMEOUT_MS;
  let runtime: Promise<Result<MergeGateRuntime>> | undefined;
  const ensureRuntime = (): Promise<Result<MergeGateRuntime>> => {
    runtime ??= createMergeGateRuntime(options, abortActive);
    return runtime;
  };
  const running = new Set<Promise<unknown>>();
  const controllers = new Set<AbortController>();
  // `true` only when a gate was actually running, so a release request never
  // claims an eviction it did not perform.
  const abortActive = (): boolean => {
    if (controllers.size === 0) return false;
    for (const controller of controllers) controller.abort(new Error('merge gate lane was reclaimed'));
    return true;
  };

  return {
    async run(command, cwd, signal): Promise<VerificationCommandResult> {
      const controller = new AbortController();
      controllers.add(controller);
      const signals = signal === undefined ? [controller.signal] : [signal, controller.signal];
      const task = (async (): Promise<VerificationCommandResult> => {
        const gate = await ensureRuntime();
        if (!gate.ok) return unavailable(`merge gate capability is unavailable: ${gate.error.message}`);
        return runGate(gate.value, command, cwd, timeoutMs, signals, options.onError);
      })();
      running.add(task);
      try {
        return await task;
      } finally {
        running.delete(task);
        controllers.delete(controller);
      }
    },
    async sweepPressure(): Promise<void> {
      const gate = await ensureRuntime();
      if (gate.ok) await gate.value.driver.tick();
    },
    async close(): Promise<void> {
      for (const controller of controllers) controller.abort(new Error('merge gate runtime is closing'));
      await withDeadline(Promise.allSettled([...running]).then(() => undefined), CLOSE_DEADLINE_MS);
      if (runtime === undefined) return;
      const gate = await runtime.catch(() => undefined);
      if (gate?.ok === true) {
        gate.value.driver.close();
        await gate.value.supervisor.shutdown().catch(() => undefined);
      }
    },
  };
}

/**
 * One registry, one supervisor, one registration, built on first use so a host
 * that never runs a local gate never pays for them.
 */
async function createMergeGateRuntime(
  options: MergeGateCommandRunnerOptions,
  abortActive: () => boolean,
): Promise<Result<MergeGateRuntime>> {
  const holder: { supervisor?: CapabilitySupervisor } = {};
  const registry = new CapabilityRegistry({
    start: (manifest: CapabilityManifest): Promise<Result<void>> =>
      holder.supervisor?.start(manifest) ?? Promise.resolve(ok(undefined)),
    stop: (manifest: CapabilityManifest): Promise<Result<void>> =>
      holder.supervisor?.stop(manifest) ?? Promise.resolve(ok(undefined)),
  });
  const supervisor = new CapabilitySupervisor({
    lifecycle: registry,
    resolveWorkerCwd: createGateCwdResolver(options.workspaceRoots),
    ...(options.processManager === undefined ? {} : { processManager: options.processManager }),
  });
  holder.supervisor = supervisor;

  const registered = await registry.register(MERGE_GATE_MANIFEST);
  if (!registered.ok) return err(registered.error);
  // The gate lane is the only leased id this runtime owns, and the only way a
  // `critical` sweep can end it is the caller's own abort: a lease still forbids
  // a kill, and the release that follows is what stops the worker.
  const driver = createCapabilityPressureDriver({
    registry,
    supervisor,
    ...(options.probe === undefined ? {} : { probe: options.probe }),
    ...(options.pressureIntervalMs === undefined ? {} : { intervalMs: options.pressureIntervalMs }),
    requestEviction: async (id: string): Promise<boolean> =>
      id === MERGE_GATE_CAPABILITY_ID && abortActive(),
    ownsLeasedWorker: (id: string): boolean => id === MERGE_GATE_CAPABILITY_ID,
    onError: options.onError ?? ((error: unknown): void => {
      process.stderr.write(`merge gate pressure sweep failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }),
  });
  driver.start();
  return ok({ registry, supervisor, manifest: registered.value, driver });
}

/**
 * A gate may run in the workspace root or in a `cwdRelative` directory the merge
 * policy names, so a descendant is allowed while a sibling, a parent or a
 * symlinked escape is not. `createWorkerCwdResolver` stays equality-only for the
 * provider, whose launch is always the root it wired.
 */
function createGateCwdResolver(workspaceRoots: () => Promise<readonly string[]>): ResolveWorkerCwd {
  return async (requested: string): Promise<Result<string>> => {
    const resolved = await realpath(requested).catch(() => undefined);
    if (resolved === undefined) {
      return err(appError('INVALID_INPUT', `capability worker cwd ${requested} cannot be resolved`, false));
    }
    for (const root of await workspaceRoots().catch(() => [] as readonly string[])) {
      const canonical = await realpath(root).catch(() => root);
      const prefix = canonical.endsWith(path.sep) ? canonical : `${canonical}${path.sep}`;
      if (resolved === canonical || resolved.startsWith(prefix)) return ok(resolved);
    }
    return err(appError('PERMISSION_DENIED', `capability worker cwd ${resolved} is not inside a registered workspace`, false));
  };
}

/**
 * `execFile` resolved a bare name through `PATH`; the supervisor refuses it, so
 * the same resolution happens here rather than narrowing what a policy may say.
 */
async function resolveExecutable(executable: string, cwd: string): Promise<string | undefined> {
  if (path.isAbsolute(executable)) return executable;
  if (executable.includes(path.sep) || (path.sep === '\\' && executable.includes('/'))) {
    return path.resolve(cwd, executable);
  }
  for (const entry of (process.env.PATH ?? '').split(path.delimiter)) {
    if (entry.length === 0) continue;
    const candidate = path.join(entry, executable);
    if (await isExecutable(candidate)) return candidate;
    if (process.platform === 'win32' && await isExecutable(`${candidate}.exe`)) return `${candidate}.exe`;
  }
  return undefined;
}

async function isExecutable(candidate: string): Promise<boolean> {
  // `X_OK` alone accepts a directory, which `execFile` would have skipped in
  // favour of the real executable further down `PATH`.
  const stats = await stat(candidate).catch(() => undefined);
  if (stats === undefined || !stats.isFile()) return false;
  return access(candidate, fsConstants.X_OK).then(() => true, () => false);
}

async function runGate(
  runtime: MergeGateRuntime,
  command: { readonly executable: string; readonly args: readonly string[] },
  cwd: string,
  timeoutMs: number,
  signals: readonly AbortSignal[],
  onError: ((error: unknown) => void) | undefined,
): Promise<VerificationCommandResult> {
  const { registry, supervisor, manifest } = runtime;
  const executable = await resolveExecutable(command.executable, cwd);
  if (executable === undefined) return unavailable(`merge gate executable ${command.executable} could not be resolved on PATH`);
  // The argv is the run's, not the capability's: one registration, one worker per
  // gate command, and the supervisor replaces it only when nothing can still run.
  const spec: CapabilityWorkerSpec = {
    executable,
    args: [...command.args],
    cwd,
    // The gate's own output is the evidence, so the pipes must reach this caller.
    exposeStdio: true,
    timeoutMs,
  };
  const registered = await supervisor.register(manifest, spec);
  if (!registered.ok) return unavailable(`merge gate worker could not be registered: ${registered.error.message}`);

  const acquired = await registry.acquire(manifest.id);
  if (!acquired.ok) return unavailable(`merge gate worker could not start: ${acquired.error.message}`);
  const lease = acquired.value;

  const pipes = supervisor.pipes(manifest.id);
  const stdout = pipes === undefined ? undefined : captureBounded(pipes.stdout);
  const stderr = pipes === undefined ? undefined : captureBounded(pipes.stderr);

  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
      timer.unref();
    });
    const aborted = new Promise<'aborted'>((resolve) => {
      if (signals.some((signal) => signal.aborted)) {
        resolve('aborted');
        return;
      }
      onAbort = (): void => resolve('aborted');
      for (const signal of signals) signal.addEventListener('abort', onAbort, { once: true });
    });
    const outcome = await Promise.race([
      supervisor.waitForExit(manifest).then((exit) => ({ kind: 'exit' as const, exit })),
      timedOut.then((kind) => ({ kind })),
      aborted.then((kind) => ({ kind })),
    ]);

    if (outcome.kind !== 'exit') {
      // No kill here: the lease is still held, and the release in `finally` is
      // what stops a burst worker (`idleTtlMs: 0`).
      return {
        exitCode: null,
        stdout: stdout?.text() ?? '',
        stderr: `merge gate ${outcome.kind} after ${timeoutMs}ms; the worker is being stopped`,
        unavailable: true,
      };
    }
    await withDeadline(Promise.all([stdout?.ended, stderr?.ended]).then(() => undefined), STREAM_DRAIN_TIMEOUT_MS);
    return {
      exitCode: outcome.exit.exitCode,
      stdout: stdout?.text() ?? '',
      stderr: stderr?.text() ?? '',
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) {
      for (const signal of signals) signal.removeEventListener('abort', onAbort);
    }
    const released = lease.release();
    if (!released.ok) onError?.(released.error);
  }
}

function unavailable(message: string): VerificationCommandResult {
  return { exitCode: null, stdout: '', stderr: message, unavailable: true };
}

/**
 * How long a caller waits for a finished worker's pipes to end before reading
 * what it has. A gate that closed its streams already ends at once.
 */
const STREAM_DRAIN_TIMEOUT_MS = 2_000;

/** How long `close()` waits for an aborted gate to release its lease. */
const CLOSE_DEADLINE_MS = 10_000;

interface CapturedOutput {
  text(): string;
  readonly ended: Promise<void>;
}

/**
 * Bounded, non-destructive tee. Past the limit chunks are dropped but the stream
 * is still drained, so a gate that writes more than the bound cannot block.
 * `readBoundedStream` in `publish-credential-helper.ts` destroys the stream on
 * overflow, which is right for a protocol handshake and wrong for evidence.
 */
function captureBounded(stream: Readable): CapturedOutput {
  const chunks: Buffer[] = [];
  let total = 0;
  stream.on('data', (chunk: Buffer | string) => {
    const remaining = MAX_COMMAND_OUTPUT_BYTES - total;
    if (remaining <= 0) return;
    const buffer: Buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    chunks.push(buffer.length <= remaining ? buffer : buffer.subarray(0, remaining));
    total += Math.min(buffer.length, remaining);
  });
  stream.on('error', () => undefined);
  const ended = new Promise<void>((resolve) => stream.once('end', () => resolve()));
  return { text: (): string => Buffer.concat(chunks).toString('utf8'), ended };
}

async function withDeadline(promise: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref();
  });
  try {
    await Promise.race([promise, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
