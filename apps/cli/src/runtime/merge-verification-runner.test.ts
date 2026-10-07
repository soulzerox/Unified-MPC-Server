import { describe, expect, it, vi } from 'vitest';
import { err, appError, type RepositoryMergePolicy } from '@unified-mpc/domain';
import type { WorkspaceRepository } from '@unified-mpc/workspace';
import {
  createMergeVerificationRunPort,
  type ExactHeadWorkspaceVerifier,
  type MergeVerificationReceiptWriter,
  type VerificationCommandRunner,
} from './merge-verification-runner.js';

const REPOSITORY = 'soulzerox/thai-rag-mcp';
const HEAD = '1111111111111111111111111111111111111111';
const BASE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function localPolicy(): RepositoryMergePolicy {
  return {
    repository: REPOSITORY,
    defaultBranch: 'main',
    verificationMode: 'local_exact_head',
    requiredGates: [{
      name: 'pytest default suite',
      source: 'local_command',
      command: {
        executable: '/usr/bin/env',
        args: ['TMPDIR=/dev/shm', 'python', '-m', 'pytest', '-q'],
      },
    }],
    reviewPolicy: { required: true, acceptedOutcomes: ['clean_llm_review'] },
  };
}

function hybridPolicy(): RepositoryMergePolicy {
  return {
    repository: 'soulzerox/Webtrans',
    defaultBranch: 'main',
    verificationMode: 'hybrid',
    requiredGates: [
      { name: 'Runtime Parity', source: 'github_check' },
      {
        name: 'pnpm test',
        source: 'local_command',
        command: { executable: 'corepack', args: ['pnpm', 'test'] },
      },
    ],
    reviewPolicy: { required: true, acceptedOutcomes: ['clean_llm_review'] },
  };
}

function githubFor(repository = REPOSITORY, options: {
  reviewCommit?: string;
  workflowRuns?: unknown[];
} = {}): { get: ReturnType<typeof vi.fn> } {
  const get = vi.fn(async (apiPath: string): Promise<unknown> => {
    if (apiPath.includes('/pulls/17/reviews')) {
      return [{
        id: 55,
        commit_id: options.reviewCommit ?? HEAD,
        state: 'COMMENTED',
        body: '[merge-review:clean] Exact-head LLM review: no blockers.',
      }];
    }
    if (apiPath.includes('/pulls/17')) {
      return {
        number: 17,
        state: 'open',
        merged: false,
        head: { sha: HEAD },
        base: {
          ref: 'main',
          sha: BASE,
          repo: { full_name: repository },
        },
      };
    }
    if (apiPath.includes('/actions/runs?')) {
      return { workflow_runs: options.workflowRuns ?? [] };
    }
    throw new Error(`unexpected GitHub API path: ${apiPath}`);
  });
  return { get };
}

function workspaceVerifier(
  inspect = vi.fn(async () => ({ ok: true as const, value: { rootPath: '/workspace' } })),
): ExactHeadWorkspaceVerifier {
  return { inspect };
}

function receiptWriter(): { writer: MergeVerificationReceiptWriter; append: ReturnType<typeof vi.fn> } {
  const append = vi.fn(async () => ({
    appended: true,
    record: { sequence: 7 },
  }));
  return {
    writer: { append } as MergeVerificationReceiptWriter,
    append,
  };
}

const workspaces = {} as WorkspaceRepository;

