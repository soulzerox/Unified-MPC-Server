import { appError, err, ok, type Result } from '@unified-mpc/domain';
import type { GcExpireReport, QuarantineTarget } from '@unified-mpc/workspace';

export interface IndexGcExpireCommand {
  readonly kind: 'index-gc-expire';
  /** The only supported mode: plan expiry and deletion without deleting anything. */
  readonly dryRun: true;
  /** Print the report as JSON instead of the operator lines. */
  readonly json: boolean;
}

const INDEX_GC_EXPIRE_USAGE = 'Usage: unified-mpc index gc expire --dry-run [--json]';

const APPLY_UNSUPPORTED = 'index gc expire cannot delete yet: --apply is not supported, only --dry-run';

/**
 * Parse `index gc expire --dry-run`.
 *
 * The expire pass releases quarantine rows and calls the physical-delete
 * callbacks, so it is the most destructive GC step. `--dry-run` is required
 * rather than defaulted, and `--apply` is rejected with a specific message so an
 * operator learns the verb is read-only instead of assuming the plan ran.
 */
export function parseIndexGcExpireArgs(args: readonly string[]): Result<IndexGcExpireCommand> {
  if (args[0] !== 'gc' || args[1] !== 'expire') {
    return err(appError('INVALID_INPUT', INDEX_GC_EXPIRE_USAGE));
  }

  let dryRun = false;
  let json = false;
  for (const argument of args.slice(2)) {
    if (argument === '--dry-run') {
      if (dryRun) return err(appError('INVALID_INPUT', INDEX_GC_EXPIRE_USAGE));
      dryRun = true;
      continue;
    }
    if (argument === '--json') {
      if (json) return err(appError('INVALID_INPUT', INDEX_GC_EXPIRE_USAGE));
      json = true;
      continue;
    }
    if (argument === '--apply') return err(appError('INVALID_INPUT', APPLY_UNSUPPORTED));
    return err(appError('INVALID_INPUT', INDEX_GC_EXPIRE_USAGE));
  }

  if (!dryRun) return err(appError('INVALID_INPUT', INDEX_GC_EXPIRE_USAGE));
  return ok({ kind: 'index-gc-expire', dryRun: true, json });
}

/** One quarantine row: a bare content hash, or repository + artifact key. */
function renderTarget(target: QuarantineTarget): string {
  return typeof target === 'string'
    ? target
    : `${target.repositoryId} ${target.artifactKey}`;
}

/**
 * Render the dry-run expire plan (#210 U23/§7).
 *
 * `expire` rows have passed their grace deadline and are still unreachable in
 * this pass's re-check; `retain` rows are either inside grace or became
 * reachable again. Nothing is released or deleted, and a refused plan is printed
 * as the safety verdict it is rather than as an empty plan.
 */
export function formatIndexGcExpire(report: GcExpireReport): string {
  if (report.status === 'refused') return `refused ${report.reason}`;
  const lines = [
    `planned (dry-run) expired ${report.expired.length} retained ${report.retained.length}`,
  ];
  for (const target of report.expired) lines.push(`expire ${renderTarget(target)}`);
  for (const target of report.retained) lines.push(`retain ${renderTarget(target)}`);
  return lines.join('\n');
}

/** A refused plan is a blocking condition for the store, not a successful read. */
export function indexGcExpireExitCode(report: GcExpireReport): number {
  return report.status === 'planned' ? 0 : 1;
}
