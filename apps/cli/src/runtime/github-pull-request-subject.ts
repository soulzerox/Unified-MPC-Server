import { appError, err, ok, type Result } from '@unified-mpc/domain';
import type {
  GuardedMergeAuthoritativeSubject,
  GuardedMergeSubjectSource,
} from '@unified-mpc/application';
import type { GitHubApiReader } from './github-merge-observer.js';

const SHA_PATTERN = /^[a-f0-9]{40,64}$/i;

/** The pull request identity GitHub currently reports, never the caller's claim. */
export interface OpenPullRequestSubject {
  readonly repository: string;
  readonly pullRequest: number;
  readonly headSha: string;
  readonly baseSha: string;
  readonly baseBranch: string;
}

/**
 * Reads one open, unmerged pull request and returns the exact subject GitHub
 * holds. Both the verification runner and the guarded merge need this, and they
 * need the same answer: a receipt is only meaningful for the head the provider
 * has, and a merge is only authorized into the base the provider names.
 *
 * Every failure is a refusal: a closed or merged PR, a PR from another
 * repository, an unreadable response. The caller must never fall back to the
 * subject it was given.
 */
export async function observeOpenPullRequest(
  github: GitHubApiReader,
  repository: string,
  pullRequest: number,
): Promise<Result<OpenPullRequestSubject>> {
  try {
    const { owner, repo } = repositoryCoordinates(repository);
    const raw = requiredRecord(await github.get(
      `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullRequest}`,
    ), 'pull request');
    if (raw.number !== pullRequest) return err(appError('CONFLICT', 'GitHub pull request identity mismatch'));
    if (raw.state !== 'open' || raw.merged === true) {
      return err(appError('CONFLICT', 'Pull request evidence and merges require an open unmerged pull request'));
    }
    const head = requiredRecord(raw.head, 'pull request head');
    const base = requiredRecord(raw.base, 'pull request base');
    const baseRepository = requiredRecord(base.repo, 'pull request base repository');
    if (baseRepository.full_name !== repository) {
      return err(appError('CONFLICT', 'GitHub pull request repository identity mismatch'));
    }
    return ok({
      repository,
      pullRequest,
      headSha: requiredSha(head.sha, 'pull request head SHA'),
      baseSha: requiredSha(base.sha, 'pull request base SHA'),
      baseBranch: requiredString(base.ref, 'pull request base branch', 256),
    });
  } catch {
    return err(appError('CONFLICT', 'GitHub pull request state could not be observed', true));
  }
}

/**
 * Adapts the observation above to the guarded merge's subject source. A
 * refusal becomes a thrown error because the service only needs to know it
 * cannot confirm the subject; its message is not surfaced to the caller.
 */
export function createAuthoritativeMergeSubjectSource(
  github: GitHubApiReader,
): GuardedMergeSubjectSource {
  return {
    async read(request): Promise<GuardedMergeAuthoritativeSubject> {
      const observed = await observeOpenPullRequest(github, request.repository, request.pullRequest);
      if (!observed.ok) throw new Error(observed.error.message);
      return {
        headSha: observed.value.headSha,
        baseBranch: observed.value.baseBranch,
        baseSha: observed.value.baseSha,
      };
    },
  };
}

function repositoryCoordinates(value: string): { owner: string; repo: string } {
  const parts = value.trim().split('/');
  if (parts.length !== 2 || parts.some((part) => part.length === 0)) {
    throw new Error(`GitHub repository '${value}' must use owner/repo form`);
  }
  return { owner: parts[0]!, repo: parts[1]! };
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} is invalid`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string') throw new Error(`${label} is invalid`);
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maximum) throw new Error(`${label} is invalid`);
  return trimmed;
}

function requiredSha(value: unknown, label: string): string {
  const sha = requiredString(value, label, 128);
  if (!SHA_PATTERN.test(sha)) throw new Error(`${label} is invalid`);
  return sha.toLowerCase();
}