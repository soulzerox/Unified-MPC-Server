import { describe, expect, it } from 'vitest';
import { SqliteDatabase, SqliteWorkspaceRepository } from '@unified-mpc/storage';
import type { WorkspaceAdmissionReceipt } from '@unified-mpc/domain';
import { createStrictThaiRagGoalAdmissionProvider } from './native-thai-rag-goal-admission.js';

const GOAL = '14fc20d1-5836-4faf-aed6-0df6a9633a38';
const PROJECT = 'ee83c457-0b79-49d7-937e-5c35aa91975d';
const NOW = Date.parse('2026-10-09T09:00:00.000Z');

function receipt(generation: number): WorkspaceAdmissionReceipt {
  return {
    admissionId: 'admission-1', projectId: PROJECT, workspaceId: GOAL, goalId: 'goal-1',
    workspaceKind: 'git', worktreeIdentity: 'opaque-worktree', branchName: 'goal/1',
    expectedWorkspaceHead: '1'.repeat(40), observedWorkspaceHead: '1'.repeat(40),
    baseRef: 'origin/main', expectedBaseSha: '2'.repeat(40), resolvedBaseSha: '2'.repeat(40),
    mergeBaseSha: '2'.repeat(40), dirtyState: 'clean', dirtyFingerprint: 'clean',
    checkpointId: 'checkpoint-1', checkpointRevision: 1, writeLeaseGeneration: generation,
    runtimeDeploymentId: 'deploy-1', runtimeGeneration: 'gen-1', runtimeBuildVersion: '4.61.0',
    runtimeBuildDirty: false, runtimeProtocolGeneration: 1,
    runtimeStartedAt: '2026-10-09T08:00:00.000Z', workflowVersion: 1,
    admissionGeneration: 1, createdAt: '2026-10-09T08:00:00.000Z',
  };
}

describe('strict-only Thai-RAG trusted Goal workspace admission scopes', () => {
  it('allows projects but denies unadmitted goals; accepts valid lease+receipt, then fences invalidated or expired admissions', async () => {
    const db = new SqliteDatabase(':memory:');
    const registry = new SqliteWorkspaceRepository(db);
    let now = NOW;
    try {
      await registry.insert({ id: PROJECT, displayName: 'Project', rootPath: '/tmp/project',
        realRootPath: '/tmp/project', createdAt: new Date(0).toISOString() });
      await registry.insert({ id: GOAL, displayName: 'Goal', rootPath: '/tmp/goal',
        realRootPath: '/tmp/goal', createdAt: new Date(0).toISOString(),
        lifecycleKind: 'goal', goalId: 'goal-1' });
      const authorized = createStrictThaiRagGoalAdmissionProvider(registry, () => now);
      expect((await authorized()).map(x => x.id)).toEqual([PROJECT]);
      const writer = await registry.acquireGoalWriterLease(
        GOAL, 'lease-1', 'owner-1', '2026-10-09T08:00:00.000Z', '2026-10-09T10:00:00.000Z',
      );
      expect(writer).not.toBeNull();
      expect((await authorized()).map(x => x.id)).toEqual([PROJECT]);
      expect(await registry.compareAndSwapAdmissionReceipt(GOAL, 0, writer!.generation, receipt(writer!.generation))).toBe(true);
      expect((await authorized()).map(x => x.id).sort()).toEqual([GOAL, PROJECT].sort());
      expect(await registry.invalidateAdmissionReceipt(GOAL, 1, 'unsafe', '2026-10-09T08:30:00.000Z')).toBe(true);
      expect((await authorized()).map(x => x.id)).toEqual([PROJECT]);
      db.connection.prepare('UPDATE workspace_admission_receipts SET receipt_json = ? WHERE workspace_id = ?')
        .run(JSON.stringify({ ...receipt(writer!.generation), expiresAt: '2026-10-09T08:59:00.000Z' }), GOAL);
      expect((await authorized()).map(x => x.id)).toEqual([PROJECT]);
      db.connection.prepare('UPDATE workspace_admission_receipts SET receipt_json = ? WHERE workspace_id = ?')
        .run(JSON.stringify({ ...receipt(writer!.generation), goalId: 'another-goal' }), GOAL);
      expect((await authorized()).map(x => x.id)).toEqual([PROJECT]);
      db.connection.prepare('UPDATE workspace_admission_receipts SET receipt_json = ? WHERE workspace_id = ?')
        .run(JSON.stringify(receipt(writer!.generation)), GOAL);
      now = Date.parse('2026-10-09T10:01:00.000Z');
      expect((await authorized()).map(x => x.id)).toEqual([PROJECT]);
      now = NOW;
      expect(await registry.releaseGoalWriterLease(GOAL, 'lease-1', writer!.generation)).toBe(true);
      expect((await authorized()).map(x => x.id)).toEqual([PROJECT]);
    } finally { db.close(); }
  });

  it('rejects clock uncertainty, malformed admission and fails closed on SQLite read exceptions', async () => {
    const db = new SqliteDatabase(':memory:');
    const registry = new SqliteWorkspaceRepository(db);
    try {
      await registry.insert({ id: GOAL, displayName: 'Goal', rootPath: '/tmp/goal',
        realRootPath: '/tmp/goal', createdAt: new Date(0).toISOString(),
        lifecycleKind: 'goal', goalId: 'goal-1' });
      await expect(createStrictThaiRagGoalAdmissionProvider(registry, () => NaN)()).rejects.toThrow('thai_rag_admission_clock_unavailable');
      const authorized = createStrictThaiRagGoalAdmissionProvider(registry, () => NOW);
      expect(await authorized()).toEqual([]);
      const erroring = createStrictThaiRagGoalAdmissionProvider({
        list: () => registry.list(),
        getAdmissionReceipt: async () => { throw new Error('sqlite_locked'); },
      }, () => NOW);
      await expect(erroring()).resolves.toEqual([]); // no lease, no read required
      await registry.acquireGoalWriterLease(
        GOAL, 'lease-1', 'owner-1', '2026-10-09T08:00:00.000Z', '2026-10-09T10:00:00.000Z',
      );
      await expect(erroring()).rejects.toThrow('sqlite_locked');
    } finally { db.close(); }
  });
});
