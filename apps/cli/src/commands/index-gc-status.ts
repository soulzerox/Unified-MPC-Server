import { appError, err, ok, type Result } from '@unified-mpc/domain';
import type { GcLeaseReport, GcStatusReport, QuarantineTarget } from '@unified-mpc/workspace';

export interface IndexGcStatusCommand {
  readonly kind: 'index-gc-status';
  /** Print the unprojected report instead of the operator lines. */
  readonly json: boolean;
}

const INDEX_GC_STATUS_USAGE = 'Usage: unified-mpc index gc status [--json]';

export function parseIndexGcStatusArgs(args: readonly string[]): Result<IndexGcStatusCommand> {
  if (args[0] !== 'gc' || args[1] !== 'status') {
    return err(appError('INVALID_INPUT', INDEX_GC_STATUS_USAGE));
  }

  let json = false;
  for (const argument of args.slice(2)) {
    if (argument !== '--json' || json) return err(appError('INVALID_INPUT', INDEX_GC_STATUS_USAGE));
    json = true;
  }
  return ok({ kind: 'index-gc-status', json });
}

/** One quarantine row: a bare content hash, or repository + artifact key. */
function renderTarget(target: QuarantineTarget): string {
  return typeof target === 'string'
    ? target
    : `${target.repositoryId} ${target.artifactKey}`;
}

function renderLease(lease: GcLeaseReport): string {
  switch (lease.status) {
    case 'free':
      return 'lease free';
    case 'corrupt':
      return 'lease corrupt';
    case 'released':
      return `lease released by ${lease.ownerId} at ${lease.releasedAt}`;
    case 'held':
      return `lease held by ${lease.ownerId} until ${lease.expiresAt}`
        + ` (generation ${lease.generation}${lease.expired ? ', expired' : ''})`;
  }
}

/**
 * Render the GC status projection (#210 §7).
 *
 * The report is read-only, so the lines describe the ledger rather than plan an
 * action: `due` rows have passed their grace deadline and are still in the
 * ledger, `in-grace` rows are not candidates yet. Reachability is not judged
 * here — `index gc expire --dry-run` owns that verdict. A corrupt lease is
 * printed as `degraded`, because the next destructive pass will refuse on it.
 */
export function formatIndexGcStatus(report: GcStatusReport): string {
  const lines = [
    `gc status: ${report.status}`,
    renderLease(report.lease),
    `quarantine ${report.quarantine.total} (due ${report.quarantine.due}, in-grace ${report.quarantine.inGrace})`,
  ];
  for (const row of report.quarantine.rows) {
    lines.push(`  ${row.due ? 'due' : 'in-grace'} ${renderTarget(row.target)} until ${row.expiresAt ?? 'unreadable'}`);
  }
  return lines.join('\n');
}

/** A corrupt lease is a real answer, so it reports and exits non-zero. */
export function indexGcStatusExitCode(report: GcStatusReport): number {
  return report.status === 'healthy' ? 0 : 1;
}
