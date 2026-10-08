import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SqliteDatabase,
  SqliteGoalRepository,
  SqliteWorkspaceRepository,
  SqliteGoalWorkspaceRetentionEvidenceRepository,
  SqliteGoalWorkspaceRetentionCustodyRepository,
} from '@unified-mpc/storage';
import { GitService } from '@unified-mpc/application';
import { createStdioMcpRuntime } from './stdio-mcp-runtime.js';

const roots: string[] = [];
afterEach(async (): Promise<void> => {
  await Promise.all(roots.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('native Goal retention full seal/readback flow #298', () => {
  it('preserves real mixed Git worktree bytes and independently pins SQLite evidence without moving the Goal', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'native-goal-retention-real-'));
    roots.push(root);
    const source = path.join(root, 'repository');
    const oldPath = path.join(root, 'original-goal');
    const nextPath = path.join(root, 'clean-destination');
    const dataPath = path.join(root, 'native-data');
    await mkdir(source);
    await mkdir(nextPath);
    const git = (cwd: string, ...args: string[]): string =>
      execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    git(source, 'init', '-q', '-b', 'main');
    git(source, 'config', 'user.name', 'Integration Test');
    git(source, 'config', 'user.email', 'test@example.invalid');
    await writeFile(path.join(source, 'tracked.txt'), 'committed\n');
    git(source, 'add', 'tracked.txt');
    git(source, 'commit', '-qm', 'base');
    git(source, 'worktree', 'add', '-qb', 'goal/native-retention', oldPath, 'HEAD');
    await writeFile(path.join(oldPath, 'tracked.txt'), 'foreign tracked bytes\n');
    await writeFile(path.join(oldPath, 'foreign-untracked.txt'), 'foreign untracked bytes\n');

    const clientId = 'trusted-real-host';
    const sessionId = 'trusted-real-session';
    const actor = { clientId, sessionId };
    const goalId = 'goal-real-retention-test';
    const sourceId = 'goal-original-worktree';
    const newId = 'goal-new-unowned-worktree';
    const operationId = 'host-verified-operation';
    const secret = 'verified-owner-secret-not-stored';
    const now = new Date().toISOString();
    const project = {
      id: 'project-parent', displayName: 'Project', rootPath: source,
      realRootPath: source, createdAt: now, lifecycleKind: 'project' as const,
    };
    const initial = new SqliteDatabase(path.join(dataPath, 'unified-mpc.sqlite'));
    await new SqliteWorkspaceRepository(initial).insert(project);
    initial.close();
    const approvals: string[] = [];
    const runtime = createStdioMcpRuntime(dataPath, project, true, {
      fullBypassAll: true,
      checkpointEncryptionKey: Buffer.alloc(32, 0x46),
      trustedGoalRelocationActorProvider: () => actor,
      goalRelocationExactActionApproval: async approved => {
        approvals.push(approved.toolName);
        return true;
      },
    });
    const db = new SqliteDatabase(path.join(dataPath, 'unified-mpc.sqlite'));
    try {
      await runtime.recoveryReady;
      const workspaces = new SqliteWorkspaceRepository(db);
      await workspaces.insert({
        id: sourceId, displayName: 'Original mixed-dirty Goal',
        rootPath: oldPath, realRootPath: oldPath, createdAt: now,
        lifecycleKind: 'goal', goalId, parentWorkspaceId: project.id,
        goalWorkspaceKind: 'git_worktree', branchName: 'goal/native-retention',
      });
      await workspaces.insert({
        id: newId, displayName: 'Clean destination', rootPath: nextPath,
        realRootPath: nextPath, createdAt: now, lifecycleKind: 'temporary',
        parentWorkspaceId: project.id, ownerSessionId: sessionId,
      });
      const goals = new SqliteGoalRepository(db);
      const acquired = await goals.acquire({
        goalId, goalKey: 'real-retention-integration', workspaceId: sourceId,
        ownerClientId: clientId, ownerSessionId: sessionId,
        objective: 'Preserve both foreign files', plan: { steps: [] },
        leaseTokenHash: createHash('sha256').update(secret).digest('hex'),
        now, leaseSeconds: 600,
      });
      expect(acquired.acquired).toBe(true);
      const liveGoal = await goals.getById(goalId);
      expect(liveGoal?.leaseGeneration).toBe(1);
      await workspaces.synchronizeGoalWriterLease(
        sourceId, goalId, 'host-lease-id', clientId + ':' + sessionId,
        1, liveGoal!.leaseExpiresAt!, now,
      );
      const observed = await new GitService(workspaces).observeWorkspace({
        clientId, clientName: 'Trusted Host Test',
      }, sourceId);
      expect(observed.ok).toBe(true);
      if (!observed.ok) return;
      expect(observed.value.statusEntries).toHaveLength(2);
      const snapshot = observed.value;
      const receipt = {
        admissionId: 'real-host-admission', workspaceKind: 'git',
        createdAt: now, runtimeDeploymentId: 'integration-deploy',
        runtimeGeneration: 'integration-generation', runtimeBuildVersion: 'test',
        runtimeBuildDirty: false, runtimeProtocolGeneration: 1,
        runtimeStartedAt: now, workflowVersion: 1,
        workspaceId: sourceId, goalId, projectId: project.id,
        branchName: snapshot.branch, expectedWorkspaceHead: snapshot.head,
        observedWorkspaceHead: snapshot.head,
        repositoryIdentity: snapshot.repositoryIdentity,
        gitCommonDirIdentity: snapshot.gitCommonDirIdentity,
        worktreeIdentity: snapshot.worktreeIdentity,
        dirtyFingerprint: snapshot.dirtyFingerprint,
        stagedFingerprint: snapshot.stagedFingerprint,
        writeLeaseGeneration: 1, admissionGeneration: 1,
        dirtyState: 'dirty',
      };
      db.connection.prepare(`
        INSERT INTO workspace_admission_receipts (
          workspace_id, admission_generation, write_lease_generation, receipt_json, updated_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(sourceId, 1, 1, JSON.stringify(receipt), now);
      expect(runtime.goalRetentionEvidenceSealing).toBeDefined();
      expect(runtime.goalCustodyAttestation).toBeDefined();
      const request = {
        operationId, goalId, oldWorkspaceId: sourceId,
        newWorkspaceId: newId, actor, leaseToken: secret,
      };
      const sealed = await runtime.goalRetentionEvidenceSealing?.sealAndRecord(request);
      if (sealed !== undefined && !sealed.ok) throw new Error(sealed.error.message);
      expect(sealed).toMatchObject({
        ok: true, value: { status: 'sealed_evidence_requires_custody_attestation' },
      });
      const evidence = await new SqliteGoalWorkspaceRetentionEvidenceRepository(db).getByOperation(operationId);
      expect(evidence?.expectedManifestSha256).toBe(sealed?.ok ? sealed.value.manifestSha256 : null);
      expect(evidence?.retentionPath).toContain('goal-retention-evidence');
      const attested = await runtime.goalCustodyAttestation?.verifyAndPin(request);
      expect(attested).toMatchObject({ ok: true, value: { status: 'verified_and_pinned' } });
      expect(await new SqliteGoalWorkspaceRetentionCustodyRepository(db).readPinned(operationId))
        .toMatchObject({ expectedManifestSha256: evidence?.expectedManifestSha256 });
      expect(approvals).toEqual(['goal_workspace_custody_attest', 'goal_workspace_custody_attest']);
      expect((await goals.getById(goalId))?.workspaceId).toBe(sourceId);
      expect(await readFile(path.join(oldPath, 'tracked.txt'), 'utf8')).toBe('foreign tracked bytes\n');
      expect(await readFile(path.join(oldPath, 'foreign-untracked.txt'), 'utf8')).toBe('foreign untracked bytes\n');
    } finally {
      await runtime.close();
      db.close();
    }
  });
});
