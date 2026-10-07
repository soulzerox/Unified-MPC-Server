import { describe, expect, it, vi } from 'vitest';
import type { RepositoryMergePolicy } from '@unified-mpc/domain';
import {
  createGitHubClosedPullRequestFeed,
  createSettingsMergeReconciliationPollStateStore,
  GitHubMergeReconciliationPoller,
  MERGE_RECONCILIATION_POLL_STATE_KEY,
  type GitHubClosedPullRequestFeedResult,
  type MergeReconciliationPollCursor,
  type MergeReconciliationPollStateStore,
} from './github-merge-reconciliation-poller.js';

const policy: RepositoryMergePolicy = {
  repository: 'soulzerox/Unified-MPC-Server',
  defaultBranch: 'main',
  verificationMode: 'github_ci',
  requiredGates: [{ name: 'Runtime release portability gate', source: 'github_check' }],
  reviewPolicy: { required: true, acceptedOutcomes: ['clean_llm_review'] },
};

function memoryState(initial?: MergeReconciliationPollCursor): {
  store: MergeReconciliationPollStateStore;
  get: () => MergeReconciliationPollCursor | undefined;
  set: ReturnType<typeof vi.fn>;
} {
  let value = initial;
  const set = vi.fn((_repository: string, next: MergeReconciliationPollCursor) => { value = next; });
  return {
    store: {
      get: () => value,
      set,
    },
    get: () => value,
    set,
  };
}

