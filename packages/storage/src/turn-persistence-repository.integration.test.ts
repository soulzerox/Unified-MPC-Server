import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteDatabase } from './database.js';
import { SqliteTurnPersistenceRepository } from './turn-persistence-repository.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createFilename(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-turn-persistence-'));
  temporaryRoots.push(root);
  return path.join(root, 'state.sqlite');
}

describe('SqliteTurnPersistenceRepository', () => {
  it('persists completed-role idempotency and active compliance across database recreation', async () => {
    const filename = await createFilename();
    const firstDatabase = new SqliteDatabase(filename);
    const first = new SqliteTurnPersistenceRepository(firstDatabase, () => '2026-09-15T00:00:00.000Z');
    first.markCompleted('client-a/workspace-a', 'turn-1', 'user');
    first.setActive('session-a', { turnId: 'turn-2', mode: 'required', violations: 3 });
    firstDatabase.close();

    const secondDatabase = new SqliteDatabase(filename);
    try {
      const recreated = new SqliteTurnPersistenceRepository(secondDatabase);
      expect(recreated.isCompleted('client-a/workspace-a', 'turn-1', 'user')).toBe(true);
      expect(recreated.isCompleted('client-a/workspace-a', 'turn-1', 'assistant')).toBe(false);
      expect(recreated.getActive('session-a')).toEqual({ turnId: 'turn-2', mode: 'required', violations: 3 });
    } finally {
      secondDatabase.close();
    }
  });

  it('clears active state only for the matching turn id', async () => {
    const filename = await createFilename();
    const database = new SqliteDatabase(filename);
    try {
      const repository = new SqliteTurnPersistenceRepository(database);
      repository.setActive('session-a', { turnId: 'turn-1', mode: 'best_effort', violations: 1 });
      repository.clearActive('session-a', 'turn-other');
      expect(repository.getActive('session-a')).toEqual({ turnId: 'turn-1', mode: 'best_effort', violations: 1 });
      repository.clearActive('session-a', 'turn-1');
      expect(repository.getActive('session-a')).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it('prunes completed and active state to the configured bounded size', async () => {
    const filename = await createFilename();
    const database = new SqliteDatabase(filename);
    let tick = 0;
    const repository = new SqliteTurnPersistenceRepository(database, () => `2026-09-15T00:00:0${tick++}.000Z`);
    try {
      repository.markCompleted('scope-a', 'turn-1', 'user');
      repository.markCompleted('scope-a', 'turn-2', 'user');
      repository.markCompleted('scope-a', 'turn-3', 'user');
      repository.pruneCompleted(2);
      expect(repository.isCompleted('scope-a', 'turn-1', 'user')).toBe(false);
      expect(repository.isCompleted('scope-a', 'turn-2', 'user')).toBe(true);
      expect(repository.isCompleted('scope-a', 'turn-3', 'user')).toBe(true);

      repository.setActive('session-1', { turnId: 'turn-1', mode: 'required', violations: 0 });
      repository.setActive('session-2', { turnId: 'turn-2', mode: 'required', violations: 0 });
      repository.setActive('session-3', { turnId: 'turn-3', mode: 'required', violations: 0 });
      repository.pruneActive(2);
      expect(repository.getActive('session-1')).toBeUndefined();
      expect(repository.getActive('session-2')).toBeDefined();
      expect(repository.getActive('session-3')).toBeDefined();
    } finally {
      database.close();
    }
  });
});
