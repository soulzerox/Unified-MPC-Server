import { describe, expect, it } from 'vitest';
import { compactionGate, type PhysicalSpaceEvidence } from './compaction-gate.js';
import type { GcLeaseState } from './gc-lease.js';

const NOW = new Date('2026-10-18T10:00:00.000Z');

function owner(overrides: Partial<GcLeaseState> = {}): GcLeaseState {
  return {
    ownerId: 'maintenance-worker',
    generation: 3,
    token: 'tok',
    acquiredAt: '2026-10-18T09:59:00.000Z',
    expiresAt: '2026-10-18T10:05:00.000Z',
    ...overrides,
  };
}

function pressure(overrides: Partial<PhysicalSpaceEvidence> = {}): PhysicalSpaceEvidence {
  return {
    databaseBytes: 100 * 1024 * 1024,
    freelistBytes: 80 * 1024 * 1024,
    freelistRatio: 0.4,
    compactionRecommended: true,
    checkpointBusy: false,
    ...overrides,
  };
}

describe('compaction gate (#210 §3 threshold-driven physical compaction)', () => {
  it('enqueues only when pressure is justified, the store is quiescent, and headroom exists', () => {
    const verdict = compactionGate({
      physical: pressure(),
      diskFreeBytes: 1024 * 1024 * 1024,
      activeReaderCount: 0,
      owner: owner(),
      now: NOW,
    });
    expect(verdict).toEqual({ status: 'enqueue', reason: 'pressure-justified' });
  });

  it('never compacts on its own: no recommendation means skip even with plenty of freed space', () => {
    const verdict = compactionGate({
      physical: pressure({ compactionRecommended: false, freelistBytes: 8 * 1024 * 1024, freelistRatio: 0.02 }),
      diskFreeBytes: 1024 * 1024 * 1024,
      activeReaderCount: 0,
      owner: owner(),
      now: NOW,
    });
    expect(verdict).toEqual({ status: 'skip', reason: 'below-threshold' });
  });

  it('skips while a checkpoint is busy or readers hold the database instead of forcing a checkpoint', () => {
    const busy = compactionGate({
      physical: pressure({ checkpointBusy: true }),
      diskFreeBytes: 1024 * 1024 * 1024,
      activeReaderCount: 0,
      owner: owner(),
      now: NOW,
    });
    expect(busy).toEqual({ status: 'skip', reason: 'reader-pressure' });

    const readers = compactionGate({
      physical: pressure(),
      diskFreeBytes: 1024 * 1024 * 1024,
      activeReaderCount: 2,
      owner: owner(),
      now: NOW,
    });
    expect(readers).toEqual({ status: 'skip', reason: 'reader-pressure' });
  });

  it('refuses without an existing owner fence so no second scheduler or lease is introduced', () => {
    const none = compactionGate({
      physical: pressure(),
      diskFreeBytes: 1024 * 1024 * 1024,
      activeReaderCount: 0,
      owner: null,
      now: NOW,
    });
    expect(none).toEqual({ status: 'refuse', reason: 'no-owner-fence' });

    const released = compactionGate({
      physical: pressure(),
      diskFreeBytes: 1024 * 1024 * 1024,
      activeReaderCount: 0,
      owner: owner({ releasedAt: '2026-10-18T09:59:30.000Z' }),
      now: NOW,
    });
    expect(released).toEqual({ status: 'refuse', reason: 'no-owner-fence' });

    const expired = compactionGate({
      physical: pressure(),
      diskFreeBytes: 1024 * 1024 * 1024,
      activeReaderCount: 0,
      owner: owner({ expiresAt: '2026-10-18T09:59:59.000Z' }),
      now: NOW,
    });
    expect(expired).toEqual({ status: 'refuse', reason: 'owner-fence-expired' });
  });

  it('refuses when disk headroom cannot be measured or cannot absorb the temporary copy', () => {
    const unknown = compactionGate({
      physical: pressure(),
      diskFreeBytes: null,
      activeReaderCount: 0,
      owner: owner(),
      now: NOW,
    });
    expect(unknown).toEqual({ status: 'refuse', reason: 'headroom-unknown' });

    const insufficient = compactionGate({
      physical: pressure(),
      diskFreeBytes: 150 * 1024 * 1024,
      activeReaderCount: 0,
      owner: owner(),
      now: NOW,
    });
    expect(insufficient).toEqual({ status: 'refuse', reason: 'headroom-insufficient' });
  });

  it('refuses when the database size is unmeasured so the temporary copy cannot be sized', () => {
    const verdict = compactionGate({
      physical: pressure({ databaseBytes: -1 }),
      diskFreeBytes: 1024 * 1024 * 1024,
      activeReaderCount: 0,
      owner: owner(),
      now: NOW,
    });
    expect(verdict).toEqual({ status: 'refuse', reason: 'headroom-unknown' });
  });

  it('treats the headroom requirement as database size times the multiplier plus the safety margin', () => {
    const databaseBytes = 100 * 1024 * 1024;
    const required = databaseBytes * 2 + 64 * 1024 * 1024;
    const base = {
      physical: pressure({ databaseBytes }),
      activeReaderCount: 0,
      owner: owner(),
      now: NOW,
    } as const;

    expect(compactionGate({ ...base, diskFreeBytes: required }).status).toBe('enqueue');
    expect(compactionGate({ ...base, diskFreeBytes: required - 1 })).toEqual({
      status: 'refuse',
      reason: 'headroom-insufficient',
    });

    const relaxed = compactionGate({
      ...base,
      diskFreeBytes: databaseBytes + 1,
      headroomMultiplier: 1,
      headroomMarginBytes: 0,
    });
    expect(relaxed.status).toBe('enqueue');
  });

  it('is a pure decision: the caller-owned owner fence is not mutated', () => {
    const fence = owner();
    const snapshot = structuredClone(fence);
    compactionGate({
      physical: pressure(),
      diskFreeBytes: 1024 * 1024 * 1024,
      activeReaderCount: 0,
      owner: fence,
      now: NOW,
    });
    expect(fence).toEqual(snapshot);
  });
});
