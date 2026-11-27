import path from 'node:path';
import type { Readable, Writable } from 'node:stream';

import { appError, err, ok, type Result } from '@unified-mpc/domain';
import { ProcessManager } from '@unified-mpc/process';

import type { CapabilityHealth, CapabilityManifest, CapabilityState } from './capability-registry.js';

/**
 * Phase 2 of the on-demand capability runtime (#133): the worker supervisor.
 *
 * `CapabilityRegistry` decides *when* a capability starts and stops;
 * `CapabilitySupervisor` makes that transition true and reports the outcome
 * back through `CapabilityLifecyclePort`, which the registry implements. The
 * supervisor owns no lifecycle state: the registry stays the only authority for
 * `state`, `leaseCount` and generations, so every lifecycle rule is still
 * testable with a fake clock and no child processes.
 *
 * Three rules shape this module:
 *
 * - **No automatic restart.** Phase 2 never restarts a worker on its own; a
 *   restart is the caller's next `recycle` + `acquire`. Only a crash-loop bound
 *   and attempt deadlines are owned here.
 * - **`cwd` has exactly one enforcement point.** `register` awaits the injected
 *   `resolveWorkerCwd` once and stores the resolved path, so no registered spec
 *   ever holds an unresolved `cwd`.
 * - **A kill is never laundered into a clean stop.** A stop whose termination
 *   cannot be verified is reported as `FAILED` with `stop-unverified`; it is
 *   never reported as `COLD`.
 */

/** One selection input for `evictionPlan`; a registry-only fact passed in. */
export interface EvictionCandidate {
  readonly id: string;
  readonly state: CapabilityState;
  readonly leaseCount: number;
  readonly idleSince: number;
  /** The manifest TTL the clamp compares against. */
  readonly idleTtlMs: number;
  readonly recyclable: boolean;
}

/** Structural, local to this package: no cross-package type import. */
export type PressureTier = 'normal' | 'elevated' | 'critical';

export type WorkerFailure = 'start-failed' | 'worker-exited' | 'stop-unverified';

/** What a diagnosis needs; the log ring buffer stays in `ProcessManager`. */
export interface CapabilityWorkerHealth {
  readonly id: string;
  readonly processId?: string;
  readonly restarts: number;
  readonly crashLoop: boolean;
  /** A kill was attempted and could not be verified within its deadline. */
  readonly stopUnverified?: boolean;
  readonly lastFailure?: WorkerFailure;
}

export interface CapabilityWorkerSpec {
  readonly executable: string;
  readonly args: readonly string[];
  /** Path as requested; `register` resolves it through `resolveWorkerCwd`. */
  readonly cwd: string;
  /**
   * Asks the process manager to hand its pipes to the supervisor. Only a worker
   * that carries a transport needs them; a plain worker keeps the default.
   */
  readonly exposeStdio?: boolean;
  /** Merged over the sanitized base environment by the process manager. */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Wall-clock cap in milliseconds (`0` = no cap). Overrides the default the
   * supervisor derives from the manifest, so a recyclable worker that serves
   * calls continuously is not SIGKILLed by a fixed hour.
   */
  readonly timeoutMs?: number;
}

/**
 * The one enforcement point for `cwd`. The supervisor has no default and
 * refuses to register without it, so "inside a registered workspace" is checked
 * by the module that owns workspace roots, not assumed from a comment.
 */
export type ResolveWorkerCwd = (requested: string) => Promise<Result<string>>;

/**
 * The supervisor's whole view of the lifecycle. Implemented by
 * `CapabilityRegistry`; injected so the supervisor holds no reference to the
 * class and a fake port can drive every test.
 */
export interface CapabilityLifecyclePort {
  /** One entry per registered capability, including its own TTL. */
  snapshot(): readonly EvictionCandidate[];
  health(id: string): CapabilityHealth | undefined;
  /**
   * Targeted stop; marks a pending stop when a lease is still held. A
   * `recyclable: false` id is refused without an error, so `shutdown()` skips
   * those ids from `snapshot()`.
   */
  reclaim(id: string): Promise<Result<void>>;
  /**
   * The only writes a death needs: `ACTIVE|WARM_IDLE -> FAILED` for an
   * unrequested exit and `STOPPING -> FAILED` for `stop-unverified`.
   */
  fail(id: string, reason: string): Result<void>;
  /**
   * A `burst` worker that ended its own run: `ACTIVE|WARM_IDLE -> COLD` with the
   * exit code, so a finished check is not a crash. A port that cannot express
   * completion omits it, and the exit is then reported as a death.
   */
  complete?(id: string, exitCode: number | null): Result<void>;
}

