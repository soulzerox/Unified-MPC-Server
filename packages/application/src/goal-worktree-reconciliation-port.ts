import { appError, err, ok, type Result } from '@unified-mpc/domain';
import { GitAdapter } from '@unified-mpc/git';
import { createGoalWorktreeGitPort, type GoalWorktreeGitAdapter } from './goal-worktree-git-port.js';
import {
  GoalWorktreeReconciliationService,
  type GoalWorktreeClassificationReport,
  type GoalWorktreeDescriptor,
} from './goal-worktree-reconciliation-service.js';

/**
 * Issue #80 slice 3 — host-owned read-only surface for the worktree reconciler.
 *
 * The reconciler itself (slice 1) is pure and the git probes (slice 2) are
 * read-only; this module only composes them with the Unified-owned worktree
 * ownership ledger and the current goal-writer leases. It never deletes,
 * archives or rewrites anything: deletion stays a separate gated surface.
 */

/** Ledger row the reconciler needs; the runtime worktree ledger satisfies this structurally. */
export interface GoalWorktreeReconciliationLedgerEntry {
  readonly workspaceId: string;
  readonly worktreePath: string;
  readonly ref: string;
  readonly owner: string;
  readonly ownerSessionId?: string;
}

export interface GoalWorktreeReconciliationRequest {
  readonly actor: { readonly clientId: string; readonly sessionId?: string };
  /** Restrict the report to one workspace; omitted means the whole owned ledger. */
  readonly workspaceId?: string;
}

export interface GoalWorktreeReconciliationPort {
  classify(request: GoalWorktreeReconciliationRequest): Promise<Result<GoalWorktreeClassificationReport>>;
}

export interface CreateGoalWorktreeReconciliationPortOptions {
  /** Read-only ownership ledger snapshot. */
  readonly listLedgerEntries: () => Promise<readonly GoalWorktreeReconciliationLedgerEntry[]>;
  /**
   * Workspaces that currently hold a live goal writer lease. A worktree in one
   * of those workspaces is never reported cleanable. A rejected probe fails the
   * whole call closed instead of reporting an active worktree as safe.
   */
  readonly listActivelyLeasedWorkspaceIds: () => Promise<readonly string[]>;
  readonly git?: GoalWorktreeGitAdapter;
  /** Integration ref that proves a head was merged (default `origin/main`). */
  readonly integrationBase?: string;
}

export function createGoalWorktreeReconciliationPort(
  options: CreateGoalWorktreeReconciliationPortOptions,
): GoalWorktreeReconciliationPort {
  const reconciler = new GoalWorktreeReconciliationService({
    git: createGoalWorktreeGitPort({ git: options.git ?? new GitAdapter() }),
  });
  return {
    async classify(request: GoalWorktreeReconciliationRequest): Promise<Result<GoalWorktreeClassificationReport>> {
      let ledger: readonly GoalWorktreeReconciliationLedgerEntry[];
      let leasedWorkspaceIds: readonly string[];
      try {
        [ledger, leasedWorkspaceIds] = await Promise.all([
          options.listLedgerEntries(),
          options.listActivelyLeasedWorkspaceIds(),
        ]);
      } catch {
        // An unreadable ledger or lease source must never be reported as "nothing
        // to keep": the caller gets an error instead of a false cleanup verdict.
        return err(appError('INTERNAL_ERROR', 'Goal worktree reconciliation evidence is unavailable', true));
      }
      const leased = new Set(leasedWorkspaceIds);
      const scoped = ledger.filter(
        (entry) => request.workspaceId === undefined || entry.workspaceId === request.workspaceId,
      );
      // Goal workspaces are one-goal-per-workspace, so a live lease in the
      // workspace blocks every worktree recorded under it (fail-closed).
      const activeLeaseWorktreePaths = new Set(
        scoped.filter((entry) => leased.has(entry.workspaceId)).map((entry) => entry.worktreePath),
      );
      const descriptors: GoalWorktreeDescriptor[] = scoped.map((entry) => ({
        worktreePath: entry.worktreePath,
        ref: entry.ref,
        owner: entry.owner,
        ...(entry.ownerSessionId === undefined ? {} : { ownerSessionId: entry.ownerSessionId }),
      }));
      return ok(await reconciler.classify(descriptors, {
        actor: request.actor,
        ...(activeLeaseWorktreePaths.size === 0 ? {} : { activeLeaseWorktreePaths }),
        ...(options.integrationBase === undefined ? {} : { integrationBase: options.integrationBase }),
      }));
    },
  };
}
