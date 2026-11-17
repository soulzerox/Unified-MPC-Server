import type { FileActor } from '@unified-mpc/application';
import type { SqliteDeferredHandleRepository, SqliteWorkspaceJournalRepository } from '@unified-mpc/storage';
import type { DeferredClosureAuthority, DeferredHandleProvider } from './deferred-closure-authority.js';

export const NO_LIVE_PROCESS_CLOSURE_CODE = 'no_live_process';

/**
 * The closure code each provider's verdict is written under, or `undefined` when
 * no adapter can answer for it yet.
 *
 * A provider missing here cannot be closed at all: its handle stays pinned, which
 * is the only safe reading of "nothing asked". Adding an authority adapter and its
 * code together is what makes a provider releasable.
 */
const CLOSURE_CODES: Readonly<Partial<Record<DeferredHandleProvider, string>>> = {
  process: NO_LIVE_PROCESS_CLOSURE_CODE,
};

/**
 * The ledger's closed provider set is wider than the runtime can answer for, so a
 * stored row can name a provider no adapter exists for. This is the narrowing that
 * keeps those rows pinned instead of asking a store that was never wired.
 */
function supportedProvider(provider: string): provider is DeferredHandleProvider {
  return provider === 'process' || provider === 'task';
}

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
 * `ownedCallIds` is not an optimisation, it is the honesty boundary. The ledger
 * and the journal are shared by every stdio host on the database, while the
 * process store only lists the handles THIS runtime registered, so "not in the
 * list" is `gone` only for a call this runtime journaled. Ownership is what makes
 * one host's answer evidence, never another host's.
 *
 * `unknown` — no adapter, an unaskable provider, or a store that cannot answer —
 * closes nothing. A call with no ledger row is skipped and keeps its pin.
 *
 * `settled` says every call this runtime owned is accounted for — its handle was
 * proven gone, or it recorded no handle any adapter can ask about — so the caller
 * can forget them instead of re-asking on every later request.
 */
export async function closeJudgedDeferredCalls(options: {
  readonly journal: Pick<SqliteWorkspaceJournalRepository, 'closeDeferredCalls'>;
  /** The handle ledger: which handle each call returned, and the authority that owns it. */
  readonly handles: Pick<SqliteDeferredHandleRepository, 'take' | 'forget'>;
  /** Asks the store that owns a handle; `unknown` never closes a call. */
  readonly authority: Pick<DeferredClosureAuthority, 'handleState'>;
  /** Kinds the journal will accept a closure for; the exact `callIds` do the narrowing. */
  readonly operationKinds: readonly string[];
  readonly actor: FileActor;
  readonly workspaceId: string;
  /** The calls to judge. A call with no recorded handle is skipped, never assumed. */
  readonly callIds: readonly string[];
  /** The subset this runtime journaled: the only calls a probe may call settled. */
  readonly ownedCallIds: readonly string[];
  readonly closedAt: string;
}): Promise<{ readonly closed: number; readonly settled: boolean }> {
  const owned = new Set(options.ownedCallIds);
  const recorded = options.handles.take(options.workspaceId, options.callIds);
  const gone: string[] = [];
  /** Calls whose handle an adapter can actually be asked about. */
  const askable = new Set<string>();
  const byCode = new Map<string, string[]>();
  for (const handle of recorded) {
    if (!supportedProvider(handle.provider)) continue;
    const code = CLOSURE_CODES[handle.provider];
    // A provider with no code has no adapter: asking it would only produce
    // `unknown`, and a verdict no code can express must not close a call.
    if (code === undefined) continue;
    askable.add(handle.callId);
    const state = await options.authority.handleState({
      actor: options.actor,
      workspaceId: options.workspaceId,
      provider: handle.provider,
      handleId: handle.handleId,
    });
    if (state !== 'gone') continue;
    gone.push(handle.callId);
    byCode.set(code, [...(byCode.get(code) ?? []), handle.callId]);
  }

  let closed = 0;
  for (const [closureCode, closedCallIds] of byCode) {
    closed += options.journal.closeDeferredCalls({
      workspaceId: options.workspaceId,
      operationKinds: [...options.operationKinds],
      recordedAtOrAfter: RUNTIME_OBSERVED_FROM,
      callIds: closedCallIds,
      closureCode,
      closedAt: options.closedAt,
    });
    // The verdict landed, so the correlation has done its job. Forgetting it is
    // what stops a settled call costing a lookup on every later request.
    options.handles.forget(options.workspaceId, closedCallIds);
  }

  // Settled means every call this runtime owned is accounted for: its handle is
  // gone, or it never recorded one an adapter can ask about (a failed launch, an
  // unwired provider), so re-asking could only produce the same answer. Anything
  // still `live` or `unknown` is asked again on the next completion.
  const pending = [...owned].filter((callId) => askable.has(callId) && !gone.includes(callId));
  const settled = owned.size > 0 && pending.length === 0;
  return { closed, settled };
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
  readonly probe: (callIds: readonly string[], ownedCallIds: readonly string[]) => Promise<{ readonly closed: number; readonly settled: boolean }>;
}): Promise<void> {
  const own = [...options.remembered]
    .filter(([, workspaceId]) => workspaceId === options.workspaceId)
    .map(([callId]) => callId);
  const { settled } = await options.probe([...new Set([options.callId, ...own])], own);
  if (!settled) return;
  for (const callId of own) options.remembered.delete(callId);
}
