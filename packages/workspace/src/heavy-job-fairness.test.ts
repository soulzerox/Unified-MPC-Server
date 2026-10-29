import { describe, expect, it } from 'vitest';
import { orderHeavyJobs, type HeavyJobFairnessCandidate } from './heavy-job-fairness.js';

const NOW = Date.parse('2026-10-30T12:00:00.000Z');

function job(
  operationId: string,
  workspaceId: string,
  requestedAt: string,
  overrides: Partial<HeavyJobFairnessCandidate> = {},
): HeavyJobFairnessCandidate {
  return {
    operationId,
    workspaceId,
    requestedAt,
    blocking: false,
    position: 1,
    ...overrides,
  };
}

function minutesAgo(minutes: number): string {
  return new Date(NOW - minutes * 60_000).toISOString();
}

function order(
  candidates: readonly HeavyJobFairnessCandidate[],
  lastServedAt: ReadonlyMap<string, number> = new Map(),
  agingMs = 30 * 60_000,
): readonly string[] {
  return orderHeavyJobs(candidates, { now: NOW, agingMs, lastServedAt });
}

describe('heavy job fairness policy (#145)', () => {
  it('keeps FIFO for a single workspace', () => {
    const candidates = [
      job('third', 'a', minutesAgo(3), { position: 3 }),
      job('first', 'a', minutesAgo(9), { position: 1 }),
      job('second', 'a', minutesAgo(6), { position: 2 }),
    ];

    expect(order(candidates)).toEqual(['first', 'second', 'third']);
  });

  it('alternates workspaces instead of draining one burst first', () => {
    const candidates = [
      job('a1', 'a', minutesAgo(9), { position: 1 }),
      job('a2', 'a', minutesAgo(8), { position: 2 }),
      job('b1', 'b', minutesAgo(7), { position: 3 }),
      job('b2', 'b', minutesAgo(6), { position: 4 }),
    ];

    expect(order(candidates)).toEqual(['a1', 'b1', 'a2', 'b2']);
  });

  it('prefers a never-served workspace over a just-served one', () => {
    const candidates = [
      job('a1', 'a', minutesAgo(9), { position: 1 }),
      job('b1', 'b', minutesAgo(8), { position: 2 }),
    ];

    expect(order(candidates, new Map([['a', NOW - 1_000]]))).toEqual(['b1', 'a1']);
  });

  it('prefers the workspace served longest ago', () => {
    const candidates = [
      job('a1', 'a', minutesAgo(9), { position: 1 }),
      job('b1', 'b', minutesAgo(8), { position: 2 }),
    ];
    const lastServedAt = new Map([
      ['a', NOW - 1_000],
      ['b', NOW - 5_000],
    ]);

    expect(order(candidates, lastServedAt)).toEqual(['b1', 'a1']);
  });

  it('attempts an aged job before non-aged work', () => {
    const candidates = [
      job('a-old', 'a', minutesAgo(40), { position: 1 }),
      job('b-new', 'b', minutesAgo(1), { position: 2 }),
    ];
    const lastServedAt = new Map([['a', NOW]]);

    expect(order(candidates, lastServedAt)).toEqual(['a-old', 'b-new']);
  });

  it('keeps blocking work ahead of aged work', () => {
    const candidates = [
      job('a-old', 'a', minutesAgo(40), { position: 1 }),
      job('b-blocking', 'b', minutesAgo(0), { position: 2, blocking: true }),
    ];
    const lastServedAt = new Map([['a', NOW]]);

    expect(order(candidates, lastServedAt)).toEqual(['b-blocking', 'a-old']);
  });

  it('rotates blocking work across workspaces before anything else', () => {
    const candidates = [
      job('a1', 'a', minutesAgo(9), { position: 1, blocking: true }),
      job('a2', 'a', minutesAgo(8), { position: 2, blocking: true }),
      job('b1', 'b', minutesAgo(7), { position: 3, blocking: true }),
      job('b2', 'b', minutesAgo(6), { position: 4, blocking: true }),
      job('aged-c', 'c', minutesAgo(40), { position: 5 }),
    ];

    expect(order(candidates)).toEqual(['a1', 'b1', 'a2', 'b2', 'aged-c']);
  });

  it('keeps blocking work FIFO within one workspace', () => {
    const candidates = [
      job('later', 'a', minutesAgo(1), { position: 2, blocking: true }),
      job('earlier', 'a', minutesAgo(3), { position: 1, blocking: true }),
    ];

    expect(order(candidates)).toEqual(['earlier', 'later']);
  });

  it('is deterministic for identical timestamps', () => {
    const candidates = [
      job('b1', 'b', minutesAgo(5), { position: 2 }),
      job('a1', 'a', minutesAgo(5), { position: 1 }),
      job('a2', 'a', minutesAgo(5), { position: 3 }),
    ];

    expect(order(candidates)).toEqual(['a1', 'b1', 'a2']);
    expect(order([...candidates].reverse())).toEqual(['a1', 'b1', 'a2']);
  });

  it('treats an unparseable request time as recent instead of aged', () => {
    const candidates = [
      job('broken', 'a', 'not-a-date', { position: 1 }),
      job('valid', 'b', minutesAgo(1), { position: 2 }),
    ];

    expect(order(candidates)).toEqual(['valid', 'broken']);
  });

  it('returns an empty order for no candidates', () => {
    expect(order([])).toEqual([]);
  });

  it('rejects a non-positive aging window', () => {
    expect(() => orderHeavyJobs([], { now: NOW, agingMs: 0, lastServedAt: new Map() }))
      .toThrow(RangeError);
  });
});
