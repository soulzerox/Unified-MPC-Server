import { spawn, type ChildProcess } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  appError,
  err,
  isApplicationAuthorized,
  isFullBypassAuthorization,
  ok,
  type GoalTaskCancellationObservation,
  type InvocationAuthorization,
  type Result,
} from '@unified-mpc/domain';
import { createProcessTreeTerminator, PathExecutableResolver, toSpawnInvocation, type ExecutableResolver, type ProcessTreeTerminator } from '@unified-mpc/process';
import type { CapabilityBackend } from './local-capability-service.js';
import { prohibitedAgentCommandReason, prohibitedUnscopedGitPushReason, prohibitedUnscopedPullRequestMergeReason, riskyAgentCommandReason } from './agent-command-policy.js';
import {
  DurableShellTaskStore,
  type DurableShellTaskExternalReconciler,
  type DurableShellTaskExternalReconciliationDescriptor,
} from './durable-shell-task-store.js';
import { capabilityTaskOwnerMatches, legacyCapabilityTaskOwner, readCapabilityActiveWorkspaceRoot, readCapabilityTaskOwner, type CapabilityTaskOwner } from './task-ownership.js';

type ShellOperation = 'run' | 'list' | 'status' | 'wait' | 'logs' | 'result' | 'cancel' | 'resume' | 'approve' | 'deny';
type ShellExecution = 'foreground' | 'background' | 'auto';
type ShellPrivilege = 'user' | 'admin';

/**
 * Heavy admission classes a `shell` run may declare (#145). Declaration is
 * the only way cost enters this path: no executable, argument, script or cwd
 * is ever inspected to guess it. These names mirror
 * `HEAVY_ADMISSION_CLASSES` in `@unified-mpc/workspace`; a parity test pins
 * the two lists together.
 */
export const SHELL_HEAVY_ADMISSION_CLASSES = ['rag_indexing', 'verification_heavy'] as const;

export type ShellHeavyAdmissionClass = (typeof SHELL_HEAVY_ADMISSION_CLASSES)[number];

export interface ShellHeavyAdmissionRequest {
  /** Deterministic per task, so a queue row can never be claimed twice. */
  readonly operationId: string;
  readonly workspaceId?: string;
  /** Requesting session, so per-session ceilings account the declared run. */
  readonly sessionId?: string;
  readonly resourceClass: ShellHeavyAdmissionClass;
}

export interface ShellHeavyAdmissionLease {
  /**
   * Release the heavy slot once the task is terminal. Idempotent: a duplicate
   * settle must not release twice or wake the queue.
   */
  settle(outcome: 'completed' | 'failed' | 'cancelled'): void;
}

export type ShellHeavyAdmissionEnqueueResult =
  | { readonly status: 'queued'; readonly position: number; readonly depth: number; readonly cost: number }
  | { readonly status: 'coalesced'; readonly depth: number; readonly cost: number }
  | { readonly status: 'full'; readonly depth: number; readonly cost: number }
  | { readonly status: 'failed'; readonly depth: number; readonly cost: number };

export type ShellHeavyAdmissionReattachResult =
  | ShellHeavyAdmissionEnqueueResult
  | { readonly status: 'missing'; readonly depth: number; readonly cost: number };

export interface ShellHeavyAdmissionGrant {
  readonly operationId: string;
  readonly lease: ShellHeavyAdmissionLease;
}

/** Bounded, runtime-local projection of the heavy-job fair order (#145). */
export interface ShellHeavyFairnessSnapshot {
  readonly agingMs: number;
  /** Configured per-workspace bound on queued rows (#543); the global bound when unset. */
  readonly maxQueuedPerWorkspace: number;
  /** `effectiveRank` is 0-based: rank 0 is the next candidate tried. */
  readonly entries: readonly {
    readonly operationId: string;
    readonly effectiveRank: number;
    readonly aged: boolean;
  }[];
}

/**
 * Admission seam for declared heavy shell work. The runtime adapter owns the
 * durable queue and the resource controller; the backend reserves the durable
 * task first, then asks the queue to admit it.
 */
export interface ShellHeavyAdmissionPort {
  /** Claim one bounded durable queue row; never starts a process. */
  enqueue(request: ShellHeavyAdmissionRequest): ShellHeavyAdmissionEnqueueResult;
  /**
   * Re-attach to a durable queue row that already exists (#145 restart).
   * Never creates or revives a row: `missing` means the admission generation
   * is gone, so the parked task must be failed instead of silently started.
   */
  reattach(request: ShellHeavyAdmissionRequest): ShellHeavyAdmissionReattachResult;
  /** Admit queued work now; grants are operations this call started. */
  pump(): readonly ShellHeavyAdmissionGrant[];
  /** Remove one still-queued row; false when it already started or settled. */
  cancel(operationId: string): boolean;
  /** Current queue position, or undefined when not queued. */
  position(operationId: string): number | undefined;
  /**
   * Runtime-local projection of the order queued work will be tried in, for
   * diagnostics. Derived from the same state as pump(); not durable state.
   */
  fairnessSnapshot(): ShellHeavyFairnessSnapshot;
  /** Register the executor that starts an admitted task; returns unsubscribe. */
  onAdmitted(listener: (grant: ShellHeavyAdmissionGrant) => void): () => void;
  /**
   * Register the listener for rows the durable queue retired before admission
   * (recovery took them over, or the row was cancelled out of band). The
   * backend must fail the parked task; no grant will ever arrive for it.
   */
  onRetired(listener: (operationId: string) => void): () => void;
}
type TaskState = 'running' | 'completed' | 'failed' | 'timed_out' | 'cancelled' | 'termination_unverified';

interface ShellRequest {
  readonly operation: ShellOperation;
  readonly executable?: string;
  readonly arguments: readonly string[];
  readonly privilege: ShellPrivilege;
  readonly cwd?: string;
  readonly activeWorkspaceRoot?: string;
  readonly execution: ShellExecution;
  readonly taskId?: string;
  readonly timeoutSeconds: number;
  readonly maxOutputBytes: number;
  readonly tailLines?: number;
  readonly includeStdout: boolean;
  readonly includeStderr: boolean;
  readonly dryRun: boolean;
  readonly userConfirmed: boolean;
  readonly owner: CapabilityTaskOwner;
  /** Declared heavy class (#145); absent means an ordinary, unqueued run. */
  readonly admissionClass?: ShellHeavyAdmissionClass;
}


export interface DurableShellTaskReconciliationProvider {
  describe(input: {
    readonly executable: string;
    readonly arguments: readonly string[];
    readonly cwd: string;
    readonly environment: NodeJS.ProcessEnv;
  }): DurableShellTaskExternalReconciliationDescriptor | undefined;
  readonly reconcile: DurableShellTaskExternalReconciler;
}

export interface ShellCapabilityOptions {
  readonly allowedRoots: readonly string[];
  readonly allowedRootsProvider?: () => Promise<readonly string[]>;
  readonly executableResolver?: ExecutableResolver;
  readonly terminator?: ProcessTreeTerminator;
  readonly defaultTimeoutSeconds?: number;
  readonly defaultBackgroundTimeoutSeconds?: number;
  readonly taskStateDirectory?: string;
  readonly autoWaitSeconds?: number;
  readonly maxSynchronousWaitSeconds?: number;
  readonly maxSynchronousWaitSecondsProvider?: () => number;
  readonly maxOutputBytes?: number;
  readonly durableTaskReconciliation?: DurableShellTaskReconciliationProvider;
  /**
   * Full-access mode: cwd may be any existing directory, the full environment is
   * passed through, and .cmd/.bat argument metacharacters are not rejected.
   * Delete-like commands are policy-gated; exact scoped destructive families may be auto-approved when the saved user policy enables them.
   */
  readonly unrestricted?: boolean;
  /** When omitted, a declared heavy run fails closed instead of starting unqueued. */
  readonly heavyAdmission?: ShellHeavyAdmissionPort;
  /** Settlement poll interval for admitted heavy tasks (tests shorten it). */
  readonly heavyAdmissionWatchIntervalMs?: number;
}

