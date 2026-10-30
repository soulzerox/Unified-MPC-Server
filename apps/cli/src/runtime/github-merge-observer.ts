import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { MergeMethod, MergeObservation } from '@unified-mpc/domain';
import type { MergeObservationReader, MergeObservationRequest } from '@unified-mpc/application';

const execFileAsync = promisify(execFile);
const SHA_PATTERN = /^[0-9a-f]{40,64}$/i;

export interface GitHubApiReader {
  get(path: string, options?: { readonly maxBufferBytes?: number }): Promise<unknown>;
}

export function createGitHubMergeObservationPort(
  github: GitHubApiReader = createGitHubApiReader(),
): MergeObservationReader {
  return {
    async observe(request: MergeObservationRequest): Promise<MergeObservation> {
      const { owner, repo } = repositoryCoordinates(request.repository);
      const pull = requiredRecord(await github.get(
        `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${request.pullRequest}`,
      ), 'pull request');

      if (pull.number !== request.pullRequest) {
        throw new Error('GitHub pull request identity mismatch');
      }
      const head = requiredRecord(pull.head, 'pull request head');
      const base = requiredRecord(pull.base, 'pull request base');
      const baseRepository = requiredRecord(base.repo, 'pull request base repository');
      if (baseRepository.full_name !== request.repository) {
        throw new Error('GitHub pull request repository identity mismatch');
      }

      const headSha = requiredSha(head.sha, 'head SHA');
      const baseSha = requiredSha(base.sha, 'base SHA');
      const baseBranch = requiredString(base.ref, 'base branch', 256);
      if (typeof pull.merged !== 'boolean') {
        throw new Error('GitHub pull request merged state is invalid');
      }

      const observedAt = requiredTimestamp(
        pull.merged ? pull.merged_at : pull.updated_at,
        pull.merged ? 'merged_at' : 'updated_at',
      );

      if (!pull.merged) {
        return {
          repository: request.repository,
          pullRequest: request.pullRequest,
          headSha,
          baseBranch,
          baseSha,
          merged: false,
          observedAt,
        };
      }

      const mergeSha = optionalSha(pull.merge_commit_sha, 'merge commit SHA');
      let mergeMethod: MergeMethod | undefined;
      if (mergeSha !== undefined) {
        const commit = requiredRecord(await github.get(
          `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${mergeSha}`,
        ), 'merge commit');
        if (commit.sha !== mergeSha) {
          throw new Error('GitHub merge commit identity mismatch');
        }
        const parentShas = requiredParentShas(commit.parents);
        // The merge is identified by the head, not by the base: a pull request
        // keeps the base SHA it branched from, while the commit is created on
        // whatever the base branch held when the merge ran. Comparing baseSha
        // would turn every merge of an outdated branch into an unproven method.
        if (parentShas.length === 2 && parentShas.includes(headSha)) {
          mergeMethod = 'merge';
        } else if (parentShas.length === 1 && parentShas[0] !== headSha
          && isSquashCommitMessage(commit.commit, request.pullRequest)) {
          // Squash: one commit on top of the base that GitHub labels with the
          // pull request number. A rebase keeps the original commit message, so
          // it cannot satisfy the trailer unless someone wrote it by hand.
          mergeMethod = 'squash';
        }
      }

      return {
        repository: request.repository,
        pullRequest: request.pullRequest,
        headSha,
        baseBranch,
        baseSha,
        merged: true,
        ...(mergeMethod === undefined ? {} : { mergeMethod }),
        ...(mergeSha === undefined ? {} : { mergeSha }),
        observedAt,
      };
    },
  };
}

export function createGitHubApiReader(): GitHubApiReader {
  return {
    async get(apiPath: string, options): Promise<unknown> {
      const { stdout } = await execFileAsync('gh', ['api', apiPath], {
        timeout: 30_000,
        maxBuffer: options?.maxBufferBytes ?? 2 * 1024 * 1024,
        encoding: 'utf8',
      });
      return JSON.parse(stdout);
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
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`GitHub ${label} response is invalid`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`GitHub ${label} is invalid`);
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) throw new Error(`GitHub ${label} is invalid`);
  return trimmed;
}

function requiredSha(value: unknown, label: string): string {
  const sha = requiredString(value, label, 128);
  if (!SHA_PATTERN.test(sha)) throw new Error(`GitHub ${label} is invalid`);
  return sha;
}

function optionalSha(value: unknown, label: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  return requiredSha(value, label);
}

function requiredTimestamp(value: unknown, label: string): string {
  const timestamp = requiredString(value, label, 128);
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error(`GitHub ${label} is invalid`);
  return timestamp;
}

function requiredParentShas(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw new Error('GitHub merge commit parents are invalid');
  return value.map((entry) => requiredSha(requiredRecord(entry, 'merge commit parent').sha, 'merge parent SHA'));
}

/**
 * GitHub writes a squash subject as `<title> (#<pull request>)`. The trailer is
 * the only part of the resulting commit that a rebase merge does not reproduce,
 * so it is what separates squash from rebase. A hand-edited squash message that
 * drops the trailer stays unproven instead of being guessed as squash.
 */
function isSquashCommitMessage(value: unknown, pullRequest: number): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const message = (value as Record<string, unknown>).message;
  if (typeof message !== 'string') return false;
  const subject = message.split('\n')[0]?.trim() ?? '';
  return subject.endsWith(`(#${pullRequest})`);
}