describe('createMergeVerificationRunPort', () => {
  it('runs host-owned local gates against the observed exact head and persists an allowed receipt', async () => {
    const github = githubFor();
    const receipts = receiptWriter();
    const run = vi.fn(async () => ({ exitCode: 0, stdout: '511 passed', stderr: '' }));
    const verifier = workspaceVerifier();
    const service = createMergeVerificationRunPort({
      github,
      receipts: receipts.writer,
      workspaces,
      workspaceVerifier: verifier,
      commandRunner: { run },
      now: () => new Date('2026-10-07T10:40:00Z'),
      randomId: () => 'receipt-id',
    });

    const result = await service.run({
      policy: localPolicy(),
      repository: REPOSITORY,
      pullRequest: 17,
      workspaceId: 'workspace-1',
      review: { outcome: 'clean_llm_review', reviewId: 55 },
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        receiptRef: `merge-verification:17@${HEAD}:receipt-id`,
        sequence: 7,
        decision: { status: 'MERGE_ALLOWED' },
        receipt: {
          repository: REPOSITORY,
          pullRequest: 17,
          headSha: HEAD,
          baseSha: BASE,
          verificationMode: 'local_exact_head',
          gates: [{
            name: 'pytest default suite',
            source: 'local_command',
            headSha: HEAD,
            outcome: 'passed',
          }],
          review: {
            outcome: 'clean_llm_review',
            headSha: HEAD,
          },
        },
      },
    });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ executable: '/usr/bin/env' }),
      '/workspace',
      undefined,
    );
    expect(verifier.inspect).toHaveBeenCalledTimes(2);
    expect(receipts.append).toHaveBeenCalledTimes(1);
  });

  it('refuses to persist when the verification workspace changes after a local gate', async () => {
    const receipts = receiptWriter();
    const inspect = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: { rootPath: '/workspace' } })
      .mockResolvedValueOnce(err(appError('CONFLICT', 'head changed')));
    const service = createMergeVerificationRunPort({
      github: githubFor(),
      receipts: receipts.writer,
      workspaces,
      workspaceVerifier: workspaceVerifier(inspect),
      commandRunner: { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
    });

    const result = await service.run({
      policy: localPolicy(),
      repository: REPOSITORY,
      pullRequest: 17,
      workspaceId: 'workspace-1',
      review: { outcome: 'clean_llm_review', reviewId: 55 },
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(receipts.append).not.toHaveBeenCalled();
  });

  it('persists failed local gate evidence so guarded merge can reject it inspectably', async () => {
    const receipts = receiptWriter();
    const service = createMergeVerificationRunPort({
      github: githubFor(),
      receipts: receipts.writer,
      workspaces,
      workspaceVerifier: workspaceVerifier(),
      commandRunner: {
        run: async () => ({ exitCode: 1, stdout: '1 failed', stderr: 'assertion failed' }),
      },
      randomId: () => 'failed',
    });

    const result = await service.run({
      policy: localPolicy(),
      repository: REPOSITORY,
      pullRequest: 17,
      workspaceId: 'workspace-1',
      review: { outcome: 'clean_llm_review', reviewId: 55 },
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        decision: {
          status: 'MERGE_BLOCKED',
          blockers: expect.arrayContaining([
            expect.objectContaining({ code: 'required_gate_not_passed', gate: 'pytest default suite' }),
          ]),
        },
        receipt: {
          gates: [expect.objectContaining({ outcome: 'failed' })],
        },
      },
    });
    expect(receipts.append).toHaveBeenCalledTimes(1);
  });

  it('combines exact-head GitHub workflow evidence with local gates for hybrid policy', async () => {
    const policy = hybridPolicy();
    const github = githubFor(policy.repository, {
      workflowRuns: [{
        id: 9001,
        name: 'Runtime Parity',
        head_sha: HEAD,
        status: 'completed',
        conclusion: 'success',
        html_url: 'https://github.com/example/run/9001',
      }],
    });
    const receipts = receiptWriter();
    const service = createMergeVerificationRunPort({
      github,
      receipts: receipts.writer,
      workspaces,
      workspaceVerifier: workspaceVerifier(),
      commandRunner: { run: async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }) },
      randomId: () => 'hybrid',
    });

    const result = await service.run({
      policy,
      repository: policy.repository,
      pullRequest: 17,
      workspaceId: 'workspace-web',
      review: { outcome: 'clean_llm_review', reviewId: 55 },
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        decision: { status: 'MERGE_ALLOWED' },
        receipt: {
          gates: expect.arrayContaining([
            expect.objectContaining({ name: 'Runtime Parity', source: 'github_check', outcome: 'passed' }),
            expect.objectContaining({ name: 'pnpm test', source: 'local_command', outcome: 'passed' }),
          ]),
        },
      },
    });
  });

  it('rejects stale GitHub review evidence without persisting a receipt', async () => {
    const receipts = receiptWriter();
    const service = createMergeVerificationRunPort({
      github: githubFor(REPOSITORY, { reviewCommit: '2222222222222222222222222222222222222222' }),
      receipts: receipts.writer,
      workspaces,
      workspaceVerifier: workspaceVerifier(),
      commandRunner: { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
    });

    const result = await service.run({
      policy: localPolicy(),
      repository: REPOSITORY,
      pullRequest: 17,
      workspaceId: 'workspace-1',
      review: { outcome: 'clean_llm_review', reviewId: 55 },
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(receipts.append).not.toHaveBeenCalled();
  });

  it('rejects a generic COMMENTED review that lacks the machine-readable clean marker', async () => {
    const receipts = receiptWriter();
    const github = githubFor();
    github.get.mockImplementation(async (apiPath: string): Promise<unknown> => {
      if (apiPath.includes('/pulls/17/reviews')) {
        return [{ id: 55, commit_id: HEAD, state: 'COMMENTED', body: 'Found one important blocker.' }];
      }
      if (apiPath.includes('/pulls/17')) {
        return {
          number: 17,
          state: 'open',
          merged: false,
          head: { sha: HEAD },
          base: { ref: 'main', sha: BASE, repo: { full_name: REPOSITORY } },
        };
      }
      throw new Error(`unexpected GitHub API path: ${apiPath}`);
    });
    const service = createMergeVerificationRunPort({
      github,
      receipts: receipts.writer,
      workspaces,
      workspaceVerifier: workspaceVerifier(),
      commandRunner: { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
    });

    const result = await service.run({
      policy: localPolicy(),
      repository: REPOSITORY,
      pullRequest: 17,
      workspaceId: 'workspace-1',
      review: { outcome: 'clean_llm_review', reviewId: 55 },
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(receipts.append).not.toHaveBeenCalled();
  });

  it('records an unavailable gate when local policy has no host-owned command instead of trusting caller prose', async () => {
    const policy: RepositoryMergePolicy = {
      ...localPolicy(),
      requiredGates: [{ name: 'pytest default suite', source: 'local_command' }],
    };
    const receipts = receiptWriter();
    const runner: VerificationCommandRunner = { run: vi.fn() };
    const service = createMergeVerificationRunPort({
      github: githubFor(),
      receipts: receipts.writer,
      workspaces,
      workspaceVerifier: workspaceVerifier(),
      commandRunner: runner,
      randomId: () => 'missing-command',
    });

    const result = await service.run({
      policy,
      repository: REPOSITORY,
      pullRequest: 17,
      workspaceId: 'workspace-1',
      review: { outcome: 'clean_llm_review', reviewId: 55 },
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        decision: {
          status: 'MERGE_BLOCKED',
          blockers: expect.arrayContaining([
            expect.objectContaining({ code: 'required_gate_not_passed', gate: 'pytest default suite' }),
          ]),
        },
        receipt: { gates: [expect.objectContaining({ outcome: 'unavailable' })] },
      },
    });
    expect(runner.run).not.toHaveBeenCalled();
  });
});
