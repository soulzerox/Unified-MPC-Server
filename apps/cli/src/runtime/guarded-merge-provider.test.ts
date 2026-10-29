import { describe, expect, it, vi } from 'vitest';
import { appError, err, ok } from '@unified-mpc/domain';
import {
  BUILTIN_GUARDED_MERGE_PROVIDER,
  createBuiltinGuardedMergeDispatchPort,
  createGitHubMergeApi,
  createGuardedMergeDispatchPort,
  resolveGuardedMergeProviderServer,
} from './guarded-merge-provider.js';

const subject = {
  repository: 'soulzerox/Unified-MPC-Server',
  pullRequest: 278,
  headSha: '1'.repeat(40),
  baseBranch: 'main',
};

function description(tools: readonly string[] = ['merge_pull_request']): ReturnType<typeof ok> {
  return ok({
    server: 'github',
    enabled: true,
    connected: true,
    provenance: {
      source: 'test',
      trustTier: 'external' as const,
      namespace: 'mcp:github',
      descriptorFingerprint: 'a'.repeat(64),
      catalogFingerprint: 'b'.repeat(64),
      drift: { status: 'none' as const },
    },
    tools: tools.map((name) => ({
      name,
      qualifiedName: `mcp:github/${name}`,
      description: name,
      inputSchema: name === 'merge_pull_request'
        ? {
            type: 'object',
            properties: {
              owner: { type: 'string' },
              repo: { type: 'string' },
              pullNumber: { type: 'number' },
              merge_method: { type: 'string' },
              expectedHeadSha: { type: 'string' },
            },
            required: ['owner', 'repo', 'pullNumber'],
          }
        : undefined,
    })),
  });
}

describe('createGuardedMergeDispatchPort', () => {
  it('binds the external merge call to the exact verified head and live MCP contract fingerprints', async () => {
    const callMcpTool = vi.fn(async () => ok({ merged: true }));
    const port = createGuardedMergeDispatchPort({
      async describeMcpServer() { return description(); },
      callMcpTool,
    }, () => 'github');

    await expect(port.dispatchMerge({ receiptRef: 'receipt-278', subject })).resolves.toBeUndefined();

    expect(callMcpTool).toHaveBeenCalledWith({
      server: 'github',
      tool: 'merge_pull_request',
      arguments: {
        owner: 'soulzerox',
        repo: 'Unified-MPC-Server',
        pullNumber: subject.pullRequest,
        merge_method: 'merge',
        expectedHeadSha: subject.headSha,
      },
      descriptorFingerprint: 'a'.repeat(64),
      catalogFingerprint: 'b'.repeat(64),
    });
  });

  it('fails closed when the configured child server does not expose the merge tool', async () => {
    const callMcpTool = vi.fn();
    const port = createGuardedMergeDispatchPort({
      async describeMcpServer() { return description(['get_pr_info']); },
      callMcpTool,
    }, () => 'github');

    await expect(port.dispatchMerge({ receiptRef: 'receipt-278', subject }))
      .rejects.toThrow('does not expose merge_pull_request');
    expect(callMcpTool).not.toHaveBeenCalled();
  });

  it('fails closed before child dispatch when the repository is not in owner/repo form', async () => {
    const callMcpTool = vi.fn();
    const port = createGuardedMergeDispatchPort({
      async describeMcpServer() { return description(); },
      callMcpTool,
    }, () => 'github');

    await expect(port.dispatchMerge({
      receiptRef: 'receipt-278',
      subject: { ...subject, repository: 'invalid-repository' },
    })).rejects.toThrow('must use owner/repo form');
    expect(callMcpTool).not.toHaveBeenCalled();
  });

  it('fails closed when the child merge provider rejects the exact-head call', async () => {
    const port = createGuardedMergeDispatchPort({
      async describeMcpServer() { return description(); },
      async callMcpTool() {
        return err(appError('CONFLICT', 'head changed'));
      },
    }, () => 'github');

    await expect(port.dispatchMerge({ receiptRef: 'receipt-278', subject })).rejects.toThrow('head changed');
  });
});

