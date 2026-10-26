import { describe, expect, it } from 'vitest';
import { SqliteDatabase } from './database.js';
import {
  MergeVerificationAttemptStoreError,
  SqliteMergeVerificationAttemptRepository,
  type BeginMergeVerificationAttemptRequest,
} from './merge-verification-attempt-repository.js';

const REPOSITORY = 'soulzerox/Unified-MPC-Server';
const HEAD = '1111111111111111111111111111111111111111';
const NOW = '2026-10-27T10:00:00.000Z';
const LATER = '2026-10-27T10:05:00.000Z';

function attempt(
  overrides: Partial<BeginMergeVerificationAttemptRequest> = {},
): BeginMergeVerificationAttemptRequest {
  return {
    attemptId: 'attempt-1',
    repository: REPOSITORY,
    pullRequest: 305,
    headSha: HEAD,
    workspaceId: 'workspace-1',
    startedAt: NOW,
    ...overrides,
  };
}

describe('SqliteMergeVerificationAttemptRepository', () => {
  it('records a running attempt, then a terminal verdict bound to the receipt', async () => {
    const database = new SqliteDatabase(':memory:');
    try {
      const repository = new SqliteMergeVerificationAttemptRepository(database);
      const started = await repository.begin(attempt({ baseBranch: 'main' }));

      expect(started).toEqual({
        attemptId: 'attempt-1',
        repository: REPOSITORY,
        pullRequest: 305,
        headSha: HEAD,
        baseBranch: 'main',
        workspaceId: 'workspace-1',
        status: 'running',
        startedAt: NOW,
        heartbeatAt: NOW,
      });

      expect(await repository.heartbeat('attempt-1', {
        heartbeatAt: '2026-10-27T10:01:00.000Z',
        gateName: 'pnpm test',
      })).toBe(true);

      const finished = await repository.finish('attempt-1', {
        status: 'completed',
        finishedAt: LATER,
        receiptRef: 'merge-verification:305@head:receipt',
      });

      expect(finished).toMatchObject({
        status: 'completed',
        gateName: 'pnpm test',
        finishedAt: LATER,
        receiptRef: 'merge-verification:305@head:receipt',
      });
      expect(await repository.list({ repository: REPOSITORY, pullRequest: 305 })).toEqual([finished]);
    } finally {
      database.close();
    }
  });

  it('rejects a duplicate attempt id and a second live attempt for the same exact head', async () => {
    const database = new SqliteDatabase(':memory:');
    try {
      const repository = new SqliteMergeVerificationAttemptRepository(database);
      await repository.begin(attempt());

      await expect(repository.begin(attempt())).rejects.toBeInstanceOf(MergeVerificationAttemptStoreError);
      await expect(repository.begin(attempt({ attemptId: 'attempt-2' }))).rejects.toMatchObject({
        reason: 'attempt_conflict',
      });

      await repository.finish('attempt-1', { status: 'failed', finishedAt: LATER, detail: 'gate failed' });
      await expect(repository.begin(attempt({ attemptId: 'attempt-2' }))).resolves.toMatchObject({
        attemptId: 'attempt-2',
        status: 'running',
      });
    } finally {
      database.close();
    }
  });

  it('reaps only stale running attempts and reports them as interrupted', async () => {
    const database = new SqliteDatabase(':memory:');
    try {
      const repository = new SqliteMergeVerificationAttemptRepository(database);
      await repository.begin(attempt({ attemptId: 'stale', startedAt: '2026-10-27T09:00:00.000Z' }));
      await repository.begin(attempt({
        attemptId: 'fresh',
        headSha: '2222222222222222222222222222222222222222',
        startedAt: '2026-10-27T09:59:30.000Z',
      }));

      const reaped = await repository.reapStale({ now: NOW, staleAfterMs: 90_000 });

      expect(reaped).toEqual(['stale']);
      expect(await repository.getById('stale')).toMatchObject({
        status: 'interrupted',
        finishedAt: NOW,
      });
      expect((await repository.getById('stale'))?.detail).toContain('heartbeat expired');
      expect(await repository.getById('fresh')).toMatchObject({ status: 'running' });
    } finally {
      database.close();
    }
  });

  it('never reports a stale attempt as live and never finishes an already-terminal attempt twice', async () => {
    const database = new SqliteDatabase(':memory:');
    try {
      const repository = new SqliteMergeVerificationAttemptRepository(database);
      await repository.begin(attempt({ startedAt: '2026-10-27T09:00:00.000Z' }));

      expect(await repository.findLive({
        repository: REPOSITORY,
        pullRequest: 305,
        headSha: HEAD,
        now: NOW,
        staleAfterMs: 90_000,
      })).toBeUndefined();

      await repository.markInterrupted('attempt-1', { finishedAt: NOW, detail: 'host restarted' });
      await expect(repository.finish('attempt-1', { status: 'completed', finishedAt: LATER })).rejects.toMatchObject({
        reason: 'attempt_conflict',
      });
    } finally {
      database.close();
    }
  });

  it('rejects malformed attempt identity instead of persisting it', async () => {
    const database = new SqliteDatabase(':memory:');
    try {
      const repository = new SqliteMergeVerificationAttemptRepository(database);
      await expect(repository.begin(attempt({ headSha: 'not-a-sha' }))).rejects.toMatchObject({
        reason: 'invalid_attempt',
      });
    } finally {
      database.close();
    }
  });
});
