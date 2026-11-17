import type { FileActor } from '@unified-mpc/application';
import type {
  DeferredHandleProvider as StoredHandleProvider,
  SqliteDeferredHandleRepository,
  SqliteWorkspaceJournalRepository,
} from '@unified-mpc/storage';
import type { DeferredClosureAuthority, DeferredHandleProvider } from './deferred-closure-authority.js';

export const NO_LIVE_PROCESS_CLOSURE_CODE = 'no_live_process';
export const NO_LIVE_TASK_CLOSURE_CODE = 'no_live_task';

/**
 * How one recorded provider becomes a verdict: the adapter to ask, and the closure
 * code its `gone` answer is written under.
 *
 * A provider missing here has no closure code yet, so its `gone` answer has no
 * vocabulary to be written in: it is never asked and never closed, and its handle
 * keeps the pin, which is the only safe reading of "no verdict". Adding an adapter
 * and its code together is what makes a provider releasable, and one entry is all
 * it takes, so the two can never disagree.
 */
interface ClosureRoute {
  readonly provider: DeferredHandleProvider;
  readonly closureCode: string;
}

const CLOSURE_ROUTES: Readonly<Partial<Record<StoredHandleProvider, ClosureRoute>>> = {
  process: { provider: 'process', closureCode: NO_LIVE_PROCESS_CLOSURE_CODE },
  // `task_create` hands back a durable shell task id; the authority answers it
  // from the shell backend that wrote the task directory, not from a second store.
  task: { provider: 'task', closureCode: NO_LIVE_TASK_CLOSURE_CODE },
};

/**
 * Calls recorded before this runtime started belong to a previous host.
 *
 * The process store only knows the handles this runtime created, so "absent from
 * the ledger answer" is evidence for a call we could have observed and a guess for
 * one we could not. This instant is what keeps the sweep on the honest side of
 * that line; module load is the earliest point of the runtime that could have
 * journaled.
 */
const RUNTIME_OBSERVED_FROM = new Date().toISOString();

/**
 * Close the deferred calls a probe can account for, each by its own handle.
 *
 * The ledger says which handle a call returned and which authority owns it; this
 * asks that authority per call instead of asking the workspace as a whole. That
 * difference is the point: a workspace answer says "some process is live", which
 * pins every call in it, while a handle answer says whether *this* call's work
 * ended.
 *
 * `ownedCallIds` is not an optimisation, it is the honesty boundary, and this
 * function reads, probes, closes and forgets nothing outside it. The ledger and
 * the journal are shared by every stdio host on the database, while the process
 * store only lists the handles THIS runtime registered, so "not in the list" is
 * `gone` only for a call this runtime journaled.
 *
 * `unknown` — no adapter, an unaskable provider, or a store that cannot answer —
 * closes nothing. A provider with no route is never asked, so it also never
 * settles.
 *
 * `accountedCallIds` is the answer the caller acts on: a call is accounted for
 * only when nothing is left to ask about it — its row closed (now or by an
 * earlier sweep), it recorded a provider no adapter can ask about, or it recorded
 * no handle at all and the workspace held nothing live. Callers forget exactly
 * these and keep the rest for a later sweep: `live` and `unknown` keep the pin and
 * are asked again on the next completion, and so does a row the store refused.
 */
