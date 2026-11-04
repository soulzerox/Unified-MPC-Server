import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { RepositoryMergePolicy } from '@unified-mpc/domain';
import { advanceRevisionFromGit, type CanonicalGitSource } from '@unified-mpc/workspace';

import { createCanonicalGitSource } from './canonical-git-source.js';

const execFileAsync = promisify(execFile);

const FETCH_TIMEOUT_MS = 120_000;
const FETCH_MAX_BUFFER = 4 * 1024 * 1024;

export interface CanonicalAdvanceRequest {
  readonly policy: RepositoryMergePolicy;
  /** Exact commit the merge produced; the local ref must already be there. */
  readonly expectedCommitSha: string;
}

export type CanonicalAdvanceOutcome =
  | {
    readonly status: 'advanced' | 'noop';
    readonly ref: string;
    readonly commitSha: string;
    readonly manifestId: string;
    readonly reusedPaths: number;
    readonly changedPaths: number;
  }
  | { readonly status: 'refused'; readonly reason: string };

/** One advancement step, called once per repository after a merge is reconciled. */
export type CanonicalAdvanceAfterMerge = (request: CanonicalAdvanceRequest) => Promise<CanonicalAdvanceOutcome>;

export interface CanonicalMergeAdvanceDeps {
  /** Root of the canonical store; refs, manifests and artifacts live beneath it. */
  readonly canonicalRoot: string;
  readonly now?: () => Date;
  /** Test seam: fetch without spawning Git. Production fetches the exact branch. */
  readonly fetchBranch?: (checkoutPath: string, branch: string) => Promise<void>;
  /** Test seam: the Git view of one checkout. Production shells out to Git. */
  readonly sourceFor?: (checkoutPath: string) => CanonicalGitSource;
}

function refused(reason: string): CanonicalAdvanceOutcome {
  return { status: 'refused', reason };
}

/**
 * The remote-tracking ref a merge advance reads (#210 §2).
 *
 * `origin` is fixed rather than discovered: a policy names one repository, and
 * reading a second remote would advance the canonical ref from a different
 * trust boundary than the one the merge belongs to. A checkout that tracks a
 * differently named remote refuses below instead of picking one.
 */
export function canonicalRefForBranch(branch: string): string {
  return `refs/remotes/origin/${branch}`;
}

async function fetchBranch(checkoutPath: string, branch: string): Promise<void> {
  // Explicit refspec: the update must not depend on the checkout's configured
  // fetch refspec, and a force-updated branch still has to land on the exact
  // commit the merge reported.
  await execFileAsync(
    'git',
    ['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${branch}:${canonicalRefForBranch(branch)}`],
    { cwd: checkoutPath, timeout: FETCH_TIMEOUT_MS, maxBuffer: FETCH_MAX_BUFFER },
  );
}

/**
 * Advance the canonical ref after a merge was reconciled (#210 §3).
 *
 * This is the runtime half of the advancement gate: the gate itself
 * (`advanceRevisionFromGit`) was only reachable through the operator command
 * `index revision advance`, so nothing in production ever moved a canonical ref
 * and reuse stayed unobservable. One reconciled merge now drives one advance.
 *
 * Fail-closed rules, all reported instead of thrown:
 *
 * - no `checkoutPath` on the policy: refused, never inferred from the
 *   repository name or the workspace registry;
 * - the fetch fails or the ref does not resolve: refused, because an advance
 *   against a checkout that cannot see the merge would record a different
 *   revision;
 * - the local ref is not the commit the merge produced: refused as a stale
 *   checkout. Advancing anyway would move the canonical ref *backwards* when
 *   the local clone lags behind, which is worse than reporting the lag;
 * - the gate itself refuses (unverifiable base manifest, unsupported tree
 *   entry, concurrent promotion): passed through unchanged.
 */
export function createCanonicalMergeAdvance(deps: CanonicalMergeAdvanceDeps): CanonicalAdvanceAfterMerge {
  const now = deps.now ?? ((): Date => new Date());
  const sourceFor = deps.sourceFor ?? createCanonicalGitSource;
  const fetch = deps.fetchBranch ?? fetchBranch;

  return async (request: CanonicalAdvanceRequest): Promise<CanonicalAdvanceOutcome> => {
    const { policy } = request;
    const checkoutPath = policy.checkoutPath;
    if (checkoutPath === undefined) {
      return refused(`no checkout mapped for ${policy.repository}; set checkoutPath to advance its canonical ref`);
    }
    const expectedCommitSha = request.expectedCommitSha.trim().toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(expectedCommitSha)) {
      return refused(`merged commit '${request.expectedCommitSha}' is not an exact Git commit id`);
    }

    const targetRef = canonicalRefForBranch(policy.defaultBranch);
    try {
      await fetch(checkoutPath, policy.defaultBranch);
    } catch (error) {
      return refused(`cannot fetch ${policy.defaultBranch} in ${checkoutPath}: ${errorMessage(error)}`);
    }

    const source = sourceFor(checkoutPath);
    let resolved;
    try {
      resolved = await source.resolveRevision(targetRef);
    } catch (error) {
      return refused(`cannot resolve ${targetRef} in ${checkoutPath}: ${errorMessage(error)}`);
    }
    if (resolved === null) {
      return refused(`${targetRef} does not resolve in ${checkoutPath}`);
    }
    if (resolved.commitSha !== expectedCommitSha) {
      return refused(`${targetRef} is ${resolved.commitSha}, not the merged commit ${expectedCommitSha}`);
    }

    const result = await advanceRevisionFromGit({
      root: deps.canonicalRoot,
      source,
      targetRef,
      now: now(),
    });

    if (result.status === 'conflict') {
      return refused(`${targetRef} advanced concurrently (now ${result.currentCommitSha ?? 'unknown'})`);
    }
    if (result.status === 'refused') {
      return refused(result.reason);
    }
    return {
      status: result.status === 'promoted' ? 'advanced' : 'noop',
      ref: targetRef,
      commitSha: result.commitSha,
      manifestId: result.manifestId,
      reusedPaths: result.reuse.reusedPaths.length,
      changedPaths: result.reuse.newPaths.length,
    };
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
