import type { FileActor, ProcessService } from '@unified-mpc/application';
import type { ManagedProcessState } from '@unified-mpc/process';

const LIVE_PROCESS_STATES: ReadonlySet<ManagedProcessState> = new Set([
  'starting', 'running', 'termination_unverified',
]);

const TASK_LIVE_STATES: ReadonlySet<string> = new Set(['working', 'input_required']);
const TASK_GONE_STATES: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);

/** Authorities this runtime can ask about directly; the ledger's closed set is wider. */
export type DeferredHandleProvider = 'process' | 'task';

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
      if (provider === 'task') return taskState(options.tasks, handleId);
      const listed = await listProcesses(actor, workspaceId);
      if (listed === undefined) return 'unknown';
      const handle = listed.find((entry) => entry.processId === handleId);
      if (handle === undefined) return 'gone';
      return LIVE_PROCESS_STATES.has(handle.state) ? 'live' : 'gone';
    },
  };
}

async function taskState(
  tasks: DeferredTaskObservation | undefined,
  handleId: string,
): Promise<DeferredHandleState> {
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
