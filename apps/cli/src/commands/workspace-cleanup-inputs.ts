import type { SqliteGoalRepository, SqliteSettingsRepository, SqliteWorkspaceJournalRepository } from '@unified-mpc/storage';
import { workspaceSelectionReferences } from '@unified-mpc/application';
import { USER_SETTING_KEYS } from '@unified-mpc/shared';
import type { Result } from '@unified-mpc/domain';
import type { WorkspaceCleanupEvaluationOptions, WorkspaceLifecycleCleanupEvaluation } from '@unified-mpc/workspace';
import type { CloseGatePorts } from './gate-command.js';

interface CleanupWorkspace {
  readonly id: string;
  readonly goalId?: string | undefined;
}

/**
 * Everything a goal-workspace cleanup decision needs beyond the runtime
 * projections. Both fields come from one place so a call site cannot pass one
 * without the other.
 */
export interface GoalWorkspaceCleanupInputs {
  readonly protectedWorkspaceIds: readonly string[];
  readonly goalDurableReferenceStates: ReturnType<SqliteWorkspaceJournalRepository['goalDurableReferenceStates']>;
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
}): Promise<GoalWorkspaceCleanupInputs> {
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

/**
 * The close gate's cleanup port, composed from the assembled inputs.
 *
 * It exists so the composition can be asserted: dropping either field used to be
 * invisible because the gate's own test injects a fake `gateCheck`, and a gate
 * that forgets `goalDurableReferenceStates` reports `allowed` for a workspace the
 * lifecycle path would keep.
 */
export function createGoalWorkspaceCleanupPort(options: {
  readonly cleanupInputs: GoalWorkspaceCleanupInputs;
  readonly goalRuntimeProjections: NonNullable<WorkspaceCleanupEvaluationOptions['goalRuntimeProjections']>;
  readonly evaluate: (input: WorkspaceCleanupEvaluationOptions) => Promise<Result<readonly WorkspaceLifecycleCleanupEvaluation[]>>;
}): CloseGatePorts['cleanup'] {
  return async () => options.evaluate({
    goalRuntimeProjections: options.goalRuntimeProjections,
    ...options.cleanupInputs,
  });
}
