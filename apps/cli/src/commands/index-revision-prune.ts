import { appError, err, ok, type Result } from '@unified-mpc/domain';
import type { RevisionPruneReport } from '@unified-mpc/workspace';

export interface IndexRevisionPruneCommand {
  readonly kind: 'index-revision-prune';
  /** The only supported mode: plan the prune without deleting anything. */
  readonly dryRun: true;
  /** Print the unprojected report instead of the operator lines. */
  readonly json: boolean;
}

const INDEX_REVISION_PRUNE_USAGE = 'Usage: unified-mpc index revision prune --dry-run [--json]';

const APPLY_UNSUPPORTED = 'index revision prune cannot delete yet: --apply is not supported, only --dry-run';

/**
 * Parse `index revision prune --dry-run`.
 *
 * `--dry-run` is required rather than defaulted: the verb exists to inspect a
 * prune plan, and a later slice adds deletion only behind its own safety
 * argument. `--apply` is rejected with a specific message so an operator who
 * guessed the next flag learns the command is read-only instead of assuming the
 * plan they see was also enforced.
 */
export function parseIndexRevisionPruneArgs(args: readonly string[]): Result<IndexRevisionPruneCommand> {
  if (args[0] !== 'revision' || args[1] !== 'prune') {
    return err(appError('INVALID_INPUT', INDEX_REVISION_PRUNE_USAGE));
  }

  let dryRun = false;
  let json = false;
  for (const argument of args.slice(2)) {
    if (argument === '--dry-run') {
      if (dryRun) return err(appError('INVALID_INPUT', INDEX_REVISION_PRUNE_USAGE));
      dryRun = true;
      continue;
    }
    if (argument === '--json') {
      if (json) return err(appError('INVALID_INPUT', INDEX_REVISION_PRUNE_USAGE));
      json = true;
      continue;
    }
    if (argument === '--apply') return err(appError('INVALID_INPUT', APPLY_UNSUPPORTED));
    return err(appError('INVALID_INPUT', INDEX_REVISION_PRUNE_USAGE));
  }

  if (!dryRun) return err(appError('INVALID_INPUT', INDEX_REVISION_PRUNE_USAGE));
  return ok({ kind: 'index-revision-prune', dryRun: true, json });
}

/**
 * Render the dry-run prune plan (#210 U20).
 *
 * `prune` lines are candidates, not deletions: the planner keeps every manifest
 * a store root still holds and this command never writes. Each `retain` line
 * names the root that holds the revision, so an operator can tell a revision
 * that is genuinely unreachable from one that is merely not a canonical ref.
 */
export function formatCanonicalRevisionPrune(report: RevisionPruneReport): string {
  const lines = [
    `planned (dry-run) pruneable ${report.pruneable.length} retained ${report.retained.length}`,
  ];
  for (const manifestId of report.pruneable) lines.push(`prune ${manifestId}`);
  for (const row of report.retained) lines.push(`retain ${row.manifestId} ${row.reason}`);
  return lines.join('\n');
}
