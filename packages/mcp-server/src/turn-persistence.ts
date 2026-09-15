export type TurnPersistenceRole = 'user' | 'assistant';

export interface RecordTurnInput {
  readonly turnId: string;
  readonly userContent: string;
  readonly assistantContent?: string;
  readonly workspace?: string;
  readonly summary?: string;
  readonly tags?: string;
}

export type TurnPersistenceClaim = 'claimed' | 'completed' | 'in_flight';
export type TurnPersistenceMode = 'required' | 'best_effort';

export interface TurnPersistenceActiveState {
  readonly turnId: string;
  readonly mode: TurnPersistenceMode;
  readonly violations: number;
}

/**
 * Durable backing contract for turn persistence state.
 *
 * Completed roles and active compliance state are durable. In-flight claims are
 * intentionally not part of this interface: a crashed writer must be able to
 * retry the unfinished role after process recreation.
 */
export interface TurnPersistenceStore {
  isCompleted(scope: string, turnId: string, role: TurnPersistenceRole): boolean;
  markCompleted(scope: string, turnId: string, role: TurnPersistenceRole): void;
  pruneCompleted(maxEntries: number): void;
  getActive(scope: string): TurnPersistenceActiveState | undefined;
  setActive(scope: string, state: TurnPersistenceActiveState): void;
  clearActive(scope: string, turnId: string): void;
  pruneActive?(maxEntries: number): void;
}

export interface TurnPersistenceLedgerOptions {
  readonly maxCompletedEntries?: number;
  readonly store?: TurnPersistenceStore;
}

export type TurnPersistenceStatus =
  | { readonly state: 'idle'; readonly violations: number }
  | { readonly state: 'awaiting_record'; readonly turnId: string; readonly mode: TurnPersistenceMode; readonly violations: number };

export type TurnPersistenceBeginResult =
  | ({ readonly accepted: true; readonly state: 'awaiting_record'; readonly turnId: string; readonly mode: TurnPersistenceMode; readonly violations: number } & Partial<{ readonly duplicate: true; readonly replacedUnpersistedTurnId: string }>)
  | { readonly accepted: false; readonly state: 'violation'; readonly turnId: string; readonly attemptedTurnId: string; readonly mode: 'required'; readonly violations: number };

/**
 * Transport-scoped idempotency and compliance state for curated turn persistence.
 *
 * HTTP transports recreate ToolRegistry instances per request, so the ledger is
 * intentionally injected above the registry and shared for the transport
 * lifetime. A durable store can be injected by the host so completed-role
 * idempotency and active compliance state survive process recreation. In-flight
 * claims remain process-local by design so crashes never strand a turn forever.
 */
export class TurnPersistenceLedger {
  private readonly completed = new Map<string, true>();
  private readonly inFlight = new Set<string>();
  private readonly activeTurns = new Map<string, TurnPersistenceActiveState>();
  private readonly maxCompletedEntries: number;
  private readonly store: TurnPersistenceStore | undefined;

  public constructor(options: number | TurnPersistenceLedgerOptions = 4096) {
    const maxCompletedEntries = typeof options === 'number' ? options : options.maxCompletedEntries ?? 4096;
    this.maxCompletedEntries = Number.isInteger(maxCompletedEntries) && maxCompletedEntries > 0
      ? maxCompletedEntries
      : 4096;
    this.store = typeof options === 'number' ? undefined : options.store;
  }

  public beginTurn(scope: string, turnId: string, mode: TurnPersistenceMode): TurnPersistenceBeginResult {
    const active = this.getActive(scope);
    if (active?.turnId === turnId) {
      return { accepted: true, state: 'awaiting_record', turnId, mode: active.mode, violations: active.violations, duplicate: true };
    }
    if (active !== undefined && mode === 'required') {
      const violations = active.violations + 1;
      this.setActive(scope, { ...active, violations });
      return { accepted: false, state: 'violation', turnId: active.turnId, attemptedTurnId: turnId, mode, violations };
    }
    const violations = (active?.violations ?? 0) + (active === undefined ? 0 : 1);
    const next = { turnId, mode, violations } satisfies TurnPersistenceActiveState;
    this.setActive(scope, next);
    return {
      accepted: true,
      state: 'awaiting_record',
      turnId,
      mode,
      violations,
      ...(active === undefined ? {} : { replacedUnpersistedTurnId: active.turnId }),
    };
  }

  public completeTurn(scope: string, turnId: string): void {
    const active = this.getActive(scope);
    if (active?.turnId !== turnId) return;
    if (this.store !== undefined) {
      this.store.clearActive(scope, turnId);
      return;
    }
    this.activeTurns.delete(scope);
  }

  public status(scope: string): TurnPersistenceStatus {
    const active = this.getActive(scope);
    return active === undefined
      ? { state: 'idle', violations: 0 }
      : { state: 'awaiting_record', turnId: active.turnId, mode: active.mode, violations: active.violations };
  }

  public claim(scope: string, turnId: string, role: TurnPersistenceRole): TurnPersistenceClaim {
    const key = turnKey(scope, turnId, role);
    if (this.store?.isCompleted(scope, turnId, role) === true || this.completed.has(key)) return 'completed';
    if (this.inFlight.has(key)) return 'in_flight';
    this.inFlight.add(key);
    return 'claimed';
  }

  public complete(scope: string, turnId: string, role: TurnPersistenceRole): void {
    const key = turnKey(scope, turnId, role);
    this.inFlight.delete(key);
    if (this.store !== undefined) {
      this.store.markCompleted(scope, turnId, role);
      this.store.pruneCompleted(this.maxCompletedEntries);
      return;
    }
    this.completed.delete(key);
    this.completed.set(key, true);
    while (this.completed.size > this.maxCompletedEntries) {
      const oldest = this.completed.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.completed.delete(oldest);
    }
  }

  public release(scope: string, turnId: string, role: TurnPersistenceRole): void {
    this.inFlight.delete(turnKey(scope, turnId, role));
  }

  private getActive(scope: string): TurnPersistenceActiveState | undefined {
    return this.store?.getActive(scope) ?? this.activeTurns.get(scope);
  }

  private setActive(scope: string, state: TurnPersistenceActiveState): void {
    if (this.store !== undefined) {
      this.store.setActive(scope, state);
      this.store.pruneActive?.(this.maxCompletedEntries);
      return;
    }
    this.activeTurns.delete(scope);
    this.activeTurns.set(scope, state);
    while (this.activeTurns.size > this.maxCompletedEntries) {
      const oldest = this.activeTurns.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.activeTurns.delete(oldest);
    }
  }
}

function turnKey(scope: string, turnId: string, role: TurnPersistenceRole): string {
  return JSON.stringify([scope, turnId, role]);
}
