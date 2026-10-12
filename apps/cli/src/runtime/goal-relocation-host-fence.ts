import { randomUUID } from 'node:crypto';
import type { GoalRelocationHostApproval, GoalRelocationHostFence } from '@unified-mpc/application';
import type { HostMutationApprovalRequest } from '@unified-mpc/mcp-server';

export interface TrustedGoalRelocationHostActor {
  readonly clientId: string;
  readonly sessionId: string;
}

export interface TrustedGoalRelocationHostFenceOptions {
  /**
   * Host/transport-sourced identity only. Must NOT forward client-supplied
   * actor IDs, Goal owner IDs, or a request-selected session here.
   */
  readonly currentHostActor: () => TrustedGoalRelocationHostActor | null;
  /** Native host exact-action approval. A missing provider FAILS CLOSED. */
  readonly approveExactAction?: (request: HostMutationApprovalRequest) => Promise<boolean> | boolean;
  /**
   * Durable single-use ledger for the minted approval capability. A missing
   * ledger FAILS CLOSED: approval that cannot be consumed exactly once at the
   * storage CAS must never authorize a Goal Workspace relocation.
   */
  readonly recordApproval?: (approval: GoalRelocationHostApproval) => Promise<boolean> | boolean;
  /** Approval lifetime. Defaults to 120s so a slow prompt cannot mint stale authority. */
  readonly approvalTtlMs?: number;
  readonly now?: () => number;
}

const inFlightGoals = new Set<string>();
const DEFAULT_APPROVAL_TTL_MS = 120_000;

function validIdentity(id: Parameters<GoalRelocationHostFence['withAuthorizedOwner']>[0]): boolean {
  return id.clientId.trim().length > 0 && id.sessionId.trim().length > 0
    && id.goalId.trim().length > 0 && id.goalId.length <= 128
    && id.operationId.trim().length > 0 && id.operationId.length <= 128
    && id.fromWorkspaceId.trim().length > 0 && id.toWorkspaceId.trim().length > 0
    && id.fromWorkspaceId !== id.toWorkspaceId
    && (id.action === 'attest_custody' || id.action === 'relocate_goal');
}

/**
 * A first-party host approval fence for the Goal relocation domain.
 *
 * - Explicit per-operation, per-source/destination, per-stage approval only.
 * - Does not consult authorizationMode or fullBypassAll.
 * - A process-wide mutex serializes Goal operations in the current runtime.
 * - The SQLite CAS + writer lease remain the cross-process ownership fence.
 * - This port is NOT exposed as an MCP tool or permission to mutate files.
 */
export function createTrustedGoalRelocationHostFence(
  options: TrustedGoalRelocationHostFenceOptions,
): GoalRelocationHostFence {
  return {
    async withAuthorizedOwner<T>(
      identity: Parameters<GoalRelocationHostFence['withAuthorizedOwner']>[0],
      run: (approval: GoalRelocationHostApproval) => Promise<T>,
    ): Promise<T> {
      const actor = options.currentHostActor();
      if (!validIdentity(identity) || options.approveExactAction === undefined
        || options.recordApproval === undefined
        || actor === null || actor.clientId !== identity.clientId || actor.sessionId !== identity.sessionId) {
        throw new Error('Goal relocation requires an authenticated host actor and exact-action approval');
      }
      if (inFlightGoals.has(identity.goalId)) {
        throw new Error('Another Goal relocation/custody operation already owns this process fence');
      }
      inFlightGoals.add(identity.goalId);
      try {
        // No approvalScope: this intentionally cannot become a session-wide
        // permission grant. A distinct action/destination needs a fresh grant.
        const approved = await options.approveExactAction({
          toolName: identity.action === 'attest_custody'
            ? 'goal_workspace_custody_attest' : 'goal_workspace_relocate',
          mutationKind: 'replace',
          reason: 'One-shot exclusive transfer of an existing owner Goal Workspace with preserved foreign files',
          summary: `Exact Goal ${identity.goalId}, operation ${identity.operationId}, stage ${identity.action}: ${identity.fromWorkspaceId} -> ${identity.toWorkspaceId}; preserves original inspection files; requires separate live writer admission`,
          workspaceId: identity.fromWorkspaceId,
        });
        const after = options.currentHostActor();
        if (approved !== true || after === null || after.clientId !== identity.clientId
          || after.sessionId !== identity.sessionId) {
          throw new Error('Host denied exact-action owner authority or the authenticated session changed');
        }
        const now = (options.now ?? Date.now)();
        const approval: GoalRelocationHostApproval = {
          approvalId: randomUUID(),
          goalId: identity.goalId,
          operationId: identity.operationId,
          action: identity.action,
          fromWorkspaceId: identity.fromWorkspaceId,
          toWorkspaceId: identity.toWorkspaceId,
          ownerClientId: identity.clientId,
          ownerSessionId: identity.sessionId,
          issuedAt: now,
          expiresAt: now + (options.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS),
        };
        // Single-use authority: the capability only exists once the durable
        // ledger has it. Storage consumes it exactly once at the CAS.
        if (await options.recordApproval(approval) !== true) {
          throw new Error('Goal relocation host approval could not be recorded durably');
        }
        return await run(approval);
      } finally {
        inFlightGoals.delete(identity.goalId);
      }
    },
  };
}
