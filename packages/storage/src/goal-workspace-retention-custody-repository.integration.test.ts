import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteDatabase } from './database.js';
import { SqliteGoalRepository } from './goal-repository.js';
import { SqliteWorkspaceRepository } from './workspace-repository.js';
import {
  SqliteGoalWorkspaceRetentionCustodyRepository,
  type RecordVerifiedGoalWorkspaceCustodyRequest,
} from './goal-workspace-retention-custody-repository.js';

const roots: string[] = [];
const now = '2026-10-09T00:00:00.000Z';
const sha = 'a'.repeat(40);
const pin: RecordVerifiedGoalWorkspaceCustodyRequest = {
  operationId: 'retention-custody-1',
  goalId: 'goal-owner', expectedGoalId: 'goal-owner',
  expectedWorkspaceId: 'goal-old', newWorkspaceId: 'goal-new',
  retentionPath: '/srv/verified-retention/custody-1',
  expectedManifestSha256: 'b'.repeat(64),
  expectedHead: sha, expectedBranch: 'goal/original',
  ownerClientId: 'owner-client', ownerSessionId: 'owner-session',
  expectedRevision: 0, expectedAdmissionGeneration: 2,
  leaseGeneration: 1, leaseTokenHash: 'real-live-token-hash', pinnedAt: now,
};