/** The outcome of a worker's own exit, as the supervisor observed it. */
export interface CapabilityExit {
  /** Absent when the manager could not report one; never guessed from a signal. */
  readonly exitCode: number | null;
}

/**
 * Structural, exactly the calls the supervisor makes: `ProcessManager`
 * satisfies it, and a test fake can too, which a class-typed option would forbid
 * because the real class carries private fields.
 */
export type CapabilityProcessPort = Pick<ProcessManager, 'start' | 'stop' | 'status' | 'onExit'>;

export interface CapabilitySupervisorOptions {
  readonly now?: () => number;
  /** Required: the only place a spec's `cwd` becomes trusted. */
  readonly resolveWorkerCwd: ResolveWorkerCwd;
  /** Required: the supervisor cannot report an exit or order a stop without it. */
  readonly lifecycle: CapabilityLifecyclePort;
  readonly processManager?: CapabilityProcessPort;
  /** Failure window for crash-loop bounding. */
  readonly crashWindowMs?: number;
  readonly maxCrashRestarts?: number;
  /**
   * One deadline for the whole `shutdown()` sweep, so a hundred idle
   * capabilities cannot add up to a hundred per-manifest windows.
   */
  readonly shutdownDeadlineMs?: number;
}

export type WorkerPipes = {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
};

interface WorkerRecord {
  readonly manifest: CapabilityManifest;
  /** Absent for `in-process`: no process, and the hooks are no-ops. */
  readonly spec?: CapabilityWorkerSpec;
  processId?: string | undefined;
  /** The live pipes of the current worker, kept only for `exposeStdio` specs. */
  pipes?: WorkerPipes | undefined;
  starts: number;
  readonly crashTimes: number[];
  stopUnverified: boolean;
  lastFailure?: WorkerFailure | undefined;
  /** A death delivered inside the `STARTING` window; the `start` hook reports it. */
  pendingDeath: boolean;
  /** The id the live `onExit` subscription belongs to, so a late spawn cannot drop someone else's. */
  subscribedProcessId?: string | undefined;
  unsubscribe?: (() => void) | undefined;
  /** The last exit this record's own listener delivered. */
  lastExit?: CapabilityExit | undefined;
  /** Callers waiting for the next exit of this record. */
  readonly exitWaiters: Array<(exit: CapabilityExit) => void>;
}

const DEFAULT_CRASH_WINDOW_MS = 60_000;
const DEFAULT_MAX_CRASH_RESTARTS = 5;
const DEFAULT_SHUTDOWN_DEADLINE_MS = 10_000;
/** The elevated clamp: the longest warm-idle window pressure leaves alone. */
const ELEVATED_IDLE_TTL_MS = 5_000;
const SHUTDOWN_POLL_MS = 5;

type DeadlineOutcome<T> = { readonly settled: true; readonly value: T } | { readonly settled: false };

/**
 * Races a promise against a deadline. A rejection counts as "not settled", the
 * same bucket as a timeout, because every caller treats that bucket as "the
 * attempt may have failed" and must never read it as a success.
 */
async function raceDeadline<T>(promise: Promise<T>, ms: number): Promise<DeadlineOutcome<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<DeadlineOutcome<T>>((resolve) => {
    timer = setTimeout(() => resolve({ settled: false }), Math.max(0, ms));
  });
  const raced = await Promise.race([
    promise.then(
      (value) => ({ settled: true as const, value }),
      () => ({ settled: false as const }),
    ),
    deadline,
  ]);
  if (timer !== undefined) clearTimeout(timer);
  return raced;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function invalid(message: string): Result<never> {
  return err(appError('INVALID_INPUT', message));
}

function conflict(message: string, details?: Readonly<Record<string, unknown>>): Result<never> {
  return err(appError('CONFLICT', message, true, details));
}

