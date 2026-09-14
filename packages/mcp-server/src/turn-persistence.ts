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
 * lifetime. Completed entries and tracked scopes are bounded to avoid unbounded
 * process memory.
 */
export class TurnPersistenceLedger {
  private readonly completed = new Map<string, true>();
  private readonly inFlight = new Set<string>();
  private readonly activeTurns = new Map<string, { turnId: string; mode: TurnPersistenceMode; violations: number }>();
  private readonly maxCompletedEntries: number;

  public constructor(maxCompletedEntries = 4096) {
    this.maxCompletedEntries = Number.isInteger(maxCompletedEntries) && maxCompletedEntries > 0
      ? maxCompletedEntries
      : 4096;
  }

  public beginTurn(scope: string, turnId: string, mode: TurnPersistenceMode): TurnPersistenceBeginResult {
    const active = this.activeTurns.get(scope);
    if (active?.turnId === turnId) {
      return { accepted: true, state: 'awaiting_record', turnId, mode: active.mode, violations: active.violations, duplicate: true };
    }
    if (active !== undefined && mode === 'required') {
      const violations = active.violations + 1;
      this.activeTurns.set(scope, { ...active, violations });
      return { accepted: false, state: 'violation', turnId: active.turnId, attemptedTurnId: turnId, mode, violations };
    }
    const violations = (active?.violations ?? 0) + (active === undefined ? 0 : 1);
    this.activeTurns.delete(scope);
    this.activeTurns.set(scope, { turnId, mode, violations });
    while (this.activeTurns.size > this.maxCompletedEntries) {
      const oldest = this.activeTurns.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.activeTurns.delete(oldest);
    }
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
    if (this.activeTurns.get(scope)?.turnId === turnId) this.activeTurns.delete(scope);
  }

  public status(scope: string): TurnPersistenceStatus {
    const active = this.activeTurns.get(scope);
    return active === undefined
      ? { state: 'idle', violations: 0 }
      : { state: 'awaiting_record', turnId: active.turnId, mode: active.mode, violations: active.violations };
  }

  public claim(scope: string, turnId: string, role: TurnPersistenceRole): TurnPersistenceClaim {
    const key = turnKey(scope, turnId, role);
    if (this.completed.has(key)) return 'completed';
    if (this.inFlight.has(key)) return 'in_flight';
    this.inFlight.add(key);
    return 'claimed';
  }

  public complete(scope: string, turnId: string, role: TurnPersistenceRole): void {
    const key = turnKey(scope, turnId, role);
    this.inFlight.delete(key);
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
}

function turnKey(scope: string, turnId: string, role: TurnPersistenceRole): string {
  return JSON.stringify([scope, turnId, role]);
}
