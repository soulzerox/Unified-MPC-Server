import type { FileActor, ProcessService } from '@unified-mpc/application';
import type { ManagedProcess, ManagedProcessState } from '@unified-mpc/process';
import type { SqliteWorkspaceJournalRepository } from '@unified-mpc/storage';

const LIVE_PROCESS_STATES: ReadonlySet<ManagedProcessState> = new Set(['starting', 'running', 'termination_unverified']);

/**
 * Deferred kinds whose handle is a managed process, and therefore answerable by
 * the process store in this runtime.
 *
 * The rest of `DEFERRED_CLOSURE_OPERATION_KINDS` stays open on purpose: a task id,
 * a parked shell, a worktree or a swarm id lives in another authority, and
 * guessing "not in the process store, so finished" is the fail-open the journal
 * exists to prevent. `shell`/`wsl_exec` are excluded for the same reason: their
 * own process can exit while a backgrounded child keeps working.
 */
export const PROCESS_HANDLE_DEFERRED_KINDS: ReadonlySet<string> = new Set([
  'process_start', 'project_dev', 'project_test', 'project_lint', 'project_typecheck', 'project_build',
]);

export const NO_LIVE_PROCESS_CLOSURE_CODE = 'no_live_process';

/**
 * Calls recorded before this runtime started belong to a previous host.
 *
 * The process store only knows the handles this runtime created, so "absent from
 * the list" is evidence for a call we could have observed and a guess for one we
 * could not. This instant is what keeps the sweep on the honest side of that line;
 * module load is the earliest point of the runtime that could have journaled.
 */
const RUNTIME_OBSERVED_FROM = new Date().toISOString();

/**
 * Close the deferred call this request opened, once the workspace has no live
 * managed process left.
 *
 * `callIds` is not an optimisation, it is the honesty boundary. `ProcessService`
 * only lists the handles THIS runtime registered, while the journal is shared by
 * every stdio host on the same database, so "no live process" is evidence about
 * one call, never about a neighbouring host's call. Closing by workspace alone
 * would read another host's running `project_dev` as finished.
 *
 * A store that cannot answer, or no process service at all, closes nothing. One
 * live process keeps the call pinned, which also errs closed.
 *
 * `settled` says the probe proved the workspace has no live process, so every
 * call in `callIds` is now either closed or was already closed: the caller can
 * forget them instead of re-asking on every later request.
 */
export async function closeObservedDeferredCalls(options: {
  readonly journal: Pick<SqliteWorkspaceJournalRepository, 'closeDeferredCalls'>;
  readonly processes?: Pick<ProcessService, 'list'>;
  readonly actor: FileActor;
  readonly workspaceId: string;
  /** The call whose request just completed: the only one this runtime may answer. */
  readonly callIds: readonly string[];
  readonly closedAt: string;
}): Promise<{ readonly closed: number; readonly settled: boolean }> {
  if (options.processes === undefined || options.callIds.length === 0) return { closed: 0, settled: false };
  const listed = await options.processes.list(options.actor, options.workspaceId);
  if (!listed.ok) return { closed: 0, settled: false };
  if (listed.value.some(isLiveProcess)) return { closed: 0, settled: false };
  const closed = options.journal.closeDeferredCalls({
    workspaceId: options.workspaceId,
    operationKinds: [...PROCESS_HANDLE_DEFERRED_KINDS],
    recordedAtOrAfter: RUNTIME_OBSERVED_FROM,
    callIds: options.callIds,
    closureCode: NO_LIVE_PROCESS_CLOSURE_CODE,
    closedAt: options.closedAt,
  });
  return { closed, settled: true };
}

/**
 * Forget a settled call, and only one the probe covered.
 *
 * `settled` is a verdict about a snapshot taken before the awaited process read,
 * so it says nothing about a launcher whose `started` row landed during that
 * await. Taking the probed ids — never the workspace — is the whole safety
 * property: an unprobed call that got dropped here is never retried, and its pin
 * pins the goal `present` for good.
 */
export function forgetSettledCalls(
  remembered: Map<string, string>,
  probedCallIds: readonly string[],
): void {
  for (const callId of probedCallIds) remembered.delete(callId);
}

function isLiveProcess(process: ManagedProcess): boolean {
  return LIVE_PROCESS_STATES.has(process.state);
}
