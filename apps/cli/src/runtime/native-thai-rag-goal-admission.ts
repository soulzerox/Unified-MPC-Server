import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { promisify } from 'node:util';

import type { WorkspaceAdmissionReceipt } from '@unified-mpc/domain';
import type { SqliteWorkspaceRepository } from '@unified-mpc/storage';
import type { Workspace } from '@unified-mpc/workspace';

/**
 * A strictly HOST-owned read boundary, never derived from the MCP caller.
 * Invalid goal admissions are excluded, not downgraded to ordinary projects.
 * The same provider is re-read on every private FD3 proof and live check.
 *
 * An epoch read before and after the provider (in the FD3 bootstrap) makes a
 * concurrently committed receipt/registry change fail closed. Git worktree
 * Goals additionally require live branch/HEAD parity. Dirty/base fingerprints
 * and completed Python side effects remain outside this narrow fence.
 */
export interface TrustedSourceGitRunner {
  run(args: readonly string[], cwd: string, options?: { readonly timeoutMs?: number }): Promise<{
    readonly exitCode: number; readonly stdout: string; readonly stderr: string;
  }>;
}

export function createStrictThaiRagGoalAdmissionProvider(
  repository: Pick<SqliteWorkspaceRepository, 'list' | 'getAdmissionReceipt'>,
  now: () => number = Date.now,
  git: TrustedSourceGitRunner = trustedSourceGitRunner,
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
        // A missing or inconsistent provenance kind is never a safe way
        // to bypass the live Git-worktree attestation.
        if (workspace.goalWorkspaceKind === 'git_worktree' && receipt!.workspaceKind !== 'git') continue;
        if (workspace.goalWorkspaceKind === 'snapshot' && receipt!.workspaceKind !== 'non_git') continue;
        if (workspace.goalWorkspaceKind !== 'git_worktree'
          && workspace.goalWorkspaceKind !== 'snapshot') continue;
        if (workspace.goalWorkspaceKind === 'git_worktree'
          && !(await hasCurrentGitHeadAndBranch(workspace, receipt!, git))) continue;
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

const execFileAsync = promisify(execFile);
const MAX_ATTESTATION_CAPTURE_BYTES = 4_096;
const ATTESTATION_TIMEOUT_MS = 1_500;
const COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/**
 * Source observations must not inherit GIT_DIR/GIT_WORK_TREE/GIT_CONFIG_* from
 * the host environment: those can make a Git command inspect another repo.
 * No shell, no user-provided Git arguments, bounded runtime/captured bytes.
 */
const trustedSourceGitRunner: TrustedSourceGitRunner = {
  async run(args, cwd): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const cleanEnvironment = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')),
    );
    try {
      const result = await execFileAsync('git', [...args], {
        cwd,
        windowsHide: true,
        timeout: ATTESTATION_TIMEOUT_MS,
        maxBuffer: MAX_ATTESTATION_CAPTURE_BYTES,
        env: { ...cleanEnvironment, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
      });
      return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
    } catch {
      return { exitCode: -1, stdout: '', stderr: '' };
    }
  },
};

/**
 * Narrow live source attestation for explicitly registered Git worktree Goals.
 * This compares the on-disk commit and symbolic branch to BOTH admitted heads
 * and the registered branch, even if the SQLite epoch never changes.
 *
 * Dirty/staged fingerprints, base freshness and Python in-flight side effects
 * are outside this bounded gate and require separate authority checks.
 */
async function hasCurrentGitHeadAndBranch(
  workspace: Workspace,
  receipt: WorkspaceAdmissionReceipt,
  git: TrustedSourceGitRunner,
): Promise<boolean> {
  if (receipt.workspaceKind !== 'git' || !workspace.branchName
    || receipt.branchName !== workspace.branchName
    || !COMMIT_SHA.test(receipt.expectedWorkspaceHead)
    || !COMMIT_SHA.test(receipt.observedWorkspaceHead)) return false;
  try {
    const root = await git.run(['rev-parse', '--show-toplevel'], workspace.realRootPath, {
      timeoutMs: ATTESTATION_TIMEOUT_MS,
    });
    if (root.exitCode !== 0 || root.stdout.length > MAX_ATTESTATION_CAPTURE_BYTES) return false;
    const resolvedRoot = await realpath(root.stdout.trim());
    if (resolvedRoot !== workspace.realRootPath) return false;

    const head = await git.run(['rev-parse', '--verify', 'HEAD^{commit}'], workspace.realRootPath, {
      timeoutMs: ATTESTATION_TIMEOUT_MS,
    });
    const observedHead = head.stdout.trim().toLowerCase();
    if (head.exitCode !== 0 || !COMMIT_SHA.test(observedHead)
      || observedHead !== receipt.expectedWorkspaceHead.toLowerCase()
      || observedHead !== receipt.observedWorkspaceHead.toLowerCase()) return false;

    const branch = await git.run(['symbolic-ref', '--quiet', '--short', 'HEAD'], workspace.realRootPath, {
      timeoutMs: ATTESTATION_TIMEOUT_MS,
    });
    return branch.exitCode === 0 && branch.stdout.trim() === workspace.branchName;
  } catch {
    return false;
  }
}
