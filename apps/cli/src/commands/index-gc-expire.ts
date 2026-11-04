import { appError, err, ok, type Result } from '@unified-mpc/domain';
import type { GcExpireReport, QuarantineTarget } from '@unified-mpc/workspace';

export interface IndexGcExpireCommand {
  readonly kind: 'index-gc-expire';
  /** `--dry-run` plans; `--apply` releases due rows and calls the delete callbacks. */
  readonly dryRun: boolean;
  /** Print the report as JSON instead of the operator lines. */
  readonly json: boolean;
}

const INDEX_GC_EXPIRE_USAGE = 'Usage: unified-mpc index gc expire (--dry-run | --apply) [--json]';

/**
 * Parse `index gc expire --dry-run|--apply`.
 *
 * Exactly one mode is required, never defaulted: this is the most destructive
 * GC step — it releases quarantine rows and calls the physical-delete
 * callbacks — so it must not become a mutation by omission. A plan stamps no
 * deadline and takes no lease; the apply pass owns both.
 */
export function parseIndexGcExpireArgs(args: readonly string[]): Result<IndexGcExpireCommand> {
  if (args[0] !== 'gc' || args[1] !== 'expire') {
    return err(appError('INVALID_INPUT', INDEX_GC_EXPIRE_USAGE));
  }

  let dryRun: boolean | undefined;
  let json = false;
  for (const argument of args.slice(2)) {
    if (argument === '--dry-run') {
      if (dryRun !== undefined) return err(appError('INVALID_INPUT', INDEX_GC_EXPIRE_USAGE));
      dryRun = true;
      continue;
    }
    if (argument === '--apply') {
      if (dryRun !== undefined) return err(appError('INVALID_INPUT', INDEX_GC_EXPIRE_USAGE));
      dryRun = false;
      continue;
    }
    if (argument === '--json') {
      if (json) return err(appError('INVALID_INPUT', INDEX_GC_EXPIRE_USAGE));
      json = true;
      continue;
    }
    return err(appError('INVALID_INPUT', INDEX_GC_EXPIRE_USAGE));
  }

  if (dryRun === undefined) return err(appError('INVALID_INPUT', INDEX_GC_EXPIRE_USAGE));
  return ok({ kind: 'index-gc-expire', dryRun, json });
}

/** One quarantine row: a bare content hash, or repository + artifact key. */
function renderTarget(target: QuarantineTarget): string {
  return typeof target === 'string'
    ? target
    : `${target.repositoryId} ${target.artifactKey}`;
}

/**
 * Render the quarantine expire report (#210 U23/§7).
 *
 * `expired` rows have passed their grace deadline and are still unreachable in
 * this pass's re-check; `retained` rows are either inside grace or became
 * reachable again. The mode is passed in rather than guessed: a dry run says
 * `planned (dry-run)` and lists candidates, while an apply pass says `applied`
 * and lists the rows it released, so a released row is never mistaken for a
 * planned one. A refused pass is printed as the safety verdict it is.
 */
export function formatIndexGcExpire(report: GcExpireReport, dryRun: boolean): string {
  if (report.status === 'refused') return `refused ${report.reason}`;
  if (dryRun) {
    const lines = [
      `planned (dry-run) expired ${report.expired.length} retained ${report.retained.length}`,
    ];
    for (const target of report.expired) lines.push(`expire ${renderTarget(target)}`);
    for (const target of report.retained) lines.push(`retain ${renderTarget(target)}`);
    return lines.join('\n');
  }
  const lines = [
    `applied due ${report.expired.length} released ${report.deleted.length}`
      + ` retained ${report.retained.length}`,
  ];
  for (const target of report.deleted) lines.push(`released ${renderTarget(target)}`);
  for (const target of report.retained) lines.push(`retain ${renderTarget(target)}`);
  return lines.join('\n');
}

/** A refused plan is a blocking condition for the store, not a successful read. */
export function indexGcExpireExitCode(report: GcExpireReport): number {
  return report.status === 'planned' ? 0 : 1;
}
