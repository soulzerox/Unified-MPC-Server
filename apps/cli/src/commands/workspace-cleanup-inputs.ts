import type { SqliteGoalRepository, SqliteSettingsRepository, SqliteWorkspaceJournalRepository } from '@unified-mpc/storage';
import { workspaceSelectionReferences } from '@unified-mpc/application';
import { USER_SETTING_KEYS } from '@unified-mpc/shared';

interface CleanupWorkspace {
  readonly id: string;
  readonly goalId?: string | undefined;
}

/**
 * The two inputs a goal-workspace cleanup decision depends on beyond the runtime
 * projections: what is protected, and what the journal still says about durable
 * references.
 *
 * `reconcileLifecycle`, `gate check --phase close` and the control plane all
 * decide from these. A call site that assembles one of them differently makes a
 * workspace look removable to one path and protected to another, so both are
 * built here and every caller spreads the result instead of rebuilding it.
 */
export async function goalWorkspaceCleanupInputs(options: {
  readonly settings: Pick<SqliteSettingsRepository, 'get'>;
  readonly goals: Pick<SqliteGoalRepository, 'countWorkspaceGoalsForHost'>;
  readonly journal: Pick<SqliteWorkspaceJournalRepository, 'goalDurableReferenceStates'>;
  readonly workspaces: readonly CleanupWorkspace[];
}): Promise<{
  readonly protectedWorkspaceIds: readonly string[];
  readonly goalDurableReferenceStates: ReturnType<SqliteWorkspaceJournalRepository['goalDurableReferenceStates']>;
}> {
  const protectedWorkspaceIds: string[] = [
    ...workspaceSelectionReferences(options.settings.get(USER_SETTING_KEYS.httpWorkspaceSelection)),
  ];
  for (const workspace of options.workspaces) {
    if (protectedWorkspaceIds.includes(workspace.id)) continue;
    if (await options.goals.countWorkspaceGoalsForHost(workspace.id) > 0) protectedWorkspaceIds.push(workspace.id);
  }
  const goalIds = options.workspaces.flatMap((workspace) => (workspace.goalId === undefined ? [] : [workspace.goalId]));
  return {
    protectedWorkspaceIds,
    goalDurableReferenceStates: options.journal.goalDurableReferenceStates(goalIds),
  };
}
