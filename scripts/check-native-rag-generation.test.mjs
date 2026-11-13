import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { readGenerationHealth, selectLiveWorkspaces } from './check-native-rag-generation.mjs';

/**
 * `#788`: `index_generations` keeps a row set per workspace id forever, so a
 * deleted goal worktree or a superseded workspace identity made the operator
 * health check fail permanently on records no one can repair. These tests pin
 * which records stay in scope and that a live rotten workspace still fails.
 */

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const liveWorkspace = '9628fc78-f52f-428e-b358-bbfb66037150';
const retiredWorkspace = '39ab310a-3fbf-4fd1-915e-cd2d4c54a7b2';
const shadowWorkspace = 'local-5c388c78391644bb9715dc73fe1383c9';

describe('generation health workspace scope', () => {
  it('keeps a recorded workspace that has no registry row', () => {
    const { live, retired } = selectLiveWorkspaces(['unknown-id'], [], () => false);
    assert.deepEqual(live, ['unknown-id']);
    assert.deepEqual(retired, []);
  });

  it('retires a registry row whose path no longer exists', () => {
    const { live, retired } = selectLiveWorkspaces(
      [retiredWorkspace],
      [{ workspaceId: retiredWorkspace, workspacePath: '/gone/goal-worktree', updatedAt: 1 }],
      () => false,
    );
    assert.deepEqual(live, []);
    assert.deepEqual(retired, [
      { workspaceId: retiredWorkspace, reason: 'workspace-path-missing', workspacePath: '/gone/goal-worktree' },
    ]);
  });

  it('evaluates one identity per root and retires the older one', () => {
    const { live, retired } = selectLiveWorkspaces(
      [shadowWorkspace, liveWorkspace],
      [
        { workspaceId: shadowWorkspace, workspacePath: '/repo', updatedAt: 1 },
        { workspaceId: liveWorkspace, workspacePath: '/repo', updatedAt: 2 },
      ],
      () => true,
    );
    assert.deepEqual(live, [liveWorkspace]);
    assert.deepEqual(retired, [
      { workspaceId: shadowWorkspace, reason: 'superseded-identity', workspacePath: '/repo' },
    ]);
  });

  it('skips a retired record but still reports a live rotten generation', () => {
    const database = fixtureDatabase();
    insertGeneration(database, { generationId: 'gen-live', workspaceId: liveWorkspace, status: 'active' });
    insertChannels(database, 'gen-live', liveWorkspace, { parent: 'ok', lexical: 'ok', structural: 'ok', vector: 'missing' });
    insertGeneration(database, { generationId: 'gen-retired', workspaceId: retiredWorkspace, status: 'active' });
    insertChannels(database, 'gen-retired', retiredWorkspace, { parent: 'ok', lexical: 'ok', structural: 'ok', vector: 'missing' });
    insertRegistry(database, liveWorkspace, path.dirname(database), '2026-11-12T20:05:54.400855+00:00');
    insertRegistry(database, retiredWorkspace, path.join(path.dirname(database), 'deleted-worktree'), '2026-10-25T20:14:42.735193+00:00');

    const { workspaces, retired } = readGenerationHealth(database);
    assert.deepEqual(workspaces.map((entry) => entry.workspaceId), [liveWorkspace]);
    assert.deepEqual(workspaces[0].violations.map((violation) => violation.kind), ['unhealthy-channel']);
    assert.deepEqual(retired.map((entry) => entry.reason), ['workspace-path-missing']);
  });

  it('lets an explicit workspace request bypass the retirement filter', () => {
    const database = fixtureDatabase();
    insertGeneration(database, { generationId: 'gen-retired', workspaceId: retiredWorkspace, status: 'staging' });
    insertRegistry(database, retiredWorkspace, path.join(path.dirname(database), 'deleted-worktree'), '2026-10-25T20:14:42.735193+00:00');

    const { workspaces, retired } = readGenerationHealth(database, [retiredWorkspace]);
    assert.deepEqual(workspaces.map((entry) => entry.workspaceId), [retiredWorkspace]);
    assert.deepEqual(workspaces[0].violations.map((violation) => violation.kind), ['no-active-generation']);
    assert.deepEqual(retired, []);
  });
});

function fixtureDatabase() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'unified-mpc-generation-health-'));
  roots.push(root);
  mkdirSync(root, { recursive: true });
  const databasePath = path.join(root, 'local_context.db');
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE index_generations (
      generation_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT,
      activated_at TEXT
    );
    CREATE TABLE index_generation_channels (
      workspace_id TEXT NOT NULL,
      generation_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      state TEXT NOT NULL,
      detail TEXT,
      updated_at REAL NOT NULL,
      PRIMARY KEY (workspace_id, generation_id, channel)
    );
    CREATE TABLE workspace_registry (
      workspace_id TEXT PRIMARY KEY,
      workspace_path TEXT NOT NULL,
      ready INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT
    );
  `);
  database.close();
  return databasePath;
}

function insertGeneration(databasePath, { generationId, workspaceId, status }) {
  const database = new DatabaseSync(databasePath);
  database
    .prepare('INSERT INTO index_generations (generation_id, workspace_id, status, created_at, activated_at) VALUES (?, ?, ?, ?, ?)')
    .run(generationId, workspaceId, status, '2026-10-28T00:00:00.000Z', status === 'active' ? '2026-10-28T00:45:00.000Z' : null);
  database.close();
}

function insertChannels(databasePath, generationId, workspaceId, channels) {
  const database = new DatabaseSync(databasePath);
  const statement = database.prepare(
    'INSERT INTO index_generation_channels (workspace_id, generation_id, channel, state, detail, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  for (const [channel, state] of Object.entries(channels)) {
    statement.run(workspaceId, generationId, channel, state, state === 'ok' ? null : '{"detail":"vectors_skipped:embeddings_unavailable"}', 1_761_600_000);
  }
  database.close();
}

function insertRegistry(databasePath, workspaceId, workspacePath, updatedAt) {
  const database = new DatabaseSync(databasePath);
  database
    .prepare('INSERT INTO workspace_registry (workspace_id, workspace_path, ready, updated_at) VALUES (?, ?, 1, ?)')
    .run(workspaceId, workspacePath, updatedAt);
  database.close();
}
