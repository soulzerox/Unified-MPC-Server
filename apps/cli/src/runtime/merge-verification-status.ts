import {
  evaluateMergeEvidence,
  type MergeEvidenceDecision,
  type MergeVerificationReceipt,
  type RepositoryMergePolicy,
} from '@unified-mpc/domain';

export type MergeVerificationStatusAttemptState = 'queued' | 'running' | 'completed' | 'failed' | 'interrupted';

export interface MergeVerificationStatusAttemptView {
  readonly attemptId: string;
  readonly headSha: string;
  readonly status: MergeVerificationStatusAttemptState;
  readonly baseBranch?: string;
  readonly workspaceId?: string;
  readonly gateName?: string;
  readonly startedAt: string;
  readonly heartbeatAt: string;
  readonly finishedAt?: string;
  readonly detail?: string;
  readonly receiptRef?: string;
}

export interface MergeVerificationStatusReceiptView {
  readonly receiptRef: string;
  readonly sequence: number;
  readonly headSha: string;
  readonly createdAt: string;
  readonly recordedAt: string;
}

export interface MergeVerificationStatusResult {
  readonly repository: string;
  readonly pullRequest: number;
  readonly headSha?: string;
  readonly attempts: readonly MergeVerificationStatusAttemptView[];
  readonly receipts: readonly MergeVerificationStatusReceiptView[];
  readonly latestReceiptRef?: string;
  readonly decision?: MergeEvidenceDecision;
}

export interface MergeVerificationStatusRequest {
  readonly repository: string;
  readonly pullRequest: number;
  readonly headSha?: string;
  readonly limit?: number;
}

interface AttemptSourceRecord {
  readonly attemptId: string;
  readonly headSha: string;
  readonly status: MergeVerificationStatusAttemptState;
  readonly baseBranch?: string;
  readonly workspaceId?: string;
  readonly gateName?: string;
  readonly startedAt: string;
  readonly heartbeatAt: string;
  readonly finishedAt?: string;
  readonly detail?: string;
  readonly receiptRef?: string;
}

interface ReceiptSourceRecord {
  readonly receiptRef: string;
  readonly sequence: number;
  readonly receipt: MergeVerificationReceipt;
  readonly recordedAt: string;
}

export interface MergeVerificationStatusDependencies {
  readonly attempts: {
    list(request: {
      readonly repository: string;
      readonly pullRequest: number;
      readonly headSha?: string;
      readonly limit?: number;
    }): Promise<readonly AttemptSourceRecord[]>;
  };
  readonly receipts: {
    listForExactHead(request: {
      readonly repository: string;
      readonly pullRequest: number;
      readonly headSha: string;
      readonly limit?: number;
    }): Promise<readonly ReceiptSourceRecord[]>;
    listForPullRequest(request: {
      readonly repository: string;
      readonly pullRequest: number;
      readonly limit?: number;
    }): Promise<readonly ReceiptSourceRecord[]>;
  };
  readonly policy: {
    getByRepository(repository: string): Promise<RepositoryMergePolicy | undefined>;
  };
  readonly now?: () => Date;
  readonly staleAfterMs?: number;
}

export interface MergeVerificationStatusPort {
  get(request: MergeVerificationStatusRequest): Promise<MergeVerificationStatusResult>;
}

const DEFAULT_STALE_AFTER_MS = 90_000;
const EXPIRED_DETAIL = 'Heartbeat expired without a verdict; the runner never reported completion';
const QUEUED_DETAIL = 'Queued behind heavy admission; no gate has run and no receipt exists yet. '
  + 'A merge_verification_run for this exact head claims it.';

/**
 * Read-only projection of durable verification state.
 *
 * This port never writes: a `running` row whose heartbeat expired is *reported* as
 * `interrupted`, and the owning runner repairs the stored row on its next attempt. That keeps
 * `merge_verification_status` genuinely read-only while still refusing to claim that a dead
 * runner is working. No decision is derived without an exact head, a persisted receipt and the
 * most recent base branch a verification attempt observed.
 */
