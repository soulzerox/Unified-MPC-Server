import { describe, expect, it } from 'vitest';
import { SqliteDatabase, SqliteHeavyJobQueueRepository } from '@unified-mpc/storage';
import type { HeavyJobQueueEntry } from '@unified-mpc/workspace';
import { HeavyJobQueueRecoveryService } from './heavy-job-queue-recovery-service.js';

const T0 = new Date('2026-10-27T10:00:00.000Z');

function entry(operationId: string, requestedAt: Date = T0): HeavyJobQueueEntry {
  return {
    operationId,
    workspaceId: 'workspace-a',
    jobKind: 'pre_edit_delta',
    resourceClass: 'rag_indexing',
    cost: 8,
    blocking: true,
    requestedAt: requestedAt.toISOString(),
  };
}

function repository(database: SqliteDatabase, ownerId: string, now: Date): SqliteHeavyJobQueueRepository {
  return new SqliteHeavyJobQueueRepository(database, {
    ownerId,
    now: (): Date => now,
    heartbeatIntervalMs: 0,
  });
}

describe('HeavyJobQueueRecoveryService (#145 U5)', () => {
  it('interrupts dead-owner running work and orphans its queued work', () => {
    const database = new SqliteDatabase(':memory:');
    try {
      const dead = repository(database, 'owner-dead', T0);
      dead.claim(entry('run-dead'), 8);
      dead.start('run-dead', T0.toISOString());
      dead.claim(entry('queued-dead'), 8);

      const liveNow = new Date(T0.getTime() + 2 * 60_000);
      const live = repository(database, 'owner-live', liveNow);
      live.claim(entry('live-run', liveNow), 8);
      live.start('live-run', liveNow.toISOString());

      const recovery = new HeavyJobQueueRecoveryService(dead, {
        currentOwnerId: 'owner-live',
        now: (): Date => liveNow,
        heartbeatStaleAfterMs: 90_000,
        queuedRetentionMs: 60 * 60_000,
      });
      expect(recovery.reconcileOnce()).toEqual({
        inspected: 3,
        interrupted: 1,
        orphaned: 1,
        expired: 0,
        retained: 1,
      });

      expect(dead.get('run-dead')).toMatchObject({
        state: 'interrupted',
        detail: expect.stringContaining("owner-dead"),
      });
      expect(dead.get('queued-dead')).toMatchObject({ state: 'queued' });
      expect(dead.get('queued-dead')).not.toHaveProperty('ownerId');
      expect(live.get('live-run')).toMatchObject({ state: 'running', ownerId: 'owner-live' });

      // The orphaned row is adoptable by the next identical claim.
      expect(live.claim(entry('queued-dead'), 8)).toMatchObject({ status: 'queued', position: 2, depth: 1 });
    } finally {
      database.close();
    }
  });

  it('expires queued intent that outlived the retention window', () => {
    const database = new SqliteDatabase(':memory:');
    try {
      const owner = repository(database, 'owner-a', T0);
      owner.claim(entry('old'), 8);

      const later = new Date(T0.getTime() + 2 * 60 * 60_000);
      const recovery = new HeavyJobQueueRecoveryService(owner, {
        now: (): Date => later,
        heartbeatStaleAfterMs: 90_000,
        queuedRetentionMs: 60 * 60_000,
      });
      expect(recovery.reconcileOnce()).toMatchObject({ inspected: 1, expired: 1, retained: 0 });
      expect(owner.get('old')).toMatchObject({ state: 'cancelled' });
      expect(owner.depth()).toBe(0);
    } finally {
      database.close();
    }
  });

  it('keeps a fresh orphaned row adoptable instead of expiring it', () => {
    const database = new SqliteDatabase(':memory:');
    try {
      const owner = repository(database, 'owner-a', T0);
      owner.claim(entry('fresh'), 8);

      const orphanAt = new Date(T0.getTime() + 2 * 60_000);
      new HeavyJobQueueRecoveryService(owner, {
        now: (): Date => orphanAt,
        heartbeatStaleAfterMs: 90_000,
        queuedRetentionMs: 60 * 60_000,
      }).reconcileOnce();
      expect(owner.get('fresh')).not.toHaveProperty('ownerId');

      const later = new Date(T0.getTime() + 30 * 60_000);
      expect(new HeavyJobQueueRecoveryService(owner, {
        now: (): Date => later,
        heartbeatStaleAfterMs: 90_000,
        queuedRetentionMs: 60 * 60_000,
      }).reconcileOnce()).toMatchObject({ inspected: 1, expired: 0, retained: 1 });
      expect(owner.get('fresh')).toMatchObject({ state: 'queued' });
    } finally {
      database.close();
    }
  });

  it('never touches this process or a live foreign owner, even past retention', () => {
    const database = new SqliteDatabase(':memory:');
    try {
      const current = repository(database, 'owner-current', T0);
      current.claim(entry('mine'), 8);
      const live = repository(database, 'owner-live', T0);
      live.claim(entry('theirs'), 8);
      live.heartbeat(new Date(T0.getTime() + 2 * 60 * 60_000).toISOString());

      const later = new Date(T0.getTime() + 2 * 60 * 60_000 + 60_000);
      const recovery = new HeavyJobQueueRecoveryService(current, {
        currentOwnerId: 'owner-current',
        now: (): Date => later,
        heartbeatStaleAfterMs: 90_000,
        queuedRetentionMs: 60 * 60_000,
      });
      expect(recovery.reconcileOnce()).toMatchObject({ inspected: 2, retained: 2, expired: 0, orphaned: 0 });
      expect(current.get('mine')).toMatchObject({ state: 'queued', ownerId: 'owner-current' });
      expect(current.get('theirs')).toMatchObject({ state: 'queued', ownerId: 'owner-live' });
    } finally {
      database.close();
    }
  });
});
