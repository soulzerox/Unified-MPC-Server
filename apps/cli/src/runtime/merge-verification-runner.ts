import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  appError,
  err,
  evaluateMergeEvidence,
  ok,
  type AppError,
  type CommandSpec,
  type MergeGateOutcome,
  type MergeGateReceipt,
  type MergeReviewOutcome,
  type MergeVerificationQueuedOutcome,
  type MergeVerificationReceipt,
  type MergeVerificationRunOutcome,
  type MergeVerificationVerdictOutcome,
  type RepositoryMergePolicy,
  type RequiredMergeGate,
  type Result,
} from '@unified-mpc/domain';
import type { WorkspaceRepository } from '@unified-mpc/workspace';
import { DEFAULT_VERIFICATION_HEAVY_ADMISSION_COST } from '@unified-mpc/workspace';
import type {
  ResourceAdmissionDecision,
  ResourceAdmissionLease,
  ResourceAdmissionRequest,
  ResourceAdmissionSnapshot,
} from '@unified-mpc/workspace';
import type { GitHubApiReader } from './github-merge-observer.js';
import { githubRepositoryFromRemote } from './github-remote.js';

const LOCAL_GATE_TIMEOUT_MS = 20 * 60_000;
const MAX_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_EVIDENCE_CHARS = 3_500;
const SHA_PATTERN = /^[a-f0-9]{40,64}$/i;
const CLEAN_LLM_REVIEW_MARKER = '[merge-review:clean]';
/**
 * Local gates can run for up to 20 minutes, so the attempt row is kept live by a timer
 * rather than by gate boundaries. Six missed beats are treated as a dead runner.
 */
const ATTEMPT_HEARTBEAT_INTERVAL_MS = 15_000;
const ATTEMPT_STALE_AFTER_MS = 90_000;
/**
 * One exact-head verification holds a heavy admission slot for the whole gate
 * run. Two verification runs cannot overlap under the default class ceiling;
 * overlap with other heavy classes is bounded by the controller's global,
 * workspace, session and pressure ceilings (the final admission authority).
 */
const MERGE_VERIFICATION_ADMISSION_COST = DEFAULT_VERIFICATION_HEAVY_ADMISSION_COST;

export interface MergeVerificationRunRequest {
  readonly policy: RepositoryMergePolicy;
  readonly repository: string;
  readonly pullRequest: number;
  readonly workspaceId?: string;
  readonly review: {
    readonly outcome: MergeReviewOutcome;
    readonly reviewId?: number;
    readonly evidence?: string;
    readonly userConfirmed?: boolean;
  };
}

export type MergeVerificationVerdictResult = MergeVerificationVerdictOutcome;

/**
 * Durable queued outcome (#305). Heavy admission was denied, so no gate ran and no
 * receipt exists. The attempt row is persisted for the exact head and the next
 * `merge_verification_run` for that head claims it instead of duplicating it.
 */
export type MergeVerificationQueuedResult = MergeVerificationQueuedOutcome;

export type MergeVerificationRunResult = MergeVerificationRunOutcome;

export interface MergeVerificationRunPort {
  run(request: MergeVerificationRunRequest, signal?: AbortSignal): Promise<Result<MergeVerificationRunResult>>;
}

export interface MergeVerificationReceiptWriter {
  append(request: {
    readonly receiptRef: string;
    readonly receipt: MergeVerificationReceipt;
    readonly recordedAt: string;
  }): Promise<{
    readonly appended: boolean;
    readonly record: { readonly sequence: number };
  }>;
}

export interface VerificationCommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly unavailable?: boolean;
}

export interface VerificationCommandRunner {
  run(command: CommandSpec, cwd: string, signal?: AbortSignal): Promise<VerificationCommandResult>;
}

export interface ExactHeadWorkspaceVerifier {
  inspect(request: {
    readonly workspaceId: string;
    readonly repository: string;
    readonly headSha: string;
  }): Promise<Result<{ readonly rootPath: string }>>;
}

export interface MergeVerificationRunDependencies {
  readonly github: GitHubApiReader;
  readonly receipts: MergeVerificationReceiptWriter;
  readonly workspaces: WorkspaceRepository;
  readonly commandRunner?: VerificationCommandRunner;
  readonly workspaceVerifier?: ExactHeadWorkspaceVerifier;
  readonly attempts?: MergeVerificationAttemptRecorder;
  /** Shared #13 controller; heavy local gates must be admitted through it. */
  readonly admission: MergeVerificationAdmissionPort;
  readonly now?: () => Date;
  readonly randomId?: () => string;
  readonly randomAttemptId?: () => string;
}