function isBlank(value: string): boolean {
  return value.trim().length === 0;
}

export class CapabilitySupervisor {
  private readonly records = new Map<string, WorkerRecord>();

  /** Ids whose `register` is awaiting `resolveWorkerCwd`, so two can never both win. */
  private readonly registering = new Set<string>();

  /**
   * How many `start` calls per id are between the spawn request and the recorded
   * process id. `ProcessManager.start` awaits executable resolution before it
   * calls `onCreated`, so during that window the record still looks idle. Counted
   * rather than flagged, so one start leaving cannot clear another's window.
   */
  private readonly starting = new Map<string, number>();

  private readonly now: () => number;

  private readonly crashWindowMs: number;

  private readonly maxCrashRestarts: number;

  private readonly shutdownDeadlineMs: number;

  private readonly lifecycle: CapabilityLifecyclePort;

  private readonly processManager: CapabilityProcessPort;

  private readonly resolveWorkerCwd: ResolveWorkerCwd;

  constructor(options: CapabilitySupervisorOptions) {
    this.now = options.now ?? Date.now;
    this.crashWindowMs = options.crashWindowMs ?? DEFAULT_CRASH_WINDOW_MS;
    this.maxCrashRestarts = options.maxCrashRestarts ?? DEFAULT_MAX_CRASH_RESTARTS;
    this.shutdownDeadlineMs = options.shutdownDeadlineMs ?? DEFAULT_SHUTDOWN_DEADLINE_MS;
    this.lifecycle = options.lifecycle;
    this.processManager = options.processManager ?? new ProcessManager();
    this.resolveWorkerCwd = options.resolveWorkerCwd;
  }

