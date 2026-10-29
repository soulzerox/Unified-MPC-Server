import { describe, expect, it, vi } from 'vitest';
import type { MergeVerificationReceipt, RepositoryMergePolicy } from '@unified-mpc/domain';
import { createMergeVerificationStatusPort } from './merge-verification-status.js';

const REPOSITORY = 'soulzerox/Unified-MPC-Server';
const HEAD = '1111111111111111111111111111111111111111';
const BASE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const NOW = '2026-10-27T10:00:00.000Z';

function policy(): RepositoryMergePolicy {
  return {
    repository: REPOSITORY,
    defaultBranch: 'main',
    verificationMode: 'local_exact_head',
    requiredGates: [{
      name: 'pnpm test',
      source: 'local_command',
      command: { executable: 'corepack', args: ['pnpm', 'test'] },
    }],
    reviewPolicy: { required: true, acceptedOutcomes: ['clean_llm_review'] },
  };
}

function receipt(): MergeVerificationReceipt {
  return {
    repository: REPOSITORY,
    pullRequest: 305,
    headSha: HEAD,
    baseSha: BASE,
    verificationMode: 'local_exact_head',
    gates: [{ name: 'pnpm test', source: 'local_command', headSha: HEAD, outcome: 'passed' }],
    review: { outcome: 'clean_llm_review', headSha: HEAD },
    createdAt: NOW,
  };
}

describe('createMergeVerificationStatusPort', () => {
  it('reports the durable verdict for an exact head from persisted receipts', async () => {
    const port = createMergeVerificationStatusPort({
      attempts: {
        list: vi.fn(async () => [{
          attemptId: 'attempt-1',
          headSha: HEAD,
          baseBranch: 'main',
          status: 'completed' as const,
          startedAt: NOW,
          heartbeatAt: NOW,
          finishedAt: NOW,
          receiptRef: 'merge-verification:305@head:receipt',
        }]),
      },
      receipts: {
        listForExactHead: vi.fn(async () => [{
          receiptRef: 'merge-verification:305@head:receipt',
          sequence: 12,
          receipt: receipt(),
          recordedAt: NOW,
        }]),
        listForPullRequest: vi.fn(async () => []),
      },
      policy: { getByRepository: async () => policy() },
      now: () => new Date(NOW),
    });

    const status = await port.get({ repository: REPOSITORY, pullRequest: 305, headSha: HEAD });

    expect(status).toMatchObject({
      repository: REPOSITORY,
      pullRequest: 305,
      headSha: HEAD,
      latestReceiptRef: 'merge-verification:305@head:receipt',
      attempts: [{ attemptId: 'attempt-1', status: 'completed' }],
      receipts: [{ receiptRef: 'merge-verification:305@head:receipt', sequence: 12 }],
      decision: { status: 'MERGE_ALLOWED' },
    });
  });

  it('reports an expired heartbeat as interrupted without mutating storage', async () => {
    const list = vi.fn(async () => [{
      attemptId: 'attempt-dead',
      headSha: HEAD,
      baseBranch: 'main',
      status: 'running' as const,
      startedAt: '2026-10-27T09:00:00.000Z',
      heartbeatAt: '2026-10-27T09:00:00.000Z',
    }]);
    const port = createMergeVerificationStatusPort({
      attempts: { list },
      receipts: {
        listForExactHead: vi.fn(async () => []),
        listForPullRequest: vi.fn(async () => []),
      },
      policy: { getByRepository: async () => policy() },
      now: () => new Date(NOW),
    });

    const status = await port.get({ repository: REPOSITORY, pullRequest: 305, headSha: HEAD });

    expect(status.attempts).toEqual([expect.objectContaining({
      attemptId: 'attempt-dead',
      status: 'interrupted',
      detail: expect.stringContaining('Heartbeat expired'),
    })]);
    expect(status.decision).toBeUndefined();
    expect(status.latestReceiptRef).toBeUndefined();
    // The read path must never write; only the owning runner repairs stored rows.
    expect(Object.keys(port)).toEqual(['get']);
  });

  it('reports a durable queued attempt without implying a verdict', async () => {
    const port = createMergeVerificationStatusPort({
      attempts: {
        list: vi.fn(async () => [{
          attemptId: 'attempt-queued',
          headSha: HEAD,
          status: 'queued' as const,
          startedAt: '2026-10-27T09:00:00.000Z',
          heartbeatAt: '2026-10-27T09:00:00.000Z',
        }]),
      },
      receipts: {
        listForExactHead: vi.fn(async () => []),
        listForPullRequest: vi.fn(async () => []),
      },
      policy: { getByRepository: async () => policy() },
      now: () => new Date(NOW),
    });

    const status = await port.get({ repository: REPOSITORY, pullRequest: 305, headSha: HEAD });

    expect(status.attempts).toEqual([expect.objectContaining({
      attemptId: 'attempt-queued',
      status: 'queued',
      detail: expect.stringContaining('Queued behind heavy admission'),
    })]);
    // A queued request never expires like a dead runner and never authorizes a merge.
    expect(status.decision).toBeUndefined();
    expect(status.latestReceiptRef).toBeUndefined();
  });

  it('keeps a live attempt running when its heartbeat is inside the grace window', async () => {
    const port = createMergeVerificationStatusPort({
      attempts: {
        list: vi.fn(async () => [{
          attemptId: 'attempt-live',
          headSha: HEAD,
          status: 'running' as const,
          startedAt: '2026-10-27T09:59:30.000Z',
          heartbeatAt: '2026-10-27T09:59:30.000Z',
        }]),
      },
      receipts: {
        listForExactHead: vi.fn(async () => []),
        listForPullRequest: vi.fn(async () => []),
      },
      policy: { getByRepository: async () => policy() },
      now: () => new Date(NOW),
    });

    const status = await port.get({ repository: REPOSITORY, pullRequest: 305, headSha: HEAD });

    expect(status.attempts).toEqual([expect.objectContaining({ status: 'running' })]);
  });

  it('omits a merge decision when no exact head was requested', async () => {
    const port = createMergeVerificationStatusPort({
      attempts: {
        list: vi.fn(async () => []),
      },
      receipts: {
        listForExactHead: vi.fn(async () => []),
        listForPullRequest: vi.fn(async () => []),
      },
      policy: { getByRepository: async () => policy() },
      now: () => new Date(NOW),
    });

    const status = await port.get({ repository: REPOSITORY, pullRequest: 305 });

    expect(status.decision).toBeUndefined();
    expect(status.headSha).toBeUndefined();
  });

  it('omits a merge decision when no attempt recorded the observed base branch', async () => {
    const port = createMergeVerificationStatusPort({
      attempts: {
        list: vi.fn(async () => [{
          attemptId: 'attempt-1',
          headSha: HEAD,
          status: 'completed' as const,
          startedAt: NOW,
          heartbeatAt: NOW,
          finishedAt: NOW,
        }]),
      },
      receipts: {
        listForExactHead: vi.fn(async () => [{
          receiptRef: 'merge-verification:305@head:receipt',
          sequence: 12,
          receipt: receipt(),
          recordedAt: NOW,
        }]),
        listForPullRequest: vi.fn(async () => []),
      },
      policy: { getByRepository: async () => policy() },
      now: () => new Date(NOW),
    });

    const status = await port.get({ repository: REPOSITORY, pullRequest: 305, headSha: HEAD });

    expect(status.latestReceiptRef).toBe('merge-verification:305@head:receipt');
    expect(status.decision).toBeUndefined();
  });
});