/** Narrow structural port satisfied by `ResourceAdmissionController`. */
export interface MergeVerificationAdmissionPort {
  tryAcquire(request: ResourceAdmissionRequest): ResourceAdmissionDecision;
  release(lease: ResourceAdmissionLease): boolean;
}

/**
 * Narrow durable-attempt port. `SqliteMergeVerificationAttemptRepository` satisfies it
 * structurally, so this package keeps no storage dependency.
 */
export interface MergeVerificationAttemptRecorder {
  begin(request: {
    readonly attemptId: string;
    readonly repository: string;
    readonly pullRequest: number;
    readonly headSha: string;
    readonly baseBranch?: string;
    readonly workspaceId?: string;
    readonly startedAt: string;
  }): Promise<unknown>;
  /** Persist a `queued` attempt when heavy admission is denied (#305). */
  enqueue(request: {
    readonly attemptId: string;
    readonly repository: string;
    readonly pullRequest: number;
    readonly headSha: string;
    readonly baseBranch?: string;
    readonly workspaceId?: string;
    readonly requestedAt: string;
  }): Promise<unknown>;
  /** Promote one `queued` attempt to `running`; exactly one caller wins. */
  claimQueued(
    attemptId: string,
    request: { readonly claimedAt: string; readonly workspaceId?: string },
  ): Promise<unknown>;
  heartbeat(
    attemptId: string,
    request: { readonly heartbeatAt: string; readonly gateName?: string },
  ): Promise<boolean>;
  finish(attemptId: string, request: {
    readonly status: 'completed' | 'failed';
    readonly finishedAt: string;
    readonly detail?: string;
    readonly receiptRef?: string;
  }): Promise<unknown>;
  markInterrupted(
    attemptId: string,
    request: { readonly finishedAt: string; readonly detail: string },
  ): Promise<unknown>;
  /** Live-or-queued lookup; a queued row never expires, a running row must be fresh. */
  findActive(request: {
    readonly repository: string;
    readonly pullRequest: number;
    readonly headSha: string;
    readonly now: string;
    readonly staleAfterMs: number;
  }): Promise<ActiveMergeVerificationAttempt | undefined>;
  reapStale(request: {
    readonly now: string;
    readonly staleAfterMs: number;
  }): Promise<readonly string[]>;
}

export interface ActiveMergeVerificationAttempt {
  readonly attemptId: string;
  readonly status: 'queued' | 'running';
}

/** @deprecated Kept for older callers; `findActive` covers queued rows too. */
export interface LiveMergeVerificationAttempt {
  readonly attemptId: string;
}

