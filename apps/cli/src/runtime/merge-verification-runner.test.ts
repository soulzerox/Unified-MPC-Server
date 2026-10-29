import { describe, expect, it, vi } from 'vitest';
import { err, appError, type MergeVerificationReceipt, type RepositoryMergePolicy } from '@unified-mpc/domain';
import type { WorkspaceRepository } from '@unified-mpc/workspace';
import { ResourceAdmissionController, tryAdmitVerificationHeavy } from '@unified-mpc/workspace';
import {
  createMergeVerificationRunPort,
  type ExactHeadWorkspaceVerifier,
  type MergeVerificationAdmissionPort,
  type MergeVerificationAttemptRecorder,
  type MergeVerificationReceiptRecord,
  type MergeVerificationReceiptWriter,
  type MergeVerificationRunDependencies,
  type VerificationCommandRunner,
} from './merge-verification-runner.js';

const REPOSITORY = 'soulzerox/thai-rag-mcp';
const HEAD = '1111111111111111111111111111111111111111';
const BASE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function permissiveAdmission(): ResourceAdmissionController {
  return new ResourceAdmissionController({
    globalCost: 100,
    workspaceCost: 100,
    sessionCost: 100,
    maxOperations: 100,
    resourceClassCost: { verification_heavy: 100 },
  });
}

function createService(
  deps: Omit<MergeVerificationRunDependencies, 'admission'> & { readonly admission?: MergeVerificationAdmissionPort },
): ReturnType<typeof createMergeVerificationRunPort> {
  return createMergeVerificationRunPort({ admission: permissiveAdmission(), ...deps });
}

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

