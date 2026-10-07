import { describe, expect, it, vi } from 'vitest';
import { mergeTools } from './merge-tools.js';
import type { McpToolContext } from './tool-types.js';
import type { RepositoryMergePolicy } from '@unified-mpc/domain';

const policy: RepositoryMergePolicy = {
  repository: 'soulzerox/Unified-MPC-Server',
  defaultBranch: 'main',
  verificationMode: 'local_exact_head',
  requiredGates: [{ name: 'test', source: 'local_command' }],
  reviewPolicy: { required: true, acceptedOutcomes: ['clean_llm_review'] },
};

function context(services: McpToolContext['services']): McpToolContext {
  return {
    actor: { clientId: 'test', clientName: 'test' },
    contextEconomy: {} as McpToolContext['contextEconomy'],
    services,
  } as McpToolContext;
}

describe('mergeTools', () => {
  it('exposes the authoritative configured repository policy without caller-supplied overrides', async () => {
    const getByRepository = vi.fn(async () => policy);
    const tool = mergeTools(context({
      mergePolicy: { getByRepository },
    } as unknown as McpToolContext['services'])).find((candidate) => candidate.name === 'merge_policy_get');
    if (tool === undefined) throw new Error('missing merge_policy_get');

    const result = await tool.execute({ repository: policy.repository }, new AbortController().signal);

    expect(getByRepository).toHaveBeenCalledWith(policy.repository);
    expect(result).toEqual({ ok: true, value: { configured: true, policy } });
  });

  it('fails closed when guarded merge has no authoritative policy and never reaches dispatch', async () => {
    const dispatch = vi.fn();
    const tool = mergeTools(context({
      mergePolicy: { async getByRepository(): Promise<undefined> { return undefined; } },
      guardedMerge: { dispatch },
    } as unknown as McpToolContext['services'])).find((candidate) => candidate.name === 'guarded_pr_merge');
    if (tool === undefined) throw new Error('missing guarded_pr_merge');

    const result = await tool.execute({
      repository: policy.repository,
      pullRequest: 278,
      headSha: '1'.repeat(40),
      baseBranch: 'main',
      receiptRef: 'receipt-278',
    }, new AbortController().signal);

    expect(dispatch).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'PERMISSION_DENIED',
        message: expect.stringContaining('authoritative merge policy'),
      },
    });
  });

  it('returns an MCP error when the guarded service blocks merge evidence', async () => {
    const dispatch = vi.fn(async () => ({
      status: 'blocked' as const,
      receiptRef: 'receipt-278',
      decision: {
        status: 'MERGE_BLOCKED' as const,
        blockers: [{ code: 'receipt_missing' as const }],
      },
    }));
    const tool = mergeTools(context({
      mergePolicy: { async getByRepository(): Promise<RepositoryMergePolicy> { return policy; } },
      guardedMerge: { dispatch },
    } as unknown as McpToolContext['services'])).find((candidate) => candidate.name === 'guarded_pr_merge');
    if (tool === undefined) throw new Error('missing guarded_pr_merge');

    const result = await tool.execute({
      repository: policy.repository,
      pullRequest: 278,
      headSha: '1'.repeat(40),
      baseBranch: 'main',
      receiptRef: 'receipt-278',
    }, new AbortController().signal);

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'PERMISSION_DENIED',
        message: expect.stringContaining('verification or review policy'),
      },
    });
  });

  it('returns a recoverable conflict when merge state requires inspection', async () => {
    const dispatch = vi.fn(async () => ({
      status: 'inspect_required' as const,
      reason: 'merge_dispatch_error' as const,
      receiptRef: 'receipt-278',
    }));
    const tool = mergeTools(context({
      mergePolicy: { async getByRepository(): Promise<RepositoryMergePolicy> { return policy; } },
      guardedMerge: { dispatch },
    } as unknown as McpToolContext['services'])).find((candidate) => candidate.name === 'guarded_pr_merge');
    if (tool === undefined) throw new Error('missing guarded_pr_merge');

    const result = await tool.execute({
      repository: policy.repository,
      pullRequest: 278,
      headSha: '1'.repeat(40),
      baseBranch: 'main',
      receiptRef: 'receipt-278',
    }, new AbortController().signal);

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'CONFLICT',
        recoverable: true,
        message: expect.stringContaining('merge_dispatch_error'),
      },
    });
  });

  it('dispatches only with the host-owned policy and exact subject supplied to the guarded service', async () => {
    const dispatch = vi.fn(async () => ({
      status: 'dispatched' as const,
      receiptRef: 'receipt-278',
      subject: {
        repository: policy.repository,
        pullRequest: 278,
        headSha: '1'.repeat(40),
        baseBranch: 'main',
        baseSha: '2'.repeat(40),
      },
    }));
    const tool = mergeTools(context({
      mergePolicy: { async getByRepository(): Promise<RepositoryMergePolicy> { return policy; } },
      guardedMerge: { dispatch },
    } as unknown as McpToolContext['services'])).find((candidate) => candidate.name === 'guarded_pr_merge');
    if (tool === undefined) throw new Error('missing guarded_pr_merge');

    const input = {
      repository: policy.repository,
      pullRequest: 278,
      headSha: '1'.repeat(40),
      baseBranch: 'main',
      baseSha: '2'.repeat(40),
      receiptRef: 'receipt-278',
    };
    const result = await tool.execute(input, new AbortController().signal);

    expect(dispatch).toHaveBeenCalledWith({
      policy,
      subject: {
        repository: policy.repository,
        pullRequest: 278,
        headSha: '1'.repeat(40),
        baseBranch: 'main',
        baseSha: '2'.repeat(40),
      },
      receiptRef: 'receipt-278',
    });
    expect(result).toMatchObject({ ok: true, value: { status: 'dispatched', receiptRef: 'receipt-278' } });
  });

  it('reconciles provider-observed merge state with the host-owned policy and defaults to merge method', async () => {
    const reconcile = vi.fn(async () => ({
      status: 'policy_breach' as const,
      record: {
        decision: { status: 'POLICY_BREACH' as const, reason: 'verification_receipt_missing' as const },
      },
    }));
    const tool = mergeTools(context({
      mergePolicy: { async getByRepository(): Promise<RepositoryMergePolicy> { return policy; } },
      mergeReconciliation: { reconcile },
    } as unknown as McpToolContext['services'])).find((candidate) => candidate.name === 'merge_reconcile');
    if (tool === undefined) throw new Error('missing merge_reconcile');

    const result = await tool.execute({
      repository: policy.repository,
      pullRequest: 281,
    }, new AbortController().signal);

    expect(reconcile).toHaveBeenCalledWith({
      policy,
      repository: policy.repository,
      pullRequest: 281,
      expectedMergeMethod: 'merge',
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        status: 'policy_breach',
        record: { decision: { reason: 'verification_receipt_missing' } },
      },
    });
  });

  it('fails closed when reconciliation has no authoritative repository policy', async () => {
    const reconcile = vi.fn();
    const tool = mergeTools(context({
      mergePolicy: { async getByRepository(): Promise<undefined> { return undefined; } },
      mergeReconciliation: { reconcile },
    } as unknown as McpToolContext['services'])).find((candidate) => candidate.name === 'merge_reconcile');
    if (tool === undefined) throw new Error('missing merge_reconcile');

    const result = await tool.execute({
      repository: policy.repository,
      pullRequest: 281,
    }, new AbortController().signal);

    expect(reconcile).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
  });
});
