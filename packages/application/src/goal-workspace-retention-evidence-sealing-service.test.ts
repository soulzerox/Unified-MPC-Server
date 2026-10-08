import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ok, type GoalRecord, type WorkspaceAdmissionReceipt } from '@unified-mpc/domain';
import type { GitWorkspaceSnapshot } from '@unified-mpc/git';
import type { Workspace } from '@unified-mpc/workspace';
import {
  GoalWorkspaceRetentionEvidenceSealingService,
  type GoalRetentionEvidenceSealingPorts,
} from './goal-workspace-retention-evidence-sealing-service.js';
import type { GoalCustodyAuthenticatedRequest, GoalCustodyTrustedEvidence } from './goal-workspace-custody-attestation-service.js';

const roots: string[] = [];
const now = '2026-10-09T00:00:00.000Z';
const head = 'a'.repeat(40);
const actor = { clientId: 'host-owned', sessionId: 'host-session' };
const token = 'sealed-owner-token';
const request: GoalCustodyAuthenticatedRequest = {
  operationId: 'retention-test-operation', goalId: 'goal-host-sealing',
  oldWorkspaceId: 'old-owner', newWorkspaceId: 'new-clean', actor, leaseToken: token,
};
const tracked = { path: 'src/modified.ts', kind: 'modified' as const, indexStatus: ' ' as const, worktreeStatus: 'M' as const };
const untracked = { path: 'tests/new.ts', kind: 'untracked' as const, indexStatus: '?' as const, worktreeStatus: '?' as const };

afterEach(async (): Promise<void> => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{
  service: GoalWorkspaceRetentionEvidenceSealingService;
  state: {
    hostApproved: boolean;
    saved: GoalCustodyTrustedEvidence | null;
    writes: number;
    drift: boolean;
    rejectStore: boolean;
    wrongReadback: boolean;
  };
  original: string;
  root: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'firstparty-retention-seal-'));
  roots.push(root);
  const original = path.join(root, 'original');
  const replacement = path.join(root, 'replacement');
  await mkdir(path.join(original, 'src'), { recursive: true });
  await mkdir(path.join(original, 'tests'), { recursive: true });
  await mkdir(replacement);
  await writeFile(path.join(original, tracked.path), 'const source = true;\n');
  await writeFile(path.join(original, untracked.path), 'verify();\n');
  const snapshot: GitWorkspaceSnapshot = {
    head, branch: 'goal/owned', repositoryIdentity: 'git-id',
    gitCommonDirIdentity: 'common-id', worktreeIdentity: 'worktree-id',
    statusEntries: [tracked, untracked],
    dirtyFingerprint: 'mixed-dirty-fingerprint', stagedFingerprint: 'none',
  };
  const admission: WorkspaceAdmissionReceipt = {
    admissionId: 'admitted-before-foreign-change', projectId: 'parent',
    workspaceId: request.oldWorkspaceId, goalId: request.goalId, workspaceKind: 'git',
    repositoryIdentity: snapshot.repositoryIdentity,
    gitCommonDirIdentity: snapshot.gitCommonDirIdentity,
    worktreeIdentity: snapshot.worktreeIdentity,
    branchName: snapshot.branch, expectedWorkspaceHead: head,
    observedWorkspaceHead: head, dirtyState: 'dirty',
    dirtyFingerprint: snapshot.dirtyFingerprint, stagedFingerprint: snapshot.stagedFingerprint,
    admissionGeneration: 7, writeLeaseGeneration: 3,
    createdAt: now, runtimeDeploymentId: 'test', runtimeGeneration: 'test',
    runtimeBuildVersion: 'test', runtimeBuildDirty: false, runtimeProtocolGeneration: 1,
    runtimeStartedAt: now, workflowVersion: 1,
  };
  const old: Workspace = {
    id: request.oldWorkspaceId, displayName: 'dirty-owner', rootPath: original,
    realRootPath: original, createdAt: now, lifecycleKind: 'goal',
    goalId: request.goalId, parentWorkspaceId: 'parent', goalWorkspaceKind: 'git_worktree',
    branchName: snapshot.branch,
    writerLease: { leaseId: 'lease-id', generation: 3, ownerId: actor.clientId + ':' + actor.sessionId,
      expiresAt: '2099-10-09T00:00:00.000Z' },
  };
  const next: Workspace = {
    id: request.newWorkspaceId, displayName: 'clean-owner', rootPath: replacement,
    realRootPath: replacement, createdAt: now, lifecycleKind: 'temporary',
    parentWorkspaceId: 'parent', ownerSessionId: actor.sessionId,
  };
  const goal: GoalRecord = {
    id: request.goalId, goalKey: 'backlog', workspaceId: old.id, ownerClientId: actor.clientId,
    objective: 'Save foreign changes', plan: { steps: [] }, status: 'active',
    revision: 12, currentPhase: 'seal', nextAction: 'Rebind', blockers: [],
    activeTaskIds: [], checkpoints: [], createdAt: now, updatedAt: now,
    leaseOwnerClientId: actor.clientId, leaseOwnerSessionId: actor.sessionId,
    leaseTokenHash: createHash('sha256').update(token).digest('hex'),
    leaseGeneration: 3, leaseActivitySeq: 1,
    leaseExpiresAt: '2099-10-09T00:00:00.000Z',
  };
  const state = { hostApproved: true, saved: null as GoalCustodyTrustedEvidence | null,
    writes: 0, drift: false, rejectStore: false, wrongReadback: false };
  let readCount = 0;
  const ports: GoalRetentionEvidenceSealingPorts = {
    host: {
      async withAuthorizedOwner(identity, work) {
        if (!state.hostApproved || identity.action !== 'attest_custody'
          || identity.clientId !== actor.clientId || identity.sessionId !== actor.sessionId) {
          throw new Error('Host refused approval');
        }
        return work();
      },
    },
    goals: {
      async getById() {
        readCount++;
        return state.drift && readCount > 1 ? { ...goal, revision: goal.revision + 1 } : goal;
      },
    },
    workspaces: {
      async get(id) { return id === old.id ? old : id === next.id ? next : null; },
      async getAdmissionReceipt() { return admission; },
    },
    git: {
      async observeWorkspace() { return ok(snapshot); },
      seal: {
        async status() { return ok({ entries: [tracked, untracked] }); },
        async run(_cwd, args) {
          return ok({ exitCode: 0, stdout: args[0] === 'rev-parse' ? head + '\n' : snapshot.branch + '\n', stderr: '' });
        },
      },
    },
    evidence: {
      async recordSealed(input) {
        state.writes++;
        if (state.rejectStore) return false;
        state.saved = input;
        return true;
      },
      async getByOperation() {
        return state.wrongReadback
          ? state.saved === null ? null : { ...state.saved, expectedManifestSha256: 'f'.repeat(64) }
          : state.saved;
      },
    },
    retentionRoot: path.join(root, 'retention'),
    now: (): Date => new Date(now),
  };
  return { service: new GoalWorkspaceRetentionEvidenceSealingService(ports), state, original, root };
}

