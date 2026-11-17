import type { CodexService, FileActor, ProcessService } from '@unified-mpc/application';
import type { ShellCapabilityBackend } from '@unified-mpc/capabilities';
import type { ManagedProcessState } from '@unified-mpc/process';

const LIVE_PROCESS_STATES: ReadonlySet<ManagedProcessState> = new Set([
  'starting', 'running', 'termination_unverified',
]);

const TASK_LIVE_STATES: ReadonlySet<string> = new Set(['working', 'input_required']);
const TASK_GONE_STATES: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);

/**
 * How a Codex task's managed process reads.
 *
 * `termination_unverified` is live: the process may still be finishing, and this
 * probe releases a goal, so the doubt goes to the pin. `stopped` and `timed_out` are
 * gone for the same reason `exited` is — the process is verified terminal, so the
 * task cannot produce more work.
 */
const CODEX_LIVE_STATES: ReadonlySet<ManagedProcessState> = new Set([
  'starting', 'running', 'termination_unverified',
]);
const CODEX_GONE_STATES: ReadonlySet<ManagedProcessState> = new Set([
  'exited', 'failed', 'stopped', 'timed_out',
]);

/** Authorities this runtime can ask about directly; the ledger's closed set is wider. */
export type DeferredHandleProvider = 'process' | 'task' | 'verification' | 'codex';

/**
 * A verdict about one deferred handle, or about the workspace that owns it.
 *
 * `unknown` is not a synonym for `gone`: it says the authority could not answer,
 * and the only safe reading of that is "still pinned". Every adapter returns it
 * on an error instead of falling back to the empty answer, which would release a
 * goal on a store that never spoke.
 */
export type DeferredHandleState = 'live' | 'gone' | 'unknown';

/**
 * The part of `ModernTasksProtocol` this module needs, spelled structurally so
 * the CLI runtime does not depend on the MCP server package to ask a task store
 * whether a task is still running. `getTask` is public there, so the protocol
 * satisfies this without an adapter.
 */
export interface DeferredTaskObservation {
  getTask(params: { readonly taskId: string }): Promise<{ readonly status: string }>;
}

/**
 * The durable-task side of a `task` handle.
 *
 * `task_create` hands back a durable shell task id, and the shell backend is the
 * only writer of that task directory, so the authority asks it for a verdict
 * instead of opening a second store over the same files: one writer per directory
 * is what keeps a probe from racing the store it reads.
 */
export type DurableTaskObservation = Pick<ShellCapabilityBackend, 'taskLivenessForGoal'>;

/**
 * The verification side of a `verification` handle.
 *
 * `merge_verification_run` hands back an attempt id while the gate it queued has
 * not run, and the status port is the one place that reads an attempt row
 * honestly — it knows a `running` row whose heartbeat expired is a dead runner,
 * not live work — so the authority asks it instead of decoding the row again.
 */
export type MergeVerificationObservation = {
  attemptState(request: {
    readonly attemptId: string;
    readonly workspaceId: string;
  }): Promise<DeferredHandleState>;
};

/**
 * The codex side of a `codex` handle.
 *
 * `codex_run` hands back a `codexTaskId`, and the `CodexService` that launched it is
 * the only reader of that task's process: the CLI's process listing is a different
 * manager and cannot see it at all, so asking the listing would read every live codex
 * run as gone. `statusForGoalLiveness` is the service's own workspace-scoped probe,
 * already used for durable-goal orphan detection, so no second store is opened here.
 *
 * Spelled structurally against `CodexService` so the CLI asks the exact method the
 * service already exposes instead of restating its shape.
 */
export type CodexTaskObservation = Pick<CodexService, 'statusForGoalLiveness'>;

export interface DeferredClosureAuthority {
  /**
   * Whether the workspace still owns a live managed process.
   *
   * This is the coarsest question the process store can answer honestly: it lists
   * every handle this runtime registered for the workspace, never another host's.
   */
  workspaceProcessState(request: {
    readonly actor: FileActor;
    readonly workspaceId: string;
  }): Promise<DeferredHandleState>;

  /** The state of one handle, asked of the authority that owns it. */
  handleState(request: {
    readonly actor: FileActor;
    readonly workspaceId: string;
    readonly provider: DeferredHandleProvider;
    readonly handleId: string;
  }): Promise<DeferredHandleState>;
}

/**
 * Route a handle question to the store that owns it, so a caller never decides
 * which store to consult and a provider without an adapter stays `unknown`.
 */