interface ShellTaskRecord {
  readonly taskId: string;
  readonly child: ChildProcess;
  readonly cwd: string;
  readonly includeStdout: boolean;
  readonly includeStderr: boolean;
  readonly maxOutputBytes: number;
  readonly stdout: OutputCapture;
  readonly stderr: OutputCapture;
  readonly startedAt: string;
  readonly completion: Promise<void>;
  readonly resolveCompletion: () => void;
  readonly owner: CapabilityTaskOwner;
  state: TaskState;
  exitCode?: number;
  errorMessage?: string;
  finishedAt?: string;
  timer?: ReturnType<typeof setTimeout>;
  stopRequested?: 'timed_out' | 'cancelled';
  terminationTarget?: 'timed_out' | 'cancelled';
  terminationAttempt?: Promise<boolean>;
}

const SHELL_OPERATIONS: readonly ShellOperation[] = ['run', 'list', 'status', 'wait', 'logs', 'result', 'cancel', 'resume', 'approve', 'deny'];
const DEFAULT_TIMEOUT_SECONDS = 3600;
const DEFAULT_BACKGROUND_TIMEOUT_SECONDS = 86_400;
const DEFAULT_AUTO_WAIT_SECONDS = 1;
const DEFAULT_MAX_SYNCHRONOUS_WAIT_SECONDS = 60;
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_TIMEOUT_SECONDS = 604_800;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const FOREGROUND_CANCELLATION_RETRY_MS = 250;
const DEFAULT_HEAVY_ADMISSION_WATCH_INTERVAL_MS = 2_000;
/** Parked declared work older than this is not revived after a restart. */
const DEFAULT_HEAVY_PARKED_RETENTION_MS = 60 * 60_000;
const HEAVY_SETTLE_READ_FAILURE_LIMIT = 3;

export class ShellCapabilityBackend implements CapabilityBackend {
  private readonly tasks = new Map<string, ShellTaskRecord>();
  private readonly executableResolver: ExecutableResolver;
  private readonly terminator: ProcessTreeTerminator;
  private readonly allowedRoots: readonly string[];
  private readonly allowedRootsProvider: (() => Promise<readonly string[]>) | undefined;
  private readonly defaultTimeoutSeconds: number;
  private readonly defaultBackgroundTimeoutSeconds: number;
  private readonly durableStore: DurableShellTaskStore | undefined;
  private readonly autoWaitSeconds: number;
  private readonly maxSynchronousWaitSeconds: number;
  private readonly maxSynchronousWaitSecondsProvider: (() => number) | undefined;
  private readonly maxOutputBytes: number;
  private readonly unrestricted: boolean;
  private readonly durableTaskReconciliation: DurableShellTaskReconciliationProvider | undefined;
  private readonly heavyAdmission: ShellHeavyAdmissionPort | undefined;
  private readonly heavyAdmissionWatchIntervalMs: number;
  private readonly heavyWatches = new Map<string, ReturnType<typeof setInterval>>();
  private readonly heavyLeases = new Map<string, ShellHeavyAdmissionLease>();
  private readonly heavyPending = new Set<string>();
  private readonly heavyStarting = new Map<string, Promise<void>>();
  private readonly heavyReservations = new Map<string, { readonly promise: Promise<void>; resolve: () => void }>();
  private readonly heavySettling = new Set<string>();
  private readonly heavySettleFailures = new Map<string, number>();

  public constructor(options: ShellCapabilityOptions) {
    if (options.allowedRoots.length === 0) throw new Error('At least one local capability root is required');
    this.allowedRoots = options.allowedRoots.map((root) => path.resolve(root));
    this.allowedRootsProvider = options.allowedRootsProvider;
    this.executableResolver = options.executableResolver ?? new PathExecutableResolver();
    this.terminator = options.terminator ?? createProcessTreeTerminator();
    this.defaultTimeoutSeconds = clampNumber(options.defaultTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS, 0.1, MAX_TIMEOUT_SECONDS);
    this.defaultBackgroundTimeoutSeconds = clampNumber(options.defaultBackgroundTimeoutSeconds ?? DEFAULT_BACKGROUND_TIMEOUT_SECONDS, 0.1, MAX_TIMEOUT_SECONDS);
    this.durableTaskReconciliation = options.durableTaskReconciliation;
    this.durableStore = options.taskStateDirectory === undefined ? undefined : new DurableShellTaskStore(path.resolve(options.taskStateDirectory), {
      ...(options.durableTaskReconciliation === undefined ? {} : { externalReconciler: options.durableTaskReconciliation.reconcile }),
    });
    this.autoWaitSeconds = clampNumber(options.autoWaitSeconds ?? DEFAULT_AUTO_WAIT_SECONDS, 0, DEFAULT_TIMEOUT_SECONDS);
    this.maxSynchronousWaitSeconds = clampNumber(options.maxSynchronousWaitSeconds ?? DEFAULT_MAX_SYNCHRONOUS_WAIT_SECONDS, 0.01, 90);
    this.maxSynchronousWaitSecondsProvider = options.maxSynchronousWaitSecondsProvider;
    this.maxOutputBytes = Math.floor(clampNumber(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES, 1, MAX_OUTPUT_BYTES));
    this.unrestricted = options.unrestricted === true;
    this.heavyAdmission = options.heavyAdmission;
    this.heavyAdmissionWatchIntervalMs = Math.max(10, Math.floor(options.heavyAdmissionWatchIntervalMs ?? DEFAULT_HEAVY_ADMISSION_WATCH_INTERVAL_MS));
    this.heavyAdmission?.onAdmitted((grant) => {
      void this.startAdmittedHeavy(grant);
    });
    this.heavyAdmission?.onRetired((operationId) => {
      void this.retireHeavyTask(operationId);
    });
  }

  public async execute(input: unknown, signal?: AbortSignal, authorization?: InvocationAuthorization): Promise<Result<unknown>> {
    const parsed = parseShellRequest(input, this.defaultTimeoutSeconds, this.defaultBackgroundTimeoutSeconds, this.maxOutputBytes);
    if (!parsed.ok) return parsed;
    if (signal?.aborted) return err(appError('PROCESS_TIMEOUT', 'Shell request was cancelled', true));

    switch (parsed.value.operation) {
      case 'run': return this.run(parsed.value, signal, authorization);
      case 'list': return this.listTasks(parsed.value.owner);
      case 'status': return this.taskSnapshot(parsed.value.taskId, undefined, parsed.value.owner);
      case 'wait': return this.wait(parsed.value);
      case 'logs': return this.taskSnapshot(parsed.value.taskId, parsed.value.tailLines, parsed.value.owner);
      case 'result': return this.taskSnapshot(parsed.value.taskId, undefined, parsed.value.owner);
      case 'cancel': {
        if (!isApplicationAuthorized(authorization, parsed.value.userConfirmed)) return err(appError('PERMISSION_REQUIRED', 'Cancelling a task requires explicit user confirmation'));
        const taskId = parsed.value.taskId;
        if (taskId !== undefined) {
          // Serialize against an in-flight admission start so a cancel can
          // never be overwritten by a later "running" write.
          const starting = this.heavyStarting.get(taskId);
          if (starting !== undefined) await starting;
        }
        const cancelled = await this.cancel(parsed.value.taskId, false, parsed.value.owner);
        if (taskId !== undefined) {
          // A declared heavy task that is already terminal must release its slot
          // now: waiting for the next poll would keep a cancelled build holding it.
          const cancelledState = cancelled.ok && isRecord(cancelled.value) ? cancelled.value.state : undefined;
          const outcome = heavyLeaseOutcome(cancelledState);
          if (outcome !== undefined) {
            // Queued work has no lease yet; its durable row is removed here so a
            // later wake can never spawn a task the caller cancelled.
            this.heavyAdmission?.cancel(shellOperationId(taskId));
            this.abandonHeavyReservation(taskId);
            if (this.heavyLeases.has(taskId)) this.settleHeavyTaskOnce(taskId, outcome);
          }
        }
        return cancelled.ok && isRecord(cancelled.value) && taskId !== undefined
          ? ok(this.decorateTaskResult(cancelled.value, taskId))
          : cancelled;
      }
      case 'resume':
      case 'approve':
      case 'deny':
        return err(appError('INVALID_INPUT', `${parsed.value.operation} is not required by the local task runner`));
    }
  }

