import { appError, err, ok, type Result } from '@unified-mpc/domain';
import type { CanonicalStatusReport } from '@unified-mpc/workspace';

export interface IndexStatusCommand {
  readonly kind: 'index-status';
  /** Print the unprojected report instead of the operator lines. */
  readonly json: boolean;
}

const INDEX_STATUS_USAGE = 'Usage: unified-mpc index status [--json]';

export function parseIndexStatusArgs(args: readonly string[]): Result<IndexStatusCommand> {
  if (args[0] !== 'status') return err(appError('INVALID_INPUT', INDEX_STATUS_USAGE));

  let json = false;
  for (const argument of args.slice(1)) {
    if (argument !== '--json' || json) return err(appError('INVALID_INPUT', INDEX_STATUS_USAGE));
    json = true;
  }
  return ok({ kind: 'index-status', json });
}

/**
 * Render the canonical store status projection (#210 §7/§11).
 *
 * Counts are always printed so an operator can see the shape of the store even
 * when it is healthy; offending ids are printed only when present, because an
 * empty section is noise. The verdict is the store's own consistency check
 * (dangling refs, missing overlay bases, orphaned pins), never a guess.
 */
export function formatCanonicalStatus(report: CanonicalStatusReport): string {
  const lines = [
    `canonical store: ${report.status}`,
    `refs ${report.refs.length}`,
  ];
  for (const ref of report.refs) {
    lines.push(`  ${ref.ref} ${ref.manifestId} commit ${ref.commitSha}`);
  }
  lines.push(
    `manifests ${report.manifestCount}`,
    `pins ${report.pinCount}`,
    `overlays ${report.overlayCount}`,
    `quarantined ${report.quarantinedCount}`,
    `active-jobs ${report.activeJobCount}`,
    `dangling-refs ${report.danglingRefs.length}`,
  );
  for (const dangling of report.danglingRefs) {
    lines.push(`  ${dangling.ref} ${dangling.manifestId}`);
  }
  lines.push(`missing-overlay-bases ${report.missingOverlayBases.length}`);
  for (const goalWorkspaceId of report.missingOverlayBases) {
    lines.push(`  ${goalWorkspaceId}`);
  }
  lines.push(`orphaned-pins ${report.orphanedPins.length}`);
  for (const manifestId of report.orphanedPins) {
    lines.push(`  ${manifestId}`);
  }
  return lines.join('\n');
}

/** A degraded store is a real answer, so it reports and exits non-zero. */
export function indexStatusExitCode(report: CanonicalStatusReport): number {
  return report.status === 'healthy' ? 0 : 1;
}
