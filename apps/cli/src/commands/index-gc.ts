import { appError, err, ok, type Result } from '@unified-mpc/domain';
import type { GcCycleReport, MaintenanceCycleReport } from '@unified-mpc/workspace';

export interface IndexGcCommand {
  readonly kind: 'index-gc';
  /** `--dry-run` plans; `--apply` is the only mutating mode. */
  readonly dryRun: boolean;
  /** Quarantine grace stamped on every row of an apply pass. */
  readonly graceMs: number;
  /** Print the report as JSON instead of the operator lines. */
  readonly json: boolean;
}

const INDEX_GC_USAGE = 'Usage: unified-mpc index gc (--dry-run | --apply [--grace <duration>]) [--json]';

/** One week: the documented default quarantine window (#210 §7). */
export const DEFAULT_GC_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

const DURATION = /^([1-9][0-9]*)([smhd])$/;
const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * Parse a positive `<n><s|m|h|d>` duration into milliseconds.
 *
 * Deliberately small: operators write `7d`, `12h`, `30m`. Zero is rejected so a
 * `--grace 0s` cannot turn the quarantine window into an instant delete, and
 * anything else is a usage error rather than a silently ignored flag.
 */
export function parseGcGrace(value: string): number | null {
  const match = DURATION.exec(value);
  if (match === null) return null;
  const units = Number(match[1]);
  const unitMs = UNIT_MS[match[2] ?? ''];
  if (!Number.isSafeInteger(units) || unitMs === undefined) return null;
  const graceMs = units * unitMs;
  return Number.isSafeInteger(graceMs) ? graceMs : null;
}

/**
 * Parse `index gc --dry-run|--apply [--grace <duration>] [--json]`.
 *
 * Exactly one mode is required, never defaulted: the verb must not become a
 * mutation by omission, and a dry run is the documented way to inspect the plan
 * before applying it. `--grace` only makes sense on the mutating pass — the
 * plan does not stamp a deadline — so pairing it with `--dry-run` is a usage
 * error instead of a flag that silently does nothing.
 */
export function parseIndexGcArgs(args: readonly string[]): Result<IndexGcCommand> {
  if (args[0] !== 'gc') return err(appError('INVALID_INPUT', INDEX_GC_USAGE));

  let dryRun: boolean | undefined;
  let graceMs: number | undefined;
  let json = false;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--dry-run') {
      if (dryRun !== undefined) return err(appError('INVALID_INPUT', INDEX_GC_USAGE));
      dryRun = true;
      continue;
    }
    if (argument === '--apply') {
      if (dryRun !== undefined) return err(appError('INVALID_INPUT', INDEX_GC_USAGE));
      dryRun = false;
      continue;
    }
    if (argument === '--json') {
      if (json) return err(appError('INVALID_INPUT', INDEX_GC_USAGE));
      json = true;
      continue;
    }
    if (argument === '--grace') {
      if (graceMs !== undefined) return err(appError('INVALID_INPUT', INDEX_GC_USAGE));
      const value = args[index + 1];
      if (value === undefined) return err(appError('INVALID_INPUT', INDEX_GC_USAGE));
      const parsed = parseGcGrace(value);
      if (parsed === null) return err(appError('INVALID_INPUT', INDEX_GC_USAGE));
      graceMs = parsed;
      index += 1;
      continue;
    }
    return err(appError('INVALID_INPUT', INDEX_GC_USAGE));
  }

  if (dryRun === undefined) return err(appError('INVALID_INPUT', INDEX_GC_USAGE));
  if (graceMs !== undefined && dryRun) return err(appError('INVALID_INPUT', INDEX_GC_USAGE));
  return ok({ kind: 'index-gc', dryRun, graceMs: graceMs ?? DEFAULT_GC_GRACE_MS, json });
}

/**
 * Render the GC cycle report (#210 §7/§11).
 *
 * Two spaces are reported because they are planned by different reachability
 * rules: `unreachable` hashes come from manifest entries, while
 * `artifact-unreachable` records are scoped to one repository. The mode is
 * passed in rather than guessed from the report: a dry run says
 * `planned (dry-run)` and lists candidates, while an apply pass says `applied`
 * and lists the rows it actually wrote to the quarantine ledger. A refused
 * pass is printed as the safety verdict it is rather than as an empty plan.
 */