  /** Trusted read-only host probe scoped to the durable goal's workspace. */
  public async statusForGoalLiveness(workspaceId: string, taskId: string): Promise<Result<unknown>> {
    const record = this.tasks.get(taskId);
    if (record !== undefined) {
      if (record.owner.workspaceId !== workspaceId) {
        return err(appError('PERMISSION_DENIED', 'Task belongs to another or unknown workspace'));
      }
      return ok(this.snapshot(record));
    }
    if (this.durableStore !== undefined) return this.durableStore.snapshotForGoalLiveness(taskId, workspaceId);
    return err(appError('PROCESS_NOT_FOUND', 'Task was not found'));
  }

  /** Trusted cancellation path used by durable goals; it deliberately ignores the transient MCP session. */
  public async cancelForGoal(
    ownerClientId: string,
    workspaceId: string,
    taskId: string,
  ): Promise<Result<GoalTaskCancellationObservation>> {
    const record = this.tasks.get(taskId);
    if (record !== undefined) {
      if (record.owner.clientId !== ownerClientId || record.owner.workspaceId !== workspaceId) {
        return err(appError('PERMISSION_DENIED', 'Task belongs to another client or workspace'));
      }
      if (isVerifiedTerminal(record.state)) {
        return ok({ matched: true, state: 'already_terminal', detail: record.state });
      }
      const verified = await this.tryTerminate(record, 'cancelled');
      if (verified && isVerifiedTerminal(record.state)) {
        return ok({ matched: true, state: 'cancelled', detail: record.state });
      }
      return ok({ matched: true, state: 'termination_unverified', detail: record.state });
    }
    if (this.durableStore !== undefined) {
      const starting = this.heavyStarting.get(taskId);
      if (starting !== undefined) await starting;
      const cancelled = await this.durableStore.cancelForGoal(taskId, ownerClientId, workspaceId);
      if (cancelled.ok) {
        // A queued declared task owns no process; retire its queue row too.
        this.heavyAdmission?.cancel(shellOperationId(taskId));
        this.abandonHeavyReservation(taskId);
        const outcome = cancelled.value.state === 'cancelled'
          ? 'cancelled' as const
          : cancelled.value.state === 'already_terminal' ? heavyLeaseOutcome(cancelled.value.detail) : undefined;
        if (outcome !== undefined && this.heavyLeases.has(taskId)) this.settleHeavyTaskOnce(taskId, outcome);
      }
      return cancelled;
    }
    return ok({ matched: false, state: 'not_found' });
  }

