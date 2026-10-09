import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
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
 * Goals additionally require live branch/HEAD parity and a clean Git status
 * when admitted clean. Exact dirty/base fingerprints and completed Python side
 * effects remain outside this narrow fence.
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
// Index flags require listing tracked paths: bound capture and reject larger
// repositories rather than silently allowing hidden index mutations.
const MAX_INDEX_FLAGS_BYTES = 1_048_576;
const ATTESTATION_TIMEOUT_MS = 1_500;
const COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

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
        maxBuffer: args.length === 3 && args[0] === 'ls-files' && args[1] === '-v' && args[2] === '-z'
          ? MAX_INDEX_FLAGS_BYTES : MAX_ATTESTATION_CAPTURE_BYTES,
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
 * A dirty admission is denied until the canonical dirty-state fingerprint can
 * be independently rechecked. For clean admissions, untracked, staged and
 * unstaged Git changes fail closed even when SQLite and HEAD do not change.
 * Base freshness and Python in-flight side effects require separate checks.
 */
async function hasCurrentGitHeadAndBranch(
  workspace: Workspace,
  receipt: WorkspaceAdmissionReceipt,
  git: TrustedSourceGitRunner,
): Promise<boolean> {
  // Fail closed for receipts declaring dirty state; the canonical content
  // fingerprint algorithm is not available at this narrow FD3 boundary.
  if (receipt.dirtyState !== 'clean'
    || receipt.workspaceKind !== 'git' || !workspace.branchName
    || !SHA256.test(receipt.repositoryIdentity ?? '')
    || !SHA256.test(receipt.gitCommonDirIdentity ?? '')
    || !SHA256.test(receipt.gitCommonDirFilesystemIdentity ?? '')
    || !SHA256.test(receipt.worktreeIdentity)
    || receipt.branchName !== workspace.branchName
    || !COMMIT_SHA.test(receipt.expectedWorkspaceHead)
    || !COMMIT_SHA.test(receipt.observedWorkspaceHead)) return false;
  try {
    // Two status observations bracket identity checks. Git can mutate between
    // these reads; this narrows, but does not close, the side-effect race.
    const statusArgs = ['status', '--porcelain=v1', '-z', '--untracked-files=all'] as const;
    const beforeStatus = await git.run(statusArgs, workspace.realRootPath, {
      timeoutMs: ATTESTATION_TIMEOUT_MS,
    });
    if (beforeStatus.exitCode !== 0 || beforeStatus.stdout.length !== 0) return false;
    if (!(await hasSafeTrackedIndexFlags(git, workspace.realRootPath))) return false;
    const root = await git.run(['rev-parse', '--show-toplevel'], workspace.realRootPath, {
      timeoutMs: ATTESTATION_TIMEOUT_MS,
    });
    if (root.exitCode !== 0 || root.stdout.length > MAX_ATTESTATION_CAPTURE_BYTES) return false;
    const resolvedRoot = await realpath(root.stdout.trim());
    if (resolvedRoot !== workspace.realRootPath || hash(resolvedRoot) !== receipt.worktreeIdentity) return false;
    if (!(await matchesCommonDirectoryIdentity(resolvedRoot, receipt, git))) return false;

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
    if (branch.exitCode !== 0 || branch.stdout.trim() !== workspace.branchName) return false;
    if (!(await matchesCommonDirectoryIdentity(resolvedRoot, receipt, git))) return false;
    const afterStatus = await git.run(statusArgs, workspace.realRootPath, {
      timeoutMs: ATTESTATION_TIMEOUT_MS,
    });
    return afterStatus.exitCode === 0 && afterStatus.stdout.length === 0
      && await hasSafeTrackedIndexFlags(git, workspace.realRootPath);
  } catch {
    return false;
  }
}

/**
 * GitAdapter's canonical common-dir path digest alone survives an adversarial
 * replacement at the SAME path. An admission now pins both the path digest
 * and the local directory's dev/inode digest. The latter is a local,
 * filesystem-lifetime identity, not a globally durable cross-host UUID.
 *
 * Re-reading before and after HEAD/branch narrows Git-swap races; it does not
 * make an already-running Python write transactionally cancellable.
 */
/**
 * Git status can be deceptively clean when tracked entries carry the
 * assume-unchanged (lowercase) or skip-worktree (S) index bits. Reject those
 * flags rather than allowing unobserved on-disk source mutations.
 *
 * The listing is bounded; oversized repositories are conservatively denied
 * in opt-in strict mode until a streaming reader can verify every index entry.
 */
async function hasSafeTrackedIndexFlags(
  git: TrustedSourceGitRunner,
  rootPath: string,
): Promise<boolean> {
  const flags = await git.run(['ls-files', '-v', '-z'], rootPath, {
    timeoutMs: ATTESTATION_TIMEOUT_MS,
  });
  if (flags.exitCode !== 0 || Buffer.byteLength(flags.stdout, 'utf8') > MAX_INDEX_FLAGS_BYTES) return false;
  if (flags.stdout.length === 0) return true;
  if (!flags.stdout.endsWith('\0')) return false;
  const records = flags.stdout.slice(0, -1).split('\0');
  return records.every((record) => record.length >= 3 && /^[A-RT-Z] /.test(record));
}

async function matchesCommonDirectoryIdentity(
  canonicalRoot: string,
  receipt: WorkspaceAdmissionReceipt,
  git: TrustedSourceGitRunner,
): Promise<boolean> {
  try {
    const response = await git.run(['rev-parse', '--git-common-dir'], canonicalRoot, {
      timeoutMs: ATTESTATION_TIMEOUT_MS,
    });
    if (response.exitCode !== 0 || response.stdout.length === 0
      || response.stdout.length > MAX_ATTESTATION_CAPTURE_BYTES) return false;
    const commonDirectory = await realpath(path.resolve(canonicalRoot, response.stdout.trim()));
    const pathIdentity = hash(commonDirectory);
    if (receipt.repositoryIdentity !== pathIdentity
      || receipt.gitCommonDirIdentity !== pathIdentity) return false;

    const inode = await stat(commonDirectory, { bigint: true });
    if (!inode.isDirectory() || inode.ino <= 0n) return false;
    return receipt.gitCommonDirFilesystemIdentity === hash(`${inode.dev}:${inode.ino}`);
  } catch {
    return false;
  }
}
