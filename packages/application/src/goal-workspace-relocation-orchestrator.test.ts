import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appError, err, ok, type GoalRecord, type WorkspaceAdmissionReceipt } from '@unified-mpc/domain';
import type { GoalWorkspaceTransferRecoveryObservation } from '@unified-mpc/storage';
import type { GitStatusResult, GitWorkspaceSnapshot } from '@unified-mpc/git';
import type { Workspace } from '@unified-mpc/workspace';
import { sealMixedDirtyGoalWorkspace, type GoalWorkspaceRetentionGitPort, type GoalWorkspaceRetentionManifest } from './goal-workspace-retention-service.js';
import {
  GoalWorkspaceRelocationOrchestrator, type GoalRelocationOrchestratorPorts,
  type GoalRelocationHostApproval,
} from './goal-workspace-relocation-orchestrator.js';

const head = 'a'.repeat(40);
const nextHead = 'b'.repeat(40);
const leaseToken = 'the-owner-lease-token';
const operationId = 'relocation-op-1';
const goalId = 'goal-existing';
const oldId = 'old-goal-workspace';
const newId = 'new-temp-workspace';
const actor = { clientId: 'owner-client', sessionId: 'owner-session' };
const entries: GitStatusResult['entries'] = [
  { path: 'src/dirty.ts', kind: 'modified', indexStatus: ' ', worktreeStatus: 'M' },
  { path: 'tests/new.test.ts', kind: 'untracked', indexStatus: '?', worktreeStatus: '?' },
];
const roots: string[] = [];
afterEach(async (): Promise<void> => {
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

interface Fixture {
  readonly service: GoalWorkspaceRelocationOrchestrator;
  readonly request: Parameters<GoalWorkspaceRelocationOrchestrator['transfer']>[0];
  readonly bundle: GoalWorkspaceRetentionManifest;
  readonly oldRoot: string;
  readonly newRoot: string;
  readonly state: {
    allowed: boolean;
    prepareCount: number;
    commitCount: number;
    revalidationDrift: boolean;
    dirtyReplacement: boolean;
    missingCheckpoint: boolean;
    custodyOwnerDrift: boolean;
    approvalIssued: number;
    lastApproval: GoalRelocationHostApproval | null;
    lastExpectedNewHead: string | undefined;
    goal: GoalRecord;
    old: Workspace;
    next: Workspace;
    oldReceipt: WorkspaceAdmissionReceipt;
    newReceipt: WorkspaceAdmissionReceipt | null;
  };
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'umcp-relocate-'));
  roots.push(root);
  const oldRoot = path.join(root, 'old');
  const newRoot = path.join(root, 'new');
  await mkdir(path.join(oldRoot, 'src'), { recursive: true });
  await mkdir(path.join(oldRoot, 'tests'), { recursive: true });
  await mkdir(newRoot);
  await writeFile(path.join(oldRoot, 'src/dirty.ts'), 'const dirty = 1;\n');
  await writeFile(path.join(oldRoot, 'tests/new.test.ts'), 'test();\n');
  const oldSnap: GitWorkspaceSnapshot = {
    repositoryIdentity: 'same-repo', gitCommonDirIdentity: 'common-git',
    worktreeIdentity: 'worktree-old', branch: 'goal/old',
    head, statusEntries: entries, dirtyFingerprint: 'dirty:old', stagedFingerprint: 'none',
  };
  const cleanSnap: GitWorkspaceSnapshot = {
    repositoryIdentity: 'same-repo', gitCommonDirIdentity: 'common-git',
    worktreeIdentity: 'worktree-new', branch: 'goal/new',
    head: nextHead, statusEntries: [], dirtyFingerprint: 'clean:sha', stagedFingerprint: 'none',
    baseSha: head, mergeBaseSha: head,
  };
  const gitRetention: GoalWorkspaceRetentionGitPort = {
    async status() { return ok({ entries }); },
    async run(_cwd: string, args: readonly string[]) {
      return ok({ exitCode: 0, stdout: args[0] === 'rev-parse' ? head + '\n' : 'goal/old\n', stderr: '' });
    },
  };
  const retained = await sealMixedDirtyGoalWorkspace({
    goalId, workspaceId: oldId, sourceRoot: oldRoot,
    retentionRoot: path.join(root, 'retention'), expectedHead: head,
    expectedBranch: 'goal/old', git: gitRetention,
  });
  if (!retained.ok) throw new Error(retained.error.message);
  const old: Workspace = {
    id: oldId, displayName: 'Old Goal', rootPath: oldRoot, realRootPath: oldRoot,
    createdAt: '2026-10-09T00:00:00.000Z', lifecycleKind: 'goal', goalId,
    parentWorkspaceId: 'project-root', goalWorkspaceKind: 'git_worktree', branchName: 'goal/old',
    writerLease: {
      leaseId: 'host-lease', generation: 3, ownerId: actor.clientId + ':' + actor.sessionId,
      expiresAt: '2099-10-09T01:00:00.000Z',
    },
  };
  const next: Workspace = {
    id: newId, displayName: 'Replacement', rootPath: newRoot, realRootPath: newRoot,
    createdAt: '2026-10-09T00:00:00.000Z', lifecycleKind: 'temporary',
    parentWorkspaceId: 'project-root', ownerSessionId: actor.sessionId,
  };
  const original: WorkspaceAdmissionReceipt = {
    admissionId: 'old-admission', workspaceId: oldId, projectId: 'project-root',
    goalId, workspaceKind: 'git', worktreeIdentity: 'worktree-old',
    repositoryIdentity: 'same-repo', gitCommonDirIdentity: 'common-git',
    branchName: 'goal/old', expectedWorkspaceHead: head, observedWorkspaceHead: head,
    dirtyState: 'dirty', dirtyFingerprint: 'dirty:old', stagedFingerprint: 'none',
    writeLeaseGeneration: 3, admissionGeneration: 3, createdAt: '2026-10-09T00:00:00.000Z',
    runtimeDeploymentId: 'deployment', runtimeGeneration: 'generation',
    runtimeBuildVersion: 'v1', runtimeBuildDirty: false,
    runtimeProtocolGeneration: 1, runtimeStartedAt: '2026-10-09T00:00:00.000Z', workflowVersion: 1,
  };
  const goal: GoalRecord = {
    id: goalId, goalKey: 'existing-key', workspaceId: oldId,
    ownerClientId: actor.clientId, objective: 'Preserve foreign work',
    plan: { steps: [] }, status: 'active', revision: 33, currentPhase: 'recover',
    nextAction: 'Rebind', blockers: [], activeTaskIds: [],
    leaseOwnerClientId: actor.clientId, leaseOwnerSessionId: actor.sessionId,
    leaseTokenHash: createHash('sha256').update(leaseToken).digest('hex'),
    leaseGeneration: 3, leaseActivitySeq: 1,
    leaseExpiresAt: '2099-10-09T01:00:00.000Z',
    createdAt: '2026-10-09T00:00:00.000Z', updatedAt: '2026-10-09T00:00:00.000Z',
    checkpoints: [],
  };
  const state = {
    allowed: true, prepareCount: 0, commitCount: 0,
    revalidationDrift: false, dirtyReplacement: false, missingCheckpoint: false,
    custodyOwnerDrift: false,
    recoveryState: 'prepared_requires_fresh_owner_verification' as GoalWorkspaceTransferRecoveryObservation['state'],
    recoveryGoalId: undefined as string | undefined,
    admissionAdmitted: true,
    admissionChecks: 0 as number,
    /** Mutates CANONICAL Goal state right after the storage CAS, simulating
     *  lease theft / owner change / fence loss in the commit-to-recheck window. */
    canonicalDriftAfterCommit: undefined as 'lease_owner' | 'goal_owner' | 'lease_generation' | 'workspace_fence' | 'admission_invalidated' | undefined,
    approvalIssued: 0,
    lastApproval: null as GoalRelocationHostApproval | null,
    lastExpectedNewHead: undefined as string | undefined,
    goal, old, next, oldReceipt: original,
    newReceipt: null as WorkspaceAdmissionReceipt | null,
  };
  let oldObservations = 0;
  const ports: GoalRelocationOrchestratorPorts = {
    host: {
      async withAuthorizedOwner(identity, run) {
        if (!state.allowed || identity.clientId !== actor.clientId || identity.sessionId !== actor.sessionId) {
          throw new Error('Host Approval refused');
        }
        state.approvalIssued += 1;
        return run({
          approvalId: `approval-${state.approvalIssued}`, goalId: identity.goalId,
          operationId: identity.operationId, action: identity.action,
          fromWorkspaceId: identity.fromWorkspaceId, toWorkspaceId: identity.toWorkspaceId,
          ownerClientId: identity.clientId, ownerSessionId: identity.sessionId,
          issuedAt: Date.parse('2026-10-09T00:00:00.000Z'),
          expiresAt: Date.parse('2026-10-09T00:02:00.000Z'),
        });
      },
    },
    goals: { async getById(id) { return id === goalId ? state.goal : null; } },
    workspaces: {
      async get(id) { return id === oldId ? state.old : id === newId ? state.next : null; },
      async getAdmissionReceipt(id) { return id === oldId ? state.oldReceipt : id === newId ? state.newReceipt : null; },
    },
    git: {
      async observeWorkspace(cwd) {
        if (cwd === oldRoot) {
          oldObservations += 1;
          return ok(state.revalidationDrift && oldObservations > 1
            ? { ...oldSnap, head: 'c'.repeat(40) } : oldSnap);
        }
        return ok(state.dirtyReplacement
          ? { ...cleanSnap, statusEntries: [entries[0]!] } : cleanSnap);
      },
    },
    custody: {
      async readPinned(id) {
        if (id !== operationId) return null;
        return {
          operationId, retentionPath: retained.value.retentionPath,
          expectedManifestSha256: retained.value.manifestSha256,
          expectedGoalId: goalId, expectedWorkspaceId: oldId, newWorkspaceId: newId,
          expectedHead: head, expectedBranch: 'goal/old',
          newWorkspaceHead: state.missingCheckpoint ? 'invalid' : nextHead,
          expectedRevision: 33, expectedAdmissionGeneration: 3, leaseGeneration: 3,
          ownerClientId: state.custodyOwnerDrift ? 'other-owner' : actor.clientId,
          ownerSessionId: actor.sessionId,
          pinnedAt: '2026-10-09T00:00:00.000Z',
        };
      },
    },
    validateAdmission: async (workspaceId, checkedGoalId, leaseGeneration, admissionGeneration) => {
      state.admissionChecks += 1;
      return state.admissionAdmitted && workspaceId === newId && checkedGoalId === goalId
        && leaseGeneration === goal.leaseGeneration
        && admissionGeneration === 1
        ? ok(undefined)
        : err(appError('WORKSPACE_ADMISSION_STALE', 'admission recheck failed', true));
    },
    transfer: {
      async get(observedOperationId) {
        return observedOperationId === operationId
          ? { retainedManifestSha256: retained.value.manifestSha256 } : null;
      },
      async inspectRecovery(observedOperationId) {
        return {
          operationId: observedOperationId,
          goalId: state.recoveryGoalId ?? goalId,
          oldWorkspaceId: oldId,
          newWorkspaceId: newId,
          state: state.recoveryState,
        };
      },
      async prepare(input) {
        state.prepareCount += 1;
        state.lastApproval = input.approval;
        state.lastExpectedNewHead = input.expectedNewHead;
        return input.goalId === goalId && input.retainedManifestSha256 === retained.value.manifestSha256;
      },
      async commit(input) {
        state.commitCount += 1;
        state.goal = { ...state.goal, workspaceId: newId, revision: state.goal.revision + 1 };
        state.old = { ...state.old, lifecycleKind: 'inspection', goalId: undefined };
        state.next = { ...state.next, lifecycleKind: 'goal', goalId, writerLease: state.old.writerLease };
        state.newReceipt = input.admissionReceipt;
        switch (state.canonicalDriftAfterCommit) {
          case 'lease_owner':
            state.goal = { ...state.goal, leaseOwnerSessionId: 'thief-session' };
            break;
          case 'goal_owner':
            state.goal = { ...state.goal, ownerClientId: 'thief-client' };
            break;
          case 'lease_generation':
            state.goal = { ...state.goal, leaseGeneration: state.goal.leaseGeneration + 1 };
            break;
          case 'workspace_fence':
            state.next = { ...state.next, writerLease: undefined };
            break;
          case 'admission_invalidated':
            state.newReceipt = { ...input.admissionReceipt, invalidatedAt: '2026-10-09T00:00:01.000Z' };
            break;
          default:
            break;
        }
        return true;
      },
    },
    runtimeIdentity: {
      runtimeDeploymentId: 'deployment', runtimeGeneration: 'generation', runtimeBuildVersion: 'v1',
      runtimeBuildDirty: false, runtimeProtocolGeneration: 1,
      runtimeStartedAt: '2026-10-09T00:00:00.000Z',
    },
    now: (): Date => new Date('2026-10-09T00:00:00.000Z'),
  };
  const service = new GoalWorkspaceRelocationOrchestrator(ports);
  const request = { goalId, operationId, oldWorkspaceId: oldId, newWorkspaceId: newId, actor, leaseToken };
  return { service, request, bundle: retained.value, oldRoot, newRoot, state };
}