export function createDeferredClosureAuthority(options: {
  readonly processes?: Pick<ProcessService, 'list'>;
  readonly tasks?: DeferredTaskObservation;
  /** The backend that wrote the durable task directory a `task_create` id lives in. */
  readonly durableTasks?: DurableTaskObservation;
  /** The status port that owns the reading of a queued `merge_verification_run`. */
  readonly verification?: MergeVerificationObservation;
  /** The codex service that launched a `codex_run` task, and the only reader of it. */
  readonly codex?: CodexTaskObservation;
}): DeferredClosureAuthority {
  const listProcesses = async (
    actor: FileActor,
    workspaceId: string,
  ): Promise<readonly { readonly processId: string; readonly state: ManagedProcessState }[] | undefined> => {
    const processes = options.processes;
    if (processes === undefined) return undefined;
    const listed = await processes.list(actor, workspaceId);
    return listed.ok ? listed.value : undefined;
  };

  return {
    async workspaceProcessState({ actor, workspaceId }): Promise<DeferredHandleState> {
      const listed = await listProcesses(actor, workspaceId);
      if (listed === undefined) return 'unknown';
      return listed.some((entry) => LIVE_PROCESS_STATES.has(entry.state)) ? 'live' : 'gone';
    },

    async handleState({ actor, workspaceId, provider, handleId }): Promise<DeferredHandleState> {
      if (provider === 'task') return taskState(options.tasks, options.durableTasks, workspaceId, handleId);
      if (provider === 'verification') return verificationState(options.verification, workspaceId, handleId);
      if (provider === 'codex') return codexState(options.codex, workspaceId, handleId);
      const listed = await listProcesses(actor, workspaceId);
      if (listed === undefined) return 'unknown';
      const handle = listed.find((entry) => entry.processId === handleId);
      if (handle === undefined) return 'gone';
      return LIVE_PROCESS_STATES.has(handle.state) ? 'live' : 'gone';
    },
  };
}

async function verificationState(
  verification: MergeVerificationObservation | undefined,
  workspaceId: string,
  attemptId: string,
): Promise<DeferredHandleState> {
  // No adapter is the same answer as an adapter that cannot read the row: the
  // call keeps its pin. Only a `gone` verdict releases it.
  if (verification === undefined) return 'unknown';
  try {
    const verdict = await verification.attemptState({ attemptId, workspaceId });
    return verdict === 'live' || verdict === 'gone' ? verdict : 'unknown';
  } catch {
    return 'unknown';
  }
}

async function codexState(
  codex: CodexTaskObservation | undefined,
  workspaceId: string,
  codexTaskId: string,
): Promise<DeferredHandleState> {
  // Same direction as every other adapter: no service and an unreadable task both
  // keep the pin. `PROCESS_NOT_FOUND` is how a host that restarted answers for a
  // task it no longer owns, and reading that as gone would release a goal on work
  // that may still be running elsewhere.
  if (codex === undefined) return 'unknown';
  try {
    const observation = codex.statusForGoalLiveness(workspaceId, codexTaskId);
    if (!observation.ok) return 'unknown';
    const state = observation.value.state;
    if (CODEX_LIVE_STATES.has(state)) return 'live';
    if (CODEX_GONE_STATES.has(state)) return 'gone';
    // A state added later is not evidence the task ended.
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

async function taskState(
  tasks: DeferredTaskObservation | undefined,
  durableTasks: DurableTaskObservation | undefined,
  workspaceId: string,
  handleId: string,
): Promise<DeferredHandleState> {
  // A durable shell task id and an MCP task id are both opaque strings, so the
  // backend that wrote the task directory is asked first: it answers `unknown`
  // for an id it never wrote, which is exactly the case the protocol covers.
  if (durableTasks !== undefined) {
    const verdict = await durableTasks.taskLivenessForGoal(workspaceId, handleId);
    if (verdict !== 'unknown') return verdict;
  }
  if (tasks === undefined) return 'unknown';
  try {
    const observation = await tasks.getTask({ taskId: handleId });
    if (TASK_LIVE_STATES.has(observation.status)) return 'live';
    if (TASK_GONE_STATES.has(observation.status)) return 'gone';
    // A status the protocol adds later is not evidence the work ended.
    return 'unknown';
  } catch {
    // An unreadable task id, an expired task and an unavailable store all look
    // the same from here, and none of them may release the pin.
    return 'unknown';
  }
}
