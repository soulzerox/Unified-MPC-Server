import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkspaceAdmissionReceipt } from '@unified-mpc/domain';
import { SqliteDatabase } from './database.js';
import { SqliteGoalRepository } from './goal-repository.js';
import { SqliteGoalWorkspaceRetentionCustodyRepository } from './goal-workspace-retention-custody-repository.js';
import { SqliteGoalWorkspaceRetentionEvidenceRepository } from './goal-workspace-retention-evidence-repository.js';
import { SqliteWorkspaceRepository } from './workspace-repository.js';
import { SqliteGoalWorkspaceTransferRepository } from './goal-workspace-transfer-repository.js';

const roots: string[] = [];
const now = '2026-10-09T00:00:00.000Z';
const sha = 'a'.repeat(40);
const manifest = 'b'.repeat(64);
const request = {
  operationId: 'relocation-1',
  goalId: 'goal-owner',
  goalKey: 'goal-backlog',
  fromWorkspaceId: 'goal-workspace-old',
  toWorkspaceId: 'goal-workspace-new',
  expectedRevision: 0,
  expectedAdmissionGeneration: 12,
  leaseGeneration: 1,
  leaseTokenHash: 'lease-token-hash',
  ownerClientId: 'owner-client',
  ownerSessionId: 'owner-session',
  expectedOldHead: sha,
  expectedOldBranch: 'goal/goal-owner',
  retainedManifestSha256: manifest,
  now,
} as const;

afterEach(async (): Promise<void> => {
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{
  database: SqliteDatabase;
  transfer: SqliteGoalWorkspaceTransferRepository;
  workspaces: SqliteWorkspaceRepository;
  databasePath: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'umcp-transfer-prepared-'));
  roots.push(root);
  const database = new SqliteDatabase(path.join(root, 'goal.sqlite'));
  const workspaces = new SqliteWorkspaceRepository(database);
  await workspaces.insert({
    id: 'project-root', displayName: 'Project', rootPath: root + '/project',
    realRootPath: root + '/project', createdAt: now, lifecycleKind: 'project',
  });
  await workspaces.insert({
    id: request.fromWorkspaceId, displayName: 'Old Goal', rootPath: root + '/old',
    realRootPath: root + '/old', createdAt: now, lifecycleKind: 'goal', goalId: request.goalId,
    parentWorkspaceId: 'project-root', goalWorkspaceKind: 'git_worktree',
    branchName: request.expectedOldBranch, baseRevision: 'c'.repeat(40),
  });
  await workspaces.insert({
    id: request.toWorkspaceId, displayName: 'Prepared Worktree', rootPath: root + '/next',
    realRootPath: root + '/next', createdAt: now, lifecycleKind: 'temporary',
    parentWorkspaceId: 'project-root', ownerSessionId: request.ownerSessionId,
  });
  const goals = new SqliteGoalRepository(database);
  const created = await goals.acquire({
    goalId: request.goalId, workspaceId: request.fromWorkspaceId,
    goalKey: request.goalKey, ownerClientId: request.ownerClientId,
    ownerSessionId: request.ownerSessionId, objective: 'Recover current Goal safely',
    plan: { steps: [{ id: 'recover', title: 'Preserve and transfer', status: 'pending' }] },
    leaseTokenHash: request.leaseTokenHash, leaseSeconds: 600, now,
  });
  expect(created.acquired).toBe(true);
  await workspaces.synchronizeGoalWriterLease(request.fromWorkspaceId, request.goalId,
    'writer-lease', request.ownerClientId + ':' + request.ownerSessionId, 1,
    '2026-10-09T00:10:00.000Z', now);
  database.connection.prepare(
    'INSERT INTO workspace_admission_receipts (workspace_id, admission_generation, write_lease_generation, receipt_json, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(request.fromWorkspaceId, 12, 1, JSON.stringify({
    goalId: request.goalId, workspaceId: request.fromWorkspaceId,
    admissionGeneration: 12, writeLeaseGeneration: 1,
    expectedWorkspaceHead: sha, observedWorkspaceHead: sha,
    branchName: request.expectedOldBranch, dirtyState: 'dirty',
  }), now);
  const evidence = new SqliteGoalWorkspaceRetentionEvidenceRepository(database);
  expect(await evidence.recordSealed({
    operationId: request.operationId, expectedGoalId: request.goalId,
    expectedWorkspaceId: request.fromWorkspaceId, newWorkspaceId: request.toWorkspaceId,
    retentionPath: '/srv/verified-retention/test-bundle',
    expectedManifestSha256: request.retainedManifestSha256,
    expectedHead: request.expectedOldHead, expectedBranch: request.expectedOldBranch,
    ownerClientId: request.ownerClientId, ownerSessionId: request.ownerSessionId,
    expectedRevision: request.expectedRevision,
    expectedAdmissionGeneration: request.expectedAdmissionGeneration,
    leaseGeneration: request.leaseGeneration, leaseTokenHash: request.leaseTokenHash,
    now,
  })).toBe(true);
  const custody = new SqliteGoalWorkspaceRetentionCustodyRepository(database);
  expect(await custody.recordVerified({
    operationId: request.operationId, goalId: request.goalId, expectedGoalId: request.goalId,
    expectedWorkspaceId: request.fromWorkspaceId, newWorkspaceId: request.toWorkspaceId,
    retentionPath: '/srv/verified-retention/test-bundle',
    expectedManifestSha256: request.retainedManifestSha256,
    expectedHead: request.expectedOldHead, expectedBranch: request.expectedOldBranch,
    expectedRevision: request.expectedRevision,
    expectedAdmissionGeneration: request.expectedAdmissionGeneration,
    leaseGeneration: request.leaseGeneration, leaseTokenHash: request.leaseTokenHash,
    ownerClientId: request.ownerClientId, ownerSessionId: request.ownerSessionId,
    pinnedAt: now,
  })).toBe(true);
  return { database, transfer: new SqliteGoalWorkspaceTransferRepository(database), workspaces,
    databasePath: path.join(root, 'goal.sqlite') };
}