afterEach(async (): Promise<void> => {
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{
  database: SqliteDatabase;
  root: string;
  custody: SqliteGoalWorkspaceRetentionCustodyRepository;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'goal-retention-custody-'));
  roots.push(root);
  const database = new SqliteDatabase(path.join(root, 'goal.sqlite'));
  const workspaces = new SqliteWorkspaceRepository(database);
  await workspaces.insert({
    id: 'project-root', displayName: 'Project', rootPath: root + '/project',
    realRootPath: root + '/project', createdAt: now, lifecycleKind: 'project',
  });
  await workspaces.insert({
    id: pin.expectedWorkspaceId, displayName: 'Original', rootPath: root + '/old',
    realRootPath: root + '/old', createdAt: now, lifecycleKind: 'goal',
    goalId: pin.goalId, parentWorkspaceId: 'project-root',
    goalWorkspaceKind: 'git_worktree', branchName: pin.expectedBranch,
  });
  await workspaces.insert({
    id: pin.newWorkspaceId, displayName: 'Replacement', rootPath: root + '/new',
    realRootPath: root + '/new', createdAt: now, lifecycleKind: 'temporary',
    parentWorkspaceId: 'project-root', ownerSessionId: pin.ownerSessionId,
  });
  const goals = new SqliteGoalRepository(database);
  expect((await goals.acquire({
    goalId: pin.goalId, workspaceId: pin.expectedWorkspaceId,
    goalKey: 'owner-backlog', ownerClientId: pin.ownerClientId,
    ownerSessionId: pin.ownerSessionId, objective: 'Preserve foreign writes',
    plan: { steps: [{ id: 'recover', title: 'Preserve source', status: 'pending' }] },
    leaseTokenHash: pin.leaseTokenHash, leaseSeconds: 600, now,
  })).acquired).toBe(true);
  await workspaces.synchronizeGoalWriterLease(
    pin.expectedWorkspaceId, pin.goalId, 'writer-lease',
    pin.ownerClientId + ':' + pin.ownerSessionId,
    1, '2026-10-09T00:10:00.000Z', now,
  );
  database.connection.prepare(`
    INSERT INTO workspace_admission_receipts
      (workspace_id, admission_generation, write_lease_generation, receipt_json, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(pin.expectedWorkspaceId, pin.expectedAdmissionGeneration, 1, JSON.stringify({
    workspaceId: pin.expectedWorkspaceId, goalId: pin.goalId,
    branchName: pin.expectedBranch, expectedWorkspaceHead: sha, observedWorkspaceHead: sha,
    dirtyState: 'dirty', admissionGeneration: pin.expectedAdmissionGeneration,
  }), now);
  return { database, root, custody: new SqliteGoalWorkspaceRetentionCustodyRepository(database) };
}

describe('SqliteGoalWorkspaceRetentionCustodyRepository (#298)', () => {
  it('stores one immutable, independently pinned metadata receipt and survives reconnect without keeping the lease token hash', async () => {
    const f = await fixture();
    try {
      expect(await f.custody.recordVerified(pin)).toBe(true);
      expect(await f.custody.recordVerified(pin)).toBe(true);
      expect(await f.custody.readPinned(pin.operationId)).toMatchObject({
        operationId: pin.operationId, expectedGoalId: pin.goalId,
        expectedManifestSha256: pin.expectedManifestSha256, leaseGeneration: 1,
      });
      const row = f.database.connection.prepare(
        'SELECT pin_json, manifest_sha256 FROM goal_workspace_retention_custody WHERE operation_id = ?',
      ).get(pin.operationId) as { pin_json: string; manifest_sha256: string };
      expect(row.pin_json).not.toContain(pin.leaseTokenHash);
      expect(row.manifest_sha256).toBe(pin.expectedManifestSha256);
      f.database.close();
      const reopened = new SqliteDatabase(path.join(f.root, 'goal.sqlite'));
      try {
        expect(await new SqliteGoalWorkspaceRetentionCustodyRepository(reopened).readPinned(pin.operationId))
          .toMatchObject({ expectedManifestSha256: pin.expectedManifestSha256 });
      } finally {
        reopened.close();
      }
    } finally {
      // Fixture DB is closed before reopening to prove restart.
    }
  });

  it('rejects wrong lease token, generation, revision, owner, branch and manifest without persisted side effects', async () => {
    const f = await fixture();
    try {
      const rejected = [
        { leaseTokenHash: 'wrong' }, { leaseGeneration: 2 },
        { expectedRevision: 1 }, { expectedAdmissionGeneration: 3 },
        { ownerClientId: 'different' }, { ownerSessionId: 'different' },
        { expectedHead: 'f'.repeat(40) }, { expectedBranch: 'goal/foreign' },
        { expectedManifestSha256: 'bad' }, { expectedGoalId: 'goal-other' },
      ];
      for (const changes of rejected) {
        expect(await f.custody.recordVerified({ ...pin, ...changes })).toBe(false);
      }
      expect(await f.custody.readPinned(pin.operationId)).toBeNull();
    } finally {
      f.database.close();
    }
  });

  it('denies competing pins and tampering with a previous immutable pin', async () => {
    const f = await fixture();
    try {
      expect(await f.custody.recordVerified(pin)).toBe(true);
      expect(await f.custody.recordVerified({
        ...pin, operationId: 'another-operation',
      })).toBe(false);
      expect(await f.custody.recordVerified({
        ...pin, expectedManifestSha256: 'c'.repeat(64),
      })).toBe(false);
      expect(await f.custody.readPinned('another-operation')).toBeNull();
    } finally {
      f.database.close();
    }
  });

  it('rejects retention path inside either workspace or containing a workspace', async () => {
    const f = await fixture();
    try {
      for (const retentionPath of [path.join(f.root, 'old', 'copies'), path.join(f.root, 'new', 'copies'), f.root]) {
        expect(await f.custody.recordVerified({ ...pin, retentionPath })).toBe(false);
      }
      expect(await f.custody.readPinned(pin.operationId)).toBeNull();
    } finally {
      f.database.close();
    }
  });

  it('denies custody after the Goal lease rotates or expires without touching the old Goal', async () => {
    const f = await fixture();
    try {
      f.database.connection.prepare('UPDATE goals SET lease_generation = 2 WHERE id = ?').run(pin.goalId);
      expect(await f.custody.recordVerified(pin)).toBe(false);
      f.database.connection.prepare('UPDATE goals SET lease_generation = 1 WHERE id = ?').run(pin.goalId);
      expect(await f.custody.recordVerified({ ...pin, pinnedAt: '2026-10-09T00:20:00.000Z' })).toBe(false);
      expect((await new SqliteWorkspaceRepository(f.database).get(pin.expectedWorkspaceId))?.goalId).toBe(pin.goalId);
    } finally {
      f.database.close();
    }
  });
});
