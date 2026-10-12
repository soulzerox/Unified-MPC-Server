import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteDatabase } from './database.js';
import { SqliteGoalRepository } from './goal-repository.js';
import { SqliteWorkspaceRepository } from './workspace-repository.js';
import {
  SqliteGoalWorkspaceRetentionEvidenceRepository,
  type SealGoalWorkspaceEvidenceRequest,
} from './goal-workspace-retention-evidence-repository.js';

const dirs: string[] = [];
const now = '2026-10-09T00:00:00.000Z';
const evidence: SealGoalWorkspaceEvidenceRequest = {
  operationId: 'operation-sealed', expectedGoalId: 'goal-owned',
  expectedWorkspaceId: 'old-owned', newWorkspaceId: 'new-owned',
  retentionPath: '/srv/immutable-retention/bundle-sealed',
  expectedHead: 'a'.repeat(40), expectedBranch: 'goal/owned',
  expectedManifestSha256: 'b'.repeat(64),
  ownerClientId: 'client-owned', ownerSessionId: 'session-owned',
  expectedRevision: 0, expectedAdmissionGeneration: 4,
  leaseGeneration: 1, leaseTokenHash: 'live-lease-token-hash', now,
};

afterEach(async (): Promise<void> => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function setup(): Promise<{
  root: string; db: SqliteDatabase; store: SqliteGoalWorkspaceRetentionEvidenceRepository;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'goal-sealed-evidence-'));
  dirs.push(root);
  const db = new SqliteDatabase(path.join(root, 'state.sqlite'));
  const workspaces = new SqliteWorkspaceRepository(db);
  await workspaces.insert({
    id: 'project', displayName: 'Project',
    rootPath: path.join(root, 'project'), realRootPath: path.join(root, 'project'),
    createdAt: now, lifecycleKind: 'project',
  });
  await workspaces.insert({
    id: evidence.expectedWorkspaceId, displayName: 'Original',
    rootPath: path.join(root, 'old'), realRootPath: path.join(root, 'old'),
    createdAt: now, lifecycleKind: 'goal', goalId: evidence.expectedGoalId,
    parentWorkspaceId: 'project', goalWorkspaceKind: 'git_worktree',
    branchName: evidence.expectedBranch,
  });
  await workspaces.insert({
    id: evidence.newWorkspaceId, displayName: 'Clean replacement',
    rootPath: path.join(root, 'new'), realRootPath: path.join(root, 'new'),
    createdAt: now, lifecycleKind: 'temporary',
    parentWorkspaceId: 'project', ownerSessionId: evidence.ownerSessionId,
  });
  const goals = new SqliteGoalRepository(db);
  expect((await goals.acquire({
    goalId: evidence.expectedGoalId, workspaceId: evidence.expectedWorkspaceId,
    goalKey: 'owner-backlog', ownerClientId: evidence.ownerClientId,
    ownerSessionId: evidence.ownerSessionId, objective: 'Preserve unrelated edits',
    plan: { steps: [{ id: 'seal', title: 'Seal retention', status: 'pending' }] },
    leaseTokenHash: evidence.leaseTokenHash, leaseSeconds: 600, now,
  })).acquired).toBe(true);
  await workspaces.synchronizeGoalWriterLease(
    evidence.expectedWorkspaceId, evidence.expectedGoalId, 'live-lease-id',
    evidence.ownerClientId + ':' + evidence.ownerSessionId,
    evidence.leaseGeneration, '2026-10-09T00:10:00.000Z', now,
  );
  db.connection.prepare(`
    INSERT INTO workspace_admission_receipts (
      workspace_id, admission_generation, write_lease_generation, receipt_json, updated_at
    ) VALUES (?, ?, ?, ?, ?)
  `).run(evidence.expectedWorkspaceId, evidence.expectedAdmissionGeneration,
    evidence.leaseGeneration, JSON.stringify({
      goalId: evidence.expectedGoalId, workspaceId: evidence.expectedWorkspaceId,
      branchName: evidence.expectedBranch,
      expectedWorkspaceHead: evidence.expectedHead,
      observedWorkspaceHead: evidence.expectedHead,
    }), now);
  return { root, db, store: new SqliteGoalWorkspaceRetentionEvidenceRepository(db) };
}

