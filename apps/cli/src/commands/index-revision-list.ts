import { appError, err, ok, type Result } from '@unified-mpc/domain';
import type { CanonicalRevisionListReport } from '@unified-mpc/workspace';

export interface IndexRevisionListCommand {
  readonly kind: 'index-revision-list';
  /** Print the unprojected report instead of the operator lines. */
  readonly json: boolean;
}

const INDEX_REVISION_LIST_USAGE = 'Usage: unified-mpc index revision list [--json]';

export function parseIndexRevisionListArgs(
  args: readonly string[],
): Result<IndexRevisionListCommand> {
  if (args[0] !== 'revision' || args[1] !== 'list') {
    return err(appError('INVALID_INPUT', INDEX_REVISION_LIST_USAGE));
  }

  let json = false;
  for (const argument of args.slice(2)) {
    if (argument !== '--json' || json) return err(appError('INVALID_INPUT', INDEX_REVISION_LIST_USAGE));
    json = true;
  }
  return ok({ kind: 'index-revision-list', json });
}

/**
 * Render the stored revision manifests (#210 §7).
 *
 * One summary line per revision carries the exact evidence a prune decision
 * needs — manifest id, commit, tree, entry count and creation time — and every
 * detail line is printed only when a store still references that revision, so
 * an unreachable revision is visibly bare rather than described as active.
 */
export function formatCanonicalRevisionList(report: CanonicalRevisionListReport): string {
  const lines = [`revisions ${report.revisions.length}`];
  for (const revision of report.revisions) {
    lines.push(
      `  ${revision.manifestId} commit ${revision.commitSha} tree ${revision.treeOid}`
        + ` entries ${revision.entryCount} created ${revision.createdAt}`,
    );
    if (revision.refs.length > 0) lines.push(`    refs ${revision.refs.join(' ')}`);
    if (revision.pins.length > 0) lines.push(`    pins ${revision.pins.join(' ')}`);
    if (revision.overlayGoalIds.length > 0) lines.push(`    overlay-bases ${revision.overlayGoalIds.join(' ')}`);
    if (revision.indexJobOperationIds.length > 0) lines.push(`    index-jobs ${revision.indexJobOperationIds.join(' ')}`);
  }
  return lines.join('\n');
}