describe('GoalWorkspaceRelocationOrchestrator #298', () => {
  it('requires a real runtime host fence, never trusting an MCP request approval flag', async () => {
    const f = await fixture();
    f.state.allowed = false;
    expect((await f.service.transfer(f.request)).ok).toBe(false);
    expect(f.state.prepareCount).toBe(0);
  });

  it('checks the actual dirty source and immutable-checksum custody before atomic transfer', async () => {
    const f = await fixture();
    const result = await f.service.transfer(f.request);
    expect(result).toMatchObject({
      ok: true,
      value: { status: 'admitted', goalId, workspaceId: newId, outstandingRuntimeAdmission: false },
    });
    // ADMITTED comes from the canonical recheck, not from the storage move.
    expect(f.state.admissionChecks).toBe(1);
    expect(f.state.prepareCount).toBe(1);
    expect(f.state.commitCount).toBe(1);
    // The single-use approval minted by the host fence is handed to storage, and
    // the expected replacement HEAD is the fence-pinned one, never a fresh read.
    expect(f.state.lastApproval).toMatchObject({
      goalId, operationId, action: 'relocate_goal', fromWorkspaceId: oldId,
      toWorkspaceId: newId, ownerClientId: actor.clientId, ownerSessionId: actor.sessionId,
    });
    expect(f.state.lastExpectedNewHead).toBe(nextHead);
    expect(await readFile(path.join(f.oldRoot, 'src/dirty.ts'), 'utf8')).toBe('const dirty = 1;\n');
    expect(await readFile(path.join(f.oldRoot, 'tests/new.test.ts'), 'utf8')).toBe('test();\n');
    expect(f.state.old.lifecycleKind).toBe('inspection');
  });

  it('rejects a custody pin bound to another authenticated owner before prepare', async () => {
    const f = await fixture();
    f.state.custodyOwnerDrift = true;
    expect((await f.service.transfer(f.request)).ok).toBe(false);
    expect(f.state.prepareCount).toBe(0);
  });

  it('refuses altered owner lease before any prepared transaction', async () => {
    const f = await fixture();
    f.state.goal = { ...f.state.goal, leaseTokenHash: 'nope' };
    expect((await f.service.transfer(f.request)).ok).toBe(false);
    expect(f.state.prepareCount).toBe(0);
  });

  it('rejects an unusable pinned replacement HEAD or a dirty replacement without preparing an intent', async () => {
    const f = await fixture();
    f.state.missingCheckpoint = true;
    expect((await f.service.transfer(f.request)).ok).toBe(false);
    f.state.missingCheckpoint = false;
    f.state.dirtyReplacement = true;
    expect((await f.service.transfer(f.request)).ok).toBe(false);
    expect(f.state.prepareCount).toBe(0);
  });

  it('refuses changed original foreign file bytes without deleting or adopting them', async () => {
    const f = await fixture();
    await writeFile(path.join(f.oldRoot, 'src/dirty.ts'), 'const dirty = 2;\n');
    expect((await f.service.transfer(f.request)).ok).toBe(false);
    expect(f.state.prepareCount).toBe(0);
  });

  it('leaves the prepared intent for reconciliation if Git HEAD moves after prepare', async () => {
    const f = await fixture();
    f.state.revalidationDrift = true;
    expect((await f.service.transfer(f.request)).ok).toBe(false);
    expect(f.state.prepareCount).toBe(1);
    expect(f.state.commitCount).toBe(0);
  });
});