export function formatIndexGc(report: GcCycleReport, dryRun: boolean): string {
  if (report.status === 'refused') return `refused ${report.reason}`;
  return dryRun ? renderPlan(report) : renderApplied(report);
}

function renderPlan(report: Extract<GcCycleReport, { status: 'planned' }>): string {
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

function renderApplied(report: Extract<GcCycleReport, { status: 'planned' }>): string {
  const lines = [
    `applied quarantined ${report.quarantined.length}`
      + ` artifact-quarantined ${report.quarantinedArtifacts.length}`,
  ];
  for (const contentHash of report.quarantined) lines.push(`quarantined ${contentHash}`);
  for (const artifact of report.quarantinedArtifacts) {
    lines.push(`artifact-quarantined ${artifact.repositoryId} ${artifact.artifactKey}`);
  }
  return lines.join('\n');
}

/** A refused plan is a blocking condition for the store, not a successful read. */
export function indexGcExitCode(report: GcCycleReport): number {
  return report.status === 'planned' ? 0 : 1;
}

export interface IndexMaintenanceCommand {
  readonly kind: 'index-maintenance';
  /** `--dry-run` plans; `--apply` is the only mutating mode. */
  readonly dryRun: boolean;
  /** Print the cycle report as JSON instead of the operator lines. */
  readonly json: boolean;
}

const INDEX_MAINTENANCE_USAGE = 'Usage: unified-mpc index maintenance (--dry-run | --apply) [--json]';

/**
 * Parse `index maintenance --dry-run|--apply [--json]`.
 *
 * Exactly one mode is required, never defaulted, for the same reason as
 * `index gc`: the verb must not become a mutation by omission. There is no
 * `--grace`: the maintenance cycle runs one bounded pass with the documented
 * default quarantine window, so a flag that only one inner verb understood
 * would silently do nothing.
 */
export function parseIndexMaintenanceArgs(args: readonly string[]): Result<IndexMaintenanceCommand> {
  if (args[0] !== 'maintenance') return err(appError('INVALID_INPUT', INDEX_MAINTENANCE_USAGE));

  let dryRun: boolean | undefined;
  let json = false;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--dry-run') {
      if (dryRun !== undefined) return err(appError('INVALID_INPUT', INDEX_MAINTENANCE_USAGE));
      dryRun = true;
      continue;
    }
    if (argument === '--apply') {
      if (dryRun !== undefined) return err(appError('INVALID_INPUT', INDEX_MAINTENANCE_USAGE));
      dryRun = false;
      continue;
    }
    if (argument === '--json') {
      if (json) return err(appError('INVALID_INPUT', INDEX_MAINTENANCE_USAGE));
      json = true;
      continue;
    }
    return err(appError('INVALID_INPUT', INDEX_MAINTENANCE_USAGE));
  }

  if (dryRun === undefined) return err(appError('INVALID_INPUT', INDEX_MAINTENANCE_USAGE));
  return ok({ kind: 'index-maintenance', dryRun, json });
}

/**
 * Render one maintenance cycle report (#210 §3, §5-§7).
 *
 * The cycle's own verdict is the only summary: a refusal is printed as the
 * safety decision it is — token plus the deciding component's detail, so an
 * operator sees the holder, the numbers or the degraded counts rather than an
 * opaque token — a skip as a successful "nothing to do", and a completed pass
 * keeps the existing GC plan/apply lines instead of inventing a second
 * rendering of the same counts.
 */
export function formatIndexMaintenance(report: MaintenanceCycleReport, dryRun: boolean): string {
  if (report.status === 'refused') return `refused ${report.reason}: ${report.detail}`;
  if (report.status === 'skipped') return `skipped ${report.reason}`;
  const mode = dryRun ? 'dry-run' : 'applied';
  return [
    `completed (${mode}) verification ${report.verification.status} manifests ${report.verification.manifests.length}`,
    formatIndexGc(report.gc, dryRun),
  ].join('\n');
}

/** A refusal blocks the store; a skip and a completed pass are both success. */
export function indexMaintenanceExitCode(report: MaintenanceCycleReport): number {
  return report.status === 'refused' ? 1 : 0;
}