  /**
   * Declares how a non-in-process capability is spawned. One registration per id
   * at a time: registering an id again replaces the whole record — manifest and
   * spec — but only while nothing of the previous record can still run, so a
   * per-run argv (a gate check's host-owned command) does not force a fresh id per
   * run. A live or possibly-live worker keeps its record: `processId` is written
   * before `start` resolves and an unrequested exit clears it; a start that is
   * between the spawn request and that write is tracked by `starting`, because
   * `ProcessManager.start` awaits executable resolution first. Both are re-checked
   * after the `cwd` await, so a worker that appeared while the path was resolving
   * keeps its record. The crash window survives a replacement: it belongs to the
   * capability, not to one command.
   *
   * Async because it awaits `resolveWorkerCwd` once and stores the resolved path,
   * so no spec exists with an untrusted `cwd`.
   */
  public async register(manifest: CapabilityManifest, spec?: CapabilityWorkerSpec): Promise<Result<void>> {
    const existing = this.records.get(manifest.id);
    const replaceable = existing !== undefined && this.idleForReplacement(existing);
    if (this.registering.has(manifest.id) || (existing !== undefined && !replaceable)) {
      return conflict(`capability ${manifest.id} already has a worker registration`);
    }
    if (manifest.runtimeKind === 'in-process') {
      if (spec !== undefined) {
        return invalid(`capability ${manifest.id} is in-process and cannot have a worker spec`);
      }
      // An in-process capability has no spec to replace, so a second
      // registration stays the conflict it always was.
      if (existing !== undefined) {
        return conflict(`capability ${manifest.id} already has a worker registration`);
      }
      this.records.set(manifest.id, this.newRecord(manifest));
      return ok(undefined);
    }
    if (spec === undefined) {
      return invalid(`capability ${manifest.id} is ${manifest.runtimeKind} and needs a worker spec`);
    }
    if (isBlank(spec.executable) || !path.isAbsolute(spec.executable)) {
      return invalid(`capability ${manifest.id} needs an absolute executable path`);
    }
    if (spec.args.some(isBlank)) {
      return invalid(`capability ${manifest.id} has a blank argument`);
    }

    // Reserve the id across the await: checking before it and storing after would
    // let two concurrent registrations both return `ok` and the second overwrite.
    this.registering.add(manifest.id);
    try {
      const resolvedCwd = await this.resolveWorkerCwd(spec.cwd);
      if (!resolvedCwd.ok) return resolvedCwd;
      // A `start` may have claimed the id while the path was resolving; its
      // worker is live (or about to be), so replacing the record now would
      // strand it.
      const current = this.records.get(manifest.id);
      if (current !== existing
        || this.starting.has(manifest.id)
        || (current !== undefined && !this.idleForReplacement(current))) {
        return conflict(`capability ${manifest.id} already has a worker registration`);
      }

      this.records.set(manifest.id, {
        // The crash window belongs to the capability, not to one command, so a
        // per-run argv cannot launder a crash loop.
        ...this.newRecord(manifest),
        ...(existing === undefined ? {} : { crashTimes: [...existing.crashTimes] }),
        spec: {
          executable: spec.executable,
          args: [...spec.args],
          cwd: resolvedCwd.value,
          ...(spec.exposeStdio === undefined ? {} : { exposeStdio: spec.exposeStdio }),
          ...(spec.env === undefined ? {} : { env: { ...spec.env } }),
          ...(spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs }),
        },
      });
      return ok(undefined);
    } finally {
      this.registering.delete(manifest.id);
    }
  }

  /** Called by the registry in place of its phase-1 `start` callback. */
  public async start(manifest: CapabilityManifest): Promise<Result<void>> {
    const record = this.records.get(manifest.id);
    if (record === undefined) return invalid(`capability ${manifest.id} has no worker registration`);
    if (record.spec === undefined) return ok(undefined);
    // The bound is a window, not a verdict: once the oldest failure falls out of
    // it the capability may start again without a new supervisor or a reset call.
    const failures = this.failuresInWindow(record);
    if (failures >= this.maxCrashRestarts) {
      return conflict(
        `capability ${manifest.id} is in a crash loop (${failures} failures inside ${this.crashWindowMs}ms); wait for the window to pass before starting again`,
        { reason: 'crash_loop', failures },
      );
    }

    record.pendingDeath = false;
    record.starts += 1;
    const spec = record.spec;
    // A resident worker must not be killed by a fixed hour, so it is the only
    // activation that drops the manager's wall-clock cap by default. A spec may
    // state its own cap; the explicit value wins over that default.
    const startOptions = {
      executable: spec.executable,
      args: [...spec.args],
      cwd: spec.cwd,
      ...(spec.exposeStdio === undefined ? {} : { exposeStdio: spec.exposeStdio }),
      ...(spec.env === undefined ? {} : { env: { ...spec.env } }),
      ...(manifest.recyclable ? {} : { timeoutMs: 0 }),
      ...(spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs }),
    };

    const attempt = record.starts;
    this.starting.set(manifest.id, (this.starting.get(manifest.id) ?? 0) + 1);
    try {
      const spawn = this.processManager.start(startOptions, undefined, (process) => {
        // The pipes are the attempt's, not the id's: a late spawn from an
        // abandoned attempt must not hand its streams to the live worker.
        if (spec.exposeStdio === true && attempt === record.starts
          && process.stdin !== undefined && process.stdout !== undefined && process.stderr !== undefined) {
          record.pipes = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr };
        }
        this.subscribe(record, process.processId, attempt);
      });
      const outcome = await raceDeadline(spawn, manifest.startupTimeoutMs);
      if (!outcome.settled) {
        // `onCreated` may already have handed this attempt's pipes over; a caller
        // must never reach a process this attempt is about to discard.
        if (attempt === record.starts) record.pipes = undefined;
        this.recordFailure(record, 'start-failed');
        void spawn.then(
          (late) => this.discardLateStart(record, late, attempt),
          () => undefined,
        );
        return err(appError('PROCESS_TIMEOUT', `capability ${manifest.id} did not spawn inside ${manifest.startupTimeoutMs}ms`, true, { reason: 'start_timeout' }));
      }
      const started = outcome.value;
      if (!started.ok) {
        // `onCreated` runs before the start promise settles, so a spawn that then
        // fails has already subscribed; leaving it registered would let this
        // attempt's close report a death inside a later attempt's start. Scoped to
        // this attempt for the same reason the listener is.
        if (attempt === record.starts) {
          this.unsubscribe(record);
          record.pipes = undefined;
        }
        this.recordFailure(record, 'start-failed');
        return started;
      }
      if (record.pendingDeath) {
        // The registry writes `ACTIVE` only after this hook resolves, so a death
        // delivered from `onCreated` is reported here instead of being dropped.
        record.pendingDeath = false;
        record.pipes = undefined;
        this.unsubscribe(record);
        this.recordFailure(record, 'worker-exited');
        void this.processManager.stop(started.value.processId);
        return err(appError('CONFLICT', `capability ${manifest.id} exited before its start completed`, true, { reason: 'worker_exited' }));
      }

      record.processId = started.value.processId;
      record.stopUnverified = false;
      return ok(undefined);
    } finally {
      const remaining = (this.starting.get(manifest.id) ?? 1) - 1;
      if (remaining > 0) this.starting.set(manifest.id, remaining);
      else this.starting.delete(manifest.id);
    }
  }

  /**
   * Called by the registry before `STOPPING -> COLD`. Waits at most
   * `shutdownTimeoutMs` for a verified kill.
   */
  public async stop(manifest: CapabilityManifest): Promise<Result<void>> {
    const record = this.records.get(manifest.id);
    if (record === undefined || record.spec === undefined) return ok(undefined);
    const processId = record.processId;
    if (processId === undefined) return ok(undefined);

    // Drop the subscription before ordering the kill: the manager reports the
    // exit it was asked to perform too, and the guard must not depend on which
    // notification lands first.
    this.unsubscribe(record);
    record.pipes = undefined;
    const outcome = await raceDeadline(this.processManager.stop(processId), manifest.shutdownTimeoutMs);
    const status = this.processManager.status(processId);
    const unverified = !outcome.settled
      || !outcome.value.ok
      || (status.ok && status.value.state === 'termination_unverified');

    if (!status.ok) {
      // The process is already gone; nothing was left unverified.
      record.processId = undefined;
      record.stopUnverified = false;
      return ok(undefined);
    }
    if (!unverified) {
      record.processId = undefined;
      record.stopUnverified = false;
      return ok(undefined);
    }

    record.stopUnverified = true;
    record.lastFailure = 'stop-unverified';
    this.lifecycle.fail(manifest.id, 'stop-unverified');
    return err(appError('PROCESS_TIMEOUT', `capability ${manifest.id} stop could not be verified inside ${manifest.shutdownTimeoutMs}ms`, true, { reason: 'stop_unverified' }));
  }

  /**
   * Which ids a `WARM_IDLE` reclaim at this pressure may stop, oldest first.
   * Pure: it starts nothing, stops nothing, holds no timer and reads no state.
   */
  public evictionPlan(tier: PressureTier, snapshot: readonly EvictionCandidate[]): readonly string[] {
    if (tier === 'normal') return [];
    const eligible = snapshot
      .filter((candidate) => candidate.recyclable
        && candidate.leaseCount === 0
        && candidate.state === 'WARM_IDLE'
        && (tier === 'critical'
          || this.now() - candidate.idleSince >= Math.min(candidate.idleTtlMs, ELEVATED_IDLE_TTL_MS)))
      .sort((left, right) => left.idleSince - right.idleSince);
    return eligible.map((candidate) => candidate.id);
  }

  /**
   * Which leased ids a `critical` sweep may ask a holder to give up, oldest
   * first. Separate from `evictionPlan` on purpose: a lease still forbids a
   * kill, so these ids are only *marked* for a stop by `reclaim`, and the stop
   * runs when the holder releases. Pure, like `evictionPlan`.
   */
  public pendingEvictionPlan(tier: PressureTier, snapshot: readonly EvictionCandidate[]): readonly string[] {
    if (tier !== 'critical') return [];
    return snapshot
      .filter((candidate) => candidate.recyclable
        && candidate.leaseCount > 0
        && (candidate.state === 'ACTIVE' || candidate.state === 'WARM_IDLE'))
      .sort((left, right) => left.idleSince - right.idleSince)
      .map((candidate) => candidate.id);
  }

  /**
   * The pipes of a live worker registered with `exposeStdio`, or `undefined` when
   * it is not running. A caller bookkeeping a connection over them must hold a
   * lease: a reclaim stops the process underneath.
   */
  public pipes(id: string): WorkerPipes | undefined {
    return this.records.get(id)?.pipes;
  }

  /** Counts a diagnosis needs; no per-request allocation. */
  public health(): readonly CapabilityWorkerHealth[] {
    return [...this.records.values()].map((record) => ({
      id: record.manifest.id,
      ...(record.processId === undefined ? {} : { processId: record.processId }),
      restarts: Math.max(0, record.starts - 1),
      crashLoop: this.failuresInWindow(record) >= this.maxCrashRestarts,
      ...(record.stopUnverified ? { stopUnverified: true } : {}),
      ...(record.lastFailure === undefined ? {} : { lastFailure: record.lastFailure }),
    }));
  }

  /** Bounded graceful stop of every id the registry reports as stoppable. */
  public async shutdown(): Promise<void> {
    const deadline = this.now() + this.shutdownDeadlineMs;
    const snapshot = this.lifecycle.snapshot().filter((candidate) => candidate.recyclable);
    // One registry call for both passes: the port has no stop operation, so a
    // supervisor that killed a warm worker directly would leave the registry
    // advertising a worker that no longer exists.
    const ordered = [...snapshot.filter((candidate) => candidate.state === 'WARM_IDLE'),
      ...snapshot.filter((candidate) => candidate.state === 'ACTIVE')];
    // An id somebody else already put in STOPPING is watched too: its terminal
    // write is still owed, and this deadline is the only one the sweep owns.
    const watch = [...ordered.map((candidate) => candidate.id),
      ...snapshot.filter((candidate) => candidate.state === 'STOPPING').map((candidate) => candidate.id)];

    for (const candidate of ordered) {
      const remaining = deadline - this.now();
      if (remaining <= 0) break;
      // On an unleased id this is a stop; on a leased one it only marks the
      // pending stop, and no kill is ever ordered while a lease is held.
      await raceDeadline(this.lifecycle.reclaim(candidate.id), remaining);
    }

    const maxPolls = Math.max(1, Math.ceil(this.shutdownDeadlineMs / SHUTDOWN_POLL_MS));
    for (let poll = 0; poll < maxPolls; poll += 1) {
      if (this.now() >= deadline) break;
      // A leased id never reaches `STOPPING`: `reclaim` only marks the pending
      // stop and `releaseLease` completes it, so waiting on `STOPPING` alone
      // would return before the release-driven stop this sweep ordered. The
      // deadline still bounds the wait.
      const pending = watch.filter((id) => {
        const health = this.lifecycle.health(id);
        if (health === undefined) return false;
        return health.state === 'STOPPING'
          || (health.state === 'ACTIVE' && health.leaseCount > 0);
      });
      if (pending.length === 0) return;
      await delay(Math.min(SHUTDOWN_POLL_MS, Math.max(1, deadline - this.now())));
    }

    for (const id of watch) {
      if (this.lifecycle.health(id)?.state !== 'STOPPING') continue;
      // An id that never reached `STOPPING` keeps `ACTIVE` and gets no write: no
      // kill was attempted, so claiming an unverified one would be a lie.
      this.lifecycle.fail(id, 'stop-unverified');
      const record = this.records.get(id);
      if (record !== undefined) {
        record.stopUnverified = true;
        record.lastFailure = 'stop-unverified';
      }
    }
  }

  private newRecord(manifest: CapabilityManifest): WorkerRecord {
    return {
      manifest,
      starts: 0,
      crashTimes: [],
      stopUnverified: false,
      pendingDeath: false,
      exitWaiters: [],
    };
  }

  /**
   * Whether a re-registration may replace this record without racing a worker.
   * `ProcessManager.start` calls `onCreated` — and so subscribes here — before its
   * promise settles, so a start that timed out leaves `processId` unset while a
   * live child is still subscribed; `subscribedProcessId` is what refuses that
   * replacement. `processId` covers a started worker, an unverified stop keeps the
   * id it named, and `pendingDeath` covers a death still being reported.
   */
  private idleForReplacement(record: WorkerRecord): boolean {
    return record.processId === undefined
      && record.subscribedProcessId === undefined
      && record.stopUnverified !== true
      && record.pendingDeath !== true;
  }

  private subscribe(record: WorkerRecord, processId: string, attempt: number): void {
    // An abandoned attempt can report its process after a newer one subscribed;
    // taking the record over there would drop the live worker's listener and
    // leave a dead process advertised as `ACTIVE`.
    if (attempt !== record.starts) return;
    this.unsubscribe(record);
    record.subscribedProcessId = processId;
    record.unsubscribe = this.processManager.onExit(processId, () => {
      // The listener is scoped to its own attempt for the same reason: an exit
      // delivered late must not be reported against the attempt now in flight.
      if (attempt !== record.starts) return;
      this.onWorkerExit(record);
    });
  }

  private unsubscribe(record: WorkerRecord): void {
    record.unsubscribe?.();
    record.unsubscribe = undefined;
    record.subscribedProcessId = undefined;
  }

  private onWorkerExit(record: WorkerRecord): void {
    // The subscription is dropped with the exit it just delivered, so the id is
    // read first: it is the only handle `status` can report the exit code from.
    const processId = record.subscribedProcessId;
    this.unsubscribe(record);
    // A replaced record no longer owns this id: a spawn or exit an abandoned
    // attempt still owes must not fail the worker that took its place.
    if (this.records.get(record.manifest.id) !== record) return;
    const status = processId === undefined ? undefined : this.processManager.status(processId);
    const exit: CapabilityExit = {
      exitCode: status !== undefined && status.ok ? status.value.exitCode ?? null : null,
    };
    record.lastExit = exit;
    const waiters = record.exitWaiters.splice(0);
    for (const waiter of waiters) waiter(exit);

    const state = this.lifecycle.health(record.manifest.id)?.state;
    if (state === 'STARTING') {
      // Reported through the `start` hook; counting happens there.
      record.pendingDeath = true;
      return;
    }
    if (state !== 'ACTIVE' && state !== 'WARM_IDLE') return;
    record.processId = undefined;
    record.pipes = undefined;
    // A `burst` worker's own exit is the end of its run, not a crash: the
    // registry writes the verdict, and only a port that cannot express
    // completion has to report it as a death.
    if (record.manifest.activation === 'burst' && this.lifecycle.complete !== undefined) {
      this.lifecycle.complete(record.manifest.id, exit.exitCode);
      return;
    }
    this.recordFailure(record, 'worker-exited');
    this.lifecycle.fail(record.manifest.id, 'worker-exited');
  }

  /** The last exit this id's own listener delivered, if it has exited once. */
  public lastExit(manifest: CapabilityManifest): CapabilityExit | undefined {
    return this.records.get(manifest.id)?.lastExit;
  }

  /**
   * Resolves with the next exit of this id. A caller holds the lease that keeps
   * the worker alive, so it races this against its own deadline; nothing here
   * starts or stops anything.
   */
  public waitForExit(manifest: CapabilityManifest): Promise<CapabilityExit> {
    const record = this.records.get(manifest.id);
    if (record === undefined) return Promise.reject(new Error(`capability ${manifest.id} has no worker registration`));
    return new Promise((resolve) => { record.exitWaiters.push(resolve); });
  }

  private discardLateStart(record: WorkerRecord, late: Result<{ readonly processId: string }>, attempt: number): void {
    if (!late.ok) return;
    // The pipes this late spawn handed over belong to the attempt being
    // discarded; a newer attempt's pipes must stay reachable.
    if (attempt === record.starts) record.pipes = undefined;
    // A later start of the same id may already own the subscription; only this
    // attempt's own subscription may be dropped.
    if (record.subscribedProcessId === late.value.processId) this.unsubscribe(record);
    void this.processManager.stop(late.value.processId);
  }

  private recordFailure(record: WorkerRecord, failure: WorkerFailure): void {
    const at = this.now();
    record.crashTimes.push(at);
    while (record.crashTimes.length > 0 && at - record.crashTimes[0]! > this.crashWindowMs) {
      record.crashTimes.shift();
    }
    record.lastFailure = failure;
  }

  /** Failures still inside `crashWindowMs`; the only crash-loop counter there is. */
  private failuresInWindow(record: WorkerRecord): number {
    const at = this.now();
    return record.crashTimes.filter((time) => at - time <= this.crashWindowMs).length;
  }
}
