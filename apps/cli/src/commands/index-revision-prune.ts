import { appError, err, ok, type Result } from '@unified-mpc/domain';
import type { RevisionPruneReport } from '@unified-mpc/workspace';

export interface IndexRevisionPruneCommand {
  readonly kind: 'index-revision-prune';
  /** Plan without deleting (`--dry-run`) or delete unreachable manifests (`--apply`). */
  readonly dryRun: boolean;
  /** Print the unprojected report instead of the operator lines. */
  readonly json: boolean;
}

const INDEX_REVISION_PRUNE_USAGE = 'Usage: unified-mpc index revision prune --dry-run|--apply [--json]';

/**
 * Parse `index revision prune --dry-run|--apply`.
 *
 * Exactly one mode is required rather than defaulted: the verb both inspects and
 * deletes, so an operator must always say which one they mean. The parser only
 * chooses the mode; the U28 cleanup lease that fences the delete pass is taken
 * inside the workspace layer, where the roots are re-read.
 */
export function parseIndexRevisionPruneArgs(args: readonly string[]): Result<IndexRevisionPruneCommand> {
  if (args[0] !== 'revision' || args[1] !== 'prune') {
    return err(appError('INVALID_INPUT', INDEX_REVISION_PRUNE_USAGE));
  }

  let mode: 'dry-run' | 'apply' | undefined;
  let json = false;
  for (const argument of args.slice(2)) {
    if (argument === '--dry-run' || argument === '--apply') {
      if (mode !== undefined) return err(appError('INVALID_INPUT', INDEX_REVISION_PRUNE_USAGE));
      mode = argument === '--dry-run' ? 'dry-run' : 'apply';
      continue;
    }
    if (argument === '--json') {
      if (json) return err(appError('INVALID_INPUT', INDEX_REVISION_PRUNE_USAGE));
      json = true;
      continue;
    }
    return err(appError('INVALID_INPUT', INDEX_REVISION_PRUNE_USAGE));
  }

  if (mode === undefined) return err(appError('INVALID_INPUT', INDEX_REVISION_PRUNE_USAGE));
  return ok({ kind: 'index-revision-prune', dryRun: mode === 'dry-run', json });
}

/**
 * Render the revision prune report (#210 U20, §12).
 *
 * A dry run prints `prune` candidates, not deletions: the planner keeps every
 * manifest a store root still holds and this mode never writes. An apply prints
 * only the manifests it actually removed, so a candidate that a concurrent pin
 * re-rooted at execution time is visibly absent from the removed set. Each
 * `retain` line names the root that holds the revision, so an operator can tell
 * a genuinely unreachable revision from one that is merely not a canonical ref.
 * A refused pass prints the reason and nothing else.
 */
export function formatCanonicalRevisionPrune(report: RevisionPruneReport, dryRun: boolean): string {
  if (report.status === 'refused') return `refused ${report.reason}`;
  const lines = [
    dryRun
      ? `planned (dry-run) pruneable ${report.pruneable.length} retained ${report.retained.length}`
      : `applied pruneable ${report.pruneable.length} removed ${report.removed.length} retained ${report.retained.length}`,
  ];
  for (const manifestId of dryRun ? report.pruneable : report.removed) {
    lines.push(dryRun ? `prune ${manifestId}` : `removed ${manifestId}`);
  }
  for (const row of report.retained) lines.push(`retain ${row.manifestId} ${row.reason}`);
  return lines.join('\n');
}

/** Exit `0` for a plan or an applied pass, `1` when the pass refused. */
export function indexRevisionPruneExitCode(report: RevisionPruneReport): number {
  return report.status === 'refused' ? 1 : 0;
}