export function createMergeVerificationRunPort(
  deps: MergeVerificationRunDependencies,
): MergeVerificationRunPort {
  const commandRunner = deps.commandRunner ?? createVerificationCommandRunner();
  const workspaceVerifier = deps.workspaceVerifier ?? createExactHeadWorkspaceVerifier(deps.workspaces);
  const now = deps.now ?? ((): Date => new Date());
  const randomId = deps.randomId ?? randomUUID;
  const randomAttemptId = deps.randomAttemptId ?? randomUUID;
  const attempts = deps.attempts;
  const context: VerifyContext = { deps, commandRunner, workspaceVerifier, now, randomId, attempts };

  return {
    async run(request, signal): Promise<Result<MergeVerificationRunResult>> {
      const subjectResult = await observeOpenPullRequest(deps.github, request.repository, request.pullRequest);
      if (!subjectResult.ok) return subjectResult;
      const subject = subjectResult.value;

      if (subject.repository !== request.policy.repository) {
        return err(appError('PERMISSION_DENIED', 'Requested repository does not match the authoritative merge policy'));
      }

      const localGates = request.policy.requiredGates.filter((gate) => gate.source === 'local_command');
      const admission = deps.admission;
      const heavy = localGates.length > 0;
      if (!heavy) return verify(context, request, subject, localGates, signal, undefined);
      if (request.workspaceId === undefined) {
        return err(appError('INVALID_INPUT', 'workspaceId is required for local exact-head verification gates'));
      }
      if (attempts === undefined) {
        const admitted = acquireVerificationAdmission(admission, {
          operationId: `merge-verification:${request.pullRequest}@${subject.headSha}`,
          workspaceId: request.workspaceId,
        });
        if (!admitted.ok) return admitted;
        const lease = admitted.value;
        try {
          return await verify(context, request, subject, localGates, signal, undefined);
        } finally {
          admission.release(lease);
        }
      }

      const startedAt = now().toISOString();
      await attempts.reapStale({ now: startedAt, staleAfterMs: ATTEMPT_STALE_AFTER_MS }).catch(() => []);

      const findActive = async (): Promise<ActiveMergeVerificationAttempt | undefined> => attempts.findActive({
        repository: request.repository,
        pullRequest: request.pullRequest,
        headSha: subject.headSha,
        now: now().toISOString(),
        staleAfterMs: ATTEMPT_STALE_AFTER_MS,
      });

      const queued = (attemptId: string, pressure: VerificationPressure): Result<MergeVerificationQueuedResult> => ok({
        status: 'queued',
        attemptId,
        repository: request.repository,
        pullRequest: request.pullRequest,
        headSha: subject.headSha,
        reason: pressure.reason,
        retryable: pressure.retryable,
        requestedCost: pressure.requestedCost,
        detail: 'Heavy admission was denied, so no gate ran and no receipt exists. '
          + 'The request is durably queued for this exact head: call merge_verification_run again to claim it, '
          + 'and read merge_verification_status for queued/running/terminal state.',
      });

      let active: ActiveMergeVerificationAttempt | undefined;
      try {
        active = await findActive();
      } catch {
        return err(appError('INTERNAL_ERROR', 'Merge verification attempt state could not be read', true));
      }
      if (active !== undefined && active.status === 'running') {
        return err(appError(
          'CONFLICT',
          `Merge verification is already running for this exact head (attempt ${active.attemptId}); `
          + 'wait for it to finish and query merge_verification_status instead of starting a duplicate run',
          true,
        ));
      }

      const runClaimedAttempt = async (attemptId: string): Promise<Result<MergeVerificationVerdictResult>> => {
        let result: Result<MergeVerificationVerdictResult>;
        try {
          // The durable attempt owns the run lifetime, not the caller's transport. A client
          // disconnect must not kill an exact-head verification that already recorded its
          // intent: each gate is still bounded by LOCAL_GATE_TIMEOUT_MS, and a crash leaves
          // the row to be reaped as interrupted rather than reported as completed.
          result = await verify(context, request, subject, localGates, undefined, attemptId);
        } catch (error) {
          await attempts.markInterrupted(attemptId, {
            finishedAt: now().toISOString(),
            detail: 'Verification runner failed before a verdict was recorded',
          }).catch(() => undefined);
          throw error;
        }

        const finishedAt = now().toISOString();
        try {
          await attempts.finish(attemptId, result.ok
            ? { status: 'completed', finishedAt, receiptRef: result.value.receiptRef }
            : { status: 'failed', finishedAt, detail: result.error.message });
        } catch {
          // The attempt row is already terminal (for example reaped as interrupted).
          // The receipt table remains authoritative for the verdict either way.
        }
        return result;
      };

      if (active !== undefined) {
        // A durable queued attempt already exists for this exact head: promote it instead
        // of inserting a duplicate, so the attempt id stays stable across retries.
        const decided = decideVerificationAdmission(admission, {
          operationId: active.attemptId,
          workspaceId: request.workspaceId,
        });
        if (decided.kind === 'rejected') return err(decided.error);
        if (decided.kind === 'pressure') return queued(active.attemptId, decided.pressure);
        const lease = decided.lease;
        try {
          try {
            await attempts.claimQueued(active.attemptId, {
              claimedAt: now().toISOString(),
              workspaceId: request.workspaceId,
            });
          } catch {
            const raced = await findActive().catch(() => undefined);
            if (raced !== undefined && raced.status === 'running') {
              return err(appError(
                'CONFLICT',
                `Merge verification is already running for this exact head (attempt ${raced.attemptId})`,
                true,
              ));
            }
            return err(appError('CONFLICT', 'Queued merge verification was claimed by another runner', true));
          }
          return await runClaimedAttempt(active.attemptId);
        } finally {
          admission.release(lease);
        }
      }

      const attemptId = randomAttemptId();
      const decided = decideVerificationAdmission(admission, {
        operationId: attemptId,
        workspaceId: request.workspaceId,
      });
      if (decided.kind === 'rejected') return err(decided.error);
      if (decided.kind === 'pressure') {
        // A denied admission must not evaporate: persist the request as a durable queued
        // attempt bound to this exact head, then report truthfully that nothing ran.
        try {
          await attempts.enqueue({
            attemptId,
            repository: request.repository,
            pullRequest: request.pullRequest,
            headSha: subject.headSha,
            baseBranch: subject.baseBranch,
            workspaceId: request.workspaceId,
            requestedAt: now().toISOString(),
          });
        } catch {
          const raced = await findActive().catch(() => undefined);
          if (raced !== undefined && raced.status === 'running') {
            return err(appError(
              'CONFLICT',
              `Merge verification is already running for this exact head (attempt ${raced.attemptId})`,
              true,
            ));
          }
          if (raced !== undefined) return queued(raced.attemptId, decided.pressure);
          // The intent could not be persisted; keep the truthful pressure failure.
          return pressureError(decided.pressure, attemptId);
        }
        return queued(attemptId, decided.pressure);
      }

      const lease = decided.lease;
      try {
        try {
          await attempts.begin({
            attemptId,
            repository: request.repository,
            pullRequest: request.pullRequest,
            headSha: subject.headSha,
            baseBranch: subject.baseBranch,
            ...(request.workspaceId === undefined ? {} : { workspaceId: request.workspaceId }),
            startedAt,
          });
        } catch {
          // The partial unique index allows one live-or-queued attempt per exact head, so a
          // losing race lands here rather than in the guard above. Re-check before blaming
          // storage: a concurrent queued row can be adopted instead of discarded.
          const raced = await findActive().catch(() => undefined);
          if (raced === undefined) {
            return err(appError('INTERNAL_ERROR', 'Merge verification attempt could not be recorded', true));
          }
          if (raced.status === 'running') {
            return err(appError(
              'CONFLICT',
              `Merge verification is already running for this exact head (attempt ${raced.attemptId})`,
              true,
            ));
          }
          try {
            await attempts.claimQueued(raced.attemptId, {
              claimedAt: now().toISOString(),
              workspaceId: request.workspaceId,
            });
          } catch {
            return err(appError('CONFLICT', 'Queued merge verification was claimed by another runner', true));
          }
          return await runClaimedAttempt(raced.attemptId);
        }

        return await runClaimedAttempt(attemptId);
      } finally {
        admission.release(lease);
      }
    },
  };
}

