import { appError, err, ok, type Result } from '@unified-mpc/domain';
import type { GcCycleReport } from '@unified-mpc/workspace';

export interface IndexGcCommand {
  readonly kind: 'index-gc';
  /** The only supported mode: plan the GC cycle without quarantining anything. */
  readonly dryRun: true;
  /** Print the report as JSON instead of the operator lines. */
  readonly json: boolean;
}

const INDEX_GC_USAGE = 'Usage: unified-mpc index gc --dry-run [--json]';

const APPLY_UNSUPPORTED = 'index gc cannot quarantine yet: --apply is not supported, only --dry-run';

/**
 * Parse `index gc --dry-run`.
 *
 * `--dry-run` is required rather than defaulted so the verb cannot become a
 * mutation by omission. The real cycle quarantines and needs the cleanup lease;
 * that apply path lands separately. `--apply` is rejected with a specific
 * message so an operator learns the verb is read-only from the command itself.
 */
export function parseIndexGcArgs(args: readonly string[]): Result<IndexGcCommand> {
  if (args[0] !== 'gc') return err(appError('INVALID_INPUT', INDEX_GC_USAGE));

  let dryRun = false;
  let json = false;
  for (const argument of args.slice(1)) {
    if (argument === '--dry-run') {
      if (dryRun) return err(appError('INVALID_INPUT', INDEX_GC_USAGE));
      dryRun = true;
      continue;
    }
    if (argument === '--json') {
      if (json) return err(appError('INVALID_INPUT', INDEX_GC_USAGE));
      json = true;
      continue;
    }
    if (argument === '--apply') return err(appError('INVALID_INPUT', APPLY_UNSUPPORTED));
    return err(appError('INVALID_INPUT', INDEX_GC_USAGE));
  }

  if (!dryRun) return err(appError('INVALID_INPUT', INDEX_GC_USAGE));
  return ok({ kind: 'index-gc', dryRun: true, json });
}

/**
 * Render the dry-run GC cycle plan (#210 §7/§11).
 *
 * Two spaces are reported because they are planned by different reachability
 * rules: `unreachable` hashes come from manifest entries, while
 * `artifact-unreachable` records are scoped to one repository. Nothing is
 * quarantined or deleted, and a refused plan is printed as the safety verdict
 * it is rather than as an empty plan.
 */
export function formatIndexGc(report: GcCycleReport): string {
  if (report.status === 'refused') return `refused ${report.reason}`;
  const lines = [
    `planned (dry-run) reachable ${report.reachable.length} unreachable ${report.unreachable.length}`
      + ` artifact-unreachable ${report.unreachableArtifacts.length}`,
  ];
  for (const contentHash of report.unreachable) lines.push(`unreachable ${contentHash}`);
  for (const artifact of report.unreachableArtifacts) {
    lines.push(`artifact-unreachable ${artifact.repositoryId} ${artifact.artifactKey}`);
  }
  return lines.join('\n');
}

/** A refused plan is a blocking condition for the store, not a successful read. */
export function indexGcExitCode(report: GcCycleReport): number {
  return report.status === 'planned' ? 0 : 1;
}