function githubOnlyPolicy(): RepositoryMergePolicy {
  return {
    repository: REPOSITORY,
    defaultBranch: 'main',
    verificationMode: 'hybrid',
    requiredGates: [{ name: 'Runtime Parity', source: 'github_check' }],
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

const REVIEW_EVIDENCE = 'GitHub review 55: [merge-review:clean] Exact-head LLM review: no blockers.';

function storedReceipt(overrides: Partial<MergeVerificationReceipt> = {}): MergeVerificationReceipt {
  return {
    repository: REPOSITORY,
    pullRequest: 17,
    headSha: HEAD,
    baseSha: BASE,
    verificationMode: 'local_exact_head',
    gates: [{ name: 'pytest default suite', source: 'local_command', headSha: HEAD, outcome: 'passed' }],
    review: { outcome: 'clean_llm_review', headSha: HEAD, evidence: REVIEW_EVIDENCE },
    createdAt: '2026-10-07T10:00:00.000Z',
    ...overrides,
  };
}

function storedVerdict(
  receipt: MergeVerificationReceipt,
  receiptRef = `merge-verification:17@${HEAD}:stored`,
): MergeVerificationReceiptRecord {
  return { receiptRef, sequence: 3, receipt, recordedAt: receipt.createdAt };
}

const workspaces = {} as WorkspaceRepository;

describe('createMergeVerificationRunPort', () => {
  it('runs host-owned local gates against the observed exact head and persists an allowed receipt', async () => {
    const github = githubFor();
    const receipts = receiptWriter();
    const run = vi.fn(async () => ({ exitCode: 0, stdout: '511 passed', stderr: '' }));
    const verifier = workspaceVerifier();
    const service = createService({
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
    const service = createService({
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
    const service = createService({
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
    const service = createService({
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
    const service = createService({
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
    const service = createService({
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
    const service = createService({
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

  it('records a durable running attempt and closes it with the persisted receipt ref', async () => {
    const attempts = attemptRecorder();
    const service = createService({
      github: githubFor(),
      receipts: receiptWriter().writer,
      workspaces,
      workspaceVerifier: workspaceVerifier(),
      commandRunner: { run: async () => ({ exitCode: 0, stdout: '511 passed', stderr: '' }) },
      attempts: attempts.recorder,
      now: () => new Date('2026-10-27T10:00:00Z'),
      randomId: () => 'receipt-id',
      randomAttemptId: () => 'attempt-id',
    });

    const result = await service.run({
      policy: localPolicy(),
      repository: REPOSITORY,
      pullRequest: 17,
      workspaceId: 'workspace-1',
      review: { outcome: 'clean_llm_review', reviewId: 55 },
    });

    expect(result).toMatchObject({ ok: true, value: { decision: { status: 'MERGE_ALLOWED' } } });
    expect(attempts.calls.begin).toEqual([{
      attemptId: 'attempt-id',
      repository: REPOSITORY,
      pullRequest: 17,
      headSha: HEAD,
      baseBranch: 'main',
      workspaceId: 'workspace-1',
      startedAt: '2026-10-27T10:00:00.000Z',
    }]);
    expect(attempts.calls.heartbeat[0]).toMatchObject({
      attemptId: 'attempt-id',
      request: { gateName: 'pytest default suite' },
    });
    expect(attempts.calls.finish).toEqual([{
      attemptId: 'attempt-id',
      request: {
        status: 'completed',
        finishedAt: '2026-10-27T10:00:00.000Z',
        receiptRef: `merge-verification:17@${HEAD}:receipt-id`,
      },
    }]);
  });

  it('keeps a durable verification running when the caller transport aborts mid-gate', async () => {
    const attempts = attemptRecorder();
    const caller = new AbortController();
    const run = vi.fn(async (_command: unknown, _cwd: string, signal: AbortSignal | undefined) => {
      // A client disconnect aborts the transport signal while the heavy gate is running.
      // Durable verification must not inherit it, or the verdict would be lost silently.
      expect(signal).toBeUndefined();
      caller.abort();
      expect(caller.signal.aborted).toBe(true);
      return { exitCode: 0, stdout: '511 passed', stderr: '' };
    });
    const service = createService({
      github: githubFor(),
      receipts: receiptWriter().writer,
      workspaces,
      workspaceVerifier: workspaceVerifier(),
      commandRunner: { run },
      attempts: attempts.recorder,
      randomId: () => 'receipt-id',
      randomAttemptId: () => 'attempt-detached',
    });

    const result = await service.run({
      policy: localPolicy(),
      repository: REPOSITORY,
      pullRequest: 17,
      workspaceId: 'workspace-1',
      review: { outcome: 'clean_llm_review', reviewId: 55 },
    }, caller.signal);

    expect(result).toMatchObject({ ok: true, value: { decision: { status: 'MERGE_ALLOWED' } } });
    expect(run).toHaveBeenCalledTimes(1);
    expect(attempts.calls.interrupted).toEqual([]);
    expect(attempts.calls.finish).toEqual([{
      attemptId: 'attempt-detached',
      request: expect.objectContaining({ status: 'completed' }),
    }]);
  });

  it('closes a blocked verdict as a completed attempt and a gate failure as failed', async () => {
    const completed = attemptRecorder();
    const blocked = await createService({
      github: githubFor(),
      receipts: receiptWriter().writer,
      workspaces,
      workspaceVerifier: workspaceVerifier(),
      commandRunner: { run: async () => ({ exitCode: 1, stdout: '1 failed', stderr: '' }) },
      attempts: completed.recorder,
      randomAttemptId: () => 'attempt-blocked',
    }).run({
      policy: localPolicy(),
      repository: REPOSITORY,
      pullRequest: 17,
      workspaceId: 'workspace-1',
      review: { outcome: 'clean_llm_review', reviewId: 55 },
    });

    expect(blocked).toMatchObject({ ok: true, value: { decision: { status: 'MERGE_BLOCKED' } } });
    expect(completed.calls.finish[0]).toMatchObject({ request: { status: 'completed' } });

    const failed = attemptRecorder();
    const rejected = await createService({
      github: githubFor(),
      receipts: receiptWriter().writer,
      workspaces,
      workspaceVerifier: workspaceVerifier(vi.fn()
        .mockResolvedValueOnce({ ok: true, value: { rootPath: '/workspace' } })
        .mockResolvedValueOnce(err(appError('CONFLICT', 'head changed')))),
      commandRunner: { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
      attempts: failed.recorder,
      randomAttemptId: () => 'attempt-failed',
    }).run({
      policy: localPolicy(),
      repository: REPOSITORY,
      pullRequest: 17,
      workspaceId: 'workspace-1',
      review: { outcome: 'clean_llm_review', reviewId: 55 },
    });

    expect(rejected).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(failed.calls.finish[0]).toMatchObject({
      attemptId: 'attempt-failed',
      request: { status: 'failed', detail: expect.stringContaining('workspace changed') },
    });
  });

  it('refuses a duplicate concurrent verification instead of running the heavy gates twice', async () => {
    const attempts = attemptRecorder({ live: { attemptId: 'already-running' } });
    const run = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const service = createService({
      github: githubFor(),
      receipts: receiptWriter().writer,
      workspaces,
      workspaceVerifier: workspaceVerifier(),
      commandRunner: { run },
      attempts: attempts.recorder,
    });

    const result = await service.run({
      policy: localPolicy(),
      repository: REPOSITORY,
      pullRequest: 17,
      workspaceId: 'workspace-1',
      review: { outcome: 'clean_llm_review', reviewId: 55 },
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(result.ok === false ? result.error.message : '').toContain('already-running');
    expect(attempts.calls.begin).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  it('marks the attempt interrupted when the runner itself throws', async () => {
    const attempts = attemptRecorder();
    const service = createService({
      github: githubFor(),
      receipts: receiptWriter().writer,
      workspaces,
      workspaceVerifier: workspaceVerifier(),
      commandRunner: {
        run: async () => {
          throw new Error('gate runner crashed');
        },
      },
      attempts: attempts.recorder,
      randomAttemptId: () => 'attempt-crashed',
    });

    await expect(service.run({
      policy: localPolicy(),
      repository: REPOSITORY,
      pullRequest: 17,
      workspaceId: 'workspace-1',
      review: { outcome: 'clean_llm_review', reviewId: 55 },
    })).rejects.toThrow('gate runner crashed');

    expect(attempts.calls.interrupted).toEqual([{
      attemptId: 'attempt-crashed',
      request: {
        finishedAt: expect.any(String),
        detail: 'Verification runner failed before a verdict was recorded',
      },
    }]);
  });

  it('durably queues the exact-head request when heavy admission is denied instead of losing it', async () => {
    const controller = new ResourceAdmissionController({
      globalCost: 16,
      workspaceCost: 16,
      sessionCost: 16,
      maxOperations: 8,
      resourceClassCost: { verification_heavy: 8 },
    });
    expect(tryAdmitVerificationHeavy(controller, {
      operationId: 'other-verification',
      workspaceId: 'workspace-2',
      cost: 8,
    }).admitted).toBe(true);
    const attempts = attemptRecorder();
    const run = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const service = createService({
      github: githubFor(),
      receipts: receiptWriter().writer,
      workspaces,
      workspaceVerifier: workspaceVerifier(),
      commandRunner: { run },
      attempts: attempts.recorder,
      admission: controller,
      randomAttemptId: () => 'attempt-denied',
      now: () => new Date('2026-10-27T10:00:00Z'),
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
        status: 'queued',
        attemptId: 'attempt-denied',
        repository: REPOSITORY,
        pullRequest: 17,
        headSha: HEAD,
        reason: 'resource_class_cost_exhausted',
        retryable: true,
        requestedCost: 8,
        detail: expect.stringContaining('no gate ran and no receipt exists'),
      },
    });
    expect(attempts.calls.enqueue).toEqual([{
      attemptId: 'attempt-denied',
      repository: REPOSITORY,
      pullRequest: 17,
      headSha: HEAD,
      baseBranch: 'main',
      workspaceId: 'workspace-1',
      requestedAt: '2026-10-27T10:00:00.000Z',
    }]);
    expect(attempts.calls.begin).toEqual([]);
    expect(attempts.calls.claim).toEqual([]);
    expect(run).not.toHaveBeenCalled();
    expect(controller.snapshot()).toMatchObject({ activeCost: 8, activeOperations: 1 });
  });

  it('fails closed with RESOURCE_PRESSURE when the denied request cannot be queued durably', async () => {
    const controller = new ResourceAdmissionController({
      globalCost: 16,
      workspaceCost: 16,
      sessionCost: 16,
      maxOperations: 8,
      resourceClassCost: { verification_heavy: 8 },
    });
    expect(tryAdmitVerificationHeavy(controller, {
      operationId: 'other-verification',
      workspaceId: 'workspace-2',
      cost: 8,
    }).admitted).toBe(true);
    const attempts = attemptRecorder({ enqueueFails: true });
    const run = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const service = createService({
      github: githubFor(),
      receipts: receiptWriter().writer,
      workspaces,
      workspaceVerifier: workspaceVerifier(),
      commandRunner: { run },
      attempts: attempts.recorder,
      admission: controller,
      randomAttemptId: () => 'attempt-denied',
    });

    const result = await service.run({
      policy: localPolicy(),
      repository: REPOSITORY,
      pullRequest: 17,
      workspaceId: 'workspace-1',
      review: { outcome: 'clean_llm_review', reviewId: 55 },
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'RESOURCE_PRESSURE',
        details: {
          reason: 'resource_class_cost_exhausted',
          operationId: 'attempt-denied',
          requestedCost: 8,
          retryable: 1,
        },
      },
    });
    expect(attempts.calls.begin).toEqual([]);
    expect(run).not.toHaveBeenCalled();
    expect(controller.snapshot()).toMatchObject({ activeCost: 8, activeOperations: 1 });
  });

  it('claims the durable queued attempt for the same exact head instead of duplicating it', async () => {
    const attempts = attemptRecorder({ active: { attemptId: 'queued-attempt', status: 'queued' } });
    const run = vi.fn(async () => ({ exitCode: 0, stdout: '511 passed', stderr: '' }));
    const receipts = receiptWriter();
    const service = createService({
      github: githubFor(),
      receipts: receipts.writer,
      workspaces,
      workspaceVerifier: workspaceVerifier(),
      commandRunner: { run },
      attempts: attempts.recorder,
      now: () => new Date('2026-10-27T10:10:00Z'),
      randomId: () => 'receipt-id',
      randomAttemptId: () => 'must-not-be-used',
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
      value: { status: 'completed', decision: { status: 'MERGE_ALLOWED' } },
    });
    expect(attempts.calls.claim).toEqual([{
      attemptId: 'queued-attempt',
      request: { claimedAt: '2026-10-27T10:10:00.000Z', workspaceId: 'workspace-1' },
    }]);
    expect(attempts.calls.begin).toEqual([]);
    expect(attempts.calls.enqueue).toEqual([]);
    expect(attempts.calls.finish[0]).toMatchObject({
      attemptId: 'queued-attempt',
      request: { status: 'completed', receiptRef: `merge-verification:17@${HEAD}:receipt-id` },
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(receipts.append).toHaveBeenCalledTimes(1);
  });

  it('reports the same queued attempt again while heavy admission is still denied', async () => {
    const controller = new ResourceAdmissionController({
      globalCost: 16,
      workspaceCost: 16,
      sessionCost: 16,
      maxOperations: 8,
      resourceClassCost: { verification_heavy: 8 },
    });
    expect(tryAdmitVerificationHeavy(controller, {
      operationId: 'other-verification',
      workspaceId: 'workspace-2',
      cost: 8,
    }).admitted).toBe(true);
    const attempts = attemptRecorder({ active: { attemptId: 'queued-attempt', status: 'queued' } });
    const run = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const service = createService({
      github: githubFor(),
      receipts: receiptWriter().writer,
      workspaces,
      workspaceVerifier: workspaceVerifier(),
      commandRunner: { run },
      attempts: attempts.recorder,
      admission: controller,
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
      value: { status: 'queued', attemptId: 'queued-attempt', reason: 'resource_class_cost_exhausted' },
    });
    expect(attempts.calls.claim).toEqual([]);
    expect(attempts.calls.enqueue).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  it('adopts a concurrent queued row when begin loses the unique-index race', async () => {
    const attempts = attemptRecorder();
    const run = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const findActive = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ attemptId: 'concurrent-queued', status: 'queued' });
    const service = createService({
      github: githubFor(),
      receipts: receiptWriter().writer,
      workspaces,
      workspaceVerifier: workspaceVerifier(),
      commandRunner: { run },
      attempts: {
        ...attempts.recorder,
        begin: async () => {
          throw new Error('unique index');
        },
        findActive,
      },
      randomAttemptId: () => 'attempt-own',
    });

    const result = await service.run({
      policy: localPolicy(),
      repository: REPOSITORY,
      pullRequest: 17,
      workspaceId: 'workspace-1',
      review: { outcome: 'clean_llm_review', reviewId: 55 },
    });

    expect(result).toMatchObject({ ok: true, value: { status: 'completed' } });
    expect(attempts.calls.claim[0]).toMatchObject({ attemptId: 'concurrent-queued' });
    expect(attempts.calls.finish[0]).toMatchObject({ attemptId: 'concurrent-queued' });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('reports the concurrently queued attempt id when its own enqueue loses the race', async () => {
    const controller = new ResourceAdmissionController({
      globalCost: 16,
      workspaceCost: 16,
      sessionCost: 16,
      maxOperations: 8,
      resourceClassCost: { verification_heavy: 8 },
    });
    expect(tryAdmitVerificationHeavy(controller, {
      operationId: 'other-verification',
      workspaceId: 'workspace-2',
      cost: 8,
    }).admitted).toBe(true);
    const attempts = attemptRecorder({ enqueueFails: true });
    const findActive = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ attemptId: 'concurrent-queued', status: 'queued' });
    const service = createService({
      github: githubFor(),
      receipts: receiptWriter().writer,
      workspaces,
      workspaceVerifier: workspaceVerifier(),
      commandRunner: { run: vi.fn() },
      attempts: { ...attempts.recorder, findActive },
      admission: controller,
      randomAttemptId: () => 'attempt-own',
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
      value: { status: 'queued', attemptId: 'concurrent-queued', reason: 'resource_class_cost_exhausted' },
    });
  });

  it('releases the heavy admission lease after a successful, blocked and thrown run', async () => {
    const controller = new ResourceAdmissionController({
      globalCost: 16,
      workspaceCost: 8,
      sessionCost: 8,
      maxOperations: 8,
      resourceClassCost: { verification_heavy: 8 },
    });
    const args = {
      policy: localPolicy(),
      repository: REPOSITORY,
      pullRequest: 17,
      workspaceId: 'workspace-1',
      review: { outcome: 'clean_llm_review' as const, reviewId: 55 },
    };
    const build = (commandRunner: VerificationCommandRunner, attempts = attemptRecorder()): ReturnType<typeof createMergeVerificationRunPort> => createService({
      github: githubFor(),
      receipts: receiptWriter().writer,
      workspaces,
      workspaceVerifier: workspaceVerifier(),
      commandRunner,
      attempts: attempts.recorder,
      admission: controller,
      randomAttemptId: () => 'attempt-admitted',
    });

    let heldDuringRun = -1;
    await build({
      run: async () => {
        heldDuringRun = controller.snapshot().activeCostByClass.verification_heavy;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    }).run(args);
    expect(heldDuringRun).toBe(8);
    expect(controller.snapshot()).toMatchObject({ activeCost: 0, activeOperations: 0 });

    await build({ run: async () => ({ exitCode: 1, stdout: '1 failed', stderr: '' }) }).run(args);
    expect(controller.snapshot()).toMatchObject({ activeCost: 0, activeOperations: 0 });

    const attempts = attemptRecorder();
    await expect(build({
      run: async () => {
        throw new Error('gate runner crashed after admission');
      },
    }, attempts).run(args)).rejects.toThrow('gate runner crashed after admission');
    expect(attempts.calls.interrupted).toHaveLength(1);
    expect(controller.snapshot()).toMatchObject({ activeCost: 0, activeOperations: 0 });
  });

  it('checks the duplicate live attempt before asking for a heavy admission slot', async () => {
    const attempts = attemptRecorder({ live: { attemptId: 'already-running' } });
    const controller = new ResourceAdmissionController({
      globalCost: 16,
      workspaceCost: 8,
      sessionCost: 8,
      maxOperations: 8,
      resourceClassCost: { verification_heavy: 8 },
    });
    const tryAcquire = vi.spyOn(controller, 'tryAcquire');
    const service = createService({
      github: githubFor(),
      receipts: receiptWriter().writer,
      workspaces,
      workspaceVerifier: workspaceVerifier(),
      commandRunner: { run: vi.fn() },
      attempts: attempts.recorder,
      admission: controller,
    });

    const result = await service.run({
      policy: localPolicy(),
      repository: REPOSITORY,
      pullRequest: 17,
      workspaceId: 'workspace-1',
      review: { outcome: 'clean_llm_review', reviewId: 55 },
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(tryAcquire).not.toHaveBeenCalled();
  });

  it('rejects a missing workspace before spending a heavy admission slot', async () => {
    const attempts = attemptRecorder();
    const run = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const controller = permissiveAdmission();
    const tryAcquire = vi.spyOn(controller, 'tryAcquire');
    const service = createService({
      github: githubFor(),
      receipts: receiptWriter().writer,
      workspaces,
      workspaceVerifier: workspaceVerifier(),
      commandRunner: { run },
      attempts: attempts.recorder,
      admission: controller,
    });

    const result = await service.run({
      policy: localPolicy(),
      repository: REPOSITORY,
      pullRequest: 17,
      review: { outcome: 'clean_llm_review', reviewId: 55 },
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(tryAcquire).not.toHaveBeenCalled();
    expect(attempts.calls.begin).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  it('releases the lease when the attempt cannot be recorded', async () => {
    const controller = permissiveAdmission();
    const attempts = attemptRecorder();
    const run = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const service = createService({
      github: githubFor(),
      receipts: receiptWriter().writer,
      workspaces,
      workspaceVerifier: workspaceVerifier(),
      commandRunner: { run },
      attempts: {
        ...attempts.recorder,
        begin: async () => {
          expect(controller.snapshot().activeCostByClass.verification_heavy).toBe(8);
          throw new Error('storage unavailable');
        },
        findActive: async () => undefined,
      },
      admission: controller,
    });

    const result = await service.run({
      policy: localPolicy(),
      repository: REPOSITORY,
      pullRequest: 17,
      workspaceId: 'workspace-1',
      review: { outcome: 'clean_llm_review', reviewId: 55 },
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    expect(run).not.toHaveBeenCalled();
    expect(controller.snapshot()).toMatchObject({ activeCost: 0, activeOperations: 0 });
  });

  it('releases the lease when a begin race loses to a live attempt', async () => {
    const controller = permissiveAdmission();
    const tryAcquire = vi.spyOn(controller, 'tryAcquire');
    const attempts = attemptRecorder();
    const findActive = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ attemptId: 'race-winner', status: 'running' });
    const run = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const service = createService({
      github: githubFor(),
      receipts: receiptWriter().writer,
      workspaces,
      workspaceVerifier: workspaceVerifier(),
      commandRunner: { run },
      attempts: {
        ...attempts.recorder,
        begin: async () => {
          throw new Error('unique index');
        },
        findActive,
      },
      admission: controller,
    });

    const result = await service.run({
      policy: localPolicy(),
      repository: REPOSITORY,
      pullRequest: 17,
      workspaceId: 'workspace-1',
      review: { outcome: 'clean_llm_review', reviewId: 55 },
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'CONFLICT', message: expect.stringContaining('race-winner') },
    });
    expect(findActive).toHaveBeenCalledTimes(2);
    expect(tryAcquire).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
    expect(controller.snapshot()).toMatchObject({ activeCost: 0, activeOperations: 0 });
  });

  it('leaves CI-only verification runs outside the attempt and admission ledgers', async () => {
    const attempts = attemptRecorder();
    const controller = permissiveAdmission();
    const tryAcquire = vi.spyOn(controller, 'tryAcquire');
    const run = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const service = createService({
      github: githubFor(),
      receipts: receiptWriter().writer,
      workspaces,
      workspaceVerifier: workspaceVerifier(),
      commandRunner: { run },
      attempts: attempts.recorder,
      admission: controller,
    });

    const result = await service.run({
      policy: githubOnlyPolicy(),
      repository: REPOSITORY,
      pullRequest: 17,
      review: { outcome: 'clean_llm_review', reviewId: 55 },
    });

    expect(result).toMatchObject({ ok: true });
    expect(attempts.calls.begin).toEqual([]);
    expect(tryAcquire).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('admits and releases heavy gates even without an attempt recorder', async () => {
    const controller = permissiveAdmission();
    const tryAcquire = vi.spyOn(controller, 'tryAcquire');
    const service = createService({
      github: githubFor(),
      receipts: receiptWriter().writer,
      workspaces,
      workspaceVerifier: workspaceVerifier(),
      commandRunner: { run: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })) },
      admission: controller,
    });

    const result = await service.run({
      policy: localPolicy(),
      repository: REPOSITORY,
      pullRequest: 17,
      workspaceId: 'workspace-1',
      review: { outcome: 'clean_llm_review', reviewId: 55 },
    });

    expect(result).toMatchObject({ ok: true });
    expect(tryAcquire).toHaveBeenCalledTimes(1);
    expect(controller.snapshot()).toMatchObject({ activeCost: 0, activeOperations: 0 });
  });

  it('reuses an identical persisted verdict instead of re-running local gates', async () => {
    const stored = storedReceipt();
    const listForExactHead = vi.fn(async () => [storedVerdict(stored)]);
    const append = vi.fn(async () => ({ appended: true, record: { sequence: 7 } }));
    const run = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const service = createService({
      github: githubFor(),
      receipts: { append, listForExactHead },
      workspaces,
      workspaceVerifier: workspaceVerifier(),
      commandRunner: { run },
      now: () => new Date('2026-10-07T11:00:00Z'),
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
        status: 'completed',
        receiptRef: `merge-verification:17@${HEAD}:stored`,
        sequence: 3,
        receipt: stored,
        decision: { status: 'MERGE_ALLOWED' },
      },
    });
    expect(listForExactHead).toHaveBeenCalledWith({
      repository: REPOSITORY,
      pullRequest: 17,
      headSha: HEAD,
      limit: 10,
    });
    expect(run).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  it('reuses a persisted GitHub-check verdict without a workspace or admission', async () => {
    const stored = storedReceipt({
      verificationMode: 'hybrid',
      gates: [{ name: 'Runtime Parity', source: 'github_check', headSha: HEAD, outcome: 'passed' }],
    });
    const controller = permissiveAdmission();
    const tryAcquire = vi.spyOn(controller, 'tryAcquire');
    const run = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const service = createService({
      github: githubFor(),
      receipts: { append: vi.fn(), listForExactHead: vi.fn(async () => [storedVerdict(stored)]) },
      workspaces,
      workspaceVerifier: workspaceVerifier(),
      commandRunner: { run },
      admission: controller,
    });

    const result = await service.run({
      policy: githubOnlyPolicy(),
      repository: REPOSITORY,
      pullRequest: 17,
      review: { outcome: 'clean_llm_review', reviewId: 55 },
    });

    expect(result).toMatchObject({ ok: true, value: { receiptRef: `merge-verification:17@${HEAD}:stored` } });
    expect(run).not.toHaveBeenCalled();
    expect(tryAcquire).not.toHaveBeenCalled();
  });

  it('re-runs gates when the requested review evidence differs from the receipt', async () => {
    const stored = storedReceipt({
      review: { outcome: 'clean_llm_review', headSha: HEAD, evidence: 'GitHub review 54: [merge-review:clean] older review' },
    });
    const append = vi.fn(async () => ({ appended: true, record: { sequence: 8 } }));
    const run = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const service = createService({
      github: githubFor(),
      receipts: { append, listForExactHead: vi.fn(async () => [storedVerdict(stored)]) },
      workspaces,
      workspaceVerifier: workspaceVerifier(),
      commandRunner: { run },
      now: () => new Date('2026-10-07T11:00:00Z'),
      randomId: () => 'fresh-id',
    });

    const result = await service.run({
      policy: localPolicy(),
      repository: REPOSITORY,
      pullRequest: 17,
      workspaceId: 'workspace-1',
      review: { outcome: 'clean_llm_review', reviewId: 55 },
    });

    expect(result).toMatchObject({ ok: true, value: { receiptRef: `merge-verification:17@${HEAD}:fresh-id`, sequence: 8 } });
    expect(run).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledTimes(1);
  });

  it('re-runs gates when the current policy requires a gate the receipt lacks', async () => {
    const stored = storedReceipt({ gates: [] });
    const append = vi.fn(async () => ({ appended: true, record: { sequence: 8 } }));
    const run = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const service = createService({
      github: githubFor(),
      receipts: { append, listForExactHead: vi.fn(async () => [storedVerdict(stored)]) },
      workspaces,
      workspaceVerifier: workspaceVerifier(),
      commandRunner: { run },
      now: () => new Date('2026-10-07T11:00:00Z'),
      randomId: () => 'fresh-id',
    });

    const result = await service.run({
      policy: localPolicy(),
      repository: REPOSITORY,
      pullRequest: 17,
      workspaceId: 'workspace-1',
      review: { outcome: 'clean_llm_review', reviewId: 55 },
    });

    expect(result).toMatchObject({ ok: true, value: { receiptRef: `merge-verification:17@${HEAD}:fresh-id` } });
    expect(run).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledTimes(1);
  });

  it('re-runs gates when the base moved or the ledger read fails', async () => {
    const movedBase = storedReceipt({ baseSha: 'b'.repeat(40) });
    const append = vi.fn(async () => ({ appended: true, record: { sequence: 8 } }));
    const run = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const movedBaseService = createService({
      github: githubFor(),
      receipts: { append, listForExactHead: vi.fn(async () => [storedVerdict(movedBase)]) },
      workspaces,
      workspaceVerifier: workspaceVerifier(),
      commandRunner: { run },
      now: () => new Date('2026-10-07T11:00:00Z'),
      randomId: () => 'fresh-id',
    });

    await expect(movedBaseService.run({
      policy: localPolicy(),
      repository: REPOSITORY,
      pullRequest: 17,
      workspaceId: 'workspace-1',
      review: { outcome: 'clean_llm_review', reviewId: 55 },
    })).resolves.toMatchObject({ ok: true, value: { receiptRef: `merge-verification:17@${HEAD}:fresh-id` } });
    expect(run).toHaveBeenCalledTimes(1);

    const failingReadService = createService({
      github: githubFor(),
      receipts: {
        append,
        listForExactHead: vi.fn(async () => {
          throw new Error('ledger unavailable');
        }),
      },
      workspaces,
      workspaceVerifier: workspaceVerifier(),
      commandRunner: { run },
      now: () => new Date('2026-10-07T11:00:00Z'),
      randomId: () => 'fresh-id',
    });

    await expect(failingReadService.run({
      policy: localPolicy(),
      repository: REPOSITORY,
      pullRequest: 17,
      workspaceId: 'workspace-1',
      review: { outcome: 'clean_llm_review', reviewId: 55 },
    })).resolves.toMatchObject({ ok: true, value: { receiptRef: `merge-verification:17@${HEAD}:fresh-id` } });
    expect(run).toHaveBeenCalledTimes(2);
    expect(append).toHaveBeenCalledTimes(2);
  });
});

function attemptRecorder(options: {
  live?: { attemptId: string };
  active?: { attemptId: string; status: 'queued' | 'running' };
  enqueueFails?: boolean;
} = {}): {
  recorder: MergeVerificationAttemptRecorder;
  calls: {
    begin: unknown[];
    enqueue: unknown[];
    claim: Array<{ attemptId: string; request: unknown }>;
    heartbeat: Array<{ attemptId: string; request: unknown }>;
    finish: Array<{ attemptId: string; request: unknown }>;
    interrupted: Array<{ attemptId: string; request: unknown }>;
  };
} {
  const active = options.active
    ?? (options.live === undefined ? undefined : { ...options.live, status: 'running' as const });
  const calls = {
    begin: [] as unknown[],
    enqueue: [] as unknown[],
    claim: [] as Array<{ attemptId: string; request: unknown }>,
    heartbeat: [] as Array<{ attemptId: string; request: unknown }>,
    finish: [] as Array<{ attemptId: string; request: unknown }>,
    interrupted: [] as Array<{ attemptId: string; request: unknown }>,
  };
  return {
    calls,
    recorder: {
      begin: async (request): Promise<unknown> => {
        calls.begin.push(request);
        return request;
      },
      enqueue: async (request): Promise<unknown> => {
        if (options.enqueueFails === true) throw new Error('a live or queued attempt already exists');
        calls.enqueue.push(request);
        return request;
      },
      claimQueued: async (attemptId, request): Promise<unknown> => {
        calls.claim.push({ attemptId, request });
        return {};
      },
      heartbeat: async (attemptId, request): Promise<boolean> => {
        calls.heartbeat.push({ attemptId, request });
        return true;
      },
      finish: async (attemptId, request): Promise<unknown> => {
        calls.finish.push({ attemptId, request });
        return {};
      },
      markInterrupted: async (attemptId, request): Promise<unknown> => {
        calls.interrupted.push({ attemptId, request });
        return {};
      },
      findActive: async (): Promise<{ attemptId: string; status: 'queued' | 'running' } | undefined> => active,
      reapStale: async (): Promise<readonly string[]> => [],
    },
  };
}
