import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ok, type GoalRecord, type WorkspaceAdmissionReceipt } from '@unified-mpc/domain';
import type { GitWorkspaceSnapshot } from '@unified-mpc/git';
import type { Workspace } from '@unified-mpc/workspace';
import { sealMixedDirtyGoalWorkspace, type GoalWorkspaceRetentionGitPort } from './goal-workspace-retention-service.js';
import {
  GoalWorkspaceCustodyAttestationService,
  type GoalCustodyAuthenticatedRequest,
  type GoalCustodyRecordRequest,
  type GoalWorkspaceCustodyAttestationPorts,
} from './goal-workspace-custody-attestation-service.js';

const oldHead = 'a'.repeat(40);
const rootPaths: string[] = [];
const now = '2026-10-09T00:00:00.000Z';
const goalId = 'goal-source-owner';
const oldId = 'goal-old';
const nextId = 'goal-next';
const operationId = 'operation-custody';
const token = 'correct-secret-lease';
const actor = { clientId: 'client-owner', sessionId: 'session-owner' };
const tracked = { path: 'src/file.ts', kind: 'modified' as const, indexStatus: ' ' as const, worktreeStatus: 'M' as const };
const untracked = { path: 'tests/new.test.ts', kind: 'untracked' as const, indexStatus: '?' as const, worktreeStatus: '?' as const };