const newAdmission: WorkspaceAdmissionReceipt = {
  admissionId: 'new-admission-1',
  projectId: 'project-root',
  workspaceId: request.toWorkspaceId,
  goalId: request.goalId,
  workspaceKind: 'git',
  repositoryIdentity: 'canonical-repo',
  gitCommonDirIdentity: 'git-common-dir',
  worktreeIdentity: 'worktree-new',
  branchName: 'goal/replacement-owner',
  expectedWorkspaceHead: 'd'.repeat(40),
  observedWorkspaceHead: 'd'.repeat(40),
  expectedBaseSha: 'c'.repeat(40),
  resolvedBaseSha: 'c'.repeat(40),
  mergeBaseSha: 'c'.repeat(40),
  dirtyState: 'clean',
  dirtyFingerprint: 'clean-sha',
  stagedFingerprint: 'stage-clean',
  checkpointId: 'new-checkpoint',
  checkpointRevision: 1,
  writeLeaseGeneration: request.leaseGeneration,
  runtimeDeploymentId: 'local-demo',
  runtimeGeneration: 'deploy-demo',
  runtimeBuildVersion: '4.61.0+demo',
  runtimeBuildCommit: 'e'.repeat(40),
  runtimeBuildDirty: false,
  runtimeProtocolGeneration: 1,
  runtimeStartedAt: now,
  workflowVersion: 1,
  admissionGeneration: 1,
  createdAt: now,
};

