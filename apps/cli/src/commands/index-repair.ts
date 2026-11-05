import { appError, err, ok, type Result } from '@unified-mpc/domain';
import type { CanonicalStoreRepairReport } from '@unified-mpc/workspace';

export interface IndexRepairCommand {
  readonly kind: 'index-repair';
  /** Report the orphan pins a repair would unpin (`--dry-run`) or unpin them (`--apply`). */
  readonly dryRun: boolean;
  /** Print the unprojected report instead of the operator lines. */
  readonly json: boolean;
}

const INDEX_REPAIR_USAGE = 'Usage: unified-mpc index repair --dry-run|--apply [--json]';

/**
 * Parse `index repair --dry-run|--apply`.
 *
 * Exactly one mode is required rather than defaulted: the verb both inspects
 * and removes store evidence, so an operator must always say which one they
 * mean. The parser only chooses the mode; the U28 GC lease that fences the
 * removal pass is taken inside the workspace layer, where the roots are
 * re-read.
 */
export function parseIndexRepairArgs(args: readonly string[]): Result<IndexRepairCommand> {
  if (args[0] !== 'repair') {
    return err(appError('INVALID_INPUT', INDEX_REPAIR_USAGE));
  }

  let mode: 'dry-run' | 'apply' | undefined;
  let json = false;
  for (const argument of args.slice(1)) {
    if (argument === '--dry-run' || argument === '--apply') {
      if (mode !== undefined) return err(appError('INVALID_INPUT', INDEX_REPAIR_USAGE));
      mode = argument === '--dry-run' ? 'dry-run' : 'apply';
      continue;
    }
    if (argument === '--json') {
      if (json) return err(appError('INVALID_INPUT', INDEX_REPAIR_USAGE));
      json = true;
      continue;
    }
    return err(appError('INVALID_INPUT', INDEX_REPAIR_USAGE));
  }

  if (mode === undefined) return err(appError('INVALID_INPUT', INDEX_REPAIR_USAGE));
  return ok({ kind: 'index-repair', dryRun: mode === 'dry-run', json });
}

/**
 * Render the canonical store repair report (#210 §7 `index_repair`).
 *
 * A dry run prints `repair` lines for the orphan pins it would remove; an apply
 * prints `removed` lines for pins from which it removed at least one reason,
 * listing only those reasons. A pin re-created before its first removal is
 * absent, and one re-created mid-removal appears with only the reasons already
 * removed. The two unrepairable degraded states are always printed with their
 * offending ids: they are operator action, not something this verb may delete.
 * A refused pass prints the reason and nothing else.
 */
export function formatCanonicalStoreRepair(report: CanonicalStoreRepairReport): string {
  if (report.status === 'refused') return `refused ${report.reason}`;
  const dryRun = report.status === 'planned';
  const lines = [
    dryRun
      ? `planned (dry-run) orphan-pins ${report.orphanPins.length}`
      : `applied orphan-pins ${report.orphanPins.length}`,
  ];
  for (const pin of report.orphanPins) {
    const reasons = pin.reasons.length === 0 ? '' : ` ${pin.reasons.join(',')}`;
    lines.push(`${dryRun ? 'repair' : 'removed'} ${pin.manifestId}${reasons}`);
  }
  lines.push(`dangling-refs ${report.danglingRefs.length}`);
  for (const dangling of report.danglingRefs) {
    lines.push(`  ${dangling.ref} ${dangling.manifestId}`);
  }
  lines.push(`missing-overlay-bases ${report.missingOverlayBases.length}`);
  for (const goalWorkspaceId of report.missingOverlayBases) {
    lines.push(`  ${goalWorkspaceId}`);
  }
  return lines.join('\n');
}

/**
 * Exit `0` only when the store is healthy after the plan/pass, `1` when it
 * refused or when unrepairable degraded state (dangling refs, missing overlay
 * bases) remains. A dry run is judged the same way as the apply it describes.
 */
export function indexRepairExitCode(report: CanonicalStoreRepairReport): number {
  if (report.status === 'refused') return 1;
  return report.danglingRefs.length === 0 && report.missingOverlayBases.length === 0 ? 0 : 1;
}
