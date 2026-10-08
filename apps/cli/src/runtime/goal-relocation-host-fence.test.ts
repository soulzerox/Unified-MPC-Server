import { describe, expect, it } from 'vitest';
import type { HostMutationApprovalRequest } from '@unified-mpc/mcp-server';
import { createTrustedGoalRelocationHostFence } from './goal-relocation-host-fence.js';

const owner = { clientId: 'trusted-owner', sessionId: 'trusted-session' };
const request = {
  goalId: 'goal-owned', operationId: 'operation-verified',
  clientId: owner.clientId, sessionId: owner.sessionId,
  fromWorkspaceId: 'goal-original', toWorkspaceId: 'goal-clean',
  action: 'attest_custody' as const,
};

describe('first-party Goal relocation Host Approval fence #298', () => {
  it('fails closed with no real Host Approval provider, regardless of Full Bypass', async () => {
    const fence = createTrustedGoalRelocationHostFence({ currentHostActor: () => owner });
    let performed = 0;
    await expect(fence.withAuthorizedOwner(request, async () => { performed++; }))
      .rejects.toThrow('exact-action approval');
    expect(performed).toBe(0);
  });

  it('requires a trusted transport identity exactly matching the Goal operation actor', async () => {
    const requests: HostMutationApprovalRequest[] = [];
    const fence = createTrustedGoalRelocationHostFence({
      currentHostActor: () => owner,
      approveExactAction: async (approval): Promise<boolean> => { requests.push(approval); return true; },
    });
    await expect(fence.withAuthorizedOwner({ ...request, sessionId: 'spoofed' }, async () => true))
      .rejects.toThrow('authenticated host actor');
    await expect(fence.withAuthorizedOwner({ ...request, toWorkspaceId: request.fromWorkspaceId }, async () => true))
      .rejects.toThrow('authenticated host actor');
    expect(requests).toHaveLength(0);
  });

  it('asks the real host to approve the precise operation/stage and never supplies broad approvalScope', async () => {
    const requests: HostMutationApprovalRequest[] = [];
    const fence = createTrustedGoalRelocationHostFence({
      currentHostActor: () => owner,
      approveExactAction: async (approval): Promise<boolean> => { requests.push(approval); return true; },
    });
    expect(await fence.withAuthorizedOwner(request, async () => 'stored')).toBe('stored');
    expect(await fence.withAuthorizedOwner({ ...request, action: 'relocate_goal' }, async () => 'relocated'))
      .toBe('relocated');
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      toolName: 'goal_workspace_custody_attest', mutationKind: 'replace', workspaceId: request.fromWorkspaceId,
    });
    expect(requests[1]).toMatchObject({ toolName: 'goal_workspace_relocate' });
    expect(requests[0]?.summary).toContain('goal-original -> goal-clean');
    expect(requests.every(approval => approval.approvalScope === undefined)).toBe(true);
  });

  it('does not execute a denied action or an action whose authenticated actor changed while awaiting consent', async () => {
    let actor: typeof owner | null = owner;
    let performed = 0;
    const denied = createTrustedGoalRelocationHostFence({
      currentHostActor: () => owner,
      approveExactAction: async (): Promise<boolean> => false,
    });
    await expect(denied.withAuthorizedOwner(request, async () => { performed++; }))
      .rejects.toThrow('Host denied');
    const changed = createTrustedGoalRelocationHostFence({
      currentHostActor: () => actor,
      approveExactAction: async (): Promise<boolean> => { actor = null; return true; },
    });
    await expect(changed.withAuthorizedOwner(request, async () => { performed++; }))
      .rejects.toThrow('session changed');
    expect(performed).toBe(0);
  });

  it('serializes conflicting Goal operations and releases the process fence even after exceptions', async () => {
    const fence = createTrustedGoalRelocationHostFence({
      currentHostActor: () => owner,
      approveExactAction: async (): Promise<boolean> => true,
    });
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    const first = fence.withAuthorizedOwner(request, async () => {
      entered();
      await gate;
      throw new Error('simulated commit failure');
    });
    await enteredPromise;
    await expect(fence.withAuthorizedOwner({ ...request, operationId: 'competing' }, async () => true))
      .rejects.toThrow('already owns');
    release();
    await expect(first).rejects.toThrow('simulated commit failure');
    expect(await fence.withAuthorizedOwner(request, async () => 'recovered')).toBe('recovered');
  });
});
