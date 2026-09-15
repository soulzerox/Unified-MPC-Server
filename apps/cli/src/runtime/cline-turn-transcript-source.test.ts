import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CompletedTurnTranscript } from '@unified-mpc/mcp-server';
import { ClineTurnTranscriptSource } from './cline-turn-transcript-source.js';

async function writeClineTask(
  root: string,
  taskId: string,
  cwd: string,
  messages: readonly Record<string, unknown>[],
): Promise<void> {
  await mkdir(path.join(root, 'state'), { recursive: true });
  await mkdir(path.join(root, 'tasks', taskId), { recursive: true });
  let history: Record<string, unknown>[] = [];
  try { history = JSON.parse(await readFile(path.join(root, 'state', 'taskHistory.json'), 'utf8')) as Record<string, unknown>[]; } catch { /* first task */ }
  const withoutTask = history.filter((entry) => entry.id !== taskId);
  withoutTask.push({ id: taskId, ulid: `ulid-${taskId}`, ts: Number(taskId), task: `task-${taskId}`, cwdOnTaskInitialization: cwd });
  await writeFile(path.join(root, 'state', 'taskHistory.json'), JSON.stringify(withoutTask), 'utf8');
  await writeFile(path.join(root, 'tasks', taskId, 'ui_messages.json'), JSON.stringify(messages), 'utf8');
}