describe('Goal Workspace retention evidence durable repository #298', () => {
  it('persists the trusted evidence outside a retention tree, survives restart, and never persists the lease token hash', async () => {
    const f = await setup();
    expect(await f.store.recordSealed(evidence)).toBe(true);
    expect(await f.store.recordSealed(evidence)).toBe(true);
    expect(await f.store.getByOperation(evidence.operationId)).toMatchObject({
      operationId: evidence.operationId, expectedGoalId: evidence.expectedGoalId,
      expectedManifestSha256: evidence.expectedManifestSha256,
    });
    const row = f.db.connection.prepare('SELECT evidence_json, status FROM goal_workspace_retention_evidence WHERE operation_id = ?')
      .get(evidence.operationId) as { evidence_json: string; status: string };
    expect(row.evidence_json).not.toContain(evidence.leaseTokenHash);
    expect(row.status).toBe('sealed');
    f.db.close();
    const resumed = new SqliteDatabase(path.join(f.root, 'state.sqlite'));
    try {
      expect(await new SqliteGoalWorkspaceRetentionEvidenceRepository(resumed).getByOperation(evidence.operationId))
        .toMatchObject({ expectedManifestSha256: evidence.expectedManifestSha256 });
    } finally { resumed.close(); }
  });

  it('refuses stale Goal owner, lease, admission, manifest and branch before persisting evidence', async () => {
    const f = await setup();
    try {
      for (const patch of [
        { ownerClientId: 'wrong' }, { ownerSessionId: 'wrong' },
        { leaseTokenHash: 'wrong' }, { leaseGeneration: 2 },
        { expectedRevision: 1 }, { expectedAdmissionGeneration: 3 },
        { expectedHead: 'd'.repeat(40) }, { expectedBranch: 'goal/foreign' },
        { expectedManifestSha256: 'invalid' },
        { newWorkspaceId: evidence.expectedWorkspaceId },
      ]) {
        expect(await f.store.recordSealed({ ...evidence, ...patch })).toBe(false);
      }
      expect(await f.store.getByOperation(evidence.operationId)).toBeNull();
    } finally { f.db.close(); }
  });

  it('rejects competing or modified operation manifests and duplicate active Goal evidence', async () => {
    const f = await setup();
    try {
      expect(await f.store.recordSealed(evidence)).toBe(true);
      expect(await f.store.recordSealed({ ...evidence, operationId: 'another-operation' })).toBe(false);
      expect(await f.store.recordSealed({ ...evidence, expectedManifestSha256: 'c'.repeat(64) })).toBe(false);
      expect(await f.store.getByOperation('another-operation')).toBeNull();
    } finally { f.db.close(); }
  });

  it('rejects retention path inside either workspace or containing the original', async () => {
    const f = await setup();
    try {
      for (const retentionPath of [
        path.join(f.root, 'old', 'retained'), path.join(f.root, 'new', 'retained'), f.root,
      ]) {
        expect(await f.store.recordSealed({ ...evidence, retentionPath })).toBe(false);
      }
      expect(await f.store.getByOperation(evidence.operationId)).toBeNull();
    } finally { f.db.close(); }
  });

  it('fails closed for expired ownership and a revoked or internally inconsistent evidence row', async () => {
    const f = await setup();
    try {
      expect(await f.store.recordSealed({ ...evidence, now: '2026-10-09T00:15:00.000Z' })).toBe(false);
      expect(await f.store.recordSealed(evidence)).toBe(true);
      f.db.connection.prepare('UPDATE goal_workspace_retention_evidence SET manifest_sha256 = ? WHERE operation_id = ?')
        .run('c'.repeat(64), evidence.operationId);
      expect(await f.store.getByOperation(evidence.operationId)).toBeNull();
      f.db.connection.prepare('UPDATE goal_workspace_retention_evidence SET manifest_sha256 = ?, status = ? WHERE operation_id = ?')
        .run(evidence.expectedManifestSha256, 'revoked', evidence.operationId);
      expect(await f.store.getByOperation(evidence.operationId)).toBeNull();
    } finally { f.db.close(); }
  });
});