  private async run(request: ShellRequest, signal?: AbortSignal, authorization?: InvocationAuthorization): Promise<Result<unknown>> {
    if (request.executable === undefined) return err(appError('INVALID_INPUT', 'Executable is required'));
    if (request.privilege === 'admin') return err(appError('PERMISSION_DENIED', 'Administrator access is not available to the local runner'));

    const fullBypass = isFullBypassAuthorization(authorization);
    const cwd = await this.resolveCwd(request.cwd, request.activeWorkspaceRoot, authorization);
    if (!cwd.ok) return cwd;
    if (signal?.aborted) return err(appError('PROCESS_TIMEOUT', 'Shell request was cancelled before launch', true));
    if (request.dryRun) {
      return ok({
        dry_run: true,
        executable: request.executable,
        arguments: [...request.arguments],
        cwd: cwd.value,
        ...(request.owner.workspaceId === undefined ? {} : { workspace_id: request.owner.workspaceId }),
      });
    }
    const unscopedGitPush = prohibitedUnscopedGitPushReason(request.executable, request.arguments);
    if (unscopedGitPush !== undefined) return err(appError('PERMISSION_DENIED', unscopedGitPush));
    const unscopedPullRequestMerge = prohibitedUnscopedPullRequestMergeReason(request.executable, request.arguments);
    if (unscopedPullRequestMerge !== undefined) return err(appError('PERMISSION_DENIED', unscopedPullRequestMerge));
    if (!fullBypass) {
      const prohibitedReason = prohibitedAgentCommandReason(request.executable, request.arguments);
      if (prohibitedReason !== undefined) return err(appError('PERMISSION_DENIED', prohibitedReason));
      const riskyReason = riskyAgentCommandReason(request.executable, request.arguments);
      if (riskyReason !== undefined && !isApplicationAuthorized(authorization, request.userConfirmed)) return err(appError('PERMISSION_REQUIRED', riskyReason));
    }
    const executable = await this.executableResolver.resolve(request.executable);
    if (!executable.ok) return executable;
    if (signal?.aborted) return err(appError('PROCESS_TIMEOUT', 'Shell request was cancelled before launch', true));
    const invocation = toSpawnInvocation(executable.value, request.arguments, { allowMetacharacters: this.unrestricted || fullBypass });
    if (!invocation.ok) return invocation;
    if (signal?.aborted) return err(appError('PROCESS_TIMEOUT', 'Shell request was cancelled before launch', true));

    if (request.admissionClass !== undefined) {
      return this.runDeclaredHeavy(request, cwd.value, invocation.value);
    }

    if (this.durableStore !== undefined && request.execution !== 'foreground') {
      // Durable tasks intentionally outlive the originating MCP request. Goal
      // cancellation reaches them through GoalTaskCancellationService using
      // the tracked task id, while an ordinary caller/response timeout must
      // not cancel a task that has already been submitted.
      return this.runDurable(request, cwd.value, invocation.value);
    }

    let child: ChildProcess;
    try {
      child = spawn(invocation.value.executable, [...invocation.value.args], {
        cwd: cwd.value,
        env: createSafeEnvironment(process.env, this.unrestricted),
        shell: false,
        detached: process.platform !== 'win32',
        windowsHide: true,
        ...(invocation.value.windowsVerbatimArguments === undefined ? {} : { windowsVerbatimArguments: invocation.value.windowsVerbatimArguments }),
      });
    } catch {
      return err(appError('INTERNAL_ERROR', 'Local task could not start', true));
    }

    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });
    const record: ShellTaskRecord = {
      taskId: randomUUID(),
      child,
      cwd: cwd.value,
      includeStdout: request.includeStdout,
      includeStderr: request.includeStderr,
      maxOutputBytes: request.maxOutputBytes,
      stdout: new OutputCapture(request.maxOutputBytes),
      stderr: new OutputCapture(request.maxOutputBytes),
      startedAt: new Date().toISOString(),
      completion,
      resolveCompletion,
      owner: request.owner,
      state: 'running',
    };
    this.tasks.set(record.taskId, record);

    child.stdout?.on('data', (chunk: Buffer | string) => record.stdout.append(chunk));
    child.stderr?.on('data', (chunk: Buffer | string) => record.stderr.append(chunk));
    child.once('error', () => {
      if (record.child.pid === undefined && record.terminationTarget !== undefined) {
        this.finish(
          record,
          record.terminationTarget,
          -1,
          record.terminationTarget === 'timed_out' ? 'Local task timed out' : undefined,
        );
      } else if (record.state === 'running' && record.stopRequested === undefined) {
        this.finish(record, 'failed', -1, 'Local task failed to start');
      }
    });
    child.once('close', (exitCode: number | null) => {
      if (record.state !== 'running') return;
      if (record.stopRequested !== undefined) return;
      this.finish(record, exitCode === 0 ? 'completed' : 'failed', exitCode ?? -1);
    });
    record.timer = setTimeout(() => { void this.timeout(record); }, request.timeoutSeconds * 1000);

    if (request.execution === 'background') return ok(this.snapshot(record));
    const synchronousWait = request.execution === 'auto'
      ? Math.min(this.autoWaitSeconds, this.currentMaxSynchronousWaitSeconds())
      : Math.min(request.timeoutSeconds, this.currentMaxSynchronousWaitSeconds());
    await this.waitForForeground(record, synchronousWait, signal);
    return ok(this.snapshot(record));
  }

  private async wait(request: ShellRequest): Promise<Result<unknown>> {
    if (request.taskId === undefined) return err(appError('INVALID_INPUT', 'Task ID is required'));
    const record = this.tasks.get(request.taskId);
    if (record !== undefined) {
      const ownership = this.authorizeTaskOwner(record.owner, request.owner);
      if (!ownership.ok) return ownership;
      await this.waitFor(record, Math.min(request.timeoutSeconds, this.currentMaxSynchronousWaitSeconds()));
      return ok(this.snapshot(record, request.tailLines));
    }
    if (this.durableStore !== undefined) {
      const waited = await this.durableStore.wait(request.taskId, Math.min(request.timeoutSeconds, this.currentMaxSynchronousWaitSeconds()), request.tailLines, request.owner);
      return waited.ok ? ok(this.decorateTaskResult(waited.value, request.taskId)) : waited;
    }
    return err(appError('PROCESS_NOT_FOUND', 'Task was not found'));
  }

  private currentMaxSynchronousWaitSeconds(): number {
    const configured = this.maxSynchronousWaitSecondsProvider?.();
    if (configured === undefined || !Number.isFinite(configured)) return this.maxSynchronousWaitSeconds;
    return clampNumber(configured, 0.01, 90);
  }

  private async waitFor(record: ShellTaskRecord, seconds: number): Promise<void> {
    if ((record.state !== 'running' && record.state !== 'termination_unverified') || seconds <= 0) return;
    await Promise.race([record.completion, delay(seconds * 1000)]);
  }

  private async waitForForeground(record: ShellTaskRecord, seconds: number, signal: AbortSignal | undefined): Promise<void> {
    if (signal === undefined) {
      await this.waitFor(record, seconds);
      return;
    }
    let cancellation: Promise<Result<unknown>> | undefined;
    let resolveAbort!: () => void;
    const aborted = new Promise<void>((resolve) => { resolveAbort = resolve; });
    const onAbort = (): void => {
      cancellation ??= this.cancel(record.taskId, true, record.owner);
      resolveAbort();
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    try {
      await Promise.race([this.waitFor(record, seconds), aborted]);
      if (cancellation !== undefined) await cancellation;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  private async timeout(record: ShellTaskRecord): Promise<void> {
    if (record.state !== 'running' || record.stopRequested !== undefined) return;
    await this.tryTerminate(record, 'timed_out');
  }

  private async cancel(taskId: string | undefined, autoRetry = false, owner: CapabilityTaskOwner = legacyCapabilityTaskOwner()): Promise<Result<unknown>> {
    if (taskId === undefined) return err(appError('INVALID_INPUT', 'Task ID is required'));
    const existing = this.tasks.get(taskId);
    if (existing === undefined) {
      if (this.durableStore !== undefined) return this.durableStore.cancel(taskId, owner);
      return err(appError('PROCESS_NOT_FOUND', 'Task was not found'));
    }
    const record = existing;
    const ownership = this.authorizeTaskOwner(record.owner, owner);
    if (!ownership.ok) return ownership;
    if (record.state === 'running' || record.state === 'termination_unverified') {
      const targetState = record.terminationTarget ?? 'cancelled';
      let verified = await this.tryTerminate(record, targetState);
      while (!verified && autoRetry) {
        if (record.child.exitCode !== null || record.child.signalCode !== null) {
          await record.completion;
        }
        await delay(FOREGROUND_CANCELLATION_RETRY_MS);
        verified = await this.tryTerminate(record, targetState);
      }
      if (!verified) await record.completion;
    }
    return ok(this.snapshot(record));
  }

  private async tryTerminate(record: ShellTaskRecord, targetState: 'timed_out' | 'cancelled'): Promise<boolean> {
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

  private async performTermination(record: ShellTaskRecord, targetState: 'timed_out' | 'cancelled'): Promise<boolean> {
    record.terminationTarget = targetState;
    record.stopRequested = targetState;
    if (record.timer !== undefined) clearTimeout(record.timer);
    const pid = record.child.pid;
    if (pid === undefined) {
      delete record.stopRequested;
      this.markTerminationUnverified(record, targetState === 'timed_out'
        ? 'Local task timed out, but process termination could not be verified'
        : 'Process termination could not be verified');
      return false;
    }
    try {
      await this.terminator.stop(record.child, pid);
      this.finish(record, targetState, -1, targetState === 'timed_out' ? 'Local task timed out' : undefined);
      return true;
    } catch {
      delete record.stopRequested;
      this.markTerminationUnverified(record, targetState === 'timed_out'
        ? 'Local task timed out, but process termination could not be verified'
        : 'Process termination could not be verified');
      return false;
    }
  }

  private async taskSnapshot(taskId: string | undefined, tailLines?: number, owner: CapabilityTaskOwner = legacyCapabilityTaskOwner()): Promise<Result<unknown>> {
    if (taskId === undefined) return err(appError('INVALID_INPUT', 'Task ID is required'));
    const record = this.tasks.get(taskId);
    if (record !== undefined) {
      const ownership = this.authorizeTaskOwner(record.owner, owner);
      return ownership.ok ? ok(this.snapshot(record, tailLines)) : ownership;
    }
    if (this.durableStore !== undefined) {
      const snapshot = await this.durableStore.snapshot(taskId, tailLines, owner);
      return snapshot.ok ? ok(this.decorateTaskResult(snapshot.value, taskId)) : snapshot;
    }
    return err(appError('PROCESS_NOT_FOUND', 'Task was not found'));
  }

  private getTask(taskId: string | undefined): Result<ShellTaskRecord> {
    if (taskId === undefined) return err(appError('INVALID_INPUT', 'Task ID is required'));
    const task = this.tasks.get(taskId);
    return task === undefined ? err(appError('PROCESS_NOT_FOUND', 'Task was not found')) : ok(task);
  }

  /**
   * Declared heavy run (#145): ask admission before any process could start, then
   * launch through the durable store and settle the slot when the task is
   * terminal. Only the declaration opts in - an undeclared run never reaches here.
   */
  private async runDeclaredHeavy(
    request: ShellRequest,
    cwd: string,
    invocation: { readonly executable: string; readonly args: readonly string[]; readonly windowsVerbatimArguments?: boolean },
  ): Promise<Result<unknown>> {
    const admissionClass = request.admissionClass;
    if (admissionClass === undefined) return err(appError('INVALID_INPUT', 'Heavy admission class is required'));
    const admission = this.heavyAdmission;
    if (admission === undefined) {
      return err(appError(
        'INVALID_INPUT',
        'Heavy admission is not configured on this runtime; remove admission_class or route the run through a runtime that owns the heavy-job queue',
        false,
      ));
    }
    const store = this.durableStore;
    if (store === undefined) {
      return err(appError('INVALID_INPUT', 'admission_class requires the durable task store', false));
    }
    if (request.execution === 'foreground') {
      return err(appError('INVALID_INPUT', 'admission_class requires background execution; a foreground run cannot hold a heavy slot', false));
    }
    const taskId = randomUUID();
    const operationId = shellOperationId(taskId);
    const workspaceId = request.owner.workspaceId;
    // Own the task before its durable queue row can be admitted. A capacity
    // release may land while reserve() is still writing, and that grant must
    // wait for this reservation instead of being mistaken for a stale one.
    this.beginHeavyReservation(taskId);
    let enqueued: ShellHeavyAdmissionEnqueueResult;
    try {
      enqueued = admission.enqueue({
        operationId,
        ...(workspaceId === undefined ? {} : { workspaceId }),
        ...(request.owner.sessionId === undefined ? {} : { sessionId: request.owner.sessionId }),
        resourceClass: admissionClass,
      });
    } catch (error: unknown) {
      this.abandonHeavyReservation(taskId);
      throw error;
    }
    if (enqueued.status === 'full') {
      this.abandonHeavyReservation(taskId);
      // No task record, no process: the caller never holds a task id for work
      // that was never accepted.
      return err(appError(
        'RESOURCE_PRESSURE',
        `The heavy-job queue is full (${enqueued.depth} waiting); wait for running work to finish, then retry`,
        true,
        { reason: 'queue_full', resourceClass: admissionClass, depth: enqueued.depth },
      ));
    }
    if (enqueued.status === 'coalesced') {
      this.abandonHeavyReservation(taskId);
      return err(appError(
        'RESOURCE_PRESSURE',
        'Heavy shell work with this identity is already owned by another runtime; retry with a fresh request',
        true,
        { reason: 'coalesced', resourceClass: admissionClass, depth: enqueued.depth },
      ));
    }
    if (enqueued.status === 'failed') {
      this.abandonHeavyReservation(taskId);
      return err(appError(
        'INTERNAL_ERROR',
        'The heavy-job queue is unavailable; retry the run',
        true,
        { reason: 'queue_unavailable', resourceClass: admissionClass },
      ));
    }
    const environment = createSafeEnvironment(process.env, this.unrestricted);
    const externalReconciliation = this.durableTaskReconciliation?.describe({
      executable: invocation.executable,
      arguments: invocation.args,
      cwd,
      environment,
    });
    const reserved = await store.reserve({
      taskId,
      executable: invocation.executable,
      arguments: invocation.args,
      cwd,
      ...(invocation.windowsVerbatimArguments === undefined ? {} : { windowsVerbatimArguments: invocation.windowsVerbatimArguments }),
      timeoutSeconds: request.timeoutSeconds,
      maxOutputBytes: request.maxOutputBytes,
      includeStdout: request.includeStdout,
      includeStderr: request.includeStderr,
      owner: request.owner,
      ...(externalReconciliation === undefined ? {} : { externalReconciliation }),
      admissionClass,
      admissionCost: enqueued.cost,
    });
    if (!reserved.ok) {
      // The durable record could not be written: give the queue row back.
      this.abandonHeavyReservation(taskId);
      admission.cancel(operationId);
      return reserved;
    }
    // The record exists, so an admitted grant may start it from here on.
    this.releaseHeavyReservation(taskId);
    await this.pumpHeavy();
    const snapshot = await store.snapshot(taskId, undefined, request.owner);
    return snapshot.ok ? ok(this.decorateTaskResult(snapshot.value, taskId)) : snapshot;
  }

  /** Admit queued declared runs now and start every grant this process owns. */
  private async pumpHeavy(): Promise<void> {
    const admission = this.heavyAdmission;
    if (admission === undefined) return;
    const grants = admission.pump();
    await Promise.all(grants.map((grant) => this.startAdmittedHeavy(grant)));
  }

  /**
   * Re-attach parked declared runs after a restart (#145). The durable task is
   * the payload, so a fresh runtime only re-claims its queue row: an orphaned
   * row is adopted, a row still owned by a live runtime is left to it, and
   * parked work older than the retention window fails truthfully instead of
   * being revived indefinitely.
   */
  public async recoverParkedHeavy(options: {
    readonly maxAgeMs?: number;
    readonly now?: () => number;
  } = {}): Promise<{ reattached: number; failed: number; skipped: number }> {
    const admission = this.heavyAdmission;
    const store = this.durableStore;
    if (admission === undefined || store === undefined) return { reattached: 0, failed: 0, skipped: 0 };
    const maxAgeMs = Math.max(1, Math.floor(options.maxAgeMs ?? DEFAULT_HEAVY_PARKED_RETENTION_MS));
    const cutoff = (options.now ?? Date.now)() - maxAgeMs;
    let reattached = 0;
    let failed = 0;
    let skipped = 0;
    for (const task of await store.listWaiting()) {
      const taskId = typeof task.task_id === 'string' ? task.task_id : undefined;
      const admissionClass = task.admission_class;
      if (taskId === undefined || !isShellHeavyAdmissionClass(admissionClass)) {
        skipped += 1;
        continue;
      }
      // Already owned by this backend: queued locally, starting, or running.
      if (this.heavyPending.has(taskId) || this.heavyStarting.has(taskId) || this.heavyLeases.has(taskId)) {
        skipped += 1;
        continue;
      }
      // Trust boundary: a runtime may only revive work whose cwd it would
      // accept today. A profile that cannot serve it must leave the task for
      // the runtime that can, not fail it or spawn outside its roots.
      const cwd = typeof task.cwd === 'string' ? task.cwd : undefined;
      if (!(await this.recoveryCwdAllowed(cwd))) {
        skipped += 1;
        continue;
      }
      this.heavyPending.add(taskId);
      const workspaceId = typeof task.workspace_id === 'string' ? task.workspace_id : undefined;
      const reattachedRow = admission.reattach({
        operationId: shellOperationId(taskId),
        ...(workspaceId === undefined ? {} : { workspaceId }),
        resourceClass: admissionClass,
      });
      if (reattachedRow.status === 'missing') {
        // The row was retired before any runtime re-attached it, so the
        // admission generation that would have run this work is gone.
        // Re-enqueueing would silently start a new generation; fail the
        // parked task instead (#145 restart).
        this.abandonHeavyReservation(taskId);
        await store.failWaiting(taskId, 'Parked heavy task was interrupted before admission: its durable queue row is gone');
        failed += 1;
        continue;
      }
      if (reattachedRow.status !== 'queued') {
        this.abandonHeavyReservation(taskId);
        // Full/unavailable is transient (the next sweep retries); coalesced
        // means a live foreign runtime owns the row and its work is never
        // expired by this process.
        skipped += 1;
        continue;
      }
      // We own the row now, so age is ours to judge. Checked after the claim
      // so a peer runtime's healthy, long-queued work is never expired here.
      const reservedAt = typeof task.started_at === 'string' ? Date.parse(task.started_at) : Number.NaN;
      if (!Number.isFinite(reservedAt) || reservedAt <= cutoff) {
        admission.cancel(shellOperationId(taskId));
        this.abandonHeavyReservation(taskId);
        await store.failWaiting(taskId, 'Parked heavy task expired before a runtime re-attached it');
        failed += 1;
        continue;
      }
      reattached += 1;
    }
    await this.pumpHeavy();
    return { reattached, failed, skipped };
  }

  private async recoveryCwdAllowed(cwd: string | undefined): Promise<boolean> {
    if (cwd === undefined) return false;
    try {
      if (this.unrestricted) return (await stat(cwd)).isDirectory();
      const configuredRoots = this.allowedRootsProvider === undefined ? this.allowedRoots : await this.allowedRootsProvider();
      const canonicalRoots: string[] = [];
      for (const root of configuredRoots) {
        try {
          if ((await stat(root)).isDirectory()) canonicalRoots.push(await realpath(root));
        } catch {
          continue;
        }
      }
      if (canonicalRoots.length === 0) return false;
      const canonicalCwd = await realpath(cwd);
      if (!(await stat(canonicalCwd)).isDirectory()) return false;
      return canonicalRoots.some((root) => isWithin(root, canonicalCwd));
    } catch {
      return false;
    }
  }

  private async startAdmittedHeavy(grant: ShellHeavyAdmissionGrant): Promise<void> {
    const taskId = shellTaskIdFromOperationId(grant.operationId);
    if (taskId === undefined) {
      grant.lease.settle('failed');
      return;
    }
    const reservation = this.heavyReservations.get(taskId);
    if (reservation !== undefined) await reservation.promise;
    if (!this.heavyPending.has(taskId)) {
      // Cancelled, retired, or failed before the reservation completed: never
      // spawn a process for work this backend no longer owns.
      grant.lease.settle('failed');
      return;
    }
    const starting = this.startHeavyTask(taskId, grant.lease);
    this.heavyStarting.set(taskId, starting);
    try {
      await starting;
    } finally {
      if (this.heavyStarting.get(taskId) === starting) this.heavyStarting.delete(taskId);
    }
  }

  /** Mark the task owned before its queue row exists; grants wait on this. */
  private beginHeavyReservation(taskId: string): void {
    let resolve!: () => void;
    const promise = new Promise<void>((resolvePromise) => {
      resolve = resolvePromise;
    });
    this.heavyPending.add(taskId);
    this.heavyReservations.set(taskId, { promise, resolve });
  }

  /** Publish the reserved record so a grant that arrived early may start it. */
  private releaseHeavyReservation(taskId: string): void {
    const reservation = this.heavyReservations.get(taskId);
    if (reservation === undefined) return;
    this.heavyReservations.delete(taskId);
    reservation.resolve();
  }

  /** Drop ownership and unblock any grant that arrived during the reservation. */
  private abandonHeavyReservation(taskId: string): void {
    this.heavyPending.delete(taskId);
    this.releaseHeavyReservation(taskId);
  }

  /**
   * A durable queue row was retired before admission, so no grant will ever
   * arrive. Fail the parked task instead of leaving a non-terminal record.
   */
  private async retireHeavyTask(operationId: string): Promise<void> {
    const taskId = shellTaskIdFromOperationId(operationId);
    if (taskId === undefined || !this.heavyPending.has(taskId)) return;
    this.abandonHeavyReservation(taskId);
    await this.durableStore?.failWaiting(taskId, 'Heavy-job queue ownership was retired before admission');
  }

  private async startHeavyTask(taskId: string, lease: ShellHeavyAdmissionLease): Promise<void> {
    const store = this.durableStore;
    if (store === undefined) {
      this.abandonHeavyReservation(taskId);
      lease.settle('failed');
      return;
    }
    try {
      const started = await store.startReserved(taskId, createSafeEnvironment(process.env, this.unrestricted));
      if (!started.ok) {
        this.abandonHeavyReservation(taskId);
        lease.settle('failed');
        return;
      }
      this.abandonHeavyReservation(taskId);
      this.watchHeavyTask(taskId, lease);
    } catch {
      this.abandonHeavyReservation(taskId);
      lease.settle('failed');
    }
  }

  /**
   * Settle the heavy slot once the durable worker reaches a verified terminal
   * state. `termination_unverified` deliberately keeps the slot: the process may
   * still be alive, so starting other heavy work would overlap it.
   */
  private watchHeavyTask(taskId: string, lease: ShellHeavyAdmissionLease): void {
    if (this.heavyWatches.has(taskId)) return;
    this.heavyLeases.set(taskId, lease);
    const timer = setInterval(() => {
      void this.settleHeavyTask(taskId);
    }, this.heavyAdmissionWatchIntervalMs);
    timer.unref?.();
    this.heavyWatches.set(taskId, timer);
  }

  private async settleHeavyTask(taskId: string): Promise<void> {
    // Two ticks can await the same snapshot; only one may settle the slot.
    if (this.heavySettling.has(taskId)) return;
    this.heavySettling.add(taskId);
    try {
      const store = this.durableStore;
      if (store === undefined) {
        this.settleHeavyTaskOnce(taskId, 'failed');
        return;
      }
      const snapshot = await store.snapshot(taskId);
      if (!snapshot.ok) {
        const failures = (this.heavySettleFailures.get(taskId) ?? 0) + 1;
        this.heavySettleFailures.set(taskId, failures);
        if (failures < HEAVY_SETTLE_READ_FAILURE_LIMIT) return;
        // A task that cannot be read back is not provably finished; holding the
        // slot forever is worse than one fail-closed release.
        this.settleHeavyTaskOnce(taskId, 'failed');
        return;
      }
      const outcome = heavyLeaseOutcome(snapshot.value.state);
      if (outcome === undefined) return;
      this.settleHeavyTaskOnce(taskId, outcome);
    } finally {
      this.heavySettling.delete(taskId);
    }
  }

  /** Terminal settle is idempotent: the lease leaves the table before it is called. */
  private settleHeavyTaskOnce(taskId: string, outcome: 'completed' | 'failed' | 'cancelled'): void {
    const lease = this.heavyLeases.get(taskId);
    this.stopHeavyWatch(taskId);
    lease?.settle(outcome);
  }

  private stopHeavyWatch(taskId: string): void {
    const timer = this.heavyWatches.get(taskId);
    if (timer !== undefined) clearInterval(timer);
    this.heavyWatches.delete(taskId);
    this.heavyLeases.delete(taskId);
    this.heavySettleFailures.delete(taskId);
  }

  /** Project the persisted declaration into the public `admission` block (#145). */
  private decorateTaskResult(value: Record<string, unknown>, taskId: string): Record<string, unknown> {
    const admissionClass = value.admission_class;
    if (!isShellHeavyAdmissionClass(admissionClass)) return value;
    const waiting = value.state === 'waiting_resource';
    const position = waiting ? this.heavyAdmission?.position(shellOperationId(taskId)) : undefined;
    const cost = typeof value.admission_cost === 'number' ? value.admission_cost : undefined;
    const startedAt = typeof value.started_at === 'string' ? Date.parse(value.started_at) : Number.NaN;
    const waitedMs = waiting && Number.isFinite(startedAt) ? Math.max(0, Date.now() - startedAt) : undefined;
    return {
      ...value,
      admission: {
        class: admissionClass,
        ...(cost === undefined ? {} : { cost }),
        state: waiting ? 'queued' : value.state,
        ...(position === undefined ? {} : { position }),
        ...(waitedMs === undefined ? {} : { waitedMs }),
      },
    };
  }

  private async runDurable(
    request: ShellRequest,
    cwd: string,
    invocation: { readonly executable: string; readonly args: readonly string[]; readonly windowsVerbatimArguments?: boolean },
    taskId: string = randomUUID(),
  ): Promise<Result<unknown>> {
    if (this.durableStore === undefined) return err(appError('INTERNAL_ERROR', 'Durable task store is unavailable', true));
    const environment = createSafeEnvironment(process.env, this.unrestricted);
    const externalReconciliation = this.durableTaskReconciliation?.describe({
      executable: invocation.executable,
      arguments: invocation.args,
      cwd,
      environment,
    });
    const launched = await this.durableStore.launch({
      taskId,
      executable: invocation.executable,
      arguments: invocation.args,
      cwd,
      environment,
      ...(invocation.windowsVerbatimArguments === undefined ? {} : { windowsVerbatimArguments: invocation.windowsVerbatimArguments }),
      timeoutSeconds: request.timeoutSeconds,
      maxOutputBytes: request.maxOutputBytes,
      includeStdout: request.includeStdout,
      includeStderr: request.includeStderr,
      owner: request.owner,
      ...(externalReconciliation === undefined ? {} : { externalReconciliation }),
    });
    if (!launched.ok || request.execution === 'background') return launched;
    return this.durableStore.wait(taskId, Math.min(this.autoWaitSeconds, this.currentMaxSynchronousWaitSeconds()), undefined, request.owner);
  }

  private async listTasks(owner: CapabilityTaskOwner): Promise<Result<unknown>> {
    const inMemory = [...this.tasks.values()]
      .filter((record) => capabilityTaskOwnerMatches(record.owner, owner))
      .map((record) => this.snapshot(record));
    if (this.durableStore === undefined) return ok({ tasks: inMemory });
    const durable = (await this.durableStore.list(owner))
      .map((task) => typeof task.task_id === 'string' ? this.decorateTaskResult(task, task.task_id) : task);
    const durableIds = new Set(durable.map((task) => task.task_id).filter((value): value is string => typeof value === 'string'));
    return ok({ tasks: [...durable, ...inMemory.filter((task) => !durableIds.has(String(task.task_id ?? '')))] });
  }

  private authorizeTaskOwner(stored: CapabilityTaskOwner, requester: CapabilityTaskOwner): Result<void> {
    return capabilityTaskOwnerMatches(stored, requester)
      ? ok(undefined)
      : err(appError('PERMISSION_DENIED', 'Task is not owned by this client session and workspace'));
  }

  private async resolveCwd(
    requestedCwd: string | undefined,
    activeWorkspaceRoot: string | undefined,
    authorization?: InvocationAuthorization,
  ): Promise<Result<string>> {
    const fullBypass = isFullBypassAuthorization(authorization);
    if ((this.unrestricted && activeWorkspaceRoot === undefined || fullBypass) && requestedCwd !== undefined && path.isAbsolute(requestedCwd)) {
      try {
        const canonical = await realpath(requestedCwd);
        if (!(await stat(canonical)).isDirectory()) return err(appError('INVALID_INPUT', 'Working directory must be a directory'));
        return ok(canonical);
      } catch {
        return err(appError('FILE_NOT_FOUND', 'Working directory was not found'));
      }
    }
    const configuredRoots = this.allowedRootsProvider === undefined ? this.allowedRoots : await this.allowedRootsProvider();
    const canonicalRoots: string[] = [];
    for (const root of configuredRoots) {
      try {
        if ((await stat(root)).isDirectory()) canonicalRoots.push(await realpath(root));
      } catch {
        continue;
      }
    }
    if (canonicalRoots.length === 0) return err(appError('FILE_NOT_FOUND', 'No local capability root is available'));

    let canonicalActiveRoot: string | undefined;
    if (activeWorkspaceRoot !== undefined) {
      if (!path.isAbsolute(activeWorkspaceRoot)) return err(appError('PATH_OUTSIDE_WORKSPACE', 'Host active workspace root is invalid'));
      try {
        canonicalActiveRoot = await realpath(activeWorkspaceRoot);
        if (!(await stat(canonicalActiveRoot)).isDirectory()) return err(appError('INVALID_INPUT', 'Host active workspace root must be a directory'));
      } catch {
        return err(appError('FILE_NOT_FOUND', 'Host active workspace root was not found'));
      }
      if (!canonicalRoots.some((root) => isWithin(root, canonicalActiveRoot!))) {
        return err(appError('PATH_OUTSIDE_WORKSPACE', 'Host active workspace root is outside configured local roots'));
      }
    }

    const baseRoot = canonicalActiveRoot ?? canonicalRoots[0]!;
    const candidate = requestedCwd === undefined ? baseRoot : path.resolve(baseRoot, requestedCwd);
    let canonicalCandidate: string;
    try {
      canonicalCandidate = await realpath(candidate);
      if (!(await stat(canonicalCandidate)).isDirectory()) return err(appError('INVALID_INPUT', 'Working directory must be a directory'));
    } catch {
      return err(appError('FILE_NOT_FOUND', 'Working directory was not found'));
    }
    if (!canonicalRoots.some((root) => isWithin(root, canonicalCandidate))) {
      return err(appError('PATH_OUTSIDE_WORKSPACE', 'Working directory is outside configured local roots'));
    }
    if (canonicalActiveRoot !== undefined && !isWithin(canonicalActiveRoot, canonicalCandidate)) {
      return err(appError('PATH_OUTSIDE_WORKSPACE', 'Working directory is outside the host active workspace'));
    }
    return ok(canonicalCandidate);
  }

  private finish(record: ShellTaskRecord, state: TaskState, exitCode?: number, errorMessage?: string): void {
    if (record.state !== 'running' && record.state !== 'termination_unverified') return;
    record.state = state;
    delete record.stopRequested;
    delete record.terminationTarget;
    if (exitCode !== undefined) record.exitCode = exitCode;
    if (errorMessage !== undefined) record.errorMessage = errorMessage;
    record.finishedAt = new Date().toISOString();
    if (record.timer !== undefined) clearTimeout(record.timer);
    record.resolveCompletion();
  }

  private markTerminationUnverified(record: ShellTaskRecord, errorMessage: string): void {
    record.state = 'termination_unverified';
    record.errorMessage = errorMessage;
    delete record.finishedAt;
    if (record.timer !== undefined) clearTimeout(record.timer);
  }

  private snapshot(record: ShellTaskRecord, tailLines?: number): Record<string, unknown> {
    const stdout = record.includeStdout ? record.stdout.text(tailLines) : undefined;
    const stderr = record.includeStderr ? record.stderr.text(tailLines) : undefined;
    return {
      task_id: record.taskId,
      state: record.state,
      ...(record.owner.workspaceId === undefined ? {} : { workspace_id: record.owner.workspaceId }),
      cwd: record.cwd,
      ...(record.exitCode === undefined ? {} : { exit_code: record.exitCode }),
      ...(stdout === undefined ? {} : { stdout }),
      ...(stderr === undefined ? {} : { stderr }),
      ...(record.errorMessage === undefined ? {} : { error: record.errorMessage }),
      started_at: record.startedAt,
      ...(record.finishedAt === undefined ? {} : { finished_at: record.finishedAt }),
      truncated: record.stdout.truncated || record.stderr.truncated,
    };
  }
}

class OutputCapture {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  public truncated = false;

  public constructor(private readonly maxBytes: number) {}

  public append(value: Buffer | string): void {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
    const remaining = this.maxBytes - this.bytes;
    if (remaining <= 0) {
      this.truncated = true;
      return;
    }
    this.chunks.push(chunk.subarray(0, remaining));
    this.bytes += Math.min(chunk.byteLength, remaining);
    if (chunk.byteLength > remaining) this.truncated = true;
  }

  public text(tailLines?: number): string {
    const value = redactText(Buffer.concat(this.chunks).toString('utf8'));
    if (tailLines === undefined || tailLines < 1) return tailLines === 0 ? '' : value;
    const lines = value.split(/\r?\n/);
    return lines.slice(-tailLines).join('\n');
  }
}

function parseShellRequest(value: unknown, defaultTimeoutSeconds: number, defaultBackgroundTimeoutSeconds: number, maxOutputBytes: number): Result<ShellRequest> {
  if (!isRecord(value)) return err(appError('INVALID_INPUT', 'Shell input must be an object'));
  const operation = value.operation === undefined ? 'run' : value.operation;
  if (!isShellOperation(operation)) return err(appError('INVALID_INPUT', 'Shell operation is invalid'));
  const executable = value.executable === undefined ? undefined : value.executable;
  if (executable !== undefined && (typeof executable !== 'string' || executable.trim().length === 0)) return err(appError('INVALID_INPUT', 'Executable is invalid'));
  const rawArguments = value.arguments === undefined ? [] : value.arguments;
  if (!Array.isArray(rawArguments) || !rawArguments.every((item) => typeof item === 'string')) return err(appError('INVALID_INPUT', 'Arguments must be strings'));
  const privilege = value.privilege === undefined ? 'user' : value.privilege;
  if (privilege !== 'user' && privilege !== 'admin') return err(appError('INVALID_INPUT', 'Privilege is invalid'));
  const execution = value.execution === undefined ? 'auto' : value.execution;
  if (execution !== 'foreground' && execution !== 'background' && execution !== 'auto') return err(appError('INVALID_INPUT', 'Execution mode is invalid'));
  const cwd = value.cwd === undefined ? undefined : value.cwd;
  if (cwd !== undefined && (typeof cwd !== 'string' || cwd.includes('\0'))) return err(appError('INVALID_INPUT', 'Working directory is invalid'));
  const taskId = value.task_id === undefined ? undefined : value.task_id;
  if (taskId !== undefined && (typeof taskId !== 'string' || taskId.trim().length === 0)) return err(appError('INVALID_INPUT', 'Task ID is invalid'));
  const timeoutSeconds = value.timeout_seconds === undefined
    ? (execution === 'background' || execution === 'auto' ? defaultBackgroundTimeoutSeconds : defaultTimeoutSeconds)
    : value.timeout_seconds;
  if (typeof timeoutSeconds !== 'number' || !Number.isFinite(timeoutSeconds) || timeoutSeconds < 0.1 || timeoutSeconds > MAX_TIMEOUT_SECONDS) return err(appError('INVALID_INPUT', 'Timeout is invalid'));
  const requestedMaxBytes = value.max_output_bytes === undefined ? maxOutputBytes : value.max_output_bytes;
  if (typeof requestedMaxBytes !== 'number' || !Number.isInteger(requestedMaxBytes) || requestedMaxBytes < 1 || requestedMaxBytes > MAX_OUTPUT_BYTES) return err(appError('INVALID_INPUT', 'Output limit is invalid'));
  const tailLines = value.tail_lines === undefined ? undefined : value.tail_lines;
  if (tailLines !== undefined && (typeof tailLines !== 'number' || !Number.isInteger(tailLines) || tailLines < 0 || tailLines > 10_000)) return err(appError('INVALID_INPUT', 'Tail limit is invalid'));
  const includeStdout = value.include_stdout === undefined ? true : value.include_stdout;
  const includeStderr = value.include_stderr === undefined ? true : value.include_stderr;
  const dryRun = value.dry_run === undefined ? false : value.dry_run;
  const userConfirmed = value.userConfirmed === true;
  const rawAdmissionClass = value.admission_class === undefined ? undefined : value.admission_class;
  if (rawAdmissionClass !== undefined && !isShellHeavyAdmissionClass(rawAdmissionClass)) {
    return err(appError('INVALID_INPUT', `admission_class must be one of ${SHELL_HEAVY_ADMISSION_CLASSES.join(', ')}`));
  }
  const owner = readCapabilityTaskOwner(value);
  const activeWorkspaceRoot = readCapabilityActiveWorkspaceRoot(value);
  if (typeof includeStdout !== 'boolean' || typeof includeStderr !== 'boolean' || typeof dryRun !== 'boolean') return err(appError('INVALID_INPUT', 'Shell flags are invalid'));
  return ok({ operation, ...(executable === undefined ? {} : { executable: executable.trim() }), arguments: rawArguments, privilege, ...(cwd === undefined ? {} : { cwd }), ...(activeWorkspaceRoot === undefined ? {} : { activeWorkspaceRoot }), execution, ...(taskId === undefined ? {} : { taskId }), timeoutSeconds, maxOutputBytes: requestedMaxBytes, ...(tailLines === undefined ? {} : { tailLines }), includeStdout, includeStderr, dryRun, userConfirmed, owner, ...(rawAdmissionClass === undefined ? {} : { admissionClass: rawAdmissionClass }) });
}

function shellOperationId(taskId: string): string {
  return `shell:${taskId}`;
}

function shellTaskIdFromOperationId(operationId: string): string | undefined {
  return operationId.startsWith('shell:') ? operationId.slice('shell:'.length) : undefined;
}

function heavyLeaseOutcome(state: unknown): 'completed' | 'failed' | 'cancelled' | undefined {
  if (state === 'completed') return 'completed';
  if (state === 'failed' || state === 'timed_out') return 'failed';
  if (state === 'cancelled') return 'cancelled';
  // running / termination_unverified / unknown: keep holding the slot.
  return undefined;
}

function isShellHeavyAdmissionClass(value: unknown): value is ShellHeavyAdmissionClass {
  return typeof value === 'string' && (SHELL_HEAVY_ADMISSION_CLASSES as readonly string[]).includes(value);
}

function isShellOperation(value: unknown): value is ShellOperation {
  return typeof value === 'string' && SHELL_OPERATIONS.some((operation) => operation === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === '') return true;
  if (path.isAbsolute(relative)) return false;
  const [firstSegment] = relative.split(path.sep);
  return firstSegment !== '..';
}

function createSafeEnvironment(source: NodeJS.ProcessEnv, unrestricted: boolean): NodeJS.ProcessEnv {
  if (unrestricted) return { ...source };
  const allowed = new Set([
    'PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'HOME',
    'LANG', 'LC_ALL', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'ComSpec',
    // POSIX desktop-session handles are not credentials. Preserve them so a
    // scoped child can use the user's X11/Wayland/DBus/PipeWire session.
    'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'XDG_SESSION_TYPE', 'DBUS_SESSION_BUS_ADDRESS',
    'XDG_CURRENT_DESKTOP', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'PULSE_SERVER', 'PIPEWIRE_REMOTE', 'AT_SPI_BUS_ADDRESS',
    'GDK_BACKEND', 'QT_QPA_PLATFORM',
  ].map((key) => process.platform === 'win32' ? key.toLowerCase() : key));
  return Object.fromEntries(Object.entries(source).filter(([key, entry]) => {
    const normalizedKey = process.platform === 'win32' ? key.toLowerCase() : key;
    return entry !== undefined && allowed.has(normalizedKey);
  }));
}

function redactText(value: string): string {
  return value
    .replace(/(\bauthorization\s*:\s*bearer\s+)[^\s]+/gi, '$1[redacted]')
    .replace(/\b(token|secret|password|api[_-]?key|private[_-]?key)\s*[:=]\s*[^\s]+/gi, '$1=[redacted]');
}

function clampNumber(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function isVerifiedTerminal(state: TaskState): boolean {
  return state === 'completed' || state === 'failed' || state === 'timed_out' || state === 'cancelled';
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