export function createMergeVerificationStatusPort(
  deps: MergeVerificationStatusDependencies,
): MergeVerificationStatusPort {
  const now = deps.now ?? ((): Date => new Date());
  const staleAfterMs = deps.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;

  return {
    async get(request: MergeVerificationStatusRequest): Promise<MergeVerificationStatusResult> {
      const observedAt = now().toISOString();
      const staleCutoff = Date.parse(observedAt) - staleAfterMs;

      const attempts = request.headSha === undefined
        ? await deps.attempts.list({
            repository: request.repository,
            pullRequest: request.pullRequest,
            ...(request.limit === undefined ? {} : { limit: request.limit }),
          })
        : await deps.attempts.list({
            repository: request.repository,
            pullRequest: request.pullRequest,
            headSha: request.headSha,
            ...(request.limit === undefined ? {} : { limit: request.limit }),
          });

      const receipts = request.headSha === undefined
        ? await deps.receipts.listForPullRequest({
            repository: request.repository,
            pullRequest: request.pullRequest,
            ...(request.limit === undefined ? {} : { limit: request.limit }),
          })
        : await deps.receipts.listForExactHead({
            repository: request.repository,
            pullRequest: request.pullRequest,
            headSha: request.headSha,
            ...(request.limit === undefined ? {} : { limit: request.limit }),
          });

      const latest = receipts[0];
      const baseBranch = attempts.find((attempt) => attempt.baseBranch !== undefined)?.baseBranch;
      const policy = request.headSha === undefined || latest === undefined || baseBranch === undefined
        ? undefined
        : await deps.policy.getByRepository(request.repository);

      const decision = policy === undefined || latest === undefined || request.headSha === undefined || baseBranch === undefined
        ? undefined
        : evaluateMergeEvidence(policy, {
            repository: request.repository,
            pullRequest: request.pullRequest,
            headSha: request.headSha,
            baseBranch,
            ...(latest.receipt.baseSha === undefined ? {} : { baseSha: latest.receipt.baseSha }),
          }, latest.receipt);

      return {
        repository: request.repository,
        pullRequest: request.pullRequest,
        ...(request.headSha === undefined ? {} : { headSha: request.headSha }),
        attempts: attempts.map((record) => toAttemptView(record, staleCutoff)),
        receipts: receipts.map((record) => ({
          receiptRef: record.receiptRef,
          sequence: record.sequence,
          headSha: record.receipt.headSha,
          createdAt: record.receipt.createdAt,
          recordedAt: record.recordedAt,
        })),
        ...(latest === undefined ? {} : { latestReceiptRef: latest.receiptRef }),
        ...(decision === undefined ? {} : { decision }),
      };
    },
  };
}

function toAttemptView(
  record: AttemptSourceRecord,
  staleCutoff: number,
): MergeVerificationStatusAttemptView {
  const expired = record.status === 'running' && Date.parse(record.heartbeatAt) <= staleCutoff;
  const queued = record.status === 'queued';
  return {
    attemptId: record.attemptId,
    headSha: record.headSha,
    status: expired ? 'interrupted' : record.status,
    ...(record.baseBranch === undefined ? {} : { baseBranch: record.baseBranch }),
    ...(record.workspaceId === undefined ? {} : { workspaceId: record.workspaceId }),
    ...(record.gateName === undefined ? {} : { gateName: record.gateName }),
    startedAt: record.startedAt,
    heartbeatAt: record.heartbeatAt,
    ...(record.finishedAt === undefined ? {} : { finishedAt: record.finishedAt }),
    ...(record.detail === undefined && !expired && !queued
      ? {}
      : { detail: record.detail ?? (expired ? EXPIRED_DETAIL : QUEUED_DETAIL) }),
    ...(record.receiptRef === undefined ? {} : { receiptRef: record.receiptRef }),
  };
}
