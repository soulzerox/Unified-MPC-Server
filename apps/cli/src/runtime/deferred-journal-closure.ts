import type { FileActor } from '@unified-mpc/application';
import type { SqliteWorkspaceJournalRepository } from '@unified-mpc/storage';
import type { DeferredClosureAuthority } from './deferred-closure-authority.js';

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
 * Close the deferred call this request opened, once the authority that owns its
 * handle proves the workspace has no live managed process left.
 *
 * `callIds` is not an optimisation, it is the honesty boundary. The process store
 * only lists the handles THIS runtime registered, while the journal is shared by
 * every stdio host on the same database, so "no live process" is evidence about
 * one call, never about a neighbouring host's call. Closing by workspace alone
 * would read another host's running `project_dev` as finished.
 *
 * `unknown` — no process service, or a store that cannot answer — closes nothing.
 * One live process keeps the call pinned, which also errs closed.
 *
 * `settled` says the probe proved the workspace has no live process, so every
 * call in `callIds` is now either closed or was already closed: the caller can
 * forget them instead of re-asking on every later request.
 */
export async function closeObservedDeferredCalls(options: {
  readonly journal: Pick<SqliteWorkspaceJournalRepository, 'closeDeferredCalls'>;
  /** Asks the store that owns the handles; `unknown` never closes a call. */
  readonly authority: Pick<DeferredClosureAuthority, 'workspaceProcessState'>;
  readonly actor: FileActor;
  readonly workspaceId: string;
  /** The call whose request just completed: the only one this runtime may answer. */
  readonly callIds: readonly string[];
  readonly closedAt: string;
}): Promise<{ readonly closed: number; readonly settled: boolean }> {
  if (options.callIds.length === 0) return { closed: 0, settled: false };
  const state = await options.authority.workspaceProcessState({
    actor: options.actor,
    workspaceId: options.workspaceId,
  });
  if (state !== 'gone') return { closed: 0, settled: false };
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
 * Probe the workspace, then forget exactly the calls the probe covered.
 *
 * `settled` is a verdict about a snapshot: the calls this runtime remembered when
 * the probe started. A launcher whose `started` row lands while the probe awaits
 * was never in that snapshot, so forgetting by workspace would drop a call no
 * verdict covers — it is never retried, and its pin holds the goal `present` for
 * good. Both the snapshot and the delete live here, so the rule has one home and
 * a caller cannot reach the map with the wrong set.
 */
export async function settleRememberedCalls(options: {
  readonly remembered: Map<string, string>;
  readonly workspaceId: string;
  /** The call whose request just completed: the runtime may answer for it too. */
  readonly callId: string;
  readonly probe: (callIds: readonly string[]) => Promise<{ readonly closed: number; readonly settled: boolean }>;
}): Promise<void> {
  const own = [...options.remembered]
    .filter(([, workspaceId]) => workspaceId === options.workspaceId)
    .map(([callId]) => callId);
  const { settled } = await options.probe([...new Set([options.callId, ...own])]);
  if (!settled) return;
  for (const callId of own) options.remembered.delete(callId);
}
