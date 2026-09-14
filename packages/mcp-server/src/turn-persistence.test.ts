import { describe, expect, it } from 'vitest';
import { TurnPersistenceLedger } from './turn-persistence.js';

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
});
