import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  TurnTranscriptSupervisor,
  loadOrCreateTurnIngressKey,
  stageTurnTranscript,
  type CompletedTurnTranscript,
} from './turn-transcript-spool.js';

type ProjectBinding = { readonly projectId: string; readonly rootPath: string };
type PersistResult = { readonly ok: boolean; readonly recorded?: number; readonly skipped?: number; readonly error?: string };

function transcript(sequence: number, overrides: Partial<CompletedTurnTranscript> = {}): CompletedTurnTranscript {
  return {
    version: 1,
    sessionId: 'cline-session-a',
    turnId: `turn-${sequence}`,
    projectRef: '/workspace/project-a',
    sequence,
    userMessage: `user-${sequence}`,
    assistantMessage: `assistant-${sequence}`,
    userTimestamp: `2026-09-16T0${sequence % 10}:00:00.000Z`,
    assistantTimestamp: `2026-09-16T0${sequence % 10}:00:01.000Z`,
    sourceClient: 'cline',
    ...overrides,
  };
}

describe('trusted turn transcript spool', () => {
  it('persists staged turns at least once, ACKs them, and deduplicates a repeated turn id', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-turn-spool-'));
    try {
      const key = await loadOrCreateTurnIngressKey(root);
      const persisted: string[] = [];
      const supervisor = new TurnTranscriptSupervisor({
        dataPath: root,
        key,
        resolveProject: async (projectRef): Promise<ProjectBinding | null> => projectRef === '/workspace/project-a'
          ? { projectId: 'workspace-a', rootPath: '/workspace/project-a' }
          : null,
        persist: async (turn): Promise<PersistResult> => { persisted.push(turn.turnId); return { ok: true, recorded: 2, skipped: 0 }; },
      });

      expect((await stageTurnTranscript(root, key, transcript(100))).ok).toBe(true);
      await supervisor.reconcile();
      expect(persisted).toEqual(['turn-100']);
      expect(supervisor.status()).toMatchObject({
        state: 'connected',
        pendingTurns: 0,
        lastRecordedTurnId: 'turn-100',
        replayCount: 0,
      });

      const duplicate = await stageTurnTranscript(root, key, transcript(100));
      expect(duplicate).toMatchObject({ ok: true, value: { duplicate: true, acknowledged: true } });
      await supervisor.reconcile();
      expect(persisted).toEqual(['turn-100']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps a failed turn pending and replays it on the next reconciliation without creating a duplicate ACK', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-turn-retry-'));
    try {
      const key = Buffer.alloc(32, 7);
      let attempts = 0;
      const supervisor = new TurnTranscriptSupervisor({
        dataPath: root,
        key,
        resolveProject: async (): Promise<ProjectBinding | null> => ({ projectId: 'workspace-a', rootPath: '/workspace/project-a' }),
        persist: async (): Promise<PersistResult> => {
          attempts += 1;
          return attempts === 1
            ? { ok: false, error: 'thai-rag unavailable' }
            : { ok: true, recorded: 2, skipped: 0 };
        },
      });
      await stageTurnTranscript(root, key, transcript(101));

      await supervisor.reconcile();
      expect(supervisor.status()).toMatchObject({ state: 'degraded', pendingTurns: 1, replayCount: 0 });
      await supervisor.reconcile();
      expect(attempts).toBe(2);
      expect(supervisor.status()).toMatchObject({ state: 'connected', pendingTurns: 0, replayCount: 1, lastRecordedTurnId: 'turn-101' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('detects a missing sequence so a host adapter can replay the absent turn', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-turn-gap-'));
    try {
      const key = Buffer.alloc(32, 8);
      const supervisor = new TurnTranscriptSupervisor({
        dataPath: root,
        key,
        resolveProject: async (): Promise<ProjectBinding | null> => ({ projectId: 'workspace-a', rootPath: '/workspace/project-a' }),
        persist: async (): Promise<PersistResult> => ({ ok: true, recorded: 2, skipped: 0 }),
      });
      for (const sequence of [100, 101, 103]) await stageTurnTranscript(root, key, transcript(sequence));
      await supervisor.reconcile();

      expect(supervisor.status()).toMatchObject({ missingSequences: [102], pendingTurns: 0 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects spoofed unsigned journal entries before persistence dispatch', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-turn-spoof-'));
    try {
      const key = Buffer.alloc(32, 9);
      const incoming = path.join(root, 'turn-journal', 'incoming');
      await mkdir(incoming, { recursive: true });
      await writeFile(path.join(incoming, 'spoof.json'), JSON.stringify({ payload: transcript(1), signature: '00' }), 'utf8');
      let dispatches = 0;
      const supervisor = new TurnTranscriptSupervisor({
        dataPath: root,
        key,
        resolveProject: async (): Promise<ProjectBinding | null> => ({ projectId: 'workspace-a', rootPath: '/workspace/project-a' }),
        persist: async (): Promise<PersistResult> => { dispatches += 1; return { ok: true, recorded: 2, skipped: 0 }; },
      });

      await supervisor.reconcile();
      expect(dispatches).toBe(0);
      expect(supervisor.status()).toMatchObject({ rejectedTurns: 1 });
      const rejected = JSON.parse(await readFile(path.join(root, 'turn-journal', 'rejected', 'spoof.json'), 'utf8')) as { reason: string };
      expect(rejected.reason).toMatch(/signature/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('validates bounded complete transcripts and refuses an unbound project', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-turn-validation-'));
    try {
      const key = Buffer.alloc(32, 10);
      const missingAssistant = await stageTurnTranscript(root, key, transcript(1, { assistantMessage: '' }));
      expect(missingAssistant).toMatchObject({ ok: false, error: expect.objectContaining({ code: 'INVALID_INPUT' }) });
      const oversized = await stageTurnTranscript(root, key, transcript(2, { userMessage: 'x'.repeat(70_000) }));
      expect(oversized).toMatchObject({ ok: false, error: expect.objectContaining({ code: 'INVALID_INPUT' }) });

      await stageTurnTranscript(root, key, transcript(3, { projectRef: '/wrong/project' }));
      let dispatches = 0;
      const supervisor = new TurnTranscriptSupervisor({
        dataPath: root,
        key,
        resolveProject: async (): Promise<ProjectBinding | null> => null,
        persist: async (): Promise<PersistResult> => { dispatches += 1; return { ok: true, recorded: 2, skipped: 0 }; },
      });
      await supervisor.reconcile();
      expect(dispatches).toBe(0);
      expect(supervisor.status()).toMatchObject({ rejectedTurns: 1 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