describe('GitHubMergeReconciliationPoller', () => {
  it('persists the bootstrap cursor before provider I/O and reconciles a merge after startup', async () => {
    const state = memoryState();
    let providerSawBootstrap = false;
    const reconcile = vi.fn(async () => ({ status: 'reconciled' as const, record: {} as never }));
    const poller = new GitHubMergeReconciliationPoller(
      () => [policy],
      {
        async listUpdatedClosed(): Promise<GitHubClosedPullRequestFeedResult> {
          providerSawBootstrap = state.get() !== undefined;
          return {
            complete: true,
            updates: [{ pullRequest: 282, updatedAt: '2026-10-07T06:00:01Z', mergedAt: '2026-10-07T06:00:01Z' }],
          };
        },
      },
      state.store,
      { reconcile },
      { now: (): Date => new Date('2026-10-07T06:00:00.900Z') },
    );

    const result = await poller.reconcileOnce();

    expect(providerSawBootstrap).toBe(true);
    expect(reconcile).toHaveBeenCalledWith({
      policy,
      repository: policy.repository,
      pullRequest: 282,
      expectedMergeMethod: 'merge',
    });
    expect(result.repositories[0]).toMatchObject({
      status: 'ok',
      candidates: 1,
      reconciled: 1,
      policyBreaches: 0,
      cursorAdvanced: true,
    });
    expect(state.get()).toEqual({
      startedAt: '2026-10-07T06:00:00.000Z',
      updatedAtWatermark: '2026-10-07T06:00:01Z',
      pullRequestsAtWatermark: [282],
    });
  });

  it('does not advance past inspect-required reconciliation so the merge is retried', async () => {
    const initial = {
      startedAt: '2026-10-07T06:00:00Z',
      updatedAtWatermark: '2026-10-07T06:00:00Z',
      pullRequestsAtWatermark: [],
    };
    const state = memoryState(initial);
    const reconcile = vi.fn(async () => ({ status: 'inspect_required' as const, reason: 'merge_observation_error' as const }));
    const poller = new GitHubMergeReconciliationPoller(
      () => [policy],
      {
        async listUpdatedClosed(): Promise<GitHubClosedPullRequestFeedResult> {
          return {
            complete: true,
            updates: [{ pullRequest: 283, updatedAt: '2026-10-07T06:00:01Z', mergedAt: '2026-10-07T06:00:01Z' }],
          };
        },
      },
      state.store,
      { reconcile },
    );

    const result = await poller.reconcileOnce();

    expect(result.repositories[0]).toMatchObject({
      status: 'inspect_required',
      candidates: 1,
      cursorAdvanced: false,
      inspectReason: 'merge_observation_error',
    });
    expect(state.set).not.toHaveBeenCalled();
    expect(state.get()).toEqual(initial);
  });

  it('ignores pre-start historical merges even when they are updated after startup', async () => {
    const state = memoryState({
      startedAt: '2026-10-07T06:00:00Z',
      updatedAtWatermark: '2026-10-07T06:00:00Z',
      pullRequestsAtWatermark: [],
    });
    const reconcile = vi.fn();
    const poller = new GitHubMergeReconciliationPoller(
      () => [policy],
      {
        async listUpdatedClosed(): Promise<GitHubClosedPullRequestFeedResult> {
          return {
            complete: true,
            updates: [{ pullRequest: 100, updatedAt: '2026-10-07T06:00:02Z', mergedAt: '2026-10-07T05:59:59Z' }],
          };
        },
      },
      state.store,
      { reconcile },
    );

    const result = await poller.reconcileOnce();

    expect(reconcile).not.toHaveBeenCalled();
    expect(result.repositories[0]).toMatchObject({ status: 'ok', ignoredHistorical: 1, candidates: 0 });
    expect(state.get()).toEqual({
      startedAt: '2026-10-07T06:00:00Z',
      updatedAtWatermark: '2026-10-07T06:00:02Z',
      pullRequestsAtWatermark: [100],
    });
  });

  it('processes an unseen PR sharing the exact cursor timestamp without repeating the terminal PR already seen', async () => {
    const state = memoryState({
      startedAt: '2026-10-07T06:00:00Z',
      updatedAtWatermark: '2026-10-07T06:00:03Z',
      pullRequestsAtWatermark: [282],
    });
    const reconcile = vi.fn(async () => ({ status: 'policy_breach' as const, record: {} as never }));
    const poller = new GitHubMergeReconciliationPoller(
      () => [policy],
      {
        async listUpdatedClosed(): Promise<GitHubClosedPullRequestFeedResult> {
          return {
            complete: true,
            updates: [
              { pullRequest: 282, updatedAt: '2026-10-07T06:00:03Z', mergedAt: '2026-10-07T06:00:02Z' },
              { pullRequest: 283, updatedAt: '2026-10-07T06:00:03Z', mergedAt: '2026-10-07T06:00:03Z' },
            ],
          };
        },
      },
      state.store,
      { reconcile },
    );

    const result = await poller.reconcileOnce();

    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ pullRequest: 283 }));
    expect(result.repositories[0]).toMatchObject({ policyBreaches: 1, candidates: 1 });
    expect(state.get()?.pullRequestsAtWatermark).toEqual([282, 283]);
  });

  it('fails closed without reconciliation or cursor advancement when the provider scan is truncated', async () => {
    const initial = {
      startedAt: '2026-10-07T06:00:00Z',
      updatedAtWatermark: '2026-10-07T06:00:00Z',
      pullRequestsAtWatermark: [],
    };
    const state = memoryState(initial);
    const reconcile = vi.fn();
    const poller = new GitHubMergeReconciliationPoller(
      () => [policy],
      {
        async listUpdatedClosed(): Promise<GitHubClosedPullRequestFeedResult> {
          return {
            complete: false,
            updates: [{ pullRequest: 284, updatedAt: '2026-10-07T06:00:04Z', mergedAt: '2026-10-07T06:00:04Z' }],
          };
        },
      },
      state.store,
      { reconcile },
    );

    const result = await poller.reconcileOnce();

    expect(result.repositories[0]).toMatchObject({ status: 'feed_truncated', cursorAdvanced: false });
    expect(reconcile).not.toHaveBeenCalled();
    expect(state.set).not.toHaveBeenCalled();
  });

  it('keeps the periodic retry armed when the initial policy provider fails', async () => {
    vi.useFakeTimers();
    try {
      let policyReads = 0;
      const feed = { listUpdatedClosed: vi.fn(async () => ({ complete: true, updates: [] })) };
      const poller = new GitHubMergeReconciliationPoller(
        () => {
          policyReads += 1;
          if (policyReads === 1) throw new Error('malformed policy state');
          return [policy];
        },
        feed,
        memoryState().store,
        { reconcile: vi.fn() },
        { pollIntervalMs: 10 },
      );

      await expect(poller.start()).rejects.toThrow('malformed policy state');
      await vi.advanceTimersByTimeAsync(10);

      expect(policyReads).toBeGreaterThanOrEqual(2);
      expect(feed.listUpdatedClosed).toHaveBeenCalledTimes(1);
      poller.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('createGitHubClosedPullRequestFeed', () => {
  it('paginates until it crosses the inclusive watermark and validates repository identity', async () => {
    const firstPage = Array.from({ length: 2 }, (_, index) => ({
      number: 20 - index,
      updated_at: index === 0 ? '2026-10-07T06:00:03Z' : '2026-10-07T06:00:02Z',
      merged_at: index === 0 ? '2026-10-07T06:00:03Z' : null,
      base: { repo: { full_name: policy.repository } },
    }));
    const secondPage = [{
      number: 18,
      updated_at: '2026-10-07T05:59:59Z',
      merged_at: '2026-10-07T05:59:58Z',
      base: { repo: { full_name: policy.repository } },
    }];
    const get = vi.fn(async (path: string) => path.includes('page=1') ? firstPage : secondPage);
    const feed = createGitHubClosedPullRequestFeed({ get }, { pageSize: 2, maxPages: 3 });

    await expect(feed.listUpdatedClosed({
      repository: policy.repository,
      updatedAtInclusive: '2026-10-07T06:00:00Z',
    })).resolves.toEqual({
      complete: true,
      updates: [
        { pullRequest: 20, updatedAt: '2026-10-07T06:00:03Z', mergedAt: '2026-10-07T06:00:03Z' },
        { pullRequest: 19, updatedAt: '2026-10-07T06:00:02Z' },
        { pullRequest: 18, updatedAt: '2026-10-07T05:59:59Z', mergedAt: '2026-10-07T05:59:58Z' },
      ],
    });
    expect(get).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenCalledWith(expect.stringContaining('page=1'), { maxBufferBytes: 16 * 1024 * 1024 });
  });

  it('returns incomplete rather than silently skipping history when max pagination is exhausted', async () => {
    const get = vi.fn(async () => [{
      number: 20,
      updated_at: '2026-10-07T06:00:03Z',
      merged_at: '2026-10-07T06:00:03Z',
      base: { repo: { full_name: policy.repository } },
    }]);
    const feed = createGitHubClosedPullRequestFeed({ get }, { pageSize: 1, maxPages: 1 });

    await expect(feed.listUpdatedClosed({
      repository: policy.repository,
      updatedAtInclusive: '2026-10-07T06:00:00Z',
    })).resolves.toMatchObject({ complete: false });
  });
});

describe('createSettingsMergeReconciliationPollStateStore', () => {
  it('round-trips independent repository cursors through one durable setting', () => {
    const values = new Map<string, string>();
    const store = createSettingsMergeReconciliationPollStateStore({
      get: (key) => values.get(key) ?? null,
      set: (key, value) => { values.set(key, value); },
    });
    const cursor: MergeReconciliationPollCursor = {
      startedAt: '2026-10-07T06:00:00Z',
      updatedAtWatermark: '2026-10-07T06:00:03Z',
      pullRequestsAtWatermark: [282, 283],
    };

    store.set('Owner/Repo', cursor);

    expect(store.get('owner/repo')).toEqual(cursor);
    expect(values.get(MERGE_RECONCILIATION_POLL_STATE_KEY)).toContain('"owner/repo"');
  });

  it('fails closed when persisted repository keys collide after normalization', () => {
    const store = createSettingsMergeReconciliationPollStateStore({
      get: () => JSON.stringify({
        schemaVersion: 1,
        repositories: {
          'Owner/Repo': {
            startedAt: '2026-10-07T06:00:00Z',
            updatedAtWatermark: '2026-10-07T06:00:00Z',
            pullRequestsAtWatermark: [],
          },
          'owner/repo': {
            startedAt: '2026-10-07T06:00:00Z',
            updatedAtWatermark: '2026-10-07T06:00:00Z',
            pullRequestsAtWatermark: [],
          },
        },
      }),
      set: vi.fn(),
    });

    expect(() => store.get('owner/repo')).toThrow();
  });

  it('fails closed on corrupt persisted state instead of resetting the watermark', () => {
    const store = createSettingsMergeReconciliationPollStateStore({
      get: () => '{"schemaVersion":1,"repositories":{"owner/repo":{"startedAt":"bad"}}}',
      set: vi.fn(),
    });

    expect(() => store.get('owner/repo')).toThrow();
  });
});