describe('SqliteGoalWorkspaceTransferRepository #298 (prepare and atomic commit)', () => {
  it('classifies a prepared intent as needing new owner verification after restart without mutating anything', async () => {
    const t = await fixture();
    try {
      expect(await t.transfer.prepare(request)).toBe(true);
      const before = await t.transfer.get(request.operationId);
      expect(await t.transfer.inspectRecovery(request.operationId, now)).toEqual({
        operationId: request.operationId, goalId: request.goalId,
        oldWorkspaceId: request.fromWorkspaceId, newWorkspaceId: request.toWorkspaceId,
        state: 'prepared_requires_fresh_owner_verification',
      });
      expect(await t.transfer.get(request.operationId)).toEqual(before);
      expect(await t.workspaces.get(request.fromWorkspaceId)).toMatchObject({ goalId: request.goalId });
      expect(await t.workspaces.get(request.toWorkspaceId)).toMatchObject({ lifecycleKind: 'temporary' });
    } finally {
      t.database.close();
    }
  });

  it('reads a persisted prepared operation after a real database close and reopen without resuming ownership', async () => {
    const t = await fixture();
    expect(await t.transfer.prepare(request)).toBe(true);
    t.database.close();
    const restarted = new SqliteDatabase(t.databasePath);
    try {
      const recovery = new SqliteGoalWorkspaceTransferRepository(restarted);
      expect(await recovery.inspectRecovery(request.operationId, now)).toMatchObject({
        state: 'prepared_requires_fresh_owner_verification',
        goalId: request.goalId,
      });
      expect(restarted.connection.prepare('SELECT workspace_id, revision FROM goals WHERE id = ?')
        .get(request.goalId)).toEqual({ workspace_id: request.fromWorkspaceId, revision: 0 });
    } finally {
      restarted.close();
    }
  });

  it('flags lease expiry, rotation and missing pinned custody as owner-review blockers', async () => {
    const t = await fixture();
    try {
      expect(await t.transfer.prepare(request)).toBe(true);
      expect((await t.transfer.inspectRecovery(request.operationId, '2026-10-09T00:20:00.000Z')).state)
        .toBe('prepared_stale_owner_review');
      t.database.connection.prepare('UPDATE goals SET lease_generation = lease_generation + 1 WHERE id = ?')
        .run(request.goalId);
      expect((await t.transfer.inspectRecovery(request.operationId, now)).state).toBe('prepared_stale_owner_review');
      t.database.connection.prepare('UPDATE goals SET lease_generation = ? WHERE id = ?').run(1, request.goalId);
      t.database.connection.prepare('UPDATE goal_workspace_retention_custody SET status = ? WHERE operation_id = ?')
        .run('revoked', request.operationId);
      expect((await t.transfer.inspectRecovery(request.operationId, now)).state).toBe('prepared_stale_owner_review');
      expect(await t.transfer.get(request.operationId)).toMatchObject({ status: 'prepared' });
    } finally {
      t.database.close();
    }
  });

  it('reports committed storage as runtime admission REQUIRED, not ADMITTED', async () => {
    const t = await fixture();
    try {
      expect(await t.transfer.prepare(request)).toBe(true);
      expect(await t.transfer.commit({
        operationId: request.operationId, goalId: request.goalId,
        leaseTokenHash: request.leaseTokenHash,
        retainedManifestSha256: request.retainedManifestSha256,
        admissionReceipt: newAdmission, now,
      })).toBe(true);
      expect(await t.transfer.inspectRecovery(request.operationId, now)).toMatchObject({
        state: 'committed_runtime_admission_required', goalId: request.goalId,
        oldWorkspaceId: request.fromWorkspaceId, newWorkspaceId: request.toWorkspaceId,
      });
      expect(await t.workspaces.get(request.fromWorkspaceId)).toMatchObject({ lifecycleKind: 'inspection' });
    } finally {
      t.database.close();
    }
  });

  it('fails closed on inconsistent post-commit custody or admission; ignores unknown operations', async () => {
    const t = await fixture();
    try {
      expect((await t.transfer.inspectRecovery('missing-operation', now)).state).toBe('missing_or_unverified');
      expect(await t.transfer.prepare(request)).toBe(true);
      expect(await t.transfer.commit({
        operationId: request.operationId, goalId: request.goalId,
        leaseTokenHash: request.leaseTokenHash,
        retainedManifestSha256: request.retainedManifestSha256,
        admissionReceipt: newAdmission, now,
      })).toBe(true);
      t.database.connection.prepare('UPDATE goal_workspace_retention_custody SET status = ? WHERE operation_id = ?')
        .run('revoked', request.operationId);
      expect((await t.transfer.inspectRecovery(request.operationId, now)).state)
        .toBe('committed_inconsistent_owner_review');
    } finally {
      t.database.close();
    }
  });


  it('durably pins exact verified-retention intent, idempotently, without changing Goal or original workspace', async () => {
    const t = await fixture();
    try {
      expect(await t.transfer.prepare(request)).toBe(true);
      expect(await t.transfer.prepare(request)).toBe(true);
      expect(await t.transfer.get(request.operationId)).toMatchObject({
        goalId: request.goalId, fromWorkspaceId: request.fromWorkspaceId,
        retainedManifestSha256: request.retainedManifestSha256, status: 'prepared',
      });
      const saved = t.database.connection.prepare('SELECT request_json FROM goal_workspace_transfer_intents WHERE operation_id = ?')
        .get(request.operationId) as { request_json: string };
      expect(saved.request_json).not.toContain(request.leaseTokenHash);
      expect(await t.workspaces.get(request.fromWorkspaceId)).toMatchObject({
        lifecycleKind: 'goal', goalId: request.goalId, branchName: request.expectedOldBranch,
      });
      expect(await t.workspaces.get(request.toWorkspaceId)).toMatchObject({ lifecycleKind: 'temporary' });
      const row = t.database.connection.prepare('SELECT workspace_id, revision FROM goals WHERE id = ?')
        .get(request.goalId) as { workspace_id: string; revision: number };
      expect(row).toEqual({ workspace_id: request.fromWorkspaceId, revision: 0 });
    } finally {
      t.database.close();
    }
  });

  it('refuses prepare without independently sealed evidence even if a custody digest exists', async () => {
    const t = await fixture();
    try {
      t.database.connection.prepare('DELETE FROM goal_workspace_retention_evidence WHERE operation_id = ?')
        .run(request.operationId);
      expect(await t.transfer.prepare(request)).toBe(false);
      expect(await t.transfer.get(request.operationId)).toBeNull();
      expect(await t.workspaces.get(request.fromWorkspaceId)).toMatchObject({ goalId: request.goalId });
    } finally { t.database.close(); }
  });

  it('rejects evidence path drift and revocation after prepare, without changing the Goal pointer', async () => {
    const t = await fixture();
    try {
      expect(await t.transfer.prepare(request)).toBe(true);
      t.database.connection.prepare('UPDATE goal_workspace_retention_evidence SET status = ? WHERE operation_id = ?')
        .run('revoked', request.operationId);
      expect((await t.transfer.inspectRecovery(request.operationId, now)).state).toBe('prepared_stale_owner_review');
      expect(await t.transfer.commit({
        operationId: request.operationId, goalId: request.goalId,
        leaseTokenHash: request.leaseTokenHash,
        retainedManifestSha256: request.retainedManifestSha256,
        admissionReceipt: newAdmission, now,
      })).toBe(false);
      expect(await t.transfer.get(request.operationId)).toMatchObject({ status: 'prepared' });
      expect(await t.workspaces.get(request.fromWorkspaceId)).toMatchObject({ goalId: request.goalId });
    } finally { t.database.close(); }
  });

  it('fails closed without independently stored custody even when a matching digest is supplied', async () => {
    const t = await fixture();
    try {
      t.database.connection.prepare(
        'DELETE FROM goal_workspace_retention_custody WHERE operation_id = ?',
      ).run(request.operationId);
      expect(await t.transfer.prepare(request)).toBe(false);
      expect(await t.transfer.get(request.operationId)).toBeNull();
      expect(await t.workspaces.get(request.fromWorkspaceId)).toMatchObject({ goalId: request.goalId });
    } finally {
      t.database.close();
    }
  });

  it('refuses post-prepare custody revocation without changing the Goal pointer or source workspace', async () => {
    const t = await fixture();
    try {
      expect(await t.transfer.prepare(request)).toBe(true);
      t.database.connection.prepare(`
        UPDATE goal_workspace_retention_custody SET status = 'revoked' WHERE operation_id = ?
      `).run(request.operationId);
      expect(await t.transfer.commit({
        operationId: request.operationId, goalId: request.goalId,
        leaseTokenHash: request.leaseTokenHash,
        retainedManifestSha256: request.retainedManifestSha256,
        admissionReceipt: newAdmission, now,
      })).toBe(false);
      expect(await t.transfer.get(request.operationId)).toMatchObject({ status: 'prepared' });
      expect(await t.workspaces.get(request.fromWorkspaceId)).toMatchObject({ goalId: request.goalId });
      expect(await t.workspaces.get(request.toWorkspaceId)).toMatchObject({ lifecycleKind: 'temporary' });
    } finally {
      t.database.close();
    }
  });

  it('rejects competing intents, owner/lease drift, revision or receipt drift without side effects', async () => {
    const t = await fixture();
    try {
      const rejected = [
        { leaseTokenHash: 'wrong' }, { leaseGeneration: 2 },
        { ownerClientId: 'another-client' }, { ownerSessionId: 'another-session' },
        { expectedRevision: 1 }, { expectedAdmissionGeneration: 11 },
        { expectedOldHead: 'd'.repeat(40) }, { expectedOldBranch: 'goal/wrong' },
        { retainedManifestSha256: 'broken' }, { fromWorkspaceId: 'another-workspace' },
        { toWorkspaceId: request.fromWorkspaceId },
      ];
      for (const changes of rejected) expect(await t.transfer.prepare({ ...request, ...changes })).toBe(false);
      expect(await t.transfer.get(request.operationId)).toBeNull();
      expect(await t.transfer.prepare(request)).toBe(true);
      expect(await t.transfer.prepare({ ...request, operationId: 'another-operation' })).toBe(false);
    } finally {
      t.database.close();
    }
  });

  it('rejects replacement with another owner or Goal without archiving any data', async () => {
    const t = await fixture();
    try {
      const replacement = (await t.workspaces.get(request.toWorkspaceId))!;
      await t.workspaces.restore(request.toWorkspaceId, { ...replacement, ownerSessionId: 'foreign-owner' });
      expect(await t.transfer.prepare(request)).toBe(false);
      expect(await t.workspaces.get(request.fromWorkspaceId)).toMatchObject({ goalId: request.goalId });
    } finally {
      t.database.close();
    }
  });

  it('rejects expired writer ownership and retains the original Goal Workspace', async () => {
    const t = await fixture();
    try {
      expect(await t.transfer.prepare({ ...request, now: '2026-10-09T00:15:00.000Z' })).toBe(false);
      expect(await t.workspaces.get(request.fromWorkspaceId)).toMatchObject({ goalId: request.goalId });
    } finally {
      t.database.close();
    }
  });

  it('atomically transfers the existing Goal pointer, writer lease and clean admission without deleting the original', async () => {
    const t = await fixture();
    try {
      expect(await t.transfer.prepare(request)).toBe(true);
      const args = {
        operationId: request.operationId,
        goalId: request.goalId,
        leaseTokenHash: request.leaseTokenHash,
        retainedManifestSha256: request.retainedManifestSha256,
        admissionReceipt: newAdmission,
        now,
      };
      expect(await t.transfer.commit(args)).toBe(true);
      expect(await t.transfer.commit(args)).toBe(true); // exact CAS idempotency
      expect(await t.transfer.commit({ ...args, leaseTokenHash: 'unauthorized-replay' })).toBe(false);
      expect(await t.transfer.get(request.operationId)).toMatchObject({ status: 'completed' });
      expect(t.database.connection.prepare(
        'SELECT status FROM goal_workspace_retention_custody WHERE operation_id = ?',
      ).get(request.operationId)).toMatchObject({ status: 'consumed' });
      expect(t.database.connection.prepare(
        'SELECT status FROM goal_workspace_retention_evidence WHERE operation_id = ?',
      ).get(request.operationId)).toMatchObject({ status: 'consumed' });
      expect(await t.workspaces.get(request.fromWorkspaceId)).toMatchObject({
        lifecycleKind: 'inspection', branchName: request.expectedOldBranch,
      });
      expect(await t.workspaces.get(request.toWorkspaceId)).toMatchObject({
        lifecycleKind: 'goal', goalId: request.goalId,
        writerLease: { generation: 1, ownerId: 'owner-client:owner-session' },
      });
      const goal = t.database.connection.prepare('SELECT workspace_id, revision, goal_key FROM goals WHERE id = ?')
        .get(request.goalId);
      expect(goal).toMatchObject({ workspace_id: request.toWorkspaceId, revision: 1, goal_key: request.goalKey });
      const receipt = await t.workspaces.getAdmissionReceipt(request.toWorkspaceId);
      expect(receipt).toMatchObject({
        workspaceId: request.toWorkspaceId, goalId: request.goalId,
        expectedWorkspaceHead: newAdmission.expectedWorkspaceHead, dirtyState: 'clean',
      });
      const oldReceipt = t.database.connection.prepare('SELECT receipt_json FROM workspace_admission_receipts WHERE workspace_id = ?')
        .get(request.fromWorkspaceId) as { receipt_json: string };
      expect(JSON.parse(oldReceipt.receipt_json)).toMatchObject({
        invalidationReason: 'goal_workspace_relocated',
      });
    } finally {
      t.database.close();
    }
  });

  it('refuses stale or corrupt post-preparation transfer evidence without moving either workspace', async () => {
    const t = await fixture();
    try {
      expect(await t.transfer.prepare(request)).toBe(true);
      const commit = {
        operationId: request.operationId,
        goalId: request.goalId,
        leaseTokenHash: request.leaseTokenHash,
        retainedManifestSha256: request.retainedManifestSha256,
        admissionReceipt: newAdmission,
        now,
      };
      expect(await t.transfer.commit({ ...commit, leaseTokenHash: 'wrong' })).toBe(false);
      expect(await t.transfer.commit({ ...commit, retainedManifestSha256: '0'.repeat(64) })).toBe(false);
      expect(await t.transfer.commit({ ...commit, admissionReceipt: { ...newAdmission, dirtyState: 'dirty' as const } })).toBe(false);
      expect(await t.transfer.commit({ ...commit, admissionReceipt: { ...newAdmission, goalId: 'foreign' } })).toBe(false);
      const goal = t.database.connection.prepare('SELECT workspace_id, revision FROM goals WHERE id = ?')
        .get(request.goalId);
      expect(goal).toEqual({ workspace_id: request.fromWorkspaceId, revision: 0 });
      expect(await t.workspaces.get(request.fromWorkspaceId)).toMatchObject({ goalId: request.goalId });
      expect(await t.workspaces.get(request.toWorkspaceId)).toMatchObject({ lifecycleKind: 'temporary' });
      expect(await t.transfer.get(request.operationId)).toMatchObject({ status: 'prepared' });
    } finally {
      t.database.close();
    }
  });

  it('fails closed when a competing worker rotates the Goal lease after preparation', async () => {
    const t = await fixture();
    try {
      expect(await t.transfer.prepare(request)).toBe(true);
      t.database.connection.prepare('UPDATE goals SET lease_generation = lease_generation + 1 WHERE id = ?').run(request.goalId);
      expect(await t.transfer.commit({
        operationId: request.operationId, goalId: request.goalId,
        leaseTokenHash: request.leaseTokenHash,
        retainedManifestSha256: manifest, admissionReceipt: newAdmission, now,
      })).toBe(false);
      expect(await t.workspaces.get(request.fromWorkspaceId)).toMatchObject({ goalId: request.goalId });
      expect(await t.workspaces.get(request.toWorkspaceId)).toMatchObject({ lifecycleKind: 'temporary' });
    } finally {
      t.database.close();
    }
  });

  it('rejects changed old-branch registration after an intent has been prepared', async () => {
    const t = await fixture();
    try {
      expect(await t.transfer.prepare(request)).toBe(true);
      t.database.connection.prepare('UPDATE workspaces SET branch_name = ? WHERE id = ?')
        .run('goal/other-owner', request.fromWorkspaceId);
      expect(await t.transfer.commit({
        operationId: request.operationId, goalId: request.goalId,
        leaseTokenHash: request.leaseTokenHash,
        retainedManifestSha256: manifest, admissionReceipt: newAdmission, now,
      })).toBe(false);
      expect(await t.transfer.get(request.operationId)).toMatchObject({ status: 'prepared' });
    } finally {
      t.database.close();
    }
  });

  it('rejects a replacement already referenced by another durable Goal', async () => {
    const t = await fixture();
    try {
      const goals = new SqliteGoalRepository(t.database);
      const competing = await goals.acquire({
        goalId: 'goal-foreign', workspaceId: request.toWorkspaceId,
        goalKey: 'foreign-goal', ownerClientId: 'other-client', ownerSessionId: 'other-session',
        objective: 'Unrelated Goal', plan: { steps: [{ id: 'keep', title: 'Keep ownership', status: 'pending' }] },
        leaseTokenHash: 'other-token-hash', leaseSeconds: 600, now,
      });
      expect(competing.acquired).toBe(true);
      expect(await t.transfer.prepare(request)).toBe(false);
      expect(await t.workspaces.get(request.fromWorkspaceId)).toMatchObject({ goalId: request.goalId });
    } finally {
      t.database.close();
    }
  });

  it('rejects an original admission invalidated after the preparation receipt', async () => {
    const t = await fixture();
    try {
      expect(await t.transfer.prepare(request)).toBe(true);
      const original = t.database.connection.prepare('SELECT receipt_json FROM workspace_admission_receipts WHERE workspace_id = ?')
        .get(request.fromWorkspaceId) as { receipt_json: string };
      const invalidated = JSON.stringify({ ...JSON.parse(original.receipt_json) as Record<string, unknown>, invalidatedAt: now });
      t.database.connection.prepare('UPDATE workspace_admission_receipts SET receipt_json = ? WHERE workspace_id = ?')
        .run(invalidated, request.fromWorkspaceId);
      expect(await t.transfer.commit({
        operationId: request.operationId, goalId: request.goalId,
        leaseTokenHash: request.leaseTokenHash,
        retainedManifestSha256: manifest, admissionReceipt: newAdmission, now,
      })).toBe(false);
      expect(await t.workspaces.get(request.fromWorkspaceId)).toMatchObject({ goalId: request.goalId });
    } finally {
      t.database.close();
    }
  });
});