afterEach(async (): Promise<void> => {
  await Promise.all(rootPaths.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

interface Fixture {
  service: GoalWorkspaceCustodyAttestationService;
  request: GoalCustodyAuthenticatedRequest;
  originalPath: string;
  retainedPath: string;
  state: {
    approved: boolean;
    recordCount: number;
    saved: GoalCustodyRecordRequest | null;
    wrongReadback: boolean;
    driftGoal: boolean;
    goal: GoalRecord;
  };
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'goal-custody-verify-'));
  rootPaths.push(root);
  const originalPath = path.join(root, 'source');
  const nextPath = path.join(root, 'next');
  await mkdir(path.join(originalPath, 'src'), { recursive: true });
  await mkdir(path.join(originalPath, 'tests'), { recursive: true });
  await mkdir(nextPath);
  await writeFile(path.join(originalPath, tracked.path), 'const original = true;\n');
  await writeFile(path.join(originalPath, untracked.path), 'check();\n');
  const git: GoalWorkspaceRetentionGitPort = {
    async status() { return ok({ entries: [tracked, untracked] }); },
    async run(_root, args) {
      return ok({ exitCode: 0, stdout: args[0] === 'rev-parse' ? oldHead + '\n' : 'goal/source\n', stderr: '' });
    },
  };
  const retained = await sealMixedDirtyGoalWorkspace({
    goalId, workspaceId: oldId, sourceRoot: originalPath,
    retentionRoot: path.join(root, 'retained'), expectedHead: oldHead,
    expectedBranch: 'goal/source', git,
  });
  if (!retained.ok) throw new Error(retained.error.message);
  const snapshot: GitWorkspaceSnapshot = {
    head: oldHead, branch: 'goal/source', repositoryIdentity: 'repo-identity',
    gitCommonDirIdentity: 'common-repo', worktreeIdentity: 'old-worktree',
    statusEntries: [tracked, untracked], dirtyFingerprint: 'dirty',
    stagedFingerprint: 'none',
  };
  const goal: GoalRecord = {
    id: goalId, goalKey: 'backlog', workspaceId: oldId, ownerClientId: actor.clientId,
    objective: 'Preserve foreign edits', plan: { steps: [] }, status: 'active',
    revision: 14, currentPhase: 'custody', nextAction: 'Prepare', blockers: [],
    activeTaskIds: [], checkpoints: [],
    createdAt: now, updatedAt: now,
    leaseOwnerClientId: actor.clientId, leaseOwnerSessionId: actor.sessionId,
    leaseTokenHash: createHash('sha256').update(token).digest('hex'),
    leaseGeneration: 4, leaseActivitySeq: 1,
    leaseExpiresAt: '2099-10-09T00:00:00.000Z',
  };
  const old: Workspace = {
    id: oldId, displayName: 'Original', rootPath: originalPath,
    realRootPath: originalPath, createdAt: now, lifecycleKind: 'goal',
    goalId, goalWorkspaceKind: 'git_worktree',
    parentWorkspaceId: 'project-root', branchName: 'goal/source',
    writerLease: {
      leaseId: 'host-lease', generation: 4,
      ownerId: actor.clientId + ':' + actor.sessionId,
      expiresAt: '2099-10-09T00:00:00.000Z',
    },
  };
  const next: Workspace = {
    id: nextId, displayName: 'Replacement', rootPath: nextPath,
    realRootPath: nextPath, createdAt: now, lifecycleKind: 'temporary',
    parentWorkspaceId: 'project-root', ownerSessionId: actor.sessionId,
  };
  const admission: WorkspaceAdmissionReceipt = {
    admissionId: 'original-admission', projectId: 'project-root',
    workspaceId: oldId, goalId, workspaceKind: 'git',
    repositoryIdentity: 'repo-identity', gitCommonDirIdentity: 'common-repo',
    worktreeIdentity: 'old-worktree', branchName: 'goal/source',
    expectedWorkspaceHead: oldHead, observedWorkspaceHead: oldHead,
    dirtyState: 'dirty', dirtyFingerprint: 'dirty', stagedFingerprint: 'none',
    admissionGeneration: 6, writeLeaseGeneration: 4, createdAt: now,
    runtimeDeploymentId: 'demo', runtimeGeneration: 'demo', runtimeBuildVersion: 'demo',
    runtimeBuildDirty: false, runtimeProtocolGeneration: 1,
    runtimeStartedAt: now, workflowVersion: 1,
  };
  const state = {
    approved: true, recordCount: 0, saved: null as GoalCustodyRecordRequest | null,
    wrongReadback: false, driftGoal: false, goal,
  };
  let goalRead = 0;
  const ports: GoalWorkspaceCustodyAttestationPorts = {
    host: {
      async withAuthorizedOwner(identity, run) {
        if (!state.approved || identity.clientId !== actor.clientId || identity.sessionId !== actor.sessionId) {
          throw new Error('host did not approve');
        }
        return run();
      },
    },
    trustedEvidence: {
      async getByOperation(id) {
        return id === operationId
          ? {
              operationId, newWorkspaceId: nextId,
              retentionPath: retained.value.retentionPath,
              expectedManifestSha256: retained.value.manifestSha256,
              expectedGoalId: goalId, expectedWorkspaceId: oldId,
              expectedHead: oldHead, expectedBranch: 'goal/source',
            }
          : null;
      },
    },
    goals: {
      async getById(id) {
        goalRead += 1;
        if (id !== goalId) return null;
        return state.driftGoal && goalRead > 1
          ? { ...state.goal, revision: state.goal.revision + 1 } : state.goal;
      },
    },
    workspaces: {
      async get(id) { return id === oldId ? old : id === nextId ? next : null; },
      async getAdmissionReceipt(id) { return id === oldId ? admission : null; },
    },
    git: { async observeWorkspace() { return ok(snapshot); } },
    custody: {
      async recordVerified(input) {
        state.recordCount += 1;
        state.saved = input;
        return true;
      },
      async readPinned() {
        return state.wrongReadback
          ? state.saved === null ? null : { ...state.saved, expectedManifestSha256: 'f'.repeat(64) }
          : state.saved;
      },
    },
    now: (): Date => new Date(now),
  };
  return {
    service: new GoalWorkspaceCustodyAttestationService(ports),
    request: { operationId, goalId, oldWorkspaceId: oldId, newWorkspaceId: nextId, actor, leaseToken: token },
    originalPath, retainedPath: retained.value.retentionPath, state,
  };
}

describe('GoalWorkspaceCustodyAttestationService #298', () => {
  it('independently rehashes retained bytes and original source before pinning Goal owner custody', async () => {
    const f = await fixture();
    const result = await f.service.verifyAndPin(f.request);
    expect(result).toMatchObject({ ok: true, value: { status: 'verified_and_pinned', operationId } });
    expect(f.state.recordCount).toBe(1);
    expect(f.state.saved).toMatchObject({
      goalId, newWorkspaceId: nextId, ownerClientId: actor.clientId, ownerSessionId: actor.sessionId,
      expectedRevision: 14, expectedAdmissionGeneration: 6, leaseGeneration: 4,
    });
    expect(await readFile(path.join(f.originalPath, tracked.path), 'utf8')).toBe('const original = true;\n');
  });

  it('refuses denied Host Approval even when all retained bytes are valid', async () => {
    const f = await fixture();
    f.state.approved = false;
    expect((await f.service.verifyAndPin(f.request)).ok).toBe(false);
    expect(f.state.recordCount).toBe(0);
  });

  it('refuses a modified retained file rather than trusting a manifest digest alone', async () => {
    const f = await fixture();
    const file = path.join(f.retainedPath, 'files', tracked.path);
    await chmod(file, 0o600);
    await writeFile(file, 'const tampered = true;\n');
    expect((await f.service.verifyAndPin(f.request)).ok).toBe(false);
    expect(f.state.recordCount).toBe(0);
  });

  it('refuses altered original foreign bytes without changing the source or recording custody', async () => {
    const f = await fixture();
    await writeFile(path.join(f.originalPath, tracked.path), 'const original = false;\n');
    expect((await f.service.verifyAndPin(f.request)).ok).toBe(false);
    expect(f.state.recordCount).toBe(0);
  });

  it('refuses a stale owner lease or a changed Goal revision on second read', async () => {
    const f = await fixture();
    expect((await f.service.verifyAndPin({ ...f.request, leaseToken: 'stolen-token' })).ok).toBe(false);
    expect(f.state.recordCount).toBe(0);
    const changed = await fixture();
    changed.state.driftGoal = true;
    expect((await changed.service.verifyAndPin(changed.request)).ok).toBe(false);
    expect(changed.state.recordCount).toBe(0);
  });

  it('refuses custody success when durable storage read-back returns another digest', async () => {
    const f = await fixture();
    f.state.wrongReadback = true;
    expect((await f.service.verifyAndPin(f.request)).ok).toBe(false);
    expect(f.state.recordCount).toBe(1);
  });
});