interface VerificationPressure {
  readonly reason: string;
  readonly requestedCost: number;
  readonly retryable: boolean;
  readonly snapshot: ResourceAdmissionSnapshot;
}

type VerificationAdmissionOutcome =
  | { readonly kind: 'admitted'; readonly lease: ResourceAdmissionLease }
  | { readonly kind: 'pressure'; readonly pressure: VerificationPressure }
  | { readonly kind: 'rejected'; readonly error: AppError };

function decideVerificationAdmission(
  admission: MergeVerificationAdmissionPort,
  input: { readonly operationId: string; readonly workspaceId: string },
): VerificationAdmissionOutcome {
  const decision = admission.tryAcquire({
    operationId: input.operationId,
    workspaceId: input.workspaceId,
    resourceClass: 'verification_heavy',
    cost: MERGE_VERIFICATION_ADMISSION_COST,
  });
  if (decision.admitted) return { kind: 'admitted', lease: decision.lease };
  if (decision.code === 'RESOURCE_PRESSURE') {
    return {
      kind: 'pressure',
      pressure: {
        reason: decision.reason,
        requestedCost: decision.requestedCost,
        retryable: decision.retryable,
        snapshot: decision.snapshot,
      },
    };
  }
  if (decision.reason === 'duplicate_operation') {
    return {
      kind: 'rejected',
      error: appError(
        'CONFLICT',
        `Merge verification admission is already held for ${input.operationId}`,
        true,
      ),
    };
  }
  return {
    kind: 'rejected',
    error: appError(
      'INVALID_INPUT',
      `Merge verification admission request was rejected (${decision.reason})`,
      false,
    ),
  };
}

function acquireVerificationAdmission(
  admission: MergeVerificationAdmissionPort,
  input: { readonly operationId: string; readonly workspaceId: string },
): Result<ResourceAdmissionLease> {
  const outcome = decideVerificationAdmission(admission, input);
  if (outcome.kind === 'admitted') return ok(outcome.lease);
  if (outcome.kind === 'pressure') return pressureError(outcome.pressure, input.operationId);
  return err(outcome.error);
}

function pressureError(pressure: VerificationPressure, operationId: string): Result<never> {
  return err(appError(
    'RESOURCE_PRESSURE',
    `Exact-head merge verification was not admitted (${pressure.reason}); `
    + 'wait for the running heavy work to finish, then retry',
    true,
    {
      reason: pressure.reason,
      operationId,
      requestedCost: pressure.requestedCost,
      retryable: pressure.retryable ? 1 : 0,
      pressureState: pressure.snapshot.pressureState,
      activeCost: pressure.snapshot.activeCost,
      effectiveGlobalCost: pressure.snapshot.effectiveGlobalCost,
    },
  ));
}

