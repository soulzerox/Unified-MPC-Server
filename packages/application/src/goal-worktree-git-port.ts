import { stat } from 'node:fs/promises';
import type { Result } from '@unified-mpc/domain';
import type { GitCommandResult, GitStatusEntry, GitStatusResult } from '@unified-mpc/git';
import type {
  GoalWorktreeAncestryProbeInput,
  GoalWorktreeGitPort,
  GoalWorktreeStatusProbe,
} from './goal-worktree-reconciliation-service.js';

/** Narrow slice of `GitAdapter` the worktree probes rely on (structurally satisfied by it). */
export interface GoalWorktreeGitAdapter {
  status(cwd: string): Promise<Result<GitStatusResult>>;
  run(cwd: string, args: readonly string[], timeoutMs?: number, signal?: AbortSignal): Promise<Result<GitCommandResult>>;
}

export interface CreateGoalWorktreeGitPortOptions {
  readonly git: GoalWorktreeGitAdapter;
  /** Override the default directory-existence probe (tests, sandboxed hosts). */
  readonly exists?: (worktreePath: string) => Promise<boolean>;
}

function isErrnoError(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

/** A worktree path is usable only while a directory lives there. */
async function worktreeDirectoryExists(worktreePath: string): Promise<boolean> {
  try {
    return (await stat(worktreePath)).isDirectory();
  } catch (error: unknown) {
    if (isErrnoError(error, 'ENOENT') || isErrnoError(error, 'ENOTDIR')) return false;
    throw error;
  }
}

/**
 * Unmerged porcelain states are `UU`, `AA`, `DD` and every pair carrying a `U`;
 * the shared status parser only labels `*U*` pairs, so `AA`/`DD` are re-checked here.
 */
function isUnmergedEntry(entry: GitStatusEntry): boolean {
  const { indexStatus, worktreeStatus } = entry;
  return indexStatus === 'U'
    || worktreeStatus === 'U'
    || (indexStatus === 'A' && worktreeStatus === 'A')
    || (indexStatus === 'D' && worktreeStatus === 'D');
}

/**
 * Host-side `GoalWorktreeGitPort` over a git adapter. Every probe is read-only,
 * and failures degrade to the reconciler's fail-closed answers (`null` HEAD,
 * `unknown` ancestry, thrown status) instead of guessing.
 */
export function createGoalWorktreeGitPort(options: CreateGoalWorktreeGitPortOptions): GoalWorktreeGitPort {
  const { git } = options;
  const exists = options.exists ?? worktreeDirectoryExists;
  return {
    exists: (worktreePath: string): Promise<boolean> => exists(worktreePath),
    async status(worktreePath: string): Promise<GoalWorktreeStatusProbe> {
      const result = await git.status(worktreePath);
      if (!result.ok) throw new Error(`git status failed for ${worktreePath}: ${result.error.message}`);
      return {
        dirtyEntries: result.value.entries.length,
        unmergedEntries: result.value.entries.filter((entry) => isUnmergedEntry(entry)).length,
      };
    },
    async headSha(worktreePath: string): Promise<string | null> {
      const result = await git.run(worktreePath, ['rev-parse', 'HEAD']);
      if (!result.ok || result.value.exitCode !== 0) return null;
      const sha = result.value.stdout.trim();
      return sha.length === 0 ? null : sha;
    },
    /**
     * Ancestry is always evaluated for the worktree's current HEAD: commits made
     * after spawn are exactly the work that must not be discarded, so the ledger
     * `ref` is informational only.
     */
    async isAncestor(input: GoalWorktreeAncestryProbeInput): Promise<'yes' | 'no' | 'unknown'> {
      const result = await git.run(input.worktreePath, ['merge-base', '--is-ancestor', 'HEAD', input.base]);
      if (!result.ok) return 'unknown';
      if (result.value.exitCode === 0) return 'yes';
      if (result.value.exitCode === 1) return 'no';
      return 'unknown';
    },
  };
}
