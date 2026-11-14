import { appError, err, ok, type Result } from '@unified-mpc/domain';
import type { GoalWorktreeReconciliationPort } from './goal-worktree-reconciliation-port.js';
import {
  goalWorktreeRemovalBlockers,
  type GoalWorktreeBlocker,
  type GoalWorktreeClassificationEntry,
  type GoalWorktreeReconcilerActor,
} from './goal-worktree-reconciliation-service.js';

/**
 * Issue #142 step 3b — read-only removal preview for the `close` gate.
 *
 * The `git_worktree_remove` dry run answers "may this worktree be removed?" but
 * checks ownership against the asking **session**, so a goal that was handed to
 * a new session cannot even preview the worktree it is about to close. This
 * module asks the same ledger question with `ownershipScope: 'client'`: the
 * client that owns the goal is the same client across a session handoff, so the
 * preview survives it.
 *
 * The port never removes anything, and the destructive path composes only the
 * pure mapper below. Deletion still goes through `git_worktree_remove`, which
 * keeps its stricter session check and its own confirmation gate. A `clean`
 * preview is therefore a statement about the goal's closeability, not an
 * authorization to delete.
 */

export type GoalWorktreeRemovalPreviewStatus = 'clean' | 'blocked';

/**
 * Structurally the CLI's `CloseGateRemovalPreview`, plus the ownership facts an
 * operator needs when the preview refuses.
 *
 * `externally_owned` stays a blocker instead of being filtered out the way
 * `goalCompletionWorktreeBlockers` filters it: completion asserts which work a
 * goal is responsible for, while this preview asserts that a specific path is
 * removable. Reporting `clean` for a path the destructive path would refuse
 * would make the close receipt claim something that is not true.
 */
export interface GoalWorktreeRemovalPreview {
  readonly worktreePath: string;
  readonly status: GoalWorktreeRemovalPreviewStatus;
  /** Removal blockers only; advisory blockers such as `unintegrated_head` are excluded. */
  readonly blockers: readonly GoalWorktreeBlocker[];
  readonly blockerDetails: readonly string[];
  /** Client id recorded as the worktree's owner in the ownership ledger. */
  readonly owner: string;
  /** True when the ledger row belongs to a different client than the asking one. */
  readonly externallyOwned: boolean;
  /** True when a live goal lease claims the worktree, so removal is fenced. */
  readonly activeLease: boolean;
  /** True when the path is already gone; on its own a removal is a no-op, but it never relaxes another blocker. */
  readonly pathMissing: boolean;
}

export interface GoalWorktreeRemovalPreviewRequest {
  readonly workspaceId: string;
  readonly worktreePath: string;
  readonly actor: GoalWorktreeReconcilerActor;
}

export interface GoalWorktreeRemovalPreviewPort {
  preview(request: GoalWorktreeRemovalPreviewRequest): Promise<Result<GoalWorktreeRemovalPreview>>;
}

/**
 * The single mapping from a classification entry to a removal verdict. The
 * destructive `git_worktree_remove` path uses it too, so the preview and the
 * deletion safety check cannot drift apart on which blockers refuse a removal.
 */
export function goalWorktreeRemovalPreview(
  entry: GoalWorktreeClassificationEntry,
): GoalWorktreeRemovalPreview {
  const blockers = goalWorktreeRemovalBlockers(entry.blockers);
  return {
    worktreePath: entry.worktreePath,
    status: blockers.length === 0 ? 'clean' : 'blocked',
    blockers,
    blockerDetails: entry.blockerDetails,
    owner: entry.owner,
    externallyOwned: entry.blockers.includes('externally_owned'),
    activeLease: entry.blockers.includes('active_lease'),
    pathMissing: entry.blockers.includes('path_missing'),
  };
}

export interface CreateGoalWorktreeRemovalPreviewPortOptions {
  /**
   * The reconciliation port the caller already builds for goal completion. The
   * preview reuses its ledger and git wiring instead of opening a second,
   * differently-scoped view of the same evidence.
   */
  readonly reconciliation: Pick<GoalWorktreeReconciliationPort, 'classify'>;
}

export function createGoalWorktreeRemovalPreviewPort(
  options: CreateGoalWorktreeRemovalPreviewPortOptions,
): GoalWorktreeRemovalPreviewPort {
  return {
    async preview(request: GoalWorktreeRemovalPreviewRequest): Promise<Result<GoalWorktreeRemovalPreview>> {
      const classified = await options.reconciliation.classify({
        workspaceId: request.workspaceId,
        actor: request.actor,
        ownershipScope: 'client',
      });
      if (!classified.ok) return classified;
      const entry = classified.value.entries.find(
        (candidate) => candidate.worktreePath === request.worktreePath,
      );
      if (entry === undefined) {
        // The ledger is the authority on what Unified owns. A path it does not
        // record cannot be previewed as removable, because nobody can say what
        // removing it would discard.
        return err(appError(
          'CONFLICT',
          `Worktree ${request.worktreePath} is not in the ownership ledger of workspace ${request.workspaceId}; refusing to preview a path that cannot be attributed`,
        ));
      }
      return ok(goalWorktreeRemovalPreview(entry));
    },
  };
}
