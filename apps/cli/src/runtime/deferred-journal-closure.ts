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
 * Close the deferred calls this runtime can prove finished: no managed process of
 * the workspace is live, and the call was recorded while this runtime was up.
 *
 * Coarse on purpose. One live process keeps every open call in the workspace
 * pinned, which errs closed; a store that cannot answer, or no process service at
 * all, closes nothing. Returns how many calls it closed.
 */
export async function closeObservedDeferredCalls(options: {
  readonly journal: Pick<SqliteWorkspaceJournalRepository, 'closeDeferredCalls'>;
  readonly processes?: Pick<ProcessService, 'list'>;
  readonly actor: FileActor;
  readonly workspaceId: string;
  readonly closedAt: string;
}): Promise<number> {
  if (options.processes === undefined) return 0;
  const listed = await options.processes.list(options.actor, options.workspaceId);
  if (!listed.ok) return 0;
  if (listed.value.some(isLiveProcess)) return 0;
  return options.journal.closeDeferredCalls({
    workspaceId: options.workspaceId,
    operationKinds: [...PROCESS_HANDLE_DEFERRED_KINDS],
    recordedAtOrAfter: RUNTIME_OBSERVED_FROM,
    closureCode: NO_LIVE_PROCESS_CLOSURE_CODE,
    closedAt: options.closedAt,
  });
}

function isLiveProcess(process: ManagedProcess): boolean {
  return LIVE_PROCESS_STATES.has(process.state);
}
