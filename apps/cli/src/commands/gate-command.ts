import {
  closeGateExitCode,
  evaluateCloseGate,
  formatCloseGateVerdict,
  writeCloseGateReceipt,
  type CloseGateRemovalPreview,
  type CloseGateVerdict,
} from './gate.js';
import { appError, err, type Result } from '@unified-mpc/domain';
import type { GoalCompletionWorktreeBlocker } from '@unified-mpc/application';
import type { WorkspaceLifecycleCleanupEvaluation } from '@unified-mpc/workspace';

/**
 * The `close` gate as a command: ask the three owners, compose their answers with
 * `evaluateCloseGate`, and persist the verdict.
 *
 * Every owner is injected as a port, so the command holds no policy and needs no
 * runtime, database or tool registry. The composition root supplies the ports
 * (the tool preview, the reconciliation port and the cleanup evaluation) and this
 * module stays testable with fakes.
 */

export interface CloseGatePorts {
  /** Cleanup rows for this workspace, already evaluated by `WorkspaceService`. */
  readonly cleanup: (request: { readonly workspaceId: string; readonly goalId?: string }) =>
  Promise<Result<readonly WorkspaceLifecycleCleanupEvaluation[]>>;
  /** The `git_worktree_remove` dry run, which owns worktree safety per path. */
  readonly removal: (request: { readonly workspaceId: string; readonly worktreePath: string }) =>
  Promise<Result<CloseGateRemovalPreview>>;
  /** Completion blockers for this goal, from the reconciliation port. */
  readonly completion: (request: { readonly workspaceId: string; readonly goalId?: string }) =>
  Promise<Result<readonly GoalCompletionWorktreeBlocker[]>>;
}

export interface RunCloseGateOptions {
  readonly ports: CloseGatePorts;
  readonly workspaceId: string;
  readonly goalId?: string;
  readonly worktrees: readonly string[];
  /** Directory the receipt is written to; a dry run may omit it. */
  readonly receiptDirectory?: string;
  readonly dryRun: boolean;
  readonly json: boolean;
  readonly now?: () => Date;
  readonly gateId?: () => string;
  readonly headSha?: string;
}

export interface RunCloseGateResult {
  readonly verdict: CloseGateVerdict;
  /** Absolute receipt path, absent on a dry run. */
  readonly receiptPath?: string;
  /** Operator lines, or one JSON document when `--json` was requested. */
  readonly lines: readonly string[];
  readonly exitCode: number;
}

/**
 * Runs the gate. A port that fails (an unreadable ledger, a refused preview)
 * aborts the run instead of being folded into the verdict: a gate that cannot
 * see an input must not report a verdict about it, and the failure carries the
 * reason the operator needs.
 */
export async function runCloseGate(options: RunCloseGateOptions): Promise<Result<RunCloseGateResult>> {
  const cleanup = await options.ports.cleanup({
    workspaceId: options.workspaceId,
    ...(options.goalId === undefined ? {} : { goalId: options.goalId }),
  });
  if (!cleanup.ok) return cleanup;

  const removals: CloseGateRemovalPreview[] = [];
  for (const worktreePath of options.worktrees) {
    const preview = await options.ports.removal({ workspaceId: options.workspaceId, worktreePath });
    if (!preview.ok) return preview;
    removals.push(preview.value);
  }

  const completion = await options.ports.completion({
    workspaceId: options.workspaceId,
    ...(options.goalId === undefined ? {} : { goalId: options.goalId }),
  });
  if (!completion.ok) return completion;

  const verdict = evaluateCloseGate({
    workspaceId: options.workspaceId,
    ...(options.goalId === undefined ? {} : { goalId: options.goalId }),
    cleanup: cleanup.value,
    removals,
    completion: completion.value,
  });

  let receiptPath: string | undefined;
  if (!options.dryRun) {
    if (options.receiptDirectory === undefined) {
      // A gate that refuses still records why; only an explicit dry run skips the
      // receipt, so a missing directory is a programming error rather than a
      // reason to silently drop the evidence.
      return err(appError('INVALID_INPUT', 'A receipt directory is required unless --dry-run is set'));
    }
    const written = await writeCloseGateReceipt({
      directory: options.receiptDirectory,
      verdict,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.gateId === undefined ? {} : { gateId: options.gateId }),
      ...(options.headSha === undefined ? {} : { headSha: options.headSha }),
    });
    if (!written.ok) return written;
    receiptPath = written.value.path;
  }

  const lines = options.json
    ? [JSON.stringify({ verdict, ...(receiptPath === undefined ? {} : { receiptPath }) }, null, 2)]
    : [
      ...formatCloseGateVerdict(verdict),
      ...(receiptPath === undefined ? ['dry run: no receipt written'] : [`receipt ${receiptPath}`]),
    ];

  return {
    ok: true,
    value: {
      verdict,
      ...(receiptPath === undefined ? {} : { receiptPath }),
      lines,
      exitCode: closeGateExitCode(verdict),
    },
  };
}
