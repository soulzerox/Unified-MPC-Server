import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
const script = path.resolve('scripts/check-native-rag-generation.mjs');
const workspace = '9628fc78-f52f-428e-b358-bbfb66037150';

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('native Thai-RAG generation health', () => {
  it('passes when the active generation published every channel healthy', async () => {
    const database = await fixtureDatabase();
    insertGeneration(database, { generationId: 'gen-healthy', status: 'active' });
    insertChannels(database, 'gen-healthy', { parent: 'ok', lexical: 'ok', structural: 'ok', vector: 'ok' });

    const result = run(database);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('generation gen-healthy active since');
    expect(result.stdout).toContain('vector=ok');
    expect(result.stdout).toContain('health passed for 1 workspace');
  });

  it('fails when the vector channel is degraded, which is the state that keeps the gate shut', async () => {
    const database = await fixtureDatabase();
    insertGeneration(database, { generationId: 'gen-degraded', status: 'active' });
    insertChannels(database, 'gen-degraded', { parent: 'ok', lexical: 'ok', structural: 'ok', vector: 'degraded' });

    const result = run(database);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('vector=degraded');
    expect(result.stdout).toContain('unhealthy-channel: channel vector is degraded');
    expect(result.stderr).toContain('pre-edit gate cannot serve evidence');
  });

  it('reports a channel that was never published as missing', async () => {
    const database = await fixtureDatabase();
    insertGeneration(database, { generationId: 'gen-partial', status: 'active' });
    insertChannels(database, 'gen-partial', { parent: 'ok', lexical: 'ok', structural: 'ok' });

    const result = run(database);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('vector=absent');
    expect(result.stdout).toContain('missing-channel: channel vector was never published');
  });

  it('distinguishes a workspace with only a staging generation from one that never indexed', async () => {
    const stagingDatabase = await fixtureDatabase();
    insertGeneration(stagingDatabase, { generationId: 'gen-staging', status: 'staging' });

    const staging = run(stagingDatabase);
    expect(staging.status).toBe(1);
    expect(staging.stdout).toContain('no active generation');
    expect(staging.stdout).toContain('no-active-generation');

    const emptyDatabase = await fixtureDatabase();
    const empty = run(emptyDatabase);
    expect(empty.status).toBe(1);
    expect(empty.stdout).toContain('no-generations');
  });

  it('exits with a usage error when the database is absent', async () => {
    const root = await fixtureRoot();
    const result = spawnSync(process.execPath, [script, '--db', path.join(root, 'missing.db'), '--workspace', workspace], { encoding: 'utf8' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Native Thai-RAG database not found');
  });
});

function run(databasePath: string): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(process.execPath, [script, '--db', databasePath, '--workspace', workspace], { encoding: 'utf8' });
}

async function fixtureDatabase(): Promise<string> {
  const root = await fixtureRoot();
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
  `);
  database.close();
  return databasePath;
}

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-generation-health-'));
  roots.push(root);
  await mkdir(root, { recursive: true });
  return root;
}

function insertGeneration(databasePath: string, options: { generationId: string; status: string }): void {
  const database = new DatabaseSync(databasePath);
  database
    .prepare('INSERT INTO index_generations (generation_id, workspace_id, status, created_at, activated_at) VALUES (?, ?, ?, ?, ?)')
    .run(
      options.generationId,
      workspace,
      options.status,
      '2026-10-28T00:00:00.000Z',
      options.status === 'active' ? '2026-10-28T00:45:00.000Z' : null,
    );
  database.close();
}

function insertChannels(databasePath: string, generationId: string, channels: Record<string, string>): void {
  const database = new DatabaseSync(databasePath);
  const statement = database.prepare(
    'INSERT INTO index_generation_channels (workspace_id, generation_id, channel, state, detail, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  for (const [channel, state] of Object.entries(channels)) {
    statement.run(workspace, generationId, channel, state, state === 'ok' ? null : '{"detail":"partial_vectors:1/10722"}', 1_761_600_000);
  }
  database.close();
}
