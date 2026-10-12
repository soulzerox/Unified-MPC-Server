import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SqliteDatabase,
  SqliteGoalRepository,
  SqliteWorkspaceRepository,
  SqliteGoalWorkspaceRetentionEvidenceRepository,
  SqliteGoalWorkspaceTransferRepository,
} from '@unified-mpc/storage';
import { GitService } from '@unified-mpc/application';
import { createStdioMcpRuntime } from './stdio-mcp-runtime.js';

const roots: string[] = [];
afterEach(async (): Promise<void> => {
  await Promise.all(roots.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('native Goal relocation storage CAS through trusted STDIO host #322', () => {
  it('refuses forged and replayed approvals, then moves the Goal and admits the replacement exactly once', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'native-goal-relocation-'));
    roots.push(root);
    const source = path.join(root, 'repository');
    const oldPath = path.join(root, 'original-goal');
    const nextPath = path.join(root, 'clean-destination');
    const dataPath = path.join(root, 'native-data');
    await mkdir(source);
    const git = (cwd: string, ...args: string[]): string =>
      execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    git(source, 'init', '-q', '-b', 'main');
    git(source, 'config', 'user.name', 'Integration Test');
    git(source, 'config', 'user.email', 'test@example.invalid');
    await writeFile(path.join(source, 'tracked.txt'), 'committed\n');
    git(source, 'add', 'tracked.txt');
    git(source, 'commit', '-qm', 'base');
    git(source, 'worktree', 'add', '-qb', 'goal/native-transfer', oldPath, 'HEAD');
    git(source, 'worktree', 'add', '-qb', 'goal/native-target', nextPath, 'HEAD');
    await writeFile(path.join(oldPath, 'tracked.txt'), 'foreign tracked bytes\n');
    await writeFile(path.join(oldPath, 'foreign-untracked.txt'), 'foreign untracked bytes\n');
    const clientId = 'trusted-transfer-host';
    const sessionId = 'trusted-transfer-session';
    const actor = { clientId, sessionId };
    const goalId = 'goal-real-transfer-test';
    const sourceId = 'goal-original-transfer-worktree';
    const newId = 'goal-new-transfer-worktree';
    const operationId = 'host-transferred-operation';
    const secret = 'transfer-owner-secret-not-stored';
    const now = new Date().toISOString();
    const project = {
      id: 'project-transfer-parent', displayName: 'Project', rootPath: source,
      realRootPath: source, createdAt: now, lifecycleKind: 'project' as const,
    };
    const initial = new SqliteDatabase(path.join(dataPath, 'unified-mpc.sqlite'));
    await new SqliteWorkspaceRepository(initial).insert(project);
    initial.close();
    const runtime = createStdioMcpRuntime(dataPath, project, true, {
      fullBypassAll: true,
      checkpointEncryptionKey: Buffer.alloc(32, 0x51),
      runtimeAdmissionIdentity: {
        runtimeDeploymentId: 'integration-deploy',
        runtimeGeneration: 'integration-generation',
        runtimeBuildVersion: 'test',
        runtimeBuildCommit: '0000000000000000000000000000000000000000',
        runtimeBuildDirty: false,
        runtimeProtocolGeneration: 1,
        runtimeStartedAt: now,
      },
      trustedGoalRelocationActorProvider: () => actor,
      goalRelocationExactActionApproval: async () => true,
    });
    const db = new SqliteDatabase(path.join(dataPath, 'unified-mpc.sqlite'));
    try {
      await runtime.recoveryReady;
      const workspaces = new SqliteWorkspaceRepository(db);
      await workspaces.insert({
        id: sourceId, displayName: 'Original mixed-dirty Goal',
        rootPath: oldPath, realRootPath: oldPath, createdAt: now,
        lifecycleKind: 'goal', goalId, parentWorkspaceId: project.id,
        goalWorkspaceKind: 'git_worktree', branchName: 'goal/native-transfer',
      });
      await workspaces.insert({
        id: newId, displayName: 'Clean destination', rootPath: nextPath,
        realRootPath: nextPath, createdAt: now, lifecycleKind: 'temporary',
        parentWorkspaceId: project.id, ownerSessionId: sessionId,
      });
      const goals = new SqliteGoalRepository(db);
      const acquired = await goals.acquire({
        goalId, goalKey: 'real-transfer-integration', workspaceId: sourceId,
        ownerClientId: clientId, ownerSessionId: sessionId,
        objective: 'Relocate onto the clean replacement worktree', plan: { steps: [] },
        leaseTokenHash: createHash('sha256').update(secret).digest('hex'),
        now, leaseSeconds: 600,
      });
      expect(acquired.acquired).toBe(true);
      const liveGoal = await goals.getById(goalId);
      expect(liveGoal?.leaseGeneration).toBe(1);
      await workspaces.synchronizeGoalWriterLease(
        sourceId, goalId, 'host-transfer-lease-id', clientId + ':' + sessionId,
        1, liveGoal!.leaseExpiresAt!, now,
      );
      const observed = await new GitService(workspaces).observeWorkspace({
        clientId, clientName: 'Trusted Host Test',
      }, sourceId);
      expect(observed.ok).toBe(true);
      if (!observed.ok) return;
      const snapshot = observed.value;
      db.connection.prepare(`
        INSERT INTO workspace_admission_receipts (
          workspace_id, admission_generation, write_lease_generation, receipt_json, updated_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(sourceId, 1, 1, JSON.stringify({
        admissionId: 'transfer-host-admission', workspaceKind: 'git', createdAt: now,
        runtimeDeploymentId: 'integration-deploy',
        runtimeGeneration: 'integration-generation', runtimeBuildVersion: 'test',
        runtimeBuildCommit: '0000000000000000000000000000000000000000',
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
        writeLeaseGeneration: 1, admissionGeneration: 1, dirtyState: 'dirty',
      }), now);
      const request = {
        operationId, goalId, oldWorkspaceId: sourceId,
        newWorkspaceId: newId, actor, leaseToken: secret,
      };
      expect(runtime.goalRetentionEvidenceSealing).toBeDefined();
      expect(runtime.goalCustodyAttestation).toBeDefined();
      const sealed = await runtime.goalRetentionEvidenceSealing?.sealAndRecord(request);
      if (sealed !== undefined && !sealed.ok) throw new Error(sealed.error.message);
      const evidence = await new SqliteGoalWorkspaceRetentionEvidenceRepository(db).getByOperation(operationId);
      expect(await runtime.goalCustodyAttestation?.verifyAndPin(request))
        .toMatchObject({ ok: true, value: { status: 'verified_and_pinned' } });
      const receiptCount = (): number =>
        (db.connection.prepare(
          'SELECT COUNT(*) AS n FROM workspace_admission_receipts WHERE workspace_id = ?',
        ).get(newId) as { n: number }).n;
      const transfer = new SqliteGoalWorkspaceTransferRepository(db);
      const intent = {
        operationId, goalId, goalKey: 'real-transfer-integration',
        fromWorkspaceId: sourceId, toWorkspaceId: newId,
        expectedRevision: liveGoal!.revision, expectedAdmissionGeneration: 1,
        leaseGeneration: 1,
        leaseTokenHash: createHash('sha256').update(secret).digest('hex'),
        ownerClientId: clientId, ownerSessionId: sessionId,
        expectedOldHead: snapshot.head, expectedOldBranch: snapshot.branch,
        expectedNewHead: git(nextPath, 'rev-parse', 'HEAD'),
        retainedManifestSha256: evidence?.expectedManifestSha256 ?? '',
        now,
      };
      const forge = (approvalId: string): Parameters<typeof transfer.prepare>[0]['approval'] => ({
        approvalId, goalId, operationId, action: 'relocate_goal',
        fromWorkspaceId: sourceId, toWorkspaceId: newId,
        ownerClientId: clientId, ownerSessionId: sessionId,
        issuedAt: Date.now(), expiresAt: Date.now() + 120_000,
      });
      // Forged: a capability the host fence never minted and the durable ledger
      // never recorded must not reach any storage CAS.
      expect(await transfer.prepare({ ...intent, approval: forge(randomUUID()) })).toBe(false);
      expect((await goals.getById(goalId))?.workspaceId).toBe(sourceId);
      expect(receiptCount()).toBe(0);
      // Happy path: the real runtime fence mints, records and spends the
      // capability inside the same transaction that moves the Goal.
      const relocated = await runtime.goalWorkspaceRelocation?.transfer(request);
      if (relocated !== undefined && !relocated.ok) throw new Error(relocated.error.message);
      expect(relocated)
        .toMatchObject({ ok: true, value: { status: 'storage_committed_runtime_admission_required' } });
      expect((await goals.getById(goalId))?.workspaceId).toBe(newId);
      expect(receiptCount()).toBe(1);
      const spent = db.connection.prepare(
        "SELECT approval_id FROM goal_relocation_approvals WHERE action = 'relocate_goal'",
      ).get() as { approval_id: string } | undefined;
      expect(spent).toBeDefined();
      // Replayed: the spent capability is single use, so re-presenting it buys
      // no second admission.
      expect(await transfer.prepare({ ...intent, approval: forge(spent!.approval_id) })).toBe(false);
      expect(receiptCount()).toBe(1);
    } finally {
      await runtime.close();
      db.close();
    }
  });
});