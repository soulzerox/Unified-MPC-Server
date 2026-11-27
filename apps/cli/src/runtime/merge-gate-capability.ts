import type { Readable } from 'node:stream';

import {
  CapabilityRegistry,
  CapabilitySupervisor,
  type CapabilityManifest,
  type CapabilityManifestInput,
  type CapabilityProcessPort,
  type CapabilityWorkerSpec,
} from '@unified-mpc/capabilities';
import { err, ok, type Result } from '@unified-mpc/domain';

import { createWorkerCwdResolver } from './capability-pressure.js';
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
 * - the worker runs only in a registered workspace root, because that is where
 *   `runLocalGate` resolved the exact-head checkout to;
 * - a non-zero exit is a *verdict*, not a crash: it never counts toward the crash
 *   loop, so a failing gate stays runnable;
 * - capture is bounded and non-destructive: reading past the limit stops
 *   appending but keeps draining, so a chatty gate cannot block on a full pipe;
 * - a timeout or a client abort returns `unavailable` and lets the lease go in
 *   `finally`; with `idleTtlMs: 0` that release *is* the stop, which is the only
 *   order the registry allows — a lease forbids a kill while it is held.
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
  /** The roots a gate may run in; a gate's cwd is always one of these. */
  readonly workspaceRoots: () => Promise<readonly string[]>;
  readonly timeoutMs?: number;
  /** Injected only so a test can avoid spawning a real child. */
  readonly processManager?: CapabilityProcessPort;
  /** A release the registry refused has no caller to return to. */
  readonly onError?: (error: unknown) => void;
}

interface MergeGateRuntime {
  readonly registry: CapabilityRegistry;
  readonly supervisor: CapabilitySupervisor;
  readonly manifest: CapabilityManifest;
}

export function createMergeGateCommandRunner(options: MergeGateCommandRunnerOptions): VerificationCommandRunner {
  const timeoutMs = options.timeoutMs ?? LOCAL_GATE_TIMEOUT_MS;
  let runtime: Promise<Result<MergeGateRuntime>> | undefined;
  const ensureRuntime = (): Promise<Result<MergeGateRuntime>> => {
    runtime ??= createMergeGateRuntime(options);
    return runtime;
  };

  return {
    async run(command, cwd, signal): Promise<VerificationCommandResult> {
      const gate = await ensureRuntime();
      if (!gate.ok) return unavailable(`merge gate capability is unavailable: ${gate.error.message}`);
      return runGate(gate.value, command, cwd, timeoutMs, signal, options.onError);
    },
  };
}

/**
 * One registry, one supervisor, one registration, built on first use so a host
 * that never runs a local gate never pays for them.
 */
async function createMergeGateRuntime(options: MergeGateCommandRunnerOptions): Promise<Result<MergeGateRuntime>> {
  const holder: { supervisor?: CapabilitySupervisor } = {};
  const registry = new CapabilityRegistry({
    start: (manifest: CapabilityManifest): Promise<Result<void>> =>
      holder.supervisor?.start(manifest) ?? Promise.resolve(ok(undefined)),
    stop: (manifest: CapabilityManifest): Promise<Result<void>> =>
      holder.supervisor?.stop(manifest) ?? Promise.resolve(ok(undefined)),
  });
  const supervisor = new CapabilitySupervisor({
    lifecycle: registry,
    // No install root: a merge gate only ever runs in a registered workspace.
    resolveWorkerCwd: createWorkerCwdResolver({ workspaceRoots: options.workspaceRoots }),
    ...(options.processManager === undefined ? {} : { processManager: options.processManager }),
  });
  holder.supervisor = supervisor;

  const registered = await registry.register(MERGE_GATE_MANIFEST);
  if (!registered.ok) return err(registered.error);
  return ok({ registry, supervisor, manifest: registered.value });
}

async function runGate(
  runtime: MergeGateRuntime,
  command: { readonly executable: string; readonly args: readonly string[] },
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  onError: ((error: unknown) => void) | undefined,
): Promise<VerificationCommandResult> {
  const { registry, supervisor, manifest } = runtime;
  // The argv is the run's, not the capability's: one registration, one worker per
  // gate command, and the supervisor replaces it only when nothing can still run.
  const spec: CapabilityWorkerSpec = {
    executable: command.executable,
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
      if (signal?.aborted === true) {
        resolve('aborted');
        return;
      }
      onAbort = (): void => resolve('aborted');
      signal?.addEventListener('abort', onAbort, { once: true });
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
    if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
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
