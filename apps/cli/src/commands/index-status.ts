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
 * when it is healthy; detail lines are printed per stored row, and offending
 * ids are printed only when present, because an empty section is noise. The
 * verdict is the store's own consistency check (dangling refs, missing overlay
 * bases, orphaned pins), never a guess.
 *
 * A ref keeps its revision, tree and manifest identity apart on one line. An
 * overlay reports its base as `live`, `drifted` or `missing`; `drifted` is the
 * same condition Goal admission refuses, reported here without changing the
 * store verdict. A job reports whether the manifest it pins still exists.
 */
export function formatCanonicalStatus(report: CanonicalStatusReport): string {
  const lines = [
    `canonical store: ${report.status}`,
    `refs ${report.refs.length}`,
  ];
  for (const ref of report.refs) {
    if (!ref.manifestExists) {
      lines.push(`  ${ref.ref} ${ref.manifestId} commit ${ref.commitSha} manifest-missing`);
      continue;
    }
    const pin = ref.pinned ? ` pinned ${ref.pinReasons.join(',') || '-'}` : '';
    lines.push(
      `  ${ref.ref} ${ref.manifestId} commit ${ref.commitSha} tree ${ref.treeOid}`
        + ` entries ${ref.manifestEntryCount}${pin}`,
    );
  }
  lines.push(
    `manifests ${report.manifestCount}`,
    `pins ${report.pinCount}`,
    `overlays ${report.overlayCount}`,
  );
  for (const overlay of report.overlays) {
    const base = !overlay.baseManifestExists
      ? 'missing'
      : overlay.baseMatchesLiveRef ? 'live' : 'drifted';
    lines.push(
      `  goal ${overlay.goalWorkspaceId} base ${overlay.baseManifestId} commit ${overlay.baseCommitSha}`
        + ` entries modified=${overlay.modifiedCount} added=${overlay.addedCount} deleted=${overlay.deletedCount}`
        + ` base=${base} updated ${overlay.updatedAt}`,
    );
  }
  lines.push(
    `quarantined ${report.quarantinedCount}`,
    `active-jobs ${report.activeJobCount}`,
  );
  for (const job of report.jobs) {
    lines.push(
      `  ${job.operationId} ${job.manifestId} ${job.status} opened ${job.openedAt}`
        + ` manifest=${job.manifestExists ? 'present' : 'missing'}`,
    );
  }
  lines.push(`dangling-refs ${report.danglingRefs.length}`);
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
