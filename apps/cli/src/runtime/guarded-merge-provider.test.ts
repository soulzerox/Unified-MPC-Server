import { describe, expect, it, vi } from 'vitest';
import { appError, err, ok } from '@unified-mpc/domain';
import { createGuardedMergeDispatchPort } from './guarded-merge-provider.js';

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
        repository_full_name: subject.repository,
        pr_number: subject.pullRequest,
        merge_method: 'merge',
        expected_head_sha: subject.headSha,
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