interface VerifyContext {
  readonly deps: MergeVerificationRunDependencies;
  readonly commandRunner: VerificationCommandRunner;
  readonly workspaceVerifier: ExactHeadWorkspaceVerifier;
  readonly now: () => Date;
  readonly randomId: () => string;
  readonly attempts: MergeVerificationAttemptRecorder | undefined;
}

async function verify(
  context: VerifyContext,
  request: MergeVerificationRunRequest,
  subject: OpenPullRequestSubject,
  localGates: readonly RequiredMergeGate[],
  signal: AbortSignal | undefined,
  attemptId: string | undefined,
): Promise<Result<MergeVerificationVerdictResult>> {
  const { deps, workspaceVerifier, now, randomId } = context;

  let workspaceRoot: string | undefined;
  if (localGates.length > 0) {
    if (request.workspaceId === undefined) {
      return err(appError('INVALID_INPUT', 'workspaceId is required for local exact-head verification gates'));
    }
    const inspected = await workspaceVerifier.inspect({
      workspaceId: request.workspaceId,
      repository: request.repository,
      headSha: subject.headSha,
    });
    if (!inspected.ok) return inspected;
    workspaceRoot = inspected.value.rootPath;
  }

  const githubRuns = request.policy.requiredGates.some((gate) => gate.source === 'github_check')
    ? await readGitHubWorkflowRuns(deps.github, request.repository, subject.headSha)
    : ok<readonly GitHubWorkflowRun[]>([]);
  if (!githubRuns.ok) return githubRuns;

  const gates: MergeGateReceipt[] = [];
  for (const gate of request.policy.requiredGates) {
    if (gate.source === 'local_command') {
      if (workspaceRoot === undefined) {
        return err(appError('INTERNAL_ERROR', 'Local merge verification workspace was not resolved'));
      }
      if (gate.command === undefined) {
        gates.push({
          name: gate.name,
          source: gate.source,
          headSha: subject.headSha,
          outcome: 'unavailable',
          evidence: 'Authoritative merge policy does not define a host-owned command for this local gate.',
        });
        continue;
      }

      const cwdResult = await resolveCommandCwd(workspaceRoot, gate.command.cwdRelative);
      if (!cwdResult.ok) return cwdResult;
      const commandResult = await runLocalGate(context, gate.name, gate.command, cwdResult.value, signal, attemptId);
      const outcome: MergeGateOutcome = commandResult.unavailable === true || commandResult.exitCode === null
        ? 'unavailable'
        : commandResult.exitCode === 0 ? 'passed' : 'failed';
      gates.push({
        name: gate.name,
        source: gate.source,
        headSha: subject.headSha,
        outcome,
        evidence: commandEvidence(gate.command, commandResult),
      });

      const rechecked = await workspaceVerifier.inspect({
        workspaceId: request.workspaceId!,
        repository: request.repository,
        headSha: subject.headSha,
      });
      if (!rechecked.ok) {
        return err(appError(
          'CONFLICT',
          `Exact-head verification workspace changed while running gate '${gate.name}'; receipt was not persisted`,
          true,
        ));
      }
      continue;
    }

    if (gate.source === 'github_check') {
      gates.push(githubGateReceipt(gate.name, subject.headSha, githubRuns.value));
      continue;
    }

    gates.push({
      name: gate.name,
      source: gate.source,
      headSha: subject.headSha,
      outcome: 'unavailable',
      evidence: 'No host-owned external verifier adapter is configured for this gate.',
    });
  }

  const reviewResult = await resolveReviewReceipt(deps.github, request, subject.headSha);
  if (!reviewResult.ok) return reviewResult;

  const createdAt = now().toISOString();
  const receipt: MergeVerificationReceipt = {
    repository: request.repository,
    pullRequest: request.pullRequest,
    headSha: subject.headSha,
    baseSha: subject.baseSha,
    verificationMode: request.policy.verificationMode,
    gates,
    review: reviewResult.value,
    createdAt,
  };
  const decision = evaluateMergeEvidence(request.policy, {
    repository: request.repository,
    pullRequest: request.pullRequest,
    headSha: subject.headSha,
    baseBranch: subject.baseBranch,
    baseSha: subject.baseSha,
  }, receipt);
  const receiptRef = `merge-verification:${request.pullRequest}@${subject.headSha}:${randomId()}`;

  try {
    const appended = await deps.receipts.append({ receiptRef, receipt, recordedAt: createdAt });
    return ok({
      status: 'completed' as const,
      receiptRef,
      receipt,
      decision,
      sequence: appended.record.sequence,
    });
  } catch {
    return err(appError('INTERNAL_ERROR', 'Merge verification receipt could not be persisted', true));
  }
}

