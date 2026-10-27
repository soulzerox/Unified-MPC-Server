import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteDatabase } from './database.js';
import {
  HeavyJobQueueStoreError,
  SqliteHeavyJobQueueRepository,
} from './heavy-job-queue-repository.js';
import type { HeavyJobQueueEntry } from '@unified-mpc/workspace';

const roots: string[] = [];
const NOW = new Date('2026-10-27T10:00:00.000Z');

afterEach(async (): Promise<void> => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function entry(operationId: string, overrides: Partial<HeavyJobQueueEntry> = {}): HeavyJobQueueEntry {
  return {
    operationId,
    workspaceId: 'workspace-a',
    jobKind: 'pre_edit_delta',
    resourceClass: 'rag_indexing',
    cost: 8,
    blocking: true,
    requestedAt: NOW.toISOString(),
    ...overrides,
  };
}

function repository(
  database: SqliteDatabase,
  ownerId = 'owner-a',
  now: Date = NOW,
): SqliteHeavyJobQueueRepository {
  return new SqliteHeavyJobQueueRepository(database, {
    ownerId,
    now: (): Date => now,
    heartbeatIntervalMs: 0,
  });
}

describe('SqliteHeavyJobQueueRepository (#145 U5)', () => {
  it('claims durable queued work and reports the bounded depth', () => {
    const database = new SqliteDatabase(':memory:');
    try {
      const queue = repository(database);
      expect(queue.depth()).toBe(0);

      expect(queue.claim(entry('job-a'), 8)).toEqual({ status: 'queued', operationId: 'job-a', position: 1, depth: 1 });
      expect(queue.claim(entry('job-b'), 8)).toEqual({ status: 'queued', operationId: 'job-b', position: 2, depth: 2 });
      expect(queue.depth()).toBe(2);

      expect(queue.listLive()).toEqual([
        expect.objectContaining({ operationId: 'job-a', state: 'queued', position: 1, attempt: 1, ownerId: 'owner-a' }),
        expect.objectContaining({ operationId: 'job-b', state: 'queued', position: 2 }),
      ]);
    } finally {
      database.close();
    }
  });

  it('coalesces the same exact input without stealing a live foreign owner', () => {
    const database = new SqliteDatabase(':memory:');
    try {
      const first = repository(database, 'owner-a');
      const second = repository(database, 'owner-b');
      expect(first.claim(entry('job-a'), 8)).toMatchObject({ status: 'queued', position: 1 });

      expect(first.claim({ ...entry('job-a'), requestedAt: NOW.toISOString() }, 8))
        .toMatchObject({ status: 'queued', position: 1, depth: 1 });
      expect(second.claim(entry('job-a'), 8)).toEqual({ status: 'coalesced', operationId: 'job-a', depth: 1 });
      expect(second.depth()).toBe(1);
    } finally {
      database.close();
    }
  });

  it('rejects new work over the bound while coalescing existing work', () => {
    const database = new SqliteDatabase(':memory:');
    try {
      const queue = repository(database);
      expect(queue.claim(entry('job-a'), 1)).toMatchObject({ status: 'queued' });
      expect(queue.claim(entry('job-b'), 1)).toEqual({ status: 'full', operationId: 'job-b', depth: 1 });
      expect(queue.claim(entry('job-a'), 1)).toMatchObject({ status: 'queued' });
    } finally {
      database.close();
    }
  });

  it('re-claims a terminal exact input as a new attempt instead of growing the table', () => {
    const database = new SqliteDatabase(':memory:');
    try {
      const queue = repository(database);
      queue.claim(entry('job-a'), 8);
      expect(queue.start('job-a', '2026-10-27T10:01:00.000Z')).toBe(true);
      expect(queue.settle('job-a', 'completed', '2026-10-27T10:02:00.000Z')).toBe(true);
      expect(queue.depth()).toBe(0);

      expect(queue.claim(entry('job-a'), 8)).toMatchObject({ status: 'queued', position: 2, depth: 1 });
      const [reclaimed] = queue.listLive();
      expect(reclaimed).toMatchObject({ operationId: 'job-a', attempt: 2 });
      expect(reclaimed).not.toHaveProperty('startedAt');
    } finally {
      database.close();
    }
  });

  it('promotes a queued job ahead of the current head', () => {
    const database = new SqliteDatabase(':memory:');
    try {
      const queue = repository(database);
      queue.claim(entry('job-a'), 8);
      queue.claim(entry('job-b'), 8);
      queue.claim(entry('job-c'), 8);

      const promoted = queue.promote('job-c');
      expect(promoted).toBe(0);
      expect(queue.listLive().map((row) => row.operationId)).toEqual(['job-c', 'job-a', 'job-b']);
      expect(queue.promote('missing')).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it('cancels queued work only and never a running owner lease', () => {
    const database = new SqliteDatabase(':memory:');
    try {
      const queue = repository(database);
      queue.claim(entry('queued'), 8);
      queue.claim(entry('running'), 8);
      expect(queue.start('running', '2026-10-27T10:01:00.000Z')).toBe(true);

      expect(queue.cancel('running', '2026-10-27T10:02:00.000Z')).toBe(false);
      expect(queue.cancel('queued', '2026-10-27T10:02:00.000Z')).toBe(true);
      expect(queue.cancel('missing', '2026-10-27T10:02:00.000Z')).toBe(false);
      expect(queue.depth()).toBe(0);
      expect(queue.listLive().map((row) => [row.operationId, row.state])).toEqual([['running', 'running']]);
    } finally {
      database.close();
    }
  });

  it('supersedes a queued generation in place and enqueues a missing predecessor', () => {
    const database = new SqliteDatabase(':memory:');
    try {
      const queue = repository(database);
      queue.claim(entry('head-1'), 8);
      queue.claim(entry('other'), 8);

      expect(queue.supersede('head-1', entry('head-2'), 8))
        .toMatchObject({ status: 'superseded', operationId: 'head-2', position: 1, depth: 2 });
      expect(queue.listLive().map((row) => row.operationId)).toEqual(['head-2', 'other']);

      expect(queue.supersede('missing-1', entry('missing-2'), 8))
        .toMatchObject({ status: 'queued', operationId: 'missing-2', depth: 3 });
      expect(queue.supersede('other', entry('head-2'), 8))
        .toMatchObject({ status: 'coalesced', operationId: 'head-2' });
      expect(queue.listLive().map((row) => row.operationId)).toEqual(['head-2', 'missing-2']);
    } finally {
      database.close();
    }
  });

  it('starts only queued rows owned by this repository and settles only running ones', () => {
    const database = new SqliteDatabase(':memory:');
    try {
      const owner = repository(database, 'owner-a');
      const foreign = repository(database, 'owner-b');
      owner.claim(entry('job-a'), 8);

      expect(foreign.start('job-a', '2026-10-27T10:01:00.000Z')).toBe(false);
      expect(owner.settle('job-a', 'completed', '2026-10-27T10:02:00.000Z')).toBe(false);
      expect(owner.start('job-a', '2026-10-27T10:01:00.000Z')).toBe(true);
      expect(owner.start('job-a', '2026-10-27T10:01:01.000Z')).toBe(false);
      expect(foreign.settle('job-a', 'failed', '2026-10-27T10:02:00.000Z')).toBe(false);
      expect(owner.settle('job-a', 'completed', '2026-10-27T10:02:00.000Z')).toBe(true);
      expect(owner.settle('job-a', 'completed', '2026-10-27T10:02:00.000Z')).toBe(false);
      expect(owner.depth()).toBe(0);
      expect(owner.listLive()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('recovers orphaned, interrupted and expired rows without reviving running work', () => {
    const database = new SqliteDatabase(':memory:');
    try {
      const queue = repository(database);
      queue.claim(entry('queued'), 8);
      queue.claim(entry('running'), 8);
      queue.start('running', '2026-10-27T10:01:00.000Z');

      expect(queue.recover('queued', 'orphan', { at: '2026-10-27T10:05:00.000Z' })).toBe(true);
      expect(queue.recover('running', 'interrupt', {
        at: '2026-10-27T10:05:00.000Z',
        detail: 'owner heartbeat expired',
      })).toBe(true);
      expect(queue.recover('queued', 'expire', {
        at: '2026-10-27T10:05:00.000Z',
        detail: 'queued work expired before start',
      })).toBe(true);

      expect(queue.listLive()).toEqual([]);
      expect(queue.depth()).toBe(0);
    } finally {
      database.close();
    }
  });

  it('keeps queue state and ordering across a database reopen', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-heavy-job-queue-'));
    roots.push(root);
    const filename = path.join(root, 'state.sqlite');

    const first = new SqliteDatabase(filename);
    try {
      const queue = repository(first);
      queue.claim(entry('oldest'), 8);
      queue.claim(entry('promoted'), 8);
      queue.claim(entry('newest'), 8);
      expect(queue.promote('promoted')).toBe(0);
    } finally {
      first.close();
    }

    const reopened = new SqliteDatabase(filename);
    try {
      const queue = repository(reopened, 'owner-b');
      expect(queue.depth()).toBe(3);
      expect(queue.listLive().map((row) => [row.operationId, row.ownerId])).toEqual([
        ['promoted', 'owner-a'],
        ['oldest', 'owner-a'],
        ['newest', 'owner-a'],
      ]);
      expect(queue.claim(entry('promoted'), 8))
        .toEqual({ status: 'coalesced', operationId: 'promoted', depth: 3 });
    } finally {
      reopened.close();
    }
  });

  it('heartbeats only the live rows owned by this repository', () => {
    const database = new SqliteDatabase(':memory:');
    try {
      const owner = repository(database, 'owner-a');
      const foreign = repository(database, 'owner-b');
      owner.claim(entry('job-a'), 8);
      foreign.claim(entry('job-b'), 8);

      expect(owner.heartbeat('2026-10-27T10:10:00.000Z')).toBe(1);
      const rows = owner.listLive();
      expect(rows.find((row) => row.operationId === 'job-a')?.heartbeatAt).toBe('2026-10-27T10:10:00.000Z');
      expect(rows.find((row) => row.operationId === 'job-b')?.heartbeatAt).toBe(NOW.toISOString());
    } finally {
      database.close();
    }
  });

  it('rejects invalid identities, classes, costs and bounds', () => {
    const database = new SqliteDatabase(':memory:');
    try {
      const queue = repository(database);
      expect(() => queue.claim(entry(''), 8)).toThrow(HeavyJobQueueStoreError);
      expect(() => queue.claim(entry('job', { resourceClass: 'unknown' as never }), 8)).toThrow(HeavyJobQueueStoreError);
      expect(() => queue.claim(entry('job', { cost: 0 }), 8)).toThrow(HeavyJobQueueStoreError);
      expect(() => queue.claim(entry('job'), 0)).toThrow(HeavyJobQueueStoreError);
      expect(() => queue.start('job', 'not-a-date')).toThrow(HeavyJobQueueStoreError);
      expect(() => queue.cancel('job', 'not-a-date')).toThrow(HeavyJobQueueStoreError);
    } finally {
      database.close();
    }
  });
});