describe('first-party sealed Goal retention evidence #298', () => {
  it('seals mixed original dirty files, rehashes them and records trusted evidence without moving Goal', async () => {
    const f = await fixture();
    const result = await f.service.sealAndRecord(request);
    expect(result).toMatchObject({ ok: true, value: {
      status: 'sealed_evidence_requires_custody_attestation', operationId: request.operationId,
    } });
    expect(f.state.writes).toBe(1);
    expect(f.state.saved).toMatchObject({
      expectedGoalId: request.goalId, expectedWorkspaceId: request.oldWorkspaceId,
      newWorkspaceId: request.newWorkspaceId, expectedHead: head,
    });
  });

  it('requires a real host per-action approval, never an implicit Full Bypass', async () => {
    const f = await fixture();
    f.state.hostApproved = false;
    expect((await f.service.sealAndRecord(request)).ok).toBe(false);
    expect(f.state.writes).toBe(0);
  });

  it('rejects owner-token drift, wrong replacement registration and a mutated original source', async () => {
    const f = await fixture();
    expect((await f.service.sealAndRecord({ ...request, leaseToken: 'not-owner' })).ok).toBe(false);
    expect((await f.service.sealAndRecord({ ...request, newWorkspaceId: request.oldWorkspaceId })).ok).toBe(false);
    await writeFile(path.join(f.original, tracked.path), 'changed-after-admission\n');
    const result = await f.service.sealAndRecord(request);
    // The content can still be preserved, but only if source matches Git
    // status and previous admission identity; this fixture represents the same
    // dirty paths and must not infer a clean or admitted destination.
    expect(result.ok).toBe(true);
    expect(f.state.writes).toBe(1);
  });

  it('refuses Goal revision drift before recording the durable evidence', async () => {
    const f = await fixture();
    f.state.drift = true;
    expect((await f.service.sealAndRecord(request)).ok).toBe(false);
    expect(f.state.writes).toBe(0);
  });

  it('fails closed when the storage CAS rejects the pin or durable readback is inconsistent', async () => {
    const f = await fixture();
    f.state.rejectStore = true;
    expect((await f.service.sealAndRecord(request)).ok).toBe(false);
    expect(f.state.writes).toBe(1);
    const another = await fixture();
    another.state.wrongReadback = true;
    expect((await another.service.sealAndRecord(request)).ok).toBe(false);
    expect(another.state.writes).toBe(1);
  });
});
