import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { RepositoryMergePolicy } from '@unified-mpc/domain';
import {
  advanceRevisionFromGit,
  CanonicalManifestStore,
  CanonicalRefStore,
  repositoryIdForRemoteUrl,
  type CanonicalGitSource,
  type GitRevisionAdvanceResult,
} from '@unified-mpc/workspace';

import { createCanonicalGitSource } from './canonical-git-source.js';
import { githubRepositoryFromRemote } from './github-remote.js';

const execFileAsync = promisify(execFile);

const FETCH_TIMEOUT_MS = 120_000;
const ANCESTRY_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 4 * 1024 * 1024;
/** Object id width: SHA-1 repositories use 40, SHA-256 repositories use 64. */
const COMMIT_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export interface CanonicalAdvanceRequest {
  readonly policy: RepositoryMergePolicy;
  /** Exact commit the merge produced; the fetched ref must contain it. */
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
  /** Test seam: ancestry without spawning Git. */
  readonly isAncestor?: (checkoutPath: string, ancestor: string, descendant: string) => Promise<boolean>;
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

/**
 * Project one gate result onto the poller's outcome vocabulary.
 *
 * Exported so every branch — including the concurrent-promotion conflict that
 * is hard to stage through the gate — is covered by a direct test.
 */
export function canonicalAdvanceOutcome(
  result: GitRevisionAdvanceResult,
  targetRef: string,
): CanonicalAdvanceOutcome {
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
}

async function fetchBranch(checkoutPath: string, branch: string): Promise<void> {
  // Explicit refspec: the update must not depend on the checkout's configured
  // fetch refspec, and a force-updated branch still has to land on the exact
  // commit the merge reported.
  await execFileAsync(
    'git',
    ['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${branch}:${canonicalRefForBranch(branch)}`],
    { cwd: checkoutPath, timeout: FETCH_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER },
  );
}

async function gitIsAncestor(checkoutPath: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['merge-base', '--is-ancestor', ancestor, descendant],
      { cwd: checkoutPath, timeout: ANCESTRY_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER });
    return true;
  } catch (error) {
    // Exit code 1 is Git's "not an ancestor" answer. Anything else (missing
    // object, spawn failure) means the question could not be answered, and an
    // unanswered ancestry question must not authorize an advance.
    if ((error as { code?: unknown }).code === 1) return false;
    throw error;
  }
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
 * - the canonical store is already bound to another repository: refused. One
 *   canonical root holds one repository namespace (`refs/...` carries no
 *   repository id), so a second repository advancing the same branch would
 *   overwrite the first ref and unroot its manifest from GC;
 * - the fetch fails or the ref does not resolve: refused, because an advance
 *   against a checkout that cannot see the merge would record a different
 *   revision;
 * - the fetched ref does not contain the merged commit: refused as a stale
 *   checkout. Advancing anyway would move the canonical ref *backwards* when
 *   the local clone lags behind, which is worse than reporting the lag;
 * - the ref moves between the ancestry check and the gate's own resolution:
 *   refused, because the gate would otherwise promote a commit no check saw;
 * - the gate itself refuses (unverifiable base manifest, unsupported tree
 *   entry, concurrent promotion): passed through unchanged.
 */
export function createCanonicalMergeAdvance(deps: CanonicalMergeAdvanceDeps): CanonicalAdvanceAfterMerge {
  const now = deps.now ?? ((): Date => new Date());
  const sourceFor = deps.sourceFor ?? createCanonicalGitSource;
  const fetch = deps.fetchBranch ?? fetchBranch;
  const isAncestor = deps.isAncestor ?? gitIsAncestor;

  return async (request: CanonicalAdvanceRequest): Promise<CanonicalAdvanceOutcome> => {
    const { policy } = request;
    const checkoutPath = policy.checkoutPath;
    if (checkoutPath === undefined) {
      return refused(`no checkout mapped for ${policy.repository}; set checkoutPath to advance its canonical ref`);
    }
    const expectedCommitSha = request.expectedCommitSha.trim().toLowerCase();
    if (!COMMIT_SHA.test(expectedCommitSha)) {
      return refused(`merged commit '${request.expectedCommitSha}' is not an exact Git commit id`);
    }

    const targetRef = canonicalRefForBranch(policy.defaultBranch);
    const source = sourceFor(checkoutPath);

    let repositoryId: string;
    try {
      const remote = await source.remoteUrl();
      if (remote === null) {
        return refused(`${checkoutPath} has no remote; the canonical trust boundary is unknown`);
      }
      // The checkout must be the repository the policy is about. Without this
      // check a wrong or shared `checkoutPath` would fetch *that* repository's
      // branch, promote its tree under this policy, and bind the canonical ref
      // to the wrong repository id — permanently refusing the correct checkout.
      const remoteRepository = await githubRepositoryFromRemote(remote).catch(() => undefined);
      if (remoteRepository === undefined
        || remoteRepository.toLowerCase() !== policy.repository.trim().toLowerCase()) {
        return refused(
          `${checkoutPath} origin is ${remoteRepository ?? 'not a verified github.com repository'}, not ${policy.repository}`,
        );
      }
      repositoryId = repositoryIdForRemoteUrl(remote);
    } catch (error) {
      return refused(`cannot read the remote of ${checkoutPath}: ${errorMessage(error)}`);
    }

    // One canonical root holds one repository namespace. Refusing here keeps a
    // second policy from silently replacing the first repository's ref.
    try {
      const bound = await boundedRepository(deps.canonicalRoot, targetRef);
      if (bound !== undefined && bound !== repositoryId) {
        return refused(`${targetRef} in the canonical store is bound to ${bound}, not ${repositoryId}`);
      }
    } catch (error) {
      return refused(`cannot read the canonical ref ${targetRef}: ${errorMessage(error)}`);
    }

    try {
      await fetch(checkoutPath, policy.defaultBranch);
    } catch (error) {
      return refused(`cannot fetch ${policy.defaultBranch} in ${checkoutPath}: ${errorMessage(error)}`);
    }

    let resolved;
    try {
      resolved = await source.resolveRevision(targetRef);
    } catch (error) {
      return refused(`cannot resolve ${targetRef} in ${checkoutPath}: ${errorMessage(error)}`);
    }
    if (resolved === null) {
      return refused(`${targetRef} does not resolve in ${checkoutPath}`);
    }

    let ancestor: boolean;
    try {
      ancestor = await isAncestor(checkoutPath, expectedCommitSha, resolved.commitSha);
    } catch (error) {
      return refused(`cannot verify ${expectedCommitSha} is on ${targetRef}: ${errorMessage(error)}`);
    }
    if (!ancestor) {
      return refused(`${targetRef} at ${resolved.commitSha} does not contain the merged commit ${expectedCommitSha}`);
    }

    const result = await advanceRevisionFromGit({
      root: deps.canonicalRoot,
      source,
      targetRef,
      now: now(),
      repositoryId,
      // Pin the commit the ancestry check approved: the gate resolves the ref
      // again, and a fetch landing in between must refuse rather than promote a
      // commit nothing verified.
      commitSha: resolved.commitSha,
    });
    return canonicalAdvanceOutcome(result, targetRef);
  };
}

/**
 * Repository id the active ref is bound to, or undefined when no ref exists.
 *
 * The read is strict: a corrupt ref file must not read as "unbound" and get
 * overwritten as a first-ever promotion, so the caller's catch turns an
 * unreadable ref into a refusal.
 */
async function boundedRepository(canonicalRoot: string, targetRef: string): Promise<string | undefined> {
  const active = await new CanonicalRefStore(canonicalRoot).read(targetRef, { strict: true });
  if (active === null) return undefined;
  const manifest = await new CanonicalManifestStore(canonicalRoot).get(active.manifestId);
  return manifest?.repositoryId;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
