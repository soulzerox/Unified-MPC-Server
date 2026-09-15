import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { CompletedTurnTranscript } from '@unified-mpc/mcp-server';
import { AntigravityTurnTranscriptSource } from './antigravity-turn-transcript-source.js';

function createSummaryDatabase(filePath: string): DatabaseSync {
  const db = new DatabaseSync(filePath);
  db.exec(`
    CREATE TABLE conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      step_count INTEGER NOT NULL DEFAULT 0,
      last_modified_time TEXT NOT NULL,
      workspace_uris TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT '',
      not_fully_idle INTEGER NOT NULL DEFAULT 0,
      killed INTEGER NOT NULL DEFAULT 0
    );
  `);
  return db;
}

async function writeTranscript(root: string, conversationId: string, rows: readonly Record<string, unknown>[]): Promise<void> {
  const logs = path.join(root, 'brain', conversationId, '.system_generated', 'logs');
  await mkdir(logs, { recursive: true });
  await writeFile(path.join(logs, 'transcript.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
}

function upsertSummary(db: DatabaseSync, input: { conversationId: string; workspace: string; stepCount: number; modified: string; status?: string; notFullyIdle?: number; killed?: number }): void {
  db.prepare(`INSERT OR REPLACE INTO conversation_summaries(
    conversation_id, step_count, last_modified_time, workspace_uris, status, not_fully_idle, killed
  ) VALUES(?,?,?,?,?,?,?)`).run(
    input.conversationId,
    input.stepCount,
    input.modified,
    JSON.stringify([pathToFileURL(input.workspace).href]),
    input.status ?? 'CASCADE_RUN_STATUS_IDLE',
    input.notFullyIdle ?? 0,
    input.killed ?? 0,
  );
}

function user(step: number, content: string, at: string): Record<string, unknown> {
  return { step_index: step, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: at, content };
}

function tool(step: number, at: string): Record<string, unknown> {
  return { step_index: step, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: at, thinking: 'internal', tool_calls: [{ name: 'read_file', args: {} }] };
}

function finalAssistant(step: number, content: string, at: string): Record<string, unknown> {
  return { step_index: step, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: at, content };
}

describe('AntigravityTurnTranscriptSource', () => {
  it('baselines existing idle conversations and stages each later completed user/final-assistant segment', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'unified-antigravity-data-'));
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-antigravity-root-'));
    const db = createSummaryDatabase(path.join(root, 'conversation_summaries.db'));
    const staged: CompletedTurnTranscript[] = [];
    const cid = 'conversation-a';
    try {
      await writeTranscript(root, cid, [
        user(0, 'old question', '2026-09-15T01:00:00Z'),
        tool(1, '2026-09-15T01:00:01Z'),
        finalAssistant(2, 'old answer', '2026-09-15T01:00:02Z'),
      ]);
      upsertSummary(db, { conversationId: cid, workspace: '/workspace/a', stepCount: 3, modified: '2026-09-15T01:00:02Z' });
      const source = new AntigravityTurnTranscriptSource({
        dataPath,
        key: Buffer.alloc(32, 1),
        storageRoots: [root],
        intervalMs: 60_000,
        stage: async (turn): Promise<{ ok: true; value: { duplicate: false; acknowledged: false; entryId: string } }> => { staged.push(turn); return { ok: true, value: { duplicate: false, acknowledged: false, entryId: turn.turnId } }; },
      });
      await source.initialize();
      expect(staged).toHaveLength(0);
      expect(source.status()).toMatchObject({ state: 'active', sourceClient: 'antigravity', captureMode: 'automatic', autoRecordTurn: true, roots: 1 });

      await writeTranscript(root, cid, [
        user(0, 'old question', '2026-09-15T01:00:00Z'),
        finalAssistant(2, 'old answer', '2026-09-15T01:00:02Z'),
        user(3, 'new question', '2026-09-15T01:01:00Z'),
        tool(4, '2026-09-15T01:01:01Z'),
        finalAssistant(5, 'new answer', '2026-09-15T01:01:02Z'),
        user(6, 'follow up', '2026-09-15T01:02:00Z'),
        finalAssistant(7, 'follow-up answer', '2026-09-15T01:02:02Z'),
      ]);
      upsertSummary(db, { conversationId: cid, workspace: '/workspace/a', stepCount: 8, modified: '2026-09-15T01:02:02Z' });
      await source.scan();
      await source.scan();

      expect(staged).toHaveLength(2);
      expect(staged.map((turn) => [turn.userMessage, turn.assistantMessage])).toEqual([
        ['new question', 'new answer'],
        ['follow up', 'follow-up answer'],
      ]);
      expect(staged[0]).toMatchObject({ projectRef: '/workspace/a', sourceClient: 'antigravity', sequence: 1 });
      expect(staged[1]).toMatchObject({ sequence: 2 });
      await source.close();
    } finally {
      db.close();
      await rm(dataPath, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it('waits for an idle, non-killed conversation before staging and replays after restart', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'unified-antigravity-replay-data-'));
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-antigravity-replay-root-'));
    const db = createSummaryDatabase(path.join(root, 'conversation_summaries.db'));
    const cid = 'conversation-b';
    try {
      await writeTranscript(root, cid, [user(0, 'question', '2026-09-15T02:00:00Z')]);
      upsertSummary(db, { conversationId: cid, workspace: '/workspace/b', stepCount: 1, modified: '2026-09-15T02:00:00Z' });
      const first = new AntigravityTurnTranscriptSource({ dataPath, key: Buffer.alloc(32, 2), storageRoots: [root], intervalMs: 60_000 });
      await first.initialize();
      await first.close();

      await writeTranscript(root, cid, [user(0, 'question', '2026-09-15T02:00:00Z'), finalAssistant(1, 'answer', '2026-09-15T02:00:02Z')]);
      upsertSummary(db, { conversationId: cid, workspace: '/workspace/b', stepCount: 2, modified: '2026-09-15T02:00:02Z', status: 'CASCADE_RUN_STATUS_RUNNING', notFullyIdle: 1 });
      const active = new AntigravityTurnTranscriptSource({ dataPath, key: Buffer.alloc(32, 2), storageRoots: [root], intervalMs: 60_000 });
      await active.initialize();
      expect(active.status()).toMatchObject({ state: 'active', stagedTurns: 0 });
      await active.close();

      upsertSummary(db, { conversationId: cid, workspace: '/workspace/b', stepCount: 2, modified: '2026-09-15T02:00:03Z' });
      const replay = new AntigravityTurnTranscriptSource({ dataPath, key: Buffer.alloc(32, 2), storageRoots: [root], intervalMs: 60_000 });
      await replay.initialize();
      expect(replay.status()).toMatchObject({ state: 'active', stagedTurns: 1 });
      await replay.close();
    } finally {
      db.close();
      await rm(dataPath, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps one Antigravity producer owner and reports missing storage truthfully', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'unified-antigravity-lease-data-'));
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-antigravity-lease-root-'));
    const db = createSummaryDatabase(path.join(root, 'conversation_summaries.db'));
    await mkdir(path.join(root, 'brain'), { recursive: true });
    try {
      const first = new AntigravityTurnTranscriptSource({ dataPath, key: Buffer.alloc(32, 3), storageRoots: [root], intervalMs: 60_000 });
      const second = new AntigravityTurnTranscriptSource({ dataPath, key: Buffer.alloc(32, 3), storageRoots: [root], intervalMs: 60_000 });
      await first.initialize();
      await second.initialize();
      expect(first.status()).toMatchObject({ state: 'active', autoRecordTurn: true });
      expect(second.status()).toMatchObject({ state: 'unavailable', autoRecordTurn: false, lastError: expect.stringContaining('producer lease') });
      await first.close();
      await second.scan();
      expect(second.status()).toMatchObject({ state: 'active', autoRecordTurn: true });
      await second.close();

      const missing = new AntigravityTurnTranscriptSource({ dataPath, key: Buffer.alloc(32, 3), storageRoots: [path.join(root, 'missing')] });
      await missing.initialize();
      expect(missing.status()).toMatchObject({ state: 'unavailable', autoRecordTurn: false, roots: 0 });
      await missing.close();
    } finally {
      db.close();
      await rm(dataPath, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });
});
