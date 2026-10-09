import type { WorkspaceAdmissionReceipt } from '@unified-mpc/domain';
import type { SqliteWorkspaceRepository } from '@unified-mpc/storage';
import type { Workspace } from '@unified-mpc/workspace';

/**
 * A strictly HOST-owned read boundary, never derived from the MCP caller.
 * Invalid goal admissions are excluded, not downgraded to ordinary projects.
 * The same provider is re-read on every private FD3 proof and live check.
 *
 * An epoch read before and after the provider (in the FD3 bootstrap) makes a
 * concurrently committed receipt/registry change fail closed. This does not
 * validate repository HEAD or make Python side effects atomic.
 */
export function createStrictThaiRagGoalAdmissionProvider(
  repository: Pick<SqliteWorkspaceRepository, 'list' | 'getAdmissionReceipt'>,
  now: () => number = Date.now,
): () => Promise<readonly { id: string; rootPath: string; realRootPath: string }[]> {
  return async () => {
    const currentTime = now();
    if (!Number.isFinite(currentTime)) throw new Error('thai_rag_admission_clock_unavailable');
    const workspaces = await repository.list();
    const eligible: Array<{ id: string; rootPath: string; realRootPath: string }> = [];
    for (const workspace of workspaces) {
      if (workspace.lifecycleKind === 'goal' || workspace.goalId !== undefined) {
        // No silent promotion of a Goal to an ordinary project if its lease,
        // persisted receipt or lifecycle identity is missing or inconsistent.
        if (workspace.lifecycleKind !== 'goal' || workspace.goalId === undefined
          || workspace.writerLease === undefined) continue;
        const receipt = await repository.getAdmissionReceipt(workspace.id);
        if (!isCurrentGoalAdmission(workspace, receipt, currentTime)) continue;
      }
      eligible.push({ id: workspace.id, rootPath: workspace.rootPath, realRootPath: workspace.realRootPath });
    }
    return eligible;
  };
}

function isCurrentGoalAdmission(
  workspace: Workspace,
  receipt: WorkspaceAdmissionReceipt | null,
  now: number,
): boolean {
  const lease = workspace.writerLease;
  if (receipt === null || lease === undefined) return false;
  if (!workspace.goalId || receipt.goalId !== workspace.goalId
    || receipt.workspaceId !== workspace.id || receipt.invalidatedAt !== undefined
    || receipt.invalidationReason !== undefined
    || !Number.isSafeInteger(receipt.admissionGeneration) || receipt.admissionGeneration < 1
    || receipt.writeLeaseGeneration !== lease.generation
    || !lease.leaseId || !lease.ownerId
    || !Number.isSafeInteger(lease.generation) || lease.generation < 1) return false;
  const leaseExpiry = Date.parse(lease.expiresAt);
  const admittedAt = Date.parse(receipt.createdAt);
  const receiptExpiry = receipt.expiresAt === undefined ? Number.POSITIVE_INFINITY : Date.parse(receipt.expiresAt);
  return Number.isFinite(leaseExpiry) && leaseExpiry > now
    && Number.isFinite(admittedAt) && admittedAt <= now
    && receiptExpiry > now;
}
