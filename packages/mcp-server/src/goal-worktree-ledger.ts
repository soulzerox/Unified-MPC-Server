import type { FileActor, GoalWorktreeReconciliationLedgerEntry } from '@unified-mpc/application';
import { UpgradeRuntimeService } from './upgrade-runtime.js';
import type { McpApplicationServices } from './tools/tool-types.js';

/**
 * #80 slice 3: host-side reader for the Unified-owned worktree ledger. The
 * ledger lives in runtime shared state, so this reuses the upgrade-runtime state
 * store instead of caching a second copy; `upgrade-runtime.js` itself stays an
 * internal module.
 */
export function createGoalWorktreeLedgerReader(options: {
  readonly services: McpApplicationServices;
  readonly actor: FileActor;
}): () => Promise<readonly GoalWorktreeReconciliationLedgerEntry[]> {
  let runtime: UpgradeRuntimeService | undefined;
  return async (): Promise<readonly GoalWorktreeReconciliationLedgerEntry[]> => {
    runtime ??= new UpgradeRuntimeService(options.services, options.actor);
    return runtime.worktreeLedgerEntries();
  };
}
