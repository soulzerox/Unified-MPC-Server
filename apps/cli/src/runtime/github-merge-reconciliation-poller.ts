import type {
  AutomaticMergeReconciliationService,
  ObservedMergeReconciliationResult,
} from '@unified-mpc/application';
import type { RepositoryMergePolicy } from '@unified-mpc/domain';
import type { GitHubApiReader } from './github-merge-observer.js';

export const MERGE_RECONCILIATION_POLL_STATE_KEY = 'merge_reconciliation_poll_state_v1';

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 10;

export interface MergeReconciliationPollCursor {
  readonly startedAt: string;
  readonly updatedAtWatermark: string;
  readonly pullRequestsAtWatermark: readonly number[];
}

export interface MergeReconciliationPollStateStore {
  get(repository: string): MergeReconciliationPollCursor | undefined;
  set(repository: string, cursor: MergeReconciliationPollCursor): void;
  retain(repositories: readonly string[]): void;
}

export interface MergeReconciliationPollSettings {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export interface GitHubClosedPullRequestUpdate {
  readonly pullRequest: number;
  readonly updatedAt: string;
  readonly mergedAt?: string;
}

export interface GitHubClosedPullRequestFeedResult {
  readonly updates: readonly GitHubClosedPullRequestUpdate[];
  readonly complete: boolean;
}

export interface GitHubClosedPullRequestFeed {
  listUpdatedClosed(request: {
    readonly repository: string;
    readonly updatedAtInclusive: string;
  }): Promise<GitHubClosedPullRequestFeedResult>;
}

export interface MergeReconciliationPollerOptions {
  readonly pollIntervalMs?: number;
  readonly now?: () => Date;
}

export interface MergeReconciliationPollRepositorySummary {
  readonly repository: string;
  readonly status: 'ok' | 'provider_error' | 'state_error' | 'inspect_required' | 'feed_truncated';
  readonly candidates: number;
  readonly reconciled: number;
  readonly policyBreaches: number;
  readonly ignoredHistorical: number;
  readonly cursorAdvanced: boolean;
  readonly inspectReason?: string;
}

export interface MergeReconciliationPollSummary {
  readonly repositories: readonly MergeReconciliationPollRepositorySummary[];
}

export class GitHubMergeReconciliationPoller {
  private readonly pollIntervalMs: number;
  private readonly now: () => Date;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private closed = false;

  public constructor(
    private readonly policiesProvider: () => readonly RepositoryMergePolicy[],
    private readonly feed: GitHubClosedPullRequestFeed,
    private readonly stateStore: MergeReconciliationPollStateStore,
    private readonly reconciliation: Pick<AutomaticMergeReconciliationService, 'reconcile'>,
    options: MergeReconciliationPollerOptions = {},
  ) {
    this.pollIntervalMs = normalizePollInterval(options.pollIntervalMs);
    this.now = options.now ?? ((): Date => new Date());
  }

  public async start(): Promise<MergeReconciliationPollSummary> {
    try {
      return await this.reconcileOnce();
    } finally {
      this.schedulePoll();
    }
  }

