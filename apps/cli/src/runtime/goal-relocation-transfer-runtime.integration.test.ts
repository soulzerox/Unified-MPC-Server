import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SqliteDatabase,
  SqliteGoalRepository,
  SqliteGoalRelocationApprovalRepository,
  SqliteWorkspaceRepository,
  SqliteGoalWorkspaceRetentionEvidenceRepository,
  SqliteGoalWorkspaceTransferRepository,
} from '@unified-mpc/storage';
import { GitService, type GoalRelocationHostApproval, type GoalRelocationRuntimeRequest } from '@unified-mpc/application';
import { createStdioMcpRuntime } from './stdio-mcp-runtime.js';

const roots: string[] = [];
afterEach(async (): Promise<void> => {
  await Promise.all(roots.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

interface TransferFixture {
  readonly root: string;
  readonly oldPath: string;
  readonly git: (cwd: string, ...args: string[]) => string;
  readonly runtime: ReturnType<typeof createStdioMcpRuntime>;
  readonly db: SqliteDatabase;
  readonly goals: SqliteGoalRepository;
  readonly transfer: SqliteGoalWorkspaceTransferRepository;
  readonly request: GoalRelocationRuntimeRequest;
  readonly intent: Record<string, unknown>;
  readonly forge: (approvalId: string) => GoalRelocationHostApproval;
  readonly receiptCount: () => number;
  /** Simulate a process crash and bring the same database back up. */
  restart(): Promise<TransferFixture>;
}

/** Builds a real mixed-dirty Goal, a sealed retention bundle and a pinned custody row. */
async function transferFixture(): Promise<TransferFixture> {
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
  const open = (): ReturnType<typeof createStdioMcpRuntime> => createStdioMcpRuntime(dataPath, project, true, {
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
  let runtime = open();
  let db = new SqliteDatabase(path.join(dataPath, 'unified-mpc.sqlite'));
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
  const transferOf = (database: SqliteDatabase): SqliteGoalWorkspaceTransferRepository =>
    new SqliteGoalWorkspaceTransferRepository(database);
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
  if (!observed.ok) throw new Error(observed.error.message);
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
  const request: GoalRelocationRuntimeRequest = {
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
  const receiptCount = (): number => (db.connection.prepare(
    'SELECT COUNT(*) AS n FROM workspace_admission_receipts WHERE workspace_id = ?',
  ).get(newId) as { n: number }).n;
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
  const forge = (approvalId: string): GoalRelocationHostApproval => ({
    approvalId, goalId, operationId, action: 'relocate_goal',
    fromWorkspaceId: sourceId, toWorkspaceId: newId,
    ownerClientId: clientId, ownerSessionId: sessionId,
    issuedAt: Date.now(), expiresAt: Date.now() + 120_000,
  });
  const fixture: TransferFixture = {
    root, oldPath, git, request, intent, forge, receiptCount,
    get runtime() { return runtime; },
    get db() { return db; },
    get goals() { return new SqliteGoalRepository(db); },
    get transfer() { return transferOf(db); },
    restart: async (): Promise<TransferFixture> => {
      await runtime.close();
      db.close();
      runtime = open();
      db = new SqliteDatabase(path.join(dataPath, 'unified-mpc.sqlite'));
      return fixture;
    },
  };
  return fixture;
}

describe('native Goal relocation storage CAS through trusted STDIO host #322', () => {
  it('refuses forged and replayed approvals, then moves the Goal and admits the replacement exactly once', async () => {
    const f = await transferFixture();
    const { runtime, db, goals, transfer, request, intent, forge, receiptCount } = f;
    try {
      // Forged: a capability the host fence never minted and the durable ledger
      // never recorded must not reach any storage CAS.
      expect(await transfer.prepare({ ...intent, approval: forge(randomUUID()) })).toBe(false);
      expect((await goals.getById(request.goalId))?.workspaceId).toBe(request.oldWorkspaceId);
      expect(receiptCount()).toBe(0);
      // Happy path: the real runtime fence mints, records and spends the
      // capability inside the same transaction that moves the Goal.
      const relocated = await runtime.goalWorkspaceRelocation?.transfer(request);
      if (relocated !== undefined && !relocated.ok) throw new Error(relocated.error.message);
      expect(relocated)
        .toMatchObject({ ok: true, value: { status: 'storage_committed_runtime_admission_required' } });
      expect((await goals.getById(request.goalId))?.workspaceId).toBe(request.newWorkspaceId);
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

describe('Goal relocation restart reconciliation through trusted STDIO host #323', () => {
  it('resumes a crash between prepare and commit through the real restarted host, then reports committed runtime admission', async () => {
    const f = await transferFixture();
    // Crash: a genuine, host-recorded approval is spent by `prepare`, and the
    // process dies before the commit CAS reaches storage.
    const approval = f.forge('crash-between-prepare-and-commit');
    expect(await new SqliteGoalRelocationApprovalRepository(f.db).record(approval)).toBe(true);
    expect(await f.transfer.prepare({ ...f.intent, approval } as Parameters<typeof f.transfer.prepare>[0])).toBe(true);
    expect(f.receiptCount()).toBe(0);
    expect((await f.goals.getById(f.request.goalId))?.workspaceId).toBe(f.request.oldWorkspaceId);

    const restarted = await f.restart();
    expect((await restarted.transfer.inspectRecovery(f.request.operationId, new Date().toISOString())).state)
      .toBe('prepared_requires_fresh_owner_verification');
    expect(restarted.receiptCount()).toBe(0);
    // Resume: a FRESH single-use host approval plus full custody, retained
    // bytes and Git re-verification, then the commit CAS.
    expect(await restarted.runtime.goalWorkspaceRelocation?.reconcile(f.request))
      .toMatchObject({ ok: true, value: { status: 'storage_committed_runtime_admission_required' } });
    expect((await restarted.goals.getById(f.request.goalId))?.workspaceId).toBe(f.request.newWorkspaceId);
    expect(restarted.receiptCount()).toBe(1);
    // The foreign-dirty original is retained as inspection, never adopted.
    expect(await readFile(path.join(f.oldPath, 'tracked.txt'), 'utf8')).toBe('foreign tracked bytes\n');
    expect(await readFile(path.join(f.oldPath, 'foreign-untracked.txt'), 'utf8')).toBe('foreign untracked bytes\n');
    expect(f.git(f.oldPath, 'rev-parse', 'HEAD')).toBe(f.intent.expectedOldHead);
    // Reconciling again is idempotent and still never reports ADMITTED.
    expect(await restarted.runtime.goalWorkspaceRelocation?.reconcile(f.request))
      .toMatchObject({ ok: true, value: { status: 'storage_committed_runtime_admission_required' } });
    expect(restarted.receiptCount()).toBe(1);
    await restarted.runtime.close();
    restarted.db.close();
  }, 60_000);

  it('fails closed when the trusted custody pin is gone at restart', async () => {
    const f = await transferFixture();
    f.db.connection.prepare('DELETE FROM goal_workspace_retention_custody WHERE operation_id = ?')
      .run(f.request.operationId);
    expect((await f.transfer.inspectRecovery(f.request.operationId, new Date().toISOString())).state)
      .toBe('missing_or_unverified');
    const reconciled = await f.runtime.goalWorkspaceRelocation?.reconcile(f.request);
    expect(reconciled?.ok).toBe(false);
    expect((await f.goals.getById(f.request.goalId))?.workspaceId).toBe(f.request.oldWorkspaceId);
    expect(f.receiptCount()).toBe(0);
    await f.runtime.close();
    f.db.close();
  }, 60_000);

  it('fails closed on restart when the pinned retained digest no longer matches the intent', async () => {
    const f = await transferFixture();
    f.db.connection.prepare('UPDATE goal_workspace_retention_custody SET manifest_sha256 = ? WHERE operation_id = ?')
      .run('f'.repeat(64), f.request.operationId);
    expect((await f.transfer.inspectRecovery(f.request.operationId, new Date().toISOString())).state)
      .toBe('missing_or_unverified');
    expect((await f.runtime.goalWorkspaceRelocation?.reconcile(f.request))?.ok).toBe(false);
    expect((await f.goals.getById(f.request.goalId))?.workspaceId).toBe(f.request.oldWorkspaceId);
    expect(f.receiptCount()).toBe(0);
    await f.runtime.close();
    f.db.close();
  }, 60_000);
});
