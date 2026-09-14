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

/**
 * Transport-scoped idempotency state for curated turn persistence.
 *
 * HTTP transports recreate ToolRegistry instances per request, so the ledger is
 * intentionally injected above the registry and shared for the transport
 * lifetime. Completed entries are bounded to avoid unbounded process memory.
 */
export class TurnPersistenceLedger {
  private readonly completed = new Map<string, true>();
  private readonly inFlight = new Set<string>();
  private readonly maxCompletedEntries: number;

  public constructor(maxCompletedEntries = 4096) {
    this.maxCompletedEntries = Number.isInteger(maxCompletedEntries) && maxCompletedEntries > 0
      ? maxCompletedEntries
      : 4096;
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
