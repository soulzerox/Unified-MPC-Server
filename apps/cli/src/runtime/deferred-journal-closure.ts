import type { FileActor } from '@unified-mpc/application';
import type {
  DeferredHandleProvider as StoredHandleProvider,
  SqliteDeferredHandleRepository,
  SqliteWorkspaceJournalRepository,
} from '@unified-mpc/storage';
import type { DeferredClosureAuthority, DeferredHandleProvider } from './deferred-closure-authority.js';

export const NO_LIVE_PROCESS_CLOSURE_CODE = 'no_live_process';

/**
 * How one recorded provider becomes a verdict: the adapter to ask, and the closure
 * code its `gone` answer is written under.
 *
 * A provider missing here has no adapter yet, so it is never asked and never
 * closed: its handle keeps the pin, which is the only safe reading of "nothing
 * asked". Adding an adapter and its code together is what makes a provider
 * releasable, and one entry is all it takes, so the two can never disagree.
 */
interface ClosureRoute {
  readonly provider: DeferredHandleProvider;
  readonly closureCode: string;
}

const CLOSURE_ROUTES: Readonly<Partial<Record<StoredHandleProvider, ClosureRoute>>> = {
  process: { provider: 'process', closureCode: NO_LIVE_PROCESS_CLOSURE_CODE },
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
 * `settled` says every owned call is accounted for — its handle was proven gone,
 * its workspace was proven to hold no live process while it recorded no handle at
 * all, or it recorded a provider no adapter can ask about — so the caller can
 * forget them instead of re-asking on every later request. `live` and `unknown`
 * keep the pin and are asked again on the next completion.
 */
export async function closeJudgedDeferredCalls(options: {
  readonly journal: Pick<SqliteWorkspaceJournalRepository, 'closeDeferredCalls'>;
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
}): Promise<{ readonly closed: number; readonly settled: boolean }> {
  const owned = new Set(options.ownedCallIds);
  if (owned.size === 0) return { closed: 0, settled: false };
  const recorded = options.handles.take(options.workspaceId, [...owned]);
  const recordedIds = new Set(recorded.map((handle) => handle.callId));
  const closedIds = new Set<string>();
  /** Calls whose recorded provider has no adapter: nothing left to ask, nothing to retry. */
  const unaskable = new Set<string>();
  const byCode = new Map<string, string[]>();

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
    closedIds.add(handle.callId);
    byCode.set(route.closureCode, [...(byCode.get(route.closureCode) ?? []), handle.callId]);
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
      for (const callId of withoutHandle) closedIds.add(callId);
      byCode.set(NO_LIVE_PROCESS_CLOSURE_CODE, [
        ...(byCode.get(NO_LIVE_PROCESS_CLOSURE_CODE) ?? []),
        ...withoutHandle,
      ]);
    }
  }

  let closed = 0;
  for (const [closureCode, closedCallIds] of byCode) {
    const closedHere = options.journal.closeDeferredCalls({
      workspaceId: options.workspaceId,
      operationKinds: [...options.operationKinds],
      recordedAtOrAfter: RUNTIME_OBSERVED_FROM,
      callIds: closedCallIds,
      closureCode,
      closedAt: options.closedAt,
    });
    closed += closedHere;
    // Only a verdict that landed retires the correlation. A row the store
    // refused (already closed, or recorded before this runtime) keeps its ledger
    // entry, so a later sweep can still ask about it.
    if (closedHere > 0) options.handles.forget(options.workspaceId, closedCallIds);
  }

  const pending = [...owned].filter((callId) => !closedIds.has(callId) && !unaskable.has(callId));
  return { closed, settled: pending.length === 0 };
}

/**
 * Probe the snapshot of remembered calls, then forget exactly that snapshot.
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
  readonly probe: (ownedCallIds: readonly string[]) => Promise<{ readonly closed: number; readonly settled: boolean }>;
}): Promise<void> {
  const own = [...options.remembered]
    .filter(([, workspaceId]) => workspaceId === options.workspaceId)
    .map(([callId]) => callId);
  if (own.length === 0) return;
  const { settled } = await options.probe(own);
  if (!settled) return;
  for (const callId of own) options.remembered.delete(callId);
}
