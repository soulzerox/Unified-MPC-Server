import { describe, expect, it } from 'vitest';
import { TurnPersistenceLedger, type TurnPersistenceActiveState, type TurnPersistenceRole, type TurnPersistenceStore } from './turn-persistence.js';

class MemoryTurnPersistenceStore implements TurnPersistenceStore {
  private readonly completed = new Set<string>();
  private readonly active = new Map<string, TurnPersistenceActiveState>();

  public isCompleted(scope: string, turnId: string, role: TurnPersistenceRole): boolean {
    return this.completed.has(JSON.stringify([scope, turnId, role]));
  }

  public markCompleted(scope: string, turnId: string, role: TurnPersistenceRole): void {
    this.completed.add(JSON.stringify([scope, turnId, role]));
  }

  public pruneCompleted(): void {}

  public getActive(scope: string): TurnPersistenceActiveState | undefined {
    return this.active.get(scope);
  }

  public setActive(scope: string, state: TurnPersistenceActiveState): void {
    this.active.set(scope, state);
  }

  public clearActive(scope: string, turnId: string): void {
    if (this.active.get(scope)?.turnId === turnId) this.active.delete(scope);
  }
}

describe('TurnPersistenceLedger task compliance', () => {
  it('blocks a new required turn until the previous turn is persisted', () => {
    const ledger = new TurnPersistenceLedger();

    expect(ledger.beginTurn('session-a', 'turn-1', 'required')).toMatchObject({ accepted: true, state: 'awaiting_record', turnId: 'turn-1', mode: 'required' });
    expect(ledger.beginTurn('session-a', 'turn-2', 'required')).toMatchObject({ accepted: false, state: 'violation', turnId: 'turn-1', attemptedTurnId: 'turn-2', mode: 'required' });

    ledger.completeTurn('session-a', 'turn-1');
    expect(ledger.beginTurn('session-a', 'turn-2', 'required')).toMatchObject({ accepted: true, state: 'awaiting_record', turnId: 'turn-2', mode: 'required' });
  });

  it('records a best-effort violation without blocking the next turn', () => {
    const ledger = new TurnPersistenceLedger();

    ledger.beginTurn('web-session', 'turn-1', 'best_effort');
    expect(ledger.beginTurn('web-session', 'turn-2', 'best_effort')).toMatchObject({ accepted: true, state: 'awaiting_record', turnId: 'turn-2', mode: 'best_effort', violations: 1, replacedUnpersistedTurnId: 'turn-1' });
    expect(ledger.status('web-session')).toMatchObject({ state: 'awaiting_record', turnId: 'turn-2', mode: 'best_effort', violations: 1 });
  });

  it('treats repeated begin for the same turn id as idempotent', () => {
    const ledger = new TurnPersistenceLedger();

    ledger.beginTurn('session-a', 'turn-1', 'required');
    expect(ledger.beginTurn('session-a', 'turn-1', 'required')).toMatchObject({ accepted: true, state: 'awaiting_record', turnId: 'turn-1', duplicate: true, violations: 0 });
  });

  it('keeps completed role idempotency across ledger recreation when backed by a durable store', () => {
    const store = new MemoryTurnPersistenceStore();
    const first = new TurnPersistenceLedger({ store });

    expect(first.claim('client-a/workspace-a', 'turn-1', 'user')).toBe('claimed');
    first.complete('client-a/workspace-a', 'turn-1', 'user');

    const recreated = new TurnPersistenceLedger({ store });
    expect(recreated.claim('client-a/workspace-a', 'turn-1', 'user')).toBe('completed');
  });

  it('keeps active required-turn compliance across ledger recreation when backed by a durable store', () => {
    const store = new MemoryTurnPersistenceStore();
    new TurnPersistenceLedger({ store }).beginTurn('session-a', 'turn-1', 'required');

    const recreated = new TurnPersistenceLedger({ store });
    expect(recreated.beginTurn('session-a', 'turn-2', 'required')).toMatchObject({
      accepted: false,
      state: 'violation',
      turnId: 'turn-1',
      attemptedTurnId: 'turn-2',
      violations: 1,
    });
  });

  it('does not persist in-flight claims so a crashed writer can be retried after recreation', () => {
    const store = new MemoryTurnPersistenceStore();
    const first = new TurnPersistenceLedger({ store });
    expect(first.claim('client-a/workspace-a', 'turn-1', 'assistant')).toBe('claimed');

    const recreated = new TurnPersistenceLedger({ store });
    expect(recreated.claim('client-a/workspace-a', 'turn-1', 'assistant')).toBe('claimed');
  });
});