describe('built-in GitHub merge provider', () => {
  const invocation = {
    repository: subject.repository,
    pullRequest: subject.pullRequest,
    headSha: subject.headSha,
    method: 'merge' as const,
  };

  it('merges through the authenticated GitHub CLI with the exact expected head', async () => {
    const run = vi.fn(async () => JSON.stringify({ merged: true, sha: '2'.repeat(40) }));
    const api = createGitHubMergeApi(run);

    await expect(api.merge(invocation)).resolves.toBeUndefined();

    expect(run).toHaveBeenCalledWith([
      'api',
      '--method',
      'PUT',
      '-H',
      'Accept: application/vnd.github+json',
      'repos/soulzerox/Unified-MPC-Server/pulls/278/merge',
      '-f',
      'merge_method=merge',
      '-f',
      `sha=${subject.headSha}`,
    ]);
  });

  it('fails closed when GitHub answers with merged:false', async () => {
    const api = createGitHubMergeApi(async () => JSON.stringify({
      merged: false,
      message: 'Pull Request is not mergeable',
    }));

    await expect(api.merge(invocation))
      .rejects.toThrow('GitHub did not merge the pull request: Pull Request is not mergeable');
  });

  it('surfaces a CLI failure without multiline noise', async () => {
    const api = createGitHubMergeApi(async () => {
      throw new Error('Command failed: gh api --method PUT\nhead changed');
    });

    await expect(api.merge(invocation))
      .rejects.toThrow('GitHub merge API call failed: Command failed: gh api --method PUT head changed');
  });

  it('rejects an invalid head SHA before running the CLI', async () => {
    const run = vi.fn();
    const api = createGitHubMergeApi(run);

    await expect(api.merge({ ...invocation, headSha: 'abc' }))
      .rejects.toThrow('must be a full commit SHA');
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects a non-positive pull request number before running the CLI', async () => {
    const run = vi.fn();
    const api = createGitHubMergeApi(run);

    await expect(api.merge({ ...invocation, pullRequest: 0 }))
      .rejects.toThrow('must be a positive integer');
    expect(run).not.toHaveBeenCalled();
  });
});

describe('built-in guarded merge dispatch port', () => {
  it('maps the verified subject to one exact-head merge', async () => {
    const merge = vi.fn(async () => undefined);
    const port = createBuiltinGuardedMergeDispatchPort({ merge });

    await expect(port.dispatchMerge({ receiptRef: 'receipt-278', subject })).resolves.toBeUndefined();

    expect(merge).toHaveBeenCalledWith({
      repository: subject.repository,
      pullRequest: subject.pullRequest,
      headSha: subject.headSha,
      method: 'merge',
    });
  });
});

describe('guarded merge provider selection', () => {
  it('resolves an unset or blank provider setting to the built-in provider', () => {
    expect(resolveGuardedMergeProviderServer(null)).toBe(BUILTIN_GUARDED_MERGE_PROVIDER);
    expect(resolveGuardedMergeProviderServer(undefined)).toBe(BUILTIN_GUARDED_MERGE_PROVIDER);
    expect(resolveGuardedMergeProviderServer('   ')).toBe(BUILTIN_GUARDED_MERGE_PROVIDER);
    expect(resolveGuardedMergeProviderServer(' github ')).toBe('github');
  });

  it('dispatches through the built-in path by default without contacting a child server', async () => {
    const builtin = { dispatchMerge: vi.fn(async () => undefined) };
    const describeMcpServer = vi.fn();
    const callMcpTool = vi.fn();
    const port = createGuardedMergeDispatchPort(
      { describeMcpServer, callMcpTool },
      () => resolveGuardedMergeProviderServer(null),
      builtin,
    );

    await expect(port.dispatchMerge({ receiptRef: 'receipt-278', subject })).resolves.toBeUndefined();

    expect(builtin.dispatchMerge).toHaveBeenCalledWith({ receiptRef: 'receipt-278', subject });
    expect(describeMcpServer).not.toHaveBeenCalled();
    expect(callMcpTool).not.toHaveBeenCalled();
  });

  it('keeps an explicit child provider name on the fingerprinted MCP contract', async () => {
    const builtin = { dispatchMerge: vi.fn(async () => undefined) };
    const callMcpTool = vi.fn(async () => ok({ merged: true }));
    const port = createGuardedMergeDispatchPort({
      async describeMcpServer() { return description(); },
      callMcpTool,
    }, () => resolveGuardedMergeProviderServer('github'), builtin);

    await expect(port.dispatchMerge({ receiptRef: 'receipt-278', subject })).resolves.toBeUndefined();

    expect(builtin.dispatchMerge).not.toHaveBeenCalled();
    expect(callMcpTool).toHaveBeenCalledWith(expect.objectContaining({
      server: 'github',
      tool: 'merge_pull_request',
      descriptorFingerprint: 'a'.repeat(64),
      catalogFingerprint: 'b'.repeat(64),
    }));
  });
});
