import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GuardedMergeDispatchPort } from '@unified-mpc/application';
import type { ExtensionsService } from '@unified-mpc/extensions';

const execFileAsync = promisify(execFile);

const MERGE_TOOL = 'merge_pull_request';
const SHA_PATTERN = /^[0-9a-f]{40,64}$/i;
const MERGE_API_TIMEOUT_MS = 60_000;
const MERGE_API_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const MAX_FAILURE_DETAIL_CHARS = 500;

/**
 * Provider name that selects the first-party GitHub merge path. It is a
 * reserved name: a child MCP server may not shadow it.
 */
export const BUILTIN_GUARDED_MERGE_PROVIDER = 'builtin';

export interface GitHubMergeInvocation {
  readonly repository: string;
  readonly pullRequest: number;
  readonly headSha: string;
  readonly method: 'merge' | 'squash' | 'rebase';
}

export interface GitHubMergeApi {
  merge(request: GitHubMergeInvocation): Promise<void>;
}

/** Runs one authenticated GitHub CLI call and returns stdout. */
export type GitHubCliRunner = (args: readonly string[]) => Promise<string>;

/**
 * First-party merge executor backed by the GitHub REST API through the
 * already-authenticated `gh` CLI. The exact expected head SHA travels with
 * the request, so GitHub rejects the merge when the PR head moved after the
 * host persisted its verification receipt.
 */
export function createGitHubMergeApi(run: GitHubCliRunner = runGitHubCli): GitHubMergeApi {
  return {
    async merge(request): Promise<void> {
      const { owner, repo } = repositoryCoordinates(request.repository);
      const pullNumber = positiveInteger(request.pullRequest, 'pullRequest');
      const headSha = requiredHeadSha(request.headSha);
      const method = requiredMergeMethod(request.method);

      let stdout: string;
      try {
        stdout = await run([
          'api',
          '--method',
          'PUT',
          '-H',
          'Accept: application/vnd.github+json',
          `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}/merge`,
          '-f',
          `merge_method=${method}`,
          '-f',
          `sha=${headSha}`,
        ]);
      } catch (error: unknown) {
        throw new Error(`GitHub merge API call failed: ${failureDetail(error)}`);
      }

      let payload: unknown;
      try {
        payload = JSON.parse(stdout);
      } catch {
        throw new Error('GitHub merge API returned invalid JSON');
      }
      if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
        throw new Error('GitHub merge API returned an invalid response');
      }

      // A 200 response is not sufficient evidence: GitHub also reports
      // `merged: false` with a message when the merge was refused.
      const record = payload as Record<string, unknown>;
      if (record.merged !== true) {
        const message = typeof record.message === 'string' && record.message.trim().length > 0
          ? record.message.trim()
          : 'the merge was not accepted';
        throw new Error(`GitHub did not merge the pull request: ${message}`);
      }
    },
  };
}

/** Built-in dispatch port: no child MCP server, no out-of-repo shim. */
export function createBuiltinGuardedMergeDispatchPort(
  api: GitHubMergeApi = createGitHubMergeApi(),
): GuardedMergeDispatchPort {
  return {
    async dispatchMerge(request): Promise<void> {
      await api.merge({
        repository: request.subject.repository,
        pullRequest: request.subject.pullRequest,
        headSha: request.subject.headSha,
        method: request.mergeMethod,
      });
    },
  };
}

/** The built-in provider is the default; an explicit child server name opts out. */
export function resolveGuardedMergeProviderServer(setting: string | null | undefined): string {
  const trimmed = setting?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : BUILTIN_GUARDED_MERGE_PROVIDER;
}

export function createGuardedMergeDispatchPort(
  extensions: Pick<ExtensionsService, 'describeMcpServer' | 'callMcpTool'>,
  providerServer: () => string,
  builtin: GuardedMergeDispatchPort = createBuiltinGuardedMergeDispatchPort(),
): GuardedMergeDispatchPort {
  return {
    async dispatchMerge(request): Promise<void> {
      const server = requiredProviderServer(providerServer());
      if (server === BUILTIN_GUARDED_MERGE_PROVIDER) {
        await builtin.dispatchMerge(request);
        return;
      }

      const described = await extensions.describeMcpServer({ server });
      if (!described.ok) throw new Error(described.error.message);
      if (!described.value.tools.some((tool) => tool.name === MERGE_TOOL)) {
        throw new Error(`Guarded merge provider '${server}' does not expose ${MERGE_TOOL}`);
      }

      const { owner, repo } = repositoryCoordinates(request.subject.repository);
      const result = await extensions.callMcpTool({
        server,
        tool: MERGE_TOOL,
        arguments: {
          owner,
          repo,
          pullNumber: request.subject.pullRequest,
          merge_method: request.mergeMethod,
          expectedHeadSha: request.subject.headSha,
        },
        descriptorFingerprint: described.value.provenance.descriptorFingerprint,
        catalogFingerprint: described.value.provenance.catalogFingerprint,
      });
      if (!result.ok) throw new Error(result.error.message);
    },
  };
}

async function runGitHubCli(args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('gh', [...args], {
    timeout: MERGE_API_TIMEOUT_MS,
    maxBuffer: MERGE_API_MAX_BUFFER_BYTES,
    encoding: 'utf8',
    env: { ...process.env, GH_PROMPT_DISABLED: '1' },
  });
  return String(stdout);
}

function repositoryCoordinates(value: string): { owner: string; repo: string } {
  const trimmed = value.trim();
  const parts = trimmed.split('/');
  if (parts.length !== 2 || parts.some((part) => part.length === 0)) {
    throw new Error(`Guarded merge repository '${value}' must use owner/repo form`);
  }
  return { owner: parts[0]!, repo: parts[1]! };
}

function requiredProviderServer(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 256) {
    throw new Error('Guarded merge provider server setting is invalid');
  }
  return trimmed;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Guarded merge ${label} must be a positive integer`);
  }
  return value;
}

function requiredHeadSha(value: string): string {
  if (!SHA_PATTERN.test(value)) {
    throw new Error('Guarded merge expected head SHA must be a full commit SHA');
  }
  return value;
}

function requiredMergeMethod(value: string): 'merge' | 'squash' | 'rebase' {
  if (value !== 'merge' && value !== 'squash' && value !== 'rebase') {
    throw new Error(`Guarded merge method '${value}' is unsupported`);
  }
  return value;
}

function failureDetail(error: unknown): string {
  const raw = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : 'unknown error';
  const normalized = Array.from(raw, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f ? ' ' : character;
  }).join('').replace(/\s+/g, ' ').trim();
  if (normalized.length === 0) return 'unknown error';
  return normalized.length <= MAX_FAILURE_DETAIL_CHARS
    ? normalized
    : `${normalized.slice(0, MAX_FAILURE_DETAIL_CHARS - 1)}…`;
}
