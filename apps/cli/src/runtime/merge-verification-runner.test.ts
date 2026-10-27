import { describe, expect, it, vi } from 'vitest';
import { err, appError, type RepositoryMergePolicy } from '@unified-mpc/domain';
import type { WorkspaceRepository } from '@unified-mpc/workspace';
import { ResourceAdmissionController, tryAdmitVerificationHeavy } from '@unified-mpc/workspace';
import {
  createMergeVerificationRunPort,
  type ExactHeadWorkspaceVerifier,
  type MergeVerificationAdmissionPort,
  type MergeVerificationAttemptRecorder,
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

  it('fails closed with RESOURCE_PRESSURE before recording an attempt or running a gate', async () => {
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
        findLive: async () => undefined,
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
    const findLive = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ attemptId: 'race-winner' });
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
        findLive,
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
    expect(findLive).toHaveBeenCalledTimes(2);
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
});

function attemptRecorder(options: { live?: { attemptId: string } } = {}): {
  recorder: MergeVerificationAttemptRecorder;
  calls: {
    begin: unknown[];
    heartbeat: Array<{ attemptId: string; request: unknown }>;
    finish: Array<{ attemptId: string; request: unknown }>;
    interrupted: Array<{ attemptId: string; request: unknown }>;
  };
} {
  const calls = {
    begin: [] as unknown[],
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
      findLive: async (): Promise<{ attemptId: string } | undefined> => options.live,
      reapStale: async (): Promise<readonly string[]> => [],
    },
  };
}
