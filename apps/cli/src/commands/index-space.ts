import { appError, err, ok, type Result } from '@unified-mpc/domain';
import type { LogicalSpaceReport } from '@unified-mpc/workspace';

export interface IndexSpaceCommand {
  readonly kind: 'index-space';
  /** Print the unprojected report instead of the operator lines. */
  readonly json: boolean;
}

const INDEX_SPACE_USAGE = 'Usage: unified-mpc index space [--json]';

export function parseIndexSpaceArgs(args: readonly string[]): Result<IndexSpaceCommand> {
  if (args[0] !== 'space') return err(appError('INVALID_INPUT', INDEX_SPACE_USAGE));

  let json = false;
  for (const argument of args.slice(1)) {
    if (argument !== '--json' || json) return err(appError('INVALID_INPUT', INDEX_SPACE_USAGE));
    json = true;
  }
  return ok({ kind: 'index-space', json });
}

/**
 * Render the logical canonical-space report (#210 §2, "report logical counts
 * separately from physical SQLite metrics").
 *
 * Every number here comes from the reachability planners, so nothing is a
 * physical claim: row deletion and revision prune do not shrink the database
 * file, and DB/WAL/SHM bytes, page/freelist counts and checkpoint status stay
 * in `storage metrics`. A byte total prints `unmeasured` when the report could
 * not measure every counted artifact — a partial sum would read as a smaller
 * store than it is, which is the opposite of what an operator needs before
 * deciding to compact.
 *
 * A refused report prints only the reason: a zero-retention count would make
 * every artifact look deletable when the roots could not be assembled.
 */
export function formatLogicalSpace(report: LogicalSpaceReport): string {
  if (report.status === 'refused') return `refused ${report.reason}`;
  const bytes = (value: number | null): string => (value === null ? 'unmeasured' : String(value));
  return [
    'logical space: measured',
    `manifests total=${report.manifests.total} retained=${report.manifests.retained} prunable=${report.manifests.prunable}`,
    `artifacts total=${report.artifacts.total} reachable=${report.artifacts.reachable} unreferenced=${report.artifacts.unreferenced}`,
    `bytes reachable=${bytes(report.artifacts.reachableBytes)} unreferenced=${bytes(report.artifacts.unreferencedBytes)}`,
  ].join('\n');
}

/** A refused report is not an answer about the store, so it exits non-zero. */
export function indexSpaceExitCode(report: LogicalSpaceReport): number {
  return report.status === 'measured' ? 0 : 1;
}
