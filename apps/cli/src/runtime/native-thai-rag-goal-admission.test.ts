import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rename, rm, stat, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SqliteDatabase, SqliteWorkspaceRepository } from '@unified-mpc/storage';
import type { WorkspaceAdmissionReceipt } from '@unified-mpc/domain';
import { createStrictThaiRagGoalAdmissionProvider, type TrustedSourceGitRunner } from './native-thai-rag-goal-admission.js';

const GOAL = '14fc20d1-5836-4faf-aed6-0df6a9633a38';
const PROJECT = 'ee83c457-0b79-49d7-937e-5c35aa91975d';
const NOW = Date.parse('2026-10-09T09:00:00.000Z');

function receipt(generation: number): WorkspaceAdmissionReceipt {
  return {
    admissionId: 'admission-1', projectId: PROJECT, workspaceId: GOAL, goalId: 'goal-1',
    workspaceKind: 'non_git', worktreeIdentity: 'opaque-worktree', branchName: 'goal/1',
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
    const base = await mkdtemp(path.join(os.tmpdir(), 'fd3-snapshot-identity-'));
    const snapshotRoot = path.join(base, 'snapshot');
    const replacementRoot = path.join(base, 'replacement');
    await mkdir(snapshotRoot);
    await mkdir(replacementRoot);
    const rootIdentity = createHash('sha256').update(await realpath(snapshotRoot)).digest('hex');
    const db = new SqliteDatabase(':memory:');
    const registry = new SqliteWorkspaceRepository(db);
    let now = NOW;
    try {
      await registry.insert({ id: PROJECT, displayName: 'Project', rootPath: '/tmp/project',
        realRootPath: '/tmp/project', createdAt: new Date(0).toISOString() });
      await registry.insert({ id: GOAL, displayName: 'Goal', rootPath: snapshotRoot,
        realRootPath: snapshotRoot, createdAt: new Date(0).toISOString(),
        lifecycleKind: 'goal', goalId: 'goal-1', goalWorkspaceKind: 'snapshot' });
      const authorized = createStrictThaiRagGoalAdmissionProvider(registry, () => now);
      expect((await authorized()).map(x => x.id)).toEqual([PROJECT]);
      const writer = await registry.acquireGoalWriterLease(
        GOAL, 'lease-1', 'owner-1', '2026-10-09T08:00:00.000Z', '2026-10-09T10:00:00.000Z',
      );
      expect(writer).not.toBeNull();
      expect((await authorized()).map(x => x.id)).toEqual([PROJECT]);
      const validReceipt = { ...receipt(writer!.generation), worktreeIdentity: rootIdentity };
      expect(await registry.compareAndSwapAdmissionReceipt(GOAL, 0, writer!.generation, validReceipt)).toBe(true);
      expect((await authorized()).map(x => x.id).sort()).toEqual([GOAL, PROJECT].sort());
      // An attacker replaces a registered snapshot root with a symlink to an
      // unrelated directory without changing receipt, lease, or SQLite epoch.
      await rename(snapshotRoot, path.join(base, 'parked'));
      await symlink(replacementRoot, snapshotRoot);
      expect((await authorized()).map(x => x.id)).toEqual([PROJECT]);
      await rm(snapshotRoot);
      await rename(path.join(base, 'parked'), snapshotRoot);
      expect((await authorized()).map(x => x.id).sort()).toEqual([GOAL, PROJECT].sort());
      expect(await registry.invalidateAdmissionReceipt(GOAL, 1, 'unsafe', '2026-10-09T08:30:00.000Z')).toBe(true);
      expect((await authorized()).map(x => x.id)).toEqual([PROJECT]);
      db.connection.prepare('UPDATE workspace_admission_receipts SET receipt_json = ? WHERE workspace_id = ?')
        .run(JSON.stringify({ ...validReceipt, expiresAt: '2026-10-09T08:59:00.000Z' }), GOAL);
      expect((await authorized()).map(x => x.id)).toEqual([PROJECT]);
      db.connection.prepare('UPDATE workspace_admission_receipts SET receipt_json = ? WHERE workspace_id = ?')
        .run(JSON.stringify({ ...validReceipt, goalId: 'another-goal' }), GOAL);
      expect((await authorized()).map(x => x.id)).toEqual([PROJECT]);
      db.connection.prepare('UPDATE workspace_admission_receipts SET receipt_json = ? WHERE workspace_id = ?')
        .run(JSON.stringify(validReceipt), GOAL);
      now = Date.parse('2026-10-09T10:01:00.000Z');
      expect((await authorized()).map(x => x.id)).toEqual([PROJECT]);
      now = NOW;
      expect(await registry.releaseGoalWriterLease(GOAL, 'lease-1', writer!.generation)).toBe(true);
      expect((await authorized()).map(x => x.id)).toEqual([PROJECT]);
    } finally { db.close(); await rm(base, { recursive: true, force: true }); }
  });

  it('rejects Git worktree Goal HEAD and branch drift with intact SQLite receipt/lease, preserving unrelated projects', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'fd3-source-head-test-'));
    const db = new SqliteDatabase(':memory:');
    const registry = new SqliteWorkspaceRepository(db);
    let head = '1'.repeat(40);
    let branch = 'goal/1';
    let fail = false;
    let status = '';
    let indexFlags = 'H tracked.ts\0';
    let commonDir = path.join(root, 'git-common-a');
    const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
    const runner: TrustedSourceGitRunner = {
      async run(args): Promise<{ exitCode: number; stdout: string; stderr: string }> {
        if (fail) return { exitCode: 1, stdout: '', stderr: 'Git unavailable' };
        const op = args.join(' ');
        return {
          exitCode: 0,
          stdout: op.includes('--git-common-dir') ? commonDir + '\n'
            : op.includes('--show-toplevel') ? root + '\n'
            : op.includes('HEAD^{commit}') ? head + '\n'
              : op.includes('--porcelain=v1') ? status
                : op.includes('ls-files -v -z') ? indexFlags
                  : branch + '\n',
          stderr: '',
        };
      },
    };
    try {
      await mkdir(commonDir);
      const initialCommon = await stat(commonDir, { bigint: true });
      const commonFilesystemIdentity = digest(`${initialCommon.dev}:${initialCommon.ino}`);
      await registry.insert({ id: PROJECT, displayName: 'Project',
        rootPath: path.join(root, 'project'), realRootPath: path.join(root, 'project'),
        createdAt: new Date(0).toISOString() });
      await registry.insert({ id: GOAL, displayName: 'Goal',
        rootPath: root, realRootPath: root, createdAt: new Date(0).toISOString(),
        lifecycleKind: 'goal', goalId: 'goal-1',
        goalWorkspaceKind: 'git_worktree', branchName: 'goal/1' });
      const lease = await registry.acquireGoalWriterLease(
        GOAL, 'lease-1', 'owner-1', '2026-10-09T08:00:00.000Z', '2026-10-09T10:00:00.000Z',
      );
      expect(lease).not.toBeNull();
      expect(await registry.compareAndSwapAdmissionReceipt(
        GOAL, 0, lease!.generation, { ...receipt(lease!.generation), workspaceKind: 'git',
          repositoryIdentity: digest(commonDir), gitCommonDirIdentity: digest(commonDir),
          gitCommonDirFilesystemIdentity: commonFilesystemIdentity,
          worktreeIdentity: digest(root) },
      )).toBe(true);
      const authorized = createStrictThaiRagGoalAdmissionProvider(registry, () => NOW, runner);
      expect((await authorized()).map(x => x.id).sort()).toEqual([GOAL, PROJECT].sort());
      commonDir = path.join(root, 'git-common-b');
      await mkdir(commonDir);
      expect((await authorized()).map(x => x.id)).toEqual([PROJECT]);
      commonDir = path.join(root, 'git-common-a');
      status = '?? unknown.ts\0';
      expect((await authorized()).map(x => x.id)).toEqual([PROJECT]);
      status = 'M  staged.ts\0';
      expect((await authorized()).map(x => x.id)).toEqual([PROJECT]);
      status = ' M modified.ts\0';
      expect((await authorized()).map(x => x.id)).toEqual([PROJECT]);
      status = '';
      indexFlags = 'h tracked.ts\0';
      expect((await authorized()).map(x => x.id)).toEqual([PROJECT]);
      indexFlags = 'S tracked.ts\0';
      expect((await authorized()).map(x => x.id)).toEqual([PROJECT]);
      indexFlags = 'H tracked.ts\0';
      head = '3'.repeat(40);
      expect((await authorized()).map(x => x.id)).toEqual([PROJECT]);
      head = '1'.repeat(40);
      branch = 'another/branch';
      expect((await authorized()).map(x => x.id)).toEqual([PROJECT]);
      branch = 'goal/1';
      fail = true;
      expect((await authorized()).map(x => x.id)).toEqual([PROJECT]);
      fail = false;
      // Even replacing the directory at exactly the same canonical path
      // must not let stale admissions authorize a different repository.
      await rename(commonDir, path.join(root, 'old-common-directory'));
      await mkdir(commonDir);
      expect((await authorized()).map(x => x.id)).toEqual([PROJECT]);
      // Invalid registered branch identity cannot be restored by the Git reader.
      db.connection.prepare('UPDATE workspaces SET branch_name = ? WHERE id = ?').run('goal/other', GOAL);
      expect((await authorized()).map(x => x.id)).toEqual([PROJECT]);
      db.connection.prepare('UPDATE workspaces SET branch_name = ? WHERE id = ?').run('goal/1', GOAL);
      db.connection.prepare('UPDATE workspace_admission_receipts SET receipt_json = ? WHERE workspace_id = ?')
        .run(JSON.stringify({ ...receipt(lease!.generation), dirtyState: 'dirty' }), GOAL);
      expect((await authorized()).map(x => x.id)).toEqual([PROJECT]);
    } finally { db.close(); await rm(root, { recursive: true, force: true }); }
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
