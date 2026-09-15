import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { CompletedTurnTranscript } from '@unified-mpc/mcp-server';
import { OpenCodeTurnTranscriptSource } from './opencode-turn-transcript-source.js';

function createOpenCodeDatabase(filePath: string): DatabaseSync {
  const db = new DatabaseSync(filePath);
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      directory TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `);
  return db;
}

function addTurn(
  db: DatabaseSync,
  input: { sessionId: string; directory: string; userId: string; assistantId: string; userText: string; assistantText: string; userAt: number; completedAt: number; finish?: string },
): void {
  db.prepare('INSERT OR REPLACE INTO session(id,directory,time_created,time_updated) VALUES(?,?,?,?)')
    .run(input.sessionId, input.directory, input.userAt, input.completedAt);
  db.prepare('INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?)')
    .run(input.userId, input.sessionId, input.userAt, input.userAt, JSON.stringify({ role: 'user', time: { created: input.userAt } }));
  db.prepare('INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?,?)')
    .run(`part-${input.userId}`, input.userId, input.sessionId, input.userAt, input.userAt, JSON.stringify({ type: 'text', text: input.userText }));
  db.prepare('INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?)')
    .run(input.assistantId, input.sessionId, input.completedAt - 1, input.completedAt, JSON.stringify({
      role: 'assistant',
      parentID: input.userId,
      time: { created: input.completedAt - 1, completed: input.completedAt },
      finish: input.finish ?? 'stop',
    }));
  db.prepare('INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?,?)')
    .run(`part-${input.assistantId}`, input.assistantId, input.sessionId, input.completedAt, input.completedAt, JSON.stringify({ type: 'text', text: input.assistantText }));
}

describe('OpenCodeTurnTranscriptSource', () => {
  it('baselines existing sessions and stages only new completed visible turns', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'unified-opencode-data-'));
    const sourceRoot = await mkdtemp(path.join(os.tmpdir(), 'unified-opencode-root-'));
    const dbPath = path.join(sourceRoot, 'opencode.db');
    const db = createOpenCodeDatabase(dbPath);
    const staged: CompletedTurnTranscript[] = [];
    try {
      addTurn(db, { sessionId: 'ses-a', directory: '/workspace/a', userId: 'u1', assistantId: 'a1', userText: 'old user', assistantText: 'old assistant', userAt: 1_000, completedAt: 1_100 });
      const source = new OpenCodeTurnTranscriptSource({
        dataPath,
        key: Buffer.alloc(32, 1),
        databasePaths: [dbPath],
        intervalMs: 60_000,
        stage: async (turn): Promise<{ ok: true; value: { duplicate: false; acknowledged: false; entryId: string } }> => { staged.push(turn); return { ok: true, value: { duplicate: false, acknowledged: false, entryId: turn.turnId } }; },
      });
      await source.initialize();
      expect(staged).toHaveLength(0);
      expect(source.status()).toMatchObject({ state: 'active', sourceClient: 'opencode', autoRecordTurn: true, captureMode: 'automatic', roots: 1 });

      addTurn(db, { sessionId: 'ses-a', directory: '/workspace/a', userId: 'u2', assistantId: 'a2', userText: 'new user', assistantText: 'new assistant', userAt: 2_000, completedAt: 2_100 });
      await source.scan();
      await source.scan();

      expect(staged).toHaveLength(1);
      expect(staged[0]).toMatchObject({
        projectRef: '/workspace/a',
        userMessage: 'new user',
        assistantMessage: 'new assistant',
        sourceClient: 'opencode',
        sequence: 1,
      });
      expect(staged[0]?.sessionId).toContain('ses-a');
      expect(staged[0]?.turnId).toContain('a2');
      await source.close();
    } finally {
      db.close();
      await rm(dataPath, { recursive: true, force: true });
      await rm(sourceRoot, { recursive: true, force: true });
    }
  });

  it('replays a turn completed while Unified MCP was offline and ignores tool-call-only assistants', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'unified-opencode-replay-data-'));
    const sourceRoot = await mkdtemp(path.join(os.tmpdir(), 'unified-opencode-replay-root-'));
    const dbPath = path.join(sourceRoot, 'opencode.db');
    const db = createOpenCodeDatabase(dbPath);
    try {
      db.prepare('INSERT INTO session(id,directory,time_created,time_updated) VALUES(?,?,?,?)').run('ses-b', '/workspace/b', 3_000, 3_000);
      const first = new OpenCodeTurnTranscriptSource({ dataPath, key: Buffer.alloc(32, 2), databasePaths: [dbPath], intervalMs: 60_000 });
      await first.initialize();
      await first.close();

      addTurn(db, { sessionId: 'ses-b', directory: '/workspace/b', userId: 'u3', assistantId: 'a-tool', userText: 'run it', assistantText: 'intermediate', userAt: 3_100, completedAt: 3_200, finish: 'tool-calls' });
      db.prepare('UPDATE session SET time_updated=? WHERE id=?').run(3_250, 'ses-b');
      const second = new OpenCodeTurnTranscriptSource({ dataPath, key: Buffer.alloc(32, 2), databasePaths: [dbPath], intervalMs: 60_000 });
      await second.initialize();
      expect(second.status()).toMatchObject({ state: 'active', stagedTurns: 0 });
      await second.close();

      addTurn(db, { sessionId: 'ses-b', directory: '/workspace/b', userId: 'u4', assistantId: 'a-stop', userText: 'finish it', assistantText: 'finished', userAt: 3_300, completedAt: 3_400 });
      const third = new OpenCodeTurnTranscriptSource({ dataPath, key: Buffer.alloc(32, 2), databasePaths: [dbPath], intervalMs: 60_000 });
      await third.initialize();
      expect(third.status()).toMatchObject({ state: 'active', stagedTurns: 1 });
      await third.close();
    } finally {
      db.close();
      await rm(dataPath, { recursive: true, force: true });
      await rm(sourceRoot, { recursive: true, force: true });
    }
  });

  it('allows one OpenCode producer owner and degrades cleanly when storage is missing', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'unified-opencode-lease-data-'));
    const sourceRoot = await mkdtemp(path.join(os.tmpdir(), 'unified-opencode-lease-root-'));
    const dbPath = path.join(sourceRoot, 'opencode.db');
    const db = createOpenCodeDatabase(dbPath);
    try {
      db.prepare('INSERT INTO session(id,directory,time_created,time_updated) VALUES(?,?,?,?)').run('ses-c', '/workspace/c', 4_000, 4_000);
      const first = new OpenCodeTurnTranscriptSource({ dataPath, key: Buffer.alloc(32, 3), databasePaths: [dbPath], intervalMs: 60_000 });
      const second = new OpenCodeTurnTranscriptSource({ dataPath, key: Buffer.alloc(32, 3), databasePaths: [dbPath], intervalMs: 60_000 });
      await first.initialize();
      await second.initialize();
      expect(first.status()).toMatchObject({ state: 'active', autoRecordTurn: true });
      expect(second.status()).toMatchObject({ state: 'unavailable', autoRecordTurn: false, lastError: expect.stringContaining('producer lease') });
      await first.close();
      await second.scan();
      expect(second.status()).toMatchObject({ state: 'active', autoRecordTurn: true });
      await second.close();

      const missing = new OpenCodeTurnTranscriptSource({ dataPath, key: Buffer.alloc(32, 3), databasePaths: [path.join(sourceRoot, 'missing.db')] });
      await missing.initialize();
      expect(missing.status()).toMatchObject({ state: 'unavailable', autoRecordTurn: false, roots: 0 });
      await missing.close();
    } finally {
      db.close();
      await rm(dataPath, { recursive: true, force: true });
      await rm(sourceRoot, { recursive: true, force: true });
    }
  });
});