export async function closeJudgedDeferredCalls(options: {
  readonly journal: Pick<SqliteWorkspaceJournalRepository, 'closeDeferredCalls' | 'openDeferredCallIds'>;
  /** The handle ledger: which handle each call returned, and the authority that owns it. */
  readonly handles: Pick<SqliteDeferredHandleRepository, 'take' | 'forget'>;
  /** Asks the stores that own a handle; `unknown` never closes a call. */
  readonly authority: Pick<DeferredClosureAuthority, 'handleState' | 'workspaceProcessState'>;
  /** Kinds the journal will accept a closure for; the exact `ownedCallIds` do the narrowing. */
  readonly operationKinds: readonly string[];
  readonly actor: FileActor;
  readonly workspaceId: string;
  /** The calls this runtime journaled: the only calls it may judge. */
  readonly ownedCallIds: readonly string[];
  readonly closedAt: string;
}): Promise<{ readonly closed: number; readonly accountedCallIds: readonly string[] }> {
  const owned = new Set(options.ownedCallIds);
  if (owned.size === 0) return { closed: 0, accountedCallIds: [] };
  const recorded = options.handles.take(options.workspaceId, [...owned]);
  const recordedIds = new Set(recorded.map((handle) => handle.callId));
  /** Calls an adapter proved gone, with the code their verdict is written under. */
  const gone = new Map<string, string>();
  /** Calls whose recorded provider has no adapter: nothing left to ask, nothing to retry. */
  const unaskable = new Set<string>();

  for (const handle of recorded) {
    // A row outside the owned set is another host's evidence: judging it here
    // would close a goal on a store this runtime never wrote.
    if (!owned.has(handle.callId)) continue;
    const route = CLOSURE_ROUTES[handle.provider];
    if (route === undefined) {
      unaskable.add(handle.callId);
      continue;
    }
    const state = await options.authority.handleState({
      actor: options.actor,
      workspaceId: options.workspaceId,
      provider: route.provider,
      handleId: handle.handleId,
    });
    if (state !== 'gone') continue;
    gone.set(handle.callId, route.closureCode);
  }

  const withoutHandle = [...owned].filter((callId) => !recordedIds.has(callId));
  if (withoutHandle.length > 0) {
    // No handle to ask about: a launch that failed, an `isError` response, or a
    // ledger write that threw. The workspace question is the only evidence left,
    // and it is asked only for calls this runtime journaled. With nothing live
    // here the work never started, so the row can close; leaving it open would
    // pin the goal `present` for good.
    const state = await options.authority.workspaceProcessState({
      actor: options.actor,
      workspaceId: options.workspaceId,
    });
    if (state === 'gone') {
      for (const callId of withoutHandle) gone.set(callId, NO_LIVE_PROCESS_CLOSURE_CODE);
    }
  }

  let closed = 0;
  /** Calls nothing is left to ask about: only those may be forgotten. */
  const accounted = new Set<string>();
  /** Calls whose close this attempt did not land, still to be classified. */
  const refused: string[] = [];
  for (const [callId, closureCode] of gone) {
    // One call per write: the store reports a count, so a shared bucket could not
    // say which rows landed.
    const closedHere = options.journal.closeDeferredCalls({
      workspaceId: options.workspaceId,
      operationKinds: [...options.operationKinds],
      recordedAtOrAfter: RUNTIME_OBSERVED_FROM,
      callIds: [callId],
      closureCode,
      closedAt: options.closedAt,
    });
    if (closedHere === 0) {
      refused.push(callId);
      continue;
    }
    closed += closedHere;
    accounted.add(callId);
    // The verdict landed, so the correlation has done its job.
    options.handles.forget(options.workspaceId, [callId]);
  }

  if (refused.length > 0) {
    // A zero is also what an earlier sweep's landed close looks like on every
    // later attempt. That row already stops pinning, so asking about it again
    // would never finish; only a row still open is a call to keep asking about.
    const stillOpen = new Set(options.journal.openDeferredCallIds({
      workspaceId: options.workspaceId,
      callIds: refused,
    }));
    for (const callId of refused) {
      if (stillOpen.has(callId)) continue;
      accounted.add(callId);
      options.handles.forget(options.workspaceId, [callId]);
    }
  }

  // Nothing can answer for these, now or later: asking again could only repeat
  // the same "no route". The ledger row stays, the pin stays, the retry does not.
  for (const callId of unaskable) accounted.add(callId);

  return { closed, accountedCallIds: [...accounted] };
}

/**
 * Probe the snapshot of remembered calls, then forget exactly the accounted ones.
 *
 * `accountedCallIds` is a verdict about a snapshot: the calls this runtime
 * remembered when the probe started. A launcher whose `started` row lands while
 * the probe awaits was never in that snapshot, so forgetting by workspace would
 * drop a call no verdict covers — it is never retried, and its pin holds the goal
 * `present` for good. Both the snapshot and the delete live here, so the rule has
 * one home and a caller cannot reach the map with the wrong set.
 *
 * Pruning is per call, not per sweep: a landed close next to a live sibling stays
 * forgotten instead of being re-probed on every later completion. A call that is
 * not accounted for is remembered again — including one supplied only through
 * `additionalOwnedCallIds`, whose eviction left it nothing else to be retried from.
 */
export async function settleRememberedCalls(options: {
  readonly remembered: Map<string, string>;
  readonly workspaceId: string;
  /**
   * Calls this runtime journaled that the bounded map no longer holds, such as the
   * one whose completion is being handled now. Ownership comes from this runtime's
   * own `started` event, not from the map, so an evicted call still gets judged.
   */
  readonly additionalOwnedCallIds?: readonly string[];
  /** Bound on the map, so re-remembering can never grow it past the caller's cap. */
  readonly maxRemembered?: number;
  readonly probe: (ownedCallIds: readonly string[]) => Promise<{
    readonly closed: number;
    readonly accountedCallIds: readonly string[];
  }>;
}): Promise<void> {
  const own = [...options.remembered]
    .filter(([, workspaceId]) => workspaceId === options.workspaceId)
    .map(([callId]) => callId);
  const judged = [...new Set([...own, ...(options.additionalOwnedCallIds ?? [])])];
  if (judged.length === 0) return;
  const { accountedCallIds } = await options.probe(judged);
  const accounted = new Set(accountedCallIds);
  for (const callId of own) {
    if (accounted.has(callId)) options.remembered.delete(callId);
  }
  for (const callId of judged) {
    if (accounted.has(callId) || options.remembered.has(callId)) continue;
    options.remembered.set(callId, options.workspaceId);
    if (options.maxRemembered === undefined) continue;
    while (options.remembered.size > options.maxRemembered) {
      const oldest = options.remembered.keys().next().value;
      if (oldest === undefined) break;
      options.remembered.delete(oldest);
    }
  }
}