async function runLocalGate(
  context: VerifyContext,
  gateName: string,
  command: CommandSpec,
  cwd: string,
  signal: AbortSignal | undefined,
  attemptId: string | undefined,
): Promise<VerificationCommandResult> {
  const { attempts, now, commandRunner } = context;
  if (attempts === undefined || attemptId === undefined) {
    return commandRunner.run(command, cwd, signal);
  }

  const beat = (): void => {
    void attempts.heartbeat(attemptId, { heartbeatAt: now().toISOString(), gateName }).catch(() => false);
  };
  beat();
  const timer = setInterval(beat, ATTEMPT_HEARTBEAT_INTERVAL_MS);
  timer.unref();
  try {
    return await commandRunner.run(command, cwd, signal);
  } finally {
    clearInterval(timer);
  }
}

interface OpenPullRequestSubject {
  readonly repository: string;
  readonly pullRequest: number;
  readonly headSha: string;
  readonly baseSha: string;
  readonly baseBranch: string;
}

interface GitHubWorkflowRun {
  readonly id: number;
  readonly name: string;
  readonly headSha: string;
  readonly status: string;
  readonly conclusion?: string;
  readonly htmlUrl?: string;
  readonly updatedAt?: string;
}

async function observeOpenPullRequest(
  github: GitHubApiReader,
  repository: string,
  pullRequest: number,
): Promise<Result<OpenPullRequestSubject>> {
  try {
    const { owner, repo } = repositoryCoordinates(repository);
    const raw = requiredRecord(await github.get(
      `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullRequest}`,
    ), 'pull request');
    if (raw.number !== pullRequest) return err(appError('CONFLICT', 'GitHub pull request identity mismatch'));
    if (raw.state !== 'open' || raw.merged === true) {
      return err(appError('CONFLICT', 'Merge verification receipts can only be produced for an open unmerged pull request'));
    }
    const head = requiredRecord(raw.head, 'pull request head');
    const base = requiredRecord(raw.base, 'pull request base');
    const baseRepository = requiredRecord(base.repo, 'pull request base repository');
    if (baseRepository.full_name !== repository) {
      return err(appError('CONFLICT', 'GitHub pull request repository identity mismatch'));
    }
    return ok({
      repository,
      pullRequest,
      headSha: requiredSha(head.sha, 'pull request head SHA'),
      baseSha: requiredSha(base.sha, 'pull request base SHA'),
      baseBranch: requiredString(base.ref, 'pull request base branch', 256),
    });
  } catch {
    return err(appError('CONFLICT', 'GitHub pull request state could not be observed', true));
  }
}

async function readGitHubWorkflowRuns(
  github: GitHubApiReader,
  repository: string,
  headSha: string,
): Promise<Result<readonly GitHubWorkflowRun[]>> {
  try {
    const { owner, repo } = repositoryCoordinates(repository);
    const raw = requiredRecord(await github.get(
      `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs?head_sha=${headSha}&per_page=100`,
      { maxBufferBytes: 8 * 1024 * 1024 },
    ), 'workflow runs');
    if (!Array.isArray(raw.workflow_runs)) throw new Error('workflow_runs is invalid');
    const runs = raw.workflow_runs.map((entry): GitHubWorkflowRun => {
      const run = requiredRecord(entry, 'workflow run');
      return {
        id: positiveInteger(run.id, 'workflow run id'),
        name: requiredString(run.name, 'workflow run name', 512),
        headSha: requiredSha(run.head_sha, 'workflow run head SHA'),
        status: requiredString(run.status, 'workflow run status', 64),
        ...(typeof run.conclusion === 'string' ? { conclusion: run.conclusion } : {}),
        ...(typeof run.html_url === 'string' ? { htmlUrl: run.html_url } : {}),
        ...(typeof run.updated_at === 'string' ? { updatedAt: run.updated_at } : {}),
      };
    });
    return ok(runs.filter((run) => run.headSha.toLowerCase() === headSha.toLowerCase()));
  } catch {
    return err(appError('CONFLICT', 'GitHub workflow evidence could not be observed', true));
  }
}

