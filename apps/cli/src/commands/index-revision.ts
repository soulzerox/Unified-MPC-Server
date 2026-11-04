import { appError, err, ok, type Result } from '@unified-mpc/domain';
import type { GitRevisionAdvanceResult } from '@unified-mpc/workspace';

export interface IndexRevisionAdvanceCommand {
  readonly kind: 'index-revision-advance';
  /** Git ref to advance the canonical pointer to; also the canonical ref key. */
  readonly ref: string;
  readonly repositoryId?: string;
  /** Print the unprojected report instead of the operator lines. */
  readonly json: boolean;
}

export type IndexRevisionCommand = IndexRevisionAdvanceCommand;

const INDEX_REVISION_USAGE = 'Usage: unified-mpc index revision advance [--ref <ref>] [--repository-id <id>] [--json]';

/** Default canonical ref: canonical main, not whatever HEAD happens to be. */
export const DEFAULT_CANONICAL_REF = 'refs/remotes/origin/main';

export function parseIndexRevisionArgs(args: readonly string[]): Result<IndexRevisionCommand> {
  if (args[0] !== 'revision') return err(appError('INVALID_INPUT', INDEX_REVISION_USAGE));
  if (args[1] !== 'advance') return err(appError('INVALID_INPUT', INDEX_REVISION_USAGE));

  const rest = args.slice(2);
  let ref: string | undefined;
  let repositoryId: string | undefined;
  let json = false;
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index]!;
    if (argument === '--json') {
      if (json) return err(appError('INVALID_INPUT', INDEX_REVISION_USAGE));
      json = true;
      continue;
    }
    if (argument === '--ref' || argument === '--repository-id') {
      const value = rest[index + 1];
      // A flag without a value, or with another flag as its value, must not be
      // guessed into the default ref.
      if (value === undefined || value.startsWith('--')) return err(appError('INVALID_INPUT', INDEX_REVISION_USAGE));
      if (argument === '--ref') {
        if (ref !== undefined) return err(appError('INVALID_INPUT', INDEX_REVISION_USAGE));
        ref = value;
      } else {
        if (repositoryId !== undefined) return err(appError('INVALID_INPUT', INDEX_REVISION_USAGE));
        repositoryId = value;
      }
      index += 1;
      continue;
    }
    return err(appError('INVALID_INPUT', INDEX_REVISION_USAGE));
  }

  const resolvedRef = ref ?? DEFAULT_CANONICAL_REF;
  // The canonical ref key and a Git ref must agree; a bare branch name would
  // make the store key ambiguous.
  if (!resolvedRef.startsWith('refs/') || resolvedRef.includes('..')) {
    return err(appError('INVALID_INPUT', INDEX_REVISION_USAGE));
  }
  return ok({
    kind: 'index-revision-advance',
    ref: resolvedRef,
    ...(repositoryId === undefined ? {} : { repositoryId }),
    json,
  });
}

/**
 * Render one advancement result (#210 §3/§11).
 *
 * The lines are the evidence, not a summary: the exact commit and Git tree the
 * manifest was built from, the reuse split that proves unchanged content was
 * reused rather than rebuilt, and the artifact split where `registered` counts
 * only artifacts this pass actually created.
 */
export function formatIndexRevisionAdvance(report: GitRevisionAdvanceResult): string {
  if (report.status === 'refused') {
    return `canonical ${report.targetRef}: refused\nreason ${report.reason}`;
  }
  if (report.status === 'conflict') {
    return `canonical ${report.targetRef}: conflict\ncurrent ${report.currentCommitSha ?? '<unset>'}`;
  }
  const artifacts = report.artifacts.status === 'registered'
    ? `artifacts reused=${report.artifacts.reused} registered=${report.artifacts.registered} unclassified=${report.artifacts.unclassified.length}`
    : `artifacts refused: ${report.artifacts.reason}`;
  return [
    `canonical ${report.targetRef}: ${report.status}`,
    `commit ${report.commitSha}`,
    `tree ${report.gitTreeOid}`,
    `manifest ${report.manifestId}`,
    `repository ${report.repositoryId}`,
    `reuse reused=${report.reuse.reusedPaths.length} new=${report.reuse.newPaths.length}`
      + ` renamed=${report.reuse.renamedPaths.length} deleted=${report.reuse.deletedPaths.length}`,
    artifacts,
  ].join('\n');
}

/**
 * A promotion whose artifact registration was refused is durable but
 * incomplete, so it must not exit zero: artifacts are re-derivable, but an
 * operator needs to know the store is half-populated.
 */
export function indexRevisionAdvanceExitCode(report: GitRevisionAdvanceResult): number {
  if (report.status === 'promoted' || report.status === 'noop') {
    return report.artifacts.status === 'registered' ? 0 : 1;
  }
  return 1;
}