  public close(): void {
    this.closed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  public async reconcileOnce(): Promise<MergeReconciliationPollSummary> {
    if (this.running) return { repositories: [] };
    this.running = true;
    try {
      const policies = this.policiesProvider();
      this.stateStore.retain(policies.map((policy) => policy.repository));
      const repositories: MergeReconciliationPollRepositorySummary[] = [];
      for (const policy of policies) {
        repositories.push(await this.reconcileRepository(policy));
      }
      return { repositories };
    } finally {
      this.running = false;
    }
  }

  private async reconcileRepository(policy: RepositoryMergePolicy): Promise<MergeReconciliationPollRepositorySummary> {
    let cursor: MergeReconciliationPollCursor;
    try {
      const stored = this.stateStore.get(policy.repository);
      if (stored === undefined) {
        const startedAt = floorToSecond(this.now()).toISOString();
        cursor = {
          startedAt,
          updatedAtWatermark: startedAt,
          pullRequestsAtWatermark: [],
        };
        this.stateStore.set(policy.repository, cursor);
      } else {
        cursor = stored;
      }
    } catch {
      return summary(policy.repository, 'state_error');
    }

    let feedResult: GitHubClosedPullRequestFeedResult;
    try {
      feedResult = await this.feed.listUpdatedClosed({
        repository: policy.repository,
        updatedAtInclusive: cursor.updatedAtWatermark,
      });
    } catch {
      return summary(policy.repository, 'provider_error');
    }
    if (!feedResult.complete) {
      return summary(policy.repository, 'feed_truncated');
    }

    const seenAtWatermark = new Set(cursor.pullRequestsAtWatermark);
    const pending = feedResult.updates
      .filter((update) => isAfterCursor(update, cursor, seenAtWatermark))
      .sort(compareUpdatesAscending);
    const historical = pending.filter((update) =>
      update.mergedAt !== undefined && Date.parse(update.mergedAt) < Date.parse(cursor.startedAt));
    const candidates = pending.filter((update) =>
      update.mergedAt !== undefined && Date.parse(update.mergedAt) >= Date.parse(cursor.startedAt));

    let reconciled = 0;
    let policyBreaches = 0;
    const terminalAtTimestamp = new Map<string, Set<number>>();
    for (const entry of historical) markTerminal(terminalAtTimestamp, entry);

    for (const update of candidates) {
      let result: ObservedMergeReconciliationResult;
      try {
        result = await this.reconciliation.reconcile({
          policy,
          repository: policy.repository,
          pullRequest: update.pullRequest,
          expectedMergeMethod: 'merge',
        });
      } catch {
        return {
          ...summary(policy.repository, 'inspect_required'),
          candidates: candidates.length,
          reconciled,
          policyBreaches,
          ignoredHistorical: historical.length,
          inspectReason: 'reconciliation_error',
        };
      }

      if (result.status === 'inspect_required') {
        return {
          ...summary(policy.repository, 'inspect_required'),
          candidates: candidates.length,
          reconciled,
          policyBreaches,
          ignoredHistorical: historical.length,
          inspectReason: result.reason,
        };
      }
      if (result.status === 'reconciled') reconciled += 1;
      else policyBreaches += 1;
      markTerminal(terminalAtTimestamp, update);
    }

    const nextCursor = advanceCursor(cursor, feedResult.updates, terminalAtTimestamp);
    let cursorAdvanced = false;
    if (!sameCursor(cursor, nextCursor)) {
      try {
        this.stateStore.set(policy.repository, nextCursor);
        cursorAdvanced = true;
      } catch {
        return {
          ...summary(policy.repository, 'state_error'),
          candidates: candidates.length,
          reconciled,
          policyBreaches,
          ignoredHistorical: historical.length,
        };
      }
    }

    return {
      repository: policy.repository,
      status: 'ok',
      candidates: candidates.length,
      reconciled,
      policyBreaches,
      ignoredHistorical: historical.length,
      cursorAdvanced,
    };
  }

  private schedulePoll(): void {
    if (this.closed || this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.reconcileOnce().catch(() => undefined).finally(() => this.schedulePoll());
    }, this.pollIntervalMs);
    this.timer.unref?.();
  }
}

export function createSettingsMergeReconciliationPollStateStore(
  settings: MergeReconciliationPollSettings,
): MergeReconciliationPollStateStore {
  return {
    get(repository): MergeReconciliationPollCursor | undefined {
      return readPersistedState(settings).repositories[repositoryKey(repository)];
    },
    set(repository, cursor): void {
      validateCursor(cursor);
      const state = readPersistedState(settings);
      settings.set(MERGE_RECONCILIATION_POLL_STATE_KEY, JSON.stringify({
        schemaVersion: 1,
        repositories: {
          ...state.repositories,
          [repositoryKey(repository)]: cursor,
        },
      }));
    },
    retain(repositories): void {
      const state = readPersistedState(settings);
      const active = new Set(repositories.map(repositoryKey));
      const retained = Object.fromEntries(
        Object.entries(state.repositories).filter(([repository]) => active.has(repository)),
      );
      if (Object.keys(retained).length === Object.keys(state.repositories).length) return;
      settings.set(MERGE_RECONCILIATION_POLL_STATE_KEY, JSON.stringify({
        schemaVersion: 1,
        repositories: retained,
      }));
    },
  };
}

export function createGitHubClosedPullRequestFeed(
  github: GitHubApiReader,
  options: { readonly pageSize?: number; readonly maxPages?: number } = {},
): GitHubClosedPullRequestFeed {
  const pageSize = boundedPositiveInteger(options.pageSize, DEFAULT_PAGE_SIZE, 100);
  const maxPages = boundedPositiveInteger(options.maxPages, DEFAULT_MAX_PAGES, 100);
  return {
    async listUpdatedClosed(request): Promise<GitHubClosedPullRequestFeedResult> {
      const { owner, repo } = repositoryCoordinates(request.repository);
      const watermark = requiredTimestamp(request.updatedAtInclusive, 'updatedAtInclusive');
      const updates: GitHubClosedPullRequestUpdate[] = [];
      let previousUpdatedAt: number | undefined;

      for (let page = 1; page <= maxPages; page += 1) {
        const value = await github.get(
          `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=closed&sort=updated&direction=desc&per_page=${pageSize}&page=${page}`,
          { maxBufferBytes: 16 * 1024 * 1024 },
        );
        if (!Array.isArray(value)) throw new Error('GitHub closed pull request page is invalid');
        if (value.length === 0) return { updates, complete: true };

        let crossedWatermark = false;
        for (const raw of value) {
          const record = requiredRecord(raw, 'closed pull request');
          const pullRequest = positiveInteger(record.number, 'pull request number');
          const base = requiredRecord(record.base, 'pull request base');
          const baseRepository = requiredRecord(base.repo, 'pull request base repository');
          if (baseRepository.full_name !== request.repository) {
            throw new Error('GitHub closed pull request repository identity mismatch');
          }
          const updatedAt = requiredTimestamp(record.updated_at, 'pull request updated_at');
          const updatedMs = Date.parse(updatedAt);
          if (previousUpdatedAt !== undefined && updatedMs > previousUpdatedAt) {
            throw new Error('GitHub closed pull request ordering is invalid');
          }
          previousUpdatedAt = updatedMs;
          const mergedAt = record.merged_at === null
            ? undefined
            : requiredTimestamp(record.merged_at, 'pull request merged_at');
          updates.push({
            pullRequest,
            updatedAt,
            ...(mergedAt === undefined ? {} : { mergedAt }),
          });
          if (updatedMs < Date.parse(watermark)) crossedWatermark = true;
        }

        if (crossedWatermark || value.length < pageSize) return { updates, complete: true };
      }
      return { updates, complete: false };
    },
  };
}

interface PersistedPollState {
  readonly schemaVersion: 1;
  readonly repositories: Readonly<Record<string, MergeReconciliationPollCursor>>;
}

function readPersistedState(settings: MergeReconciliationPollSettings): PersistedPollState {
  const raw = settings.get(MERGE_RECONCILIATION_POLL_STATE_KEY);
  if (raw === null || raw.trim().length === 0) return { schemaVersion: 1, repositories: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Merge reconciliation poll state is invalid JSON');
  }
  const root = requiredRecord(parsed, 'merge reconciliation poll state');
  if (root.schemaVersion !== 1) throw new Error('Merge reconciliation poll state schema is unsupported');
  const repositoriesValue = requiredRecord(root.repositories, 'merge reconciliation poll repositories');
  const repositories: Record<string, MergeReconciliationPollCursor> = {};
  for (const [key, value] of Object.entries(repositoriesValue)) {
    const repository = repositoryKey(key);
    if (repositories[repository] !== undefined) {
      throw new Error('Merge reconciliation poll state contains duplicate repository identities');
    }
    const cursorRecord = requiredRecord(value, 'merge reconciliation poll cursor');
    const cursor: MergeReconciliationPollCursor = {
      startedAt: requiredTimestamp(cursorRecord.startedAt, 'poll cursor startedAt'),
      updatedAtWatermark: requiredTimestamp(cursorRecord.updatedAtWatermark, 'poll cursor updatedAtWatermark'),
      pullRequestsAtWatermark: requiredPositiveIntegerArray(
        cursorRecord.pullRequestsAtWatermark,
        'poll cursor pullRequestsAtWatermark',
      ),
    };
    validateCursor(cursor);
    repositories[repository] = cursor;
  }
  return { schemaVersion: 1, repositories };
}

function validateCursor(cursor: MergeReconciliationPollCursor): void {
  requiredTimestamp(cursor.startedAt, 'poll cursor startedAt');
  requiredTimestamp(cursor.updatedAtWatermark, 'poll cursor updatedAtWatermark');
  if (Date.parse(cursor.updatedAtWatermark) < Date.parse(cursor.startedAt)) {
    throw new Error('Merge reconciliation poll watermark precedes startup');
  }
  requiredPositiveIntegerArray(cursor.pullRequestsAtWatermark, 'poll cursor pullRequestsAtWatermark');
}

function isAfterCursor(
  update: GitHubClosedPullRequestUpdate,
  cursor: MergeReconciliationPollCursor,
  seenAtWatermark: ReadonlySet<number>,
): boolean {
  const updated = Date.parse(update.updatedAt);
  const watermark = Date.parse(cursor.updatedAtWatermark);
  return updated > watermark || (updated === watermark && !seenAtWatermark.has(update.pullRequest));
}

function compareUpdatesAscending(a: GitHubClosedPullRequestUpdate, b: GitHubClosedPullRequestUpdate): number {
  return Date.parse(a.updatedAt) - Date.parse(b.updatedAt) || a.pullRequest - b.pullRequest;
}

function markTerminal(target: Map<string, Set<number>>, update: GitHubClosedPullRequestUpdate): void {
  const set = target.get(update.updatedAt) ?? new Set<number>();
  set.add(update.pullRequest);
  target.set(update.updatedAt, set);
}

function advanceCursor(
  cursor: MergeReconciliationPollCursor,
  updates: readonly GitHubClosedPullRequestUpdate[],
  terminalAtTimestamp: ReadonlyMap<string, ReadonlySet<number>>,
): MergeReconciliationPollCursor {
  let watermark = cursor.updatedAtWatermark;
  for (const update of updates) {
    if (Date.parse(update.updatedAt) > Date.parse(watermark)) watermark = update.updatedAt;
  }

  const pullRequests = new Set<number>(
    Date.parse(watermark) === Date.parse(cursor.updatedAtWatermark)
      ? cursor.pullRequestsAtWatermark
      : [],
  );
  for (const pullRequest of terminalAtTimestamp.get(watermark) ?? []) pullRequests.add(pullRequest);

  return {
    startedAt: cursor.startedAt,
    updatedAtWatermark: watermark,
    pullRequestsAtWatermark: [...pullRequests].sort((a, b) => a - b),
  };
}

function sameCursor(a: MergeReconciliationPollCursor, b: MergeReconciliationPollCursor): boolean {
  return a.startedAt === b.startedAt
    && a.updatedAtWatermark === b.updatedAtWatermark
    && a.pullRequestsAtWatermark.length === b.pullRequestsAtWatermark.length
    && a.pullRequestsAtWatermark.every((value, index) => value === b.pullRequestsAtWatermark[index]);
}

function summary(
  repository: string,
  status: MergeReconciliationPollRepositorySummary['status'],
): MergeReconciliationPollRepositorySummary {
  return {
    repository,
    status,
    candidates: 0,
    reconciled: 0,
    policyBreaches: 0,
    ignoredHistorical: 0,
    cursorAdvanced: false,
  };
}

function floorToSecond(value: Date): Date {
  return new Date(Math.floor(value.getTime() / 1_000) * 1_000);
}

function normalizePollInterval(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.floor(value))
    : DEFAULT_POLL_INTERVAL_MS;
}

function boundedPositiveInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (!Number.isInteger(value) || value === undefined || value <= 0 || value > maximum) return fallback;
  return value;
}

function repositoryCoordinates(value: string): { owner: string; repo: string } {
  const parts = value.trim().split('/');
  if (parts.length !== 2 || parts.some((part) => part.length === 0)) {
    throw new Error(`GitHub repository '${value}' must use owner/repo form`);
  }
  return { owner: parts[0]!, repo: parts[1]! };
}

function repositoryKey(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const parts = trimmed.split('/');
  if (trimmed.length === 0 || trimmed.length > 512 || parts.length !== 2 || parts.some((part) => part.length === 0)) {
    throw new Error('Merge reconciliation repository identity is invalid');
  }
  return trimmed;
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) throw new Error(`${label} is invalid`);
  return value as number;
}

function requiredPositiveIntegerArray(value: unknown, label: string): readonly number[] {
  if (!Array.isArray(value)) throw new Error(`${label} is invalid`);
  const result = value.map((entry) => positiveInteger(entry, label));
  if (new Set(result).size !== result.length) throw new Error(`${label} contains duplicates`);
  return result;
}

function requiredTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} is invalid`);
  }
  return value.trim();
}