function githubGateReceipt(
  gateName: string,
  headSha: string,
  runs: readonly GitHubWorkflowRun[],
): MergeGateReceipt {
  const matching = runs
    .filter((run) => run.name === gateName)
    .sort((a, b) => b.id - a.id);
  const latest = matching[0];
  if (latest === undefined) {
    return {
      name: gateName,
      source: 'github_check',
      headSha,
      outcome: 'unavailable',
      evidence: 'No exact-head GitHub workflow run matched this required gate.',
    };
  }
  const passed = latest.status === 'completed' && latest.conclusion === 'success';
  const pending = latest.status !== 'completed';
  return {
    name: gateName,
    source: 'github_check',
    headSha,
    outcome: pending ? 'unavailable' : passed ? 'passed' : 'failed',
    evidence: boundedEvidence(
      `GitHub Actions run ${latest.id} status=${latest.status} conclusion=${latest.conclusion ?? 'none'}`
      + (latest.htmlUrl === undefined ? '' : ` url=${latest.htmlUrl}`),
    ),
  };
}

async function resolveReviewReceipt(
  github: GitHubApiReader,
  request: MergeVerificationRunRequest,
  headSha: string,
): Promise<Result<MergeVerificationReceipt['review']>> {
  const outcome = request.review.outcome;
  if (outcome === 'missing' || outcome === 'rejected') {
    return ok({
      outcome,
      headSha,
      ...(request.review.evidence?.trim() ? { evidence: boundedEvidence(request.review.evidence) } : {}),
    });
  }

  if (outcome === 'user_override') {
    if (request.review.userConfirmed !== true) {
      return err(appError('PERMISSION_REQUIRED', 'user_override review evidence requires explicit user confirmation'));
    }
    const evidence = request.review.evidence?.trim();
    if (!evidence) return err(appError('INVALID_INPUT', 'user_override review evidence is required'));
    return ok({ outcome, headSha, evidence: boundedEvidence(evidence) });
  }

  if (request.review.reviewId === undefined) {
    return err(appError('INVALID_INPUT', `${outcome} requires an exact GitHub reviewId`));
  }

  try {
    const { owner, repo } = repositoryCoordinates(request.repository);
    const raw = await github.get(
      `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${request.pullRequest}/reviews`,
      { maxBufferBytes: 8 * 1024 * 1024 },
    );
    if (!Array.isArray(raw)) throw new Error('reviews response is invalid');
    const candidate = raw
      .map((entry) => requiredRecord(entry, 'pull request review'))
      .find((entry) => entry.id === request.review.reviewId);
    if (candidate === undefined) return err(appError('CONFLICT', 'Referenced GitHub review was not found'));
    const commitId = requiredSha(candidate.commit_id, 'review commit id');
    if (commitId.toLowerCase() !== headSha.toLowerCase()) {
      return err(appError('CONFLICT', 'Referenced GitHub review is stale for the current pull request head'));
    }
    const state = requiredString(candidate.state, 'review state', 64).toUpperCase();
    if (outcome === 'github_approved' && state !== 'APPROVED') {
      return err(appError('CONFLICT', 'Referenced GitHub review is not an approval'));
    }
    if (outcome === 'clean_llm_review' && state !== 'COMMENTED') {
      return err(appError('CONFLICT', 'Referenced clean LLM review must be a truthful COMMENTED review'));
    }
    const body = typeof candidate.body === 'string' && candidate.body.trim().length > 0
      ? candidate.body.trim()
      : `GitHub review ${request.review.reviewId}`;
    if (outcome === 'clean_llm_review' && !body.includes(CLEAN_LLM_REVIEW_MARKER)) {
      return err(appError('CONFLICT', `Referenced clean LLM review must contain ${CLEAN_LLM_REVIEW_MARKER}`));
    }
    return ok({
      outcome,
      headSha,
      evidence: boundedEvidence(`GitHub review ${request.review.reviewId}: ${body}`),
    });
  } catch (error) {
    if (isResultLikeError(error)) return error;
    return err(appError('CONFLICT', 'GitHub review evidence could not be observed', true));
  }
}

