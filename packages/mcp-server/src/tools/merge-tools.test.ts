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

  it('reports durable verification status without running any gate', async () => {
    const get = vi.fn(async () => ({
      repository: policy.repository,
      pullRequest: 305,
      headSha: '1'.repeat(40),
      attempts: [{
        attemptId: 'attempt-1',
        headSha: '1'.repeat(40),
        status: 'interrupted' as const,
        startedAt: '2026-10-27T10:00:00Z',
        heartbeatAt: '2026-10-27T10:00:00Z',
        finishedAt: '2026-10-27T10:05:00Z',
      }],
      receipts: [],
    }));
    const tool = mergeTools(context({
      mergeVerificationStatus: { get },
    } as unknown as McpToolContext['services'])).find((candidate) => candidate.name === 'merge_verification_status');
    if (tool === undefined) throw new Error('missing merge_verification_status');

    const result = await tool.execute({
      repository: policy.repository,
      pullRequest: 305,
      headSha: '1'.repeat(40),
    }, new AbortController().signal);

    expect(get).toHaveBeenCalledWith({
      repository: policy.repository,
      pullRequest: 305,
      headSha: '1'.repeat(40),
    });
    expect(result).toMatchObject({ ok: true, value: { attempts: [{ status: 'interrupted' }], receipts: [] } });
  });

  it('runs verification only with the host-owned policy and caller cannot supply gate outcomes', async () => {
    const run = vi.fn(async () => ({
      ok: true as const,
      value: {
        receiptRef: 'merge-verification:278@head:receipt',
        receipt: {
          repository: policy.repository,
          pullRequest: 278,
          headSha: '1'.repeat(40),
          verificationMode: policy.verificationMode,
          gates: [],
          review: { outcome: 'clean_llm_review' as const, headSha: '1'.repeat(40) },
          createdAt: '2026-10-07T10:00:00Z',
        },
        decision: { status: 'MERGE_ALLOWED' as const, blockers: [] as const },
        sequence: 6,
      },
    }));
    const tool = mergeTools(context({
      mergePolicy: { async getByRepository(): Promise<RepositoryMergePolicy> { return policy; } },
      mergeVerificationRun: { run },
    } as unknown as McpToolContext['services'])).find((candidate) => candidate.name === 'merge_verification_run');
    if (tool === undefined) throw new Error('missing merge_verification_run');

    const signal = new AbortController().signal;
    const result = await tool.execute({
      repository: policy.repository,
      pullRequest: 278,
      workspaceId: 'workspace-1',
      review: { outcome: 'clean_llm_review', reviewId: 55 },
    }, signal);

    expect(run).toHaveBeenCalledWith({
      policy,
      repository: policy.repository,
      pullRequest: 278,
      workspaceId: 'workspace-1',
      review: { outcome: 'clean_llm_review', reviewId: 55 },
    }, signal);
    expect(result).toMatchObject({ ok: true, value: { sequence: 6 } });
  });

  it('fails closed before verification when no authoritative repository policy exists', async () => {
    const run = vi.fn();
    const tool = mergeTools(context({
      mergePolicy: { async getByRepository(): Promise<undefined> { return undefined; } },
      mergeVerificationRun: { run },
    } as unknown as McpToolContext['services'])).find((candidate) => candidate.name === 'merge_verification_run');
    if (tool === undefined) throw new Error('missing merge_verification_run');

    const result = await tool.execute({
      repository: policy.repository,
      pullRequest: 278,
      review: { outcome: 'missing' },
    }, new AbortController().signal);

    expect(run).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
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
      detail: 'Unknown MCP server: github',
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
    const message = result.ok === false ? result.error.message : '';
    expect(message).toContain('Unknown MCP server: github');
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

  it('reconciles against the method the policy declares when the caller omits it', async () => {
    const squashPolicy: RepositoryMergePolicy = { ...policy, mergeMethod: 'squash' };
    const reconcile = vi.fn(async () => ({ status: 'reconciled' as const, record: {} as never }));
    const tool = mergeTools(context({
      mergePolicy: { async getByRepository(): Promise<RepositoryMergePolicy> { return squashPolicy; } },
      mergeReconciliation: { reconcile },
    } as unknown as McpToolContext['services'])).find((candidate) => candidate.name === 'merge_reconcile');
    if (tool === undefined) throw new Error('missing merge_reconcile');

    await tool.execute({ repository: squashPolicy.repository, pullRequest: 281 }, new AbortController().signal);

    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ expectedMergeMethod: 'squash' }));
  });

  it('refuses a caller method that contradicts the policy instead of applying it', async () => {
    const squashPolicy: RepositoryMergePolicy = { ...policy, mergeMethod: 'squash' };
    const reconcile = vi.fn();
    const tool = mergeTools(context({
      mergePolicy: { async getByRepository(): Promise<RepositoryMergePolicy> { return squashPolicy; } },
      mergeReconciliation: { reconcile },
    } as unknown as McpToolContext['services'])).find((candidate) => candidate.name === 'merge_reconcile');
    if (tool === undefined) throw new Error('missing merge_reconcile');

    const result = await tool.execute({
      repository: squashPolicy.repository,
      pullRequest: 281,
      expectedMergeMethod: 'merge',
    }, new AbortController().signal);

    expect(result).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('accepts a caller method that restates the policy', async () => {
    const squashPolicy: RepositoryMergePolicy = { ...policy, mergeMethod: 'squash' };
    const reconcile = vi.fn(async () => ({ status: 'reconciled' as const, record: {} as never }));
    const tool = mergeTools(context({
      mergePolicy: { async getByRepository(): Promise<RepositoryMergePolicy> { return squashPolicy; } },
      mergeReconciliation: { reconcile },
    } as unknown as McpToolContext['services'])).find((candidate) => candidate.name === 'merge_reconcile');
    if (tool === undefined) throw new Error('missing merge_reconcile');

    const result = await tool.execute({
      repository: squashPolicy.repository,
      pullRequest: 281,
      expectedMergeMethod: 'squash',
    }, new AbortController().signal);

    expect(result).toMatchObject({ ok: true });
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ expectedMergeMethod: 'squash' }));
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