describe('GoalWorkspaceRelocationOrchestrator.reconcile #323', () => {
  it('resumes a crash between prepare and commit under fresh owner verification', async () => {
    const f = await fixture();
    f.state.revalidationDrift = true;
    expect((await f.service.transfer(f.request)).ok).toBe(false);
    expect(f.state.prepareCount).toBe(1);
    expect(f.state.commitCount).toBe(0);
    // Restart: no drift any more, fresh Host Approval, re-verified custody.
    f.state.revalidationDrift = false;
    f.state.approvalIssued = 0;
    expect(await f.service.reconcile(f.request)).toMatchObject({
      ok: true,
      value: { status: 'admitted', goalId, workspaceId: newId, outstandingRuntimeAdmission: false },
    });
    expect(f.state.approvalIssued).toBe(1);
    expect(f.state.commitCount).toBe(1);
    expect(f.state.newReceipt?.admissionGeneration).toBe(1);
  });

  it('fails closed for every non-resumable durable state, never adopting the dirty workspace', async () => {
    for (const state of ['missing_or_unverified', 'prepared_stale_owner_review',
      'committed_inconsistent_owner_review', 'cancelled'] as const) {
      const f = await fixture();
      f.state.recoveryState = state;
      expect((await f.service.reconcile(f.request)).ok).toBe(false);
      expect(f.state.approvalIssued).toBe(0);
      expect(f.state.prepareCount).toBe(0);
      expect(f.state.commitCount).toBe(0);
      expect(f.state.goal.workspaceId).toBe(oldId);
      expect(await readFile(path.join(f.oldRoot, 'src/dirty.ts'), 'utf8')).toBe('const dirty = 1;\n');
    }
  });

  it('refuses a recovery operation that belongs to another Goal', async () => {
    const f = await fixture();
    f.state.recoveryGoalId = 'goal-other';
    const result = await f.service.reconcile(f.request);
    expect(result.ok).toBe(false);
    expect(f.state.commitCount).toBe(0);
  });

  it('reaches a genuine ADMITTED on a restart of an already committed relocation', async () => {
    const f = await fixture();
    expect((await f.service.transfer(f.request)).ok).toBe(true);
    f.state.recoveryState = 'committed_runtime_admission_required';
    f.state.admissionChecks = 0;
    expect(await f.service.reconcile(f.request)).toMatchObject({
      ok: true,
      value: { status: 'admitted', workspaceId: newId, outstandingRuntimeAdmission: false },
    });
    expect(f.state.admissionChecks).toBe(1);
    expect(f.state.commitCount).toBe(1);
  });

  it('never reports ADMITTED when the canonical admission recheck still fails', async () => {
    const f = await fixture();
    f.state.admissionAdmitted = false;
    expect(await f.service.transfer(f.request)).toMatchObject({
      ok: true,
      value: { status: 'storage_committed_runtime_admission_required', outstandingRuntimeAdmission: true },
    });
    expect(f.state.commitCount).toBe(1);
  });

  it('fails closed when the trusted custody pin no longer matches on the resume path', async () => {
    const f = await fixture();
    f.state.custodyOwnerDrift = true;
    expect((await f.service.reconcile(f.request)).ok).toBe(false);
    expect(f.state.prepareCount).toBe(0);
    expect(f.state.commitCount).toBe(0);
  });
});

describe('GoalWorkspaceRelocationOrchestrator canonical admission recheck #324', () => {
  it('fails closed when canonical Goal state drifts between the CAS and the recheck', async () => {
    for (const drift of ['lease_owner', 'goal_owner', 'lease_generation', 'workspace_fence', 'admission_invalidated'] as const) {
      const f = await fixture();
      f.state.canonicalDriftAfterCommit = drift;
      const result = await f.service.transfer(f.request);
      expect(result.ok).toBe(false);
      // The drift is detected on canonical read-back: no ADMITTED is invented.
      expect(f.state.admissionChecks).toBe(0);
      expect(f.state.goal.workspaceId).toBe(newId);
      expect(f.state.newReceipt).not.toBeNull();
    }
  });

  it('surfaces the outstanding runtime-admission obligation instead of a false ADMITTED', async () => {
    const f = await fixture();
    f.state.admissionAdmitted = false;
    expect(await f.service.transfer(f.request)).toMatchObject({
      ok: true,
      value: {
        status: 'storage_committed_runtime_admission_required',
        goalId, workspaceId: newId, outstandingRuntimeAdmission: true,
      },
    });
    expect(f.state.admissionChecks).toBe(1);
  });
});
