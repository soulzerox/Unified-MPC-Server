import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteDatabase, SqliteWorkspaceRepository } from '@unified-mpc/storage';
import type { HostMutationApprovalRequest } from '@unified-mpc/mcp-server';
import { createStdioMcpRuntime } from './stdio-mcp-runtime.js';

const directories: string[] = [];
const hostIdentity = { clientId: 'verified-host-client', sessionId: 'verified-host-session' };
const exact = {
  goalId: 'goal-preserved', operationId: 'operation-validated',
  clientId: hostIdentity.clientId, sessionId: hostIdentity.sessionId,
  fromWorkspaceId: 'original-owned', toWorkspaceId: 'replacement-owned',
  action: 'attest_custody' as const,
};

afterEach(async (): Promise<void> => {
  await Promise.all(directories.splice(0).map(dir => rm(dir, { force: true, recursive: true })));
});

async function source(): Promise<{ root: string; data: string; project: {
  id: string; displayName: string; rootPath: string; realRootPath: string; createdAt: string;
} }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'goal-host-approval-'));
  directories.push(root);
  const data = path.join(root, 'data');
  const project = { id: 'goal-host-project', displayName: 'Goal Project',
    rootPath: path.join(root, 'project'), realRootPath: path.join(root, 'project'),
    createdAt: '2026-10-09T00:00:00.000Z' };
  const db = new SqliteDatabase(path.join(data, 'unified-mpc.sqlite'));
  try { await new SqliteWorkspaceRepository(db).insert(project); } finally { db.close(); }
  return { root, data, project };
}

describe('stdio runtime owner-goal host approval integration #298', () => {
  it('fails closed even with Full Bypass when no authenticated host approval provider was installed', async () => {
    const f = await source();
    const runtime = createStdioMcpRuntime(f.data, f.project, true, {
      fullBypassAll: true, checkpointEncryptionKey: Buffer.alloc(32, 0x46),
    });
    try {
      await runtime.recoveryReady;
      expect(runtime.authorizationModeProvider()).toBe('full_bypass');
      expect(runtime.goalCustodyAttestation).toBeUndefined();
      expect(runtime.goalRetentionEvidenceSealing).toBeUndefined();
      let actionCount = 0;
      await expect(runtime.goalRelocationHostFence.withAuthorizedOwner(exact, async () => { actionCount++; }))
        .rejects.toThrow('exact-action approval');
      expect(actionCount).toBe(0);
    } finally { await runtime.close(); }
  });

  it('passes per-operation exact details to the native host and refuses a substituted session', async () => {
    const f = await source();
    const approvals: HostMutationApprovalRequest[] = [];
    const runtime = createStdioMcpRuntime(f.data, f.project, true, {
      fullBypassAll: true, checkpointEncryptionKey: Buffer.alloc(32, 0x46),
      trustedGoalRelocationActorProvider: () => hostIdentity,
      goalRelocationExactActionApproval: async approval => {
        approvals.push(approval);
        return true;
      },
    });
    try {
      await runtime.recoveryReady;
      await expect(runtime.goalRelocationHostFence.withAuthorizedOwner(
        { ...exact, sessionId: 'forged-session' }, async () => true,
      )).rejects.toThrow('authenticated host actor');
      expect(approvals).toHaveLength(0);
      expect(await runtime.goalRelocationHostFence.withAuthorizedOwner(exact, async () => 'done'))
        .toBe('done');
      expect(approvals).toHaveLength(1);
      expect(approvals[0]).toMatchObject({
        workspaceId: exact.fromWorkspaceId, toolName: 'goal_workspace_custody_attest',
      });
      expect(runtime.goalCustodyAttestation).toBeDefined();
      expect(runtime.goalRetentionEvidenceSealing).toBeDefined();
      const attempt = await runtime.goalCustodyAttestation?.verifyAndPin({
        goalId: exact.goalId, operationId: exact.operationId,
        oldWorkspaceId: exact.fromWorkspaceId, newWorkspaceId: exact.toWorkspaceId,
        actor: hostIdentity, leaseToken: 'unknown-lease',
      });
      expect(attempt?.ok).toBe(false);
      expect(approvals).toHaveLength(2);
      const sealed = await runtime.goalRetentionEvidenceSealing?.sealAndRecord({
        goalId: exact.goalId, operationId: exact.operationId,
        oldWorkspaceId: exact.fromWorkspaceId, newWorkspaceId: exact.toWorkspaceId,
        actor: hostIdentity, leaseToken: 'unknown-lease',
      });
      expect(sealed?.ok).toBe(false);
      expect(approvals).toHaveLength(3);
    } finally { await runtime.close(); }
  });
});