describe('ClineTurnTranscriptSource', () => {
  it('baselines existing history once, then stages only newly completed Cline turns with the task workspace binding', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'unified-cline-source-data-'));
    const clineRoot = await mkdtemp(path.join(os.tmpdir(), 'unified-cline-source-root-'));
    const staged: CompletedTurnTranscript[] = [];
    try {
      await writeClineTask(clineRoot, '1000', '/workspace/project-a', [
        { ts: 1_000, type: 'say', say: 'task', text: 'Initial task' },
        { ts: 1_100, type: 'say', say: 'completion_result', text: 'Initial answer' },
      ]);
      const source = new ClineTurnTranscriptSource({
        dataPath,
        key: Buffer.alloc(32, 1),
        storageRoots: [clineRoot],
        stage: async (turn): Promise<{ ok: true; value: { duplicate: false; acknowledged: false; entryId: string } }> => { staged.push(turn); return { ok: true, value: { duplicate: false, acknowledged: false, entryId: turn.turnId } }; },
        intervalMs: 60_000,
      });

      await source.initialize();
      expect(staged).toEqual([]);
      expect(source.status()).toMatchObject({ state: 'active', sourceClient: 'cline', autoRecordTurn: true, roots: 1, stagedTurns: 0 });

      await writeClineTask(clineRoot, '1000', '/workspace/project-a', [
        { ts: 1_000, type: 'say', say: 'task', text: 'Initial task' },
        { ts: 1_100, type: 'say', say: 'completion_result', text: 'Initial answer' },
        { ts: 2_000, type: 'say', say: 'user_feedback', text: 'Please also fix the retry path.' },
        { ts: 2_100, type: 'say', say: 'completion_result', text: 'Retry path fixed.' },
      ]);
      await source.scan();
      await source.scan();

      expect(staged).toHaveLength(1);
      expect(staged[0]).toMatchObject({
        version: 1,
        projectRef: '/workspace/project-a',
        sequence: 1,
        userMessage: 'Please also fix the retry path.',
        assistantMessage: 'Retry path fixed.',
        sourceClient: 'cline',
      });
      expect(staged[0]?.sessionId).toContain('1000');
      expect(staged[0]?.turnId).toContain('2100');
      expect(source.status()).toMatchObject({ state: 'active', stagedTurns: 1 });
      await source.close();
    } finally {
      await rm(dataPath, { recursive: true, force: true });
      await rm(clineRoot, { recursive: true, force: true });
    }
  });

  it('replays a completion written while Unified MCP was offline after source recreation', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'unified-cline-restart-data-'));
    const clineRoot = await mkdtemp(path.join(os.tmpdir(), 'unified-cline-restart-root-'));
    try {
      await writeClineTask(clineRoot, '2000', '/workspace/project-b', [
        { ts: 2_000, type: 'say', say: 'task', text: 'Start task' },
      ]);
      const first = new ClineTurnTranscriptSource({ dataPath, key: Buffer.alloc(32, 2), storageRoots: [clineRoot], intervalMs: 60_000 });
      await first.initialize();
      await first.close();

      await writeClineTask(clineRoot, '2000', '/workspace/project-b', [
        { ts: 2_000, type: 'say', say: 'task', text: 'Start task' },
        { ts: 2_500, type: 'say', say: 'completion_result', text: 'Finished while MCP was down.' },
      ]);
      const second = new ClineTurnTranscriptSource({ dataPath, key: Buffer.alloc(32, 2), storageRoots: [clineRoot], intervalMs: 60_000 });
      await second.initialize();

      expect(second.status()).toMatchObject({ state: 'active', stagedTurns: 1 });
      const incoming = path.join(dataPath, 'turn-journal', 'incoming');
      const entries = await import('node:fs/promises').then(({ readdir }) => readdir(incoming));
      expect(entries).toHaveLength(1);
      await second.close();
    } finally {
      await rm(dataPath, { recursive: true, force: true });
      await rm(clineRoot, { recursive: true, force: true });
    }
  });

  it('allows only one runtime to own the Cline producer lease at a time', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'unified-cline-lease-data-'));
    const clineRoot = await mkdtemp(path.join(os.tmpdir(), 'unified-cline-lease-root-'));
    try {
      await writeClineTask(clineRoot, '2500', '/workspace/project-b', [
        { ts: 2_500, type: 'say', say: 'task', text: 'Lease test' },
      ]);
      const first = new ClineTurnTranscriptSource({ dataPath, key: Buffer.alloc(32, 4), storageRoots: [clineRoot], intervalMs: 60_000 });
      const second = new ClineTurnTranscriptSource({ dataPath, key: Buffer.alloc(32, 4), storageRoots: [clineRoot], intervalMs: 60_000 });
      await first.initialize();
      await second.initialize();

      expect(first.status()).toMatchObject({ state: 'active', autoRecordTurn: true });
      expect(second.status()).toMatchObject({ state: 'unavailable', autoRecordTurn: false, lastError: expect.stringContaining('producer lease') });

      await first.close();
      await second.scan();
      expect(second.status()).toMatchObject({ state: 'active', autoRecordTurn: true });
      await second.close();
    } finally {
      await rm(dataPath, { recursive: true, force: true });
      await rm(clineRoot, { recursive: true, force: true });
    }
  });

  it('does not stage an unfinished Cline task and reports unavailable when no supported storage root exists', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'unified-cline-incomplete-data-'));
    const clineRoot = path.join(dataPath, 'missing-cline-root');
    try {
      const unavailable = new ClineTurnTranscriptSource({ dataPath, key: Buffer.alloc(32, 3), storageRoots: [clineRoot] });
      await unavailable.initialize();
      expect(unavailable.status()).toMatchObject({ state: 'unavailable', autoRecordTurn: false, roots: 0, stagedTurns: 0 });
      await unavailable.close();

      await mkdir(clineRoot, { recursive: true });
      await writeClineTask(clineRoot, '3000', '/workspace/project-c', [
        { ts: 3_000, type: 'say', say: 'task', text: 'Still working' },
        { ts: 3_100, type: 'ask', ask: 'resume_task' },
      ]);
      const active = new ClineTurnTranscriptSource({ dataPath, key: Buffer.alloc(32, 3), storageRoots: [clineRoot], intervalMs: 60_000 });
      await active.initialize();
      expect(active.status()).toMatchObject({ state: 'active', autoRecordTurn: true, stagedTurns: 0 });
      await active.close();
    } finally {
      await rm(dataPath, { recursive: true, force: true });
    }
  });
});