function createExactHeadWorkspaceVerifier(workspaces: WorkspaceRepository): ExactHeadWorkspaceVerifier {
  return {
    async inspect(request): Promise<Result<{ readonly rootPath: string }>> {
      const workspace = await workspaces.get(request.workspaceId);
      if (workspace === null) return err(appError('WORKSPACE_NOT_FOUND', `Workspace not found: ${request.workspaceId}`));
      const rootPath = workspace.realRootPath;
      try {
        const [head, status, remote] = await Promise.all([
          execGit(rootPath, ['rev-parse', 'HEAD']),
          execGit(rootPath, ['status', '--porcelain=v1', '--untracked-files=normal']),
          execGit(rootPath, ['config', '--get', 'remote.origin.url']),
        ]);
        if (head.trim().toLowerCase() !== request.headSha.toLowerCase()) {
          return err(appError('CONFLICT', 'Verification workspace HEAD does not match the exact pull request head'));
        }
        if (status.trim().length > 0) {
          return err(appError('CONFLICT', 'Verification workspace must be clean before and after local gates'));
        }
        const observedRepository = await githubRepositoryFromRemote(remote.trim());
        if (observedRepository === undefined
          || observedRepository.toLowerCase() !== request.repository.toLowerCase()) {
          return err(appError('PERMISSION_DENIED', 'Verification workspace origin does not match the requested repository'));
        }
        return ok({ rootPath });
      } catch {
        return err(appError('CONFLICT', 'Verification workspace Git identity could not be inspected', true));
      }
    },
  };
}

function createVerificationCommandRunner(): VerificationCommandRunner {
  return {
    async run(command, cwd, signal): Promise<VerificationCommandResult> {
      return new Promise((resolve) => {
        execFile(command.executable, [...command.args], {
          cwd,
          encoding: 'utf8',
          shell: false,
          timeout: LOCAL_GATE_TIMEOUT_MS,
          maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
          ...(signal === undefined ? {} : { signal }),
        }, (error, stdout, stderr) => {
          if (error === null) {
            resolve({ exitCode: 0, stdout, stderr });
            return;
          }
          const code = (error as NodeJS.ErrnoException & { code?: string | number }).code;
          resolve({
            exitCode: typeof code === 'number' ? code : null,
            stdout: typeof stdout === 'string' ? stdout : '',
            stderr: typeof stderr === 'string' ? stderr : error.message,
            unavailable: code === 'ENOENT' || typeof code !== 'number',
          });
        });
      });
    },
  };
}

async function resolveCommandCwd(rootPath: string, cwdRelative: string | undefined): Promise<Result<string>> {
  if (cwdRelative === undefined) return ok(rootPath);
  try {
    const root = await realpath(rootPath);
    const candidate = await realpath(path.resolve(root, cwdRelative));
    if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
      return err(appError('PATH_OUTSIDE_WORKSPACE', 'Verification gate cwd escapes the registered workspace'));
    }
    return ok(candidate);
  } catch {
    return err(appError('INVALID_INPUT', 'Verification gate cwd could not be resolved inside the workspace'));
  }
}

function commandEvidence(command: CommandSpec, result: VerificationCommandResult): string {
  const printable = [command.executable, ...command.args].map(shellQuoteForEvidence).join(' ');
  return boundedEvidence(
    `command=${printable} exit=${result.exitCode ?? 'unavailable'}`
    + (result.stdout.trim() ? `\nstdout=${result.stdout.trim()}` : '')
    + (result.stderr.trim() ? `\nstderr=${result.stderr.trim()}` : ''),
  );
}

function shellQuoteForEvidence(value: string): string {
  return /^[A-Za-z0-9_./:@=+-]+$/.test(value) ? value : JSON.stringify(value);
}

function boundedEvidence(value: string): string {
  return value.length <= MAX_EVIDENCE_CHARS ? value : `${value.slice(0, MAX_EVIDENCE_CHARS - 15)}…[truncated]`;
}

async function execGit(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', [...args], {
      cwd,
      encoding: 'utf8',
      shell: false,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    }, (error, stdout) => error === null ? resolve(stdout) : reject(error));
  });
}

function repositoryCoordinates(value: string): { owner: string; repo: string } {
  const parts = value.trim().split('/');
  if (parts.length !== 2 || parts.some((part) => part.length === 0)) {
    throw new Error(`GitHub repository '${value}' must use owner/repo form`);
  }
  return { owner: parts[0]!, repo: parts[1]! };
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} is invalid`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string') throw new Error(`${label} is invalid`);
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maximum) throw new Error(`${label} is invalid`);
  return trimmed;
}

function requiredSha(value: unknown, label: string): string {
  const sha = requiredString(value, label, 128);
  if (!SHA_PATTERN.test(sha)) throw new Error(`${label} is invalid`);
  return sha.toLowerCase();
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) throw new Error(`${label} is invalid`);
  return value as number;
}

function isResultLikeError(value: unknown): value is Result<never> {
  return typeof value === 'object' && value !== null && 'ok' in value && (value as { ok?: unknown }).ok === false;
}
