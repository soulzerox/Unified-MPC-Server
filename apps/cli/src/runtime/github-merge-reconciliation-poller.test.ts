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
  type MergeReconciliationPollSummary,
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
  retain: ReturnType<typeof vi.fn>;
} {
  let value = initial;
  const set = vi.fn((_repository: string, next: MergeReconciliationPollCursor) => { value = next; });
  const retain = vi.fn((repositories: readonly string[]) => {
    if (!repositories.some((repository) => repository.toLowerCase() === policy.repository.toLowerCase())) value = undefined;
  });
  return {
    store: {
      get: () => value,
      set,
      retain,
    },
    get: () => value,
    set,
    retain,
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

  it('expects the merge method the policy declares', async () => {
    const state = memoryState();
    const squashPolicy: RepositoryMergePolicy = { ...policy, mergeMethod: 'squash' };
    const reconcile = vi.fn(async () => ({ status: 'reconciled' as const, record: {} as never }));
    const poller = new GitHubMergeReconciliationPoller(
      () => [squashPolicy],
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
      { now: (): Date => new Date('2026-10-07T06:00:00.900Z') },
    );

    await poller.reconcileOnce();

    expect(reconcile).toHaveBeenCalledWith({
      policy: squashPolicy,
      repository: squashPolicy.repository,
      pullRequest: 283,
      expectedMergeMethod: 'squash',
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

  it('retires a removed policy cursor and bootstraps a fresh epoch when the policy is re-added', async () => {
    let policies: readonly RepositoryMergePolicy[] = [policy];
    let now = new Date('2026-10-07T06:10:00Z');
    const state = memoryState({
      startedAt: '2026-10-07T06:00:00Z',
      updatedAtWatermark: '2026-10-07T06:05:00Z',
      pullRequestsAtWatermark: [282],
    });
    const reconcile = vi.fn(async () => ({ status: 'policy_breach' as const, record: {} as never }));
    const feed = {
      listUpdatedClosed: vi.fn(async (): Promise<GitHubClosedPullRequestFeedResult> => ({
        complete: true,
        updates: [{
          pullRequest: 284,
          updatedAt: '2026-10-07T06:21:00Z',
          mergedAt: '2026-10-07T06:15:00Z',
        }],
      })),
    };
    const poller = new GitHubMergeReconciliationPoller(
      () => policies,
      feed,
      state.store,
      { reconcile },
      { now: (): Date => now },
    );

    policies = [];
    await poller.reconcileOnce();
    expect(state.get()).toBeUndefined();
    expect(feed.listUpdatedClosed).not.toHaveBeenCalled();

    now = new Date('2026-10-07T06:20:00Z');
    policies = [policy];
    const result = await poller.reconcileOnce();

    expect(reconcile).not.toHaveBeenCalled();
    expect(result.repositories[0]).toMatchObject({
      status: 'ok',
      candidates: 0,
      ignoredHistorical: 1,
    });
    expect(state.get()).toEqual({
      startedAt: '2026-10-07T06:20:00.000Z',
      updatedAtWatermark: '2026-10-07T06:21:00Z',
      pullRequestsAtWatermark: [284],
    });
  });

  it('keeps the periodic retry armed when the initial policy provider fails', async () => {
    vi.useFakeTimers();
    try {
      let policyReads = 0;
      const feed = { listUpdatedClosed: vi.fn(async () => ({ complete: true, updates: [] })) };
      const initial = {
        startedAt: '2026-10-07T06:00:00Z',
        updatedAtWatermark: '2026-10-07T06:05:00Z',
        pullRequestsAtWatermark: [282],
      };
      const state = memoryState(initial);
      const poller = new GitHubMergeReconciliationPoller(
        () => {
          policyReads += 1;
          if (policyReads === 1) throw new Error('malformed policy state');
          return [policy];
        },
        feed,
        state.store,
        { reconcile: vi.fn() },
        { pollIntervalMs: 10 },
      );

      await expect(poller.start()).rejects.toThrow('malformed policy state');
      expect(state.get()).toEqual(initial);
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

  it('retires inactive repository cursors while preserving active cursor state', () => {
    const values = new Map<string, string>();
    const store = createSettingsMergeReconciliationPollStateStore({
      get: (key) => values.get(key) ?? null,
      set: (key, value) => { values.set(key, value); },
    });
    const activeCursor: MergeReconciliationPollCursor = {
      startedAt: '2026-10-07T06:00:00Z',
      updatedAtWatermark: '2026-10-07T06:00:03Z',
      pullRequestsAtWatermark: [282],
    };
    const inactiveCursor: MergeReconciliationPollCursor = {
      startedAt: '2026-10-07T06:01:00Z',
      updatedAtWatermark: '2026-10-07T06:01:03Z',
      pullRequestsAtWatermark: [10],
    };
    store.set('Owner/Active', activeCursor);
    store.set('Owner/Inactive', inactiveCursor);

    store.retain(['owner/active']);

    expect(store.get('OWNER/ACTIVE')).toEqual(activeCursor);
    expect(store.get('owner/inactive')).toBeUndefined();
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

describe('canonical advance after a reconciled merge (#210 §3)', () => {
  const MERGE_SHA = 'c'.repeat(40);

  function feedWith(updates: readonly GitHubClosedPullRequestUpdate[]): GitHubClosedPullRequestFeed {
    return {
      async listUpdatedClosed(): Promise<GitHubClosedPullRequestFeedResult> {
        return { complete: true, updates };
      },
    };
  }

  function reconciledRecord(pullRequest: number, mergeSha: string | undefined): never {
    return { observation: { pullRequest, ...(mergeSha === undefined ? {} : { mergeSha }) } } as never;
  }

  const updates: readonly GitHubClosedPullRequestUpdate[] = [
    { pullRequest: 282, updatedAt: '2026-10-07T06:00:01Z', mergedAt: '2026-10-07T06:00:01Z' },
  ];

  it('advances once per repository to the commit the merge produced', async () => {
    const advance = vi.fn(async () => ({
      status: 'advanced' as const,
      ref: 'refs/remotes/origin/main',
      commitSha: MERGE_SHA,
      manifestId: 'man:v1:x',
      reusedPaths: 3,
      changedPaths: 1,
    }));
    const poller = new GitHubMergeReconciliationPoller(
      () => [policy],
      feedWith(updates),
      memoryState().store,
      { reconcile: vi.fn(async () => ({ status: 'reconciled' as const, record: reconciledRecord(282, MERGE_SHA) })) },
      { now: (): Date => new Date('2026-10-07T06:00:00.900Z'), canonicalAdvance: advance },
    );

    const result = await poller.reconcileOnce();

    expect(advance).toHaveBeenCalledTimes(1);
    expect(advance).toHaveBeenCalledWith({ policy, expectedCommitSha: MERGE_SHA });
    expect(result.repositories[0]?.canonicalAdvance).toEqual({
      status: 'advanced',
      ref: 'refs/remotes/origin/main',
      commitSha: MERGE_SHA,
      manifestId: 'man:v1:x',
    });
  });

  it('advances once even when several merges reconcile in one pass', async () => {
    const advance = vi.fn(async () => ({
      status: 'noop' as const,
      ref: 'refs/remotes/origin/main',
      commitSha: MERGE_SHA,
      manifestId: 'man:v1:x',
      reusedPaths: 0,
      changedPaths: 0,
    }));
    const reconcile = vi.fn(async ({ pullRequest }: { readonly pullRequest: number }) => ({
      status: 'reconciled' as const,
      record: reconciledRecord(pullRequest, `${pullRequest}`.padStart(40, 'd')),
    }));
    const poller = new GitHubMergeReconciliationPoller(
      () => [policy],
      feedWith([
        { pullRequest: 282, updatedAt: '2026-10-07T06:00:01Z', mergedAt: '2026-10-07T06:00:01Z' },
        { pullRequest: 283, updatedAt: '2026-10-07T06:00:02Z', mergedAt: '2026-10-07T06:00:02Z' },
      ]),
      memoryState().store,
      { reconcile },
      { now: (): Date => new Date('2026-10-07T06:00:00.900Z'), canonicalAdvance: advance },
    );

    await poller.reconcileOnce();

    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(advance).toHaveBeenCalledTimes(1);
    // Ascending `updatedAt`: the last reconciled merge is the branch head.
    expect(advance).toHaveBeenCalledWith({ policy, expectedCommitSha: `${283}`.padStart(40, 'd') });
  });

  it('reports a refusal instead of throwing or claiming an advance', async () => {
    const poller = new GitHubMergeReconciliationPoller(
      () => [policy],
      feedWith(updates),
      memoryState().store,
      { reconcile: vi.fn(async () => ({ status: 'reconciled' as const, record: reconciledRecord(282, MERGE_SHA) })) },
      {
        now: (): Date => new Date('2026-10-07T06:00:00.900Z'),
        canonicalAdvance: vi.fn(async () => ({ status: 'refused' as const, reason: 'no checkout mapped' })),
      },
    );

    const result = await poller.reconcileOnce();

    expect(result.repositories[0]?.status).toBe('ok');
    expect(result.repositories[0]?.canonicalAdvance).toEqual({ status: 'refused', reason: 'no checkout mapped' });
  });

  it('turns a thrown advance into a refusal rather than failing the poll', async () => {
    const poller = new GitHubMergeReconciliationPoller(
      () => [policy],
      feedWith(updates),
      memoryState().store,
      { reconcile: vi.fn(async () => ({ status: 'reconciled' as const, record: reconciledRecord(282, MERGE_SHA) })) },
      {
        now: (): Date => new Date('2026-10-07T06:00:00.900Z'),
        canonicalAdvance: vi.fn(async () => { throw new Error('git exploded'); }),
      },
    );

    const result = await poller.reconcileOnce();

    expect(result.repositories[0]?.status).toBe('ok');
    expect(result.repositories[0]?.canonicalAdvance).toEqual({ status: 'refused', reason: 'git exploded' });
  });

  it('does not advance when the policy breach was the only outcome', async () => {
    const advance = vi.fn();
    const poller = new GitHubMergeReconciliationPoller(
      () => [policy],
      feedWith(updates),
      memoryState().store,
      { reconcile: vi.fn(async () => ({ status: 'policy_breach' as const, record: reconciledRecord(282, MERGE_SHA) })) },
      { now: (): Date => new Date('2026-10-07T06:00:00.900Z'), canonicalAdvance: advance },
    );

    const result = await poller.reconcileOnce();

    expect(advance).not.toHaveBeenCalled();
    expect(result.repositories[0]?.canonicalAdvance).toEqual({ status: 'skipped', reason: 'no_merge' });
  });

  it('does not advance when the observation carried no merge commit', async () => {
    const advance = vi.fn();
    const poller = new GitHubMergeReconciliationPoller(
      () => [policy],
      feedWith(updates),
      memoryState().store,
      { reconcile: vi.fn(async () => ({ status: 'reconciled' as const, record: reconciledRecord(282, undefined) })) },
      { now: (): Date => new Date('2026-10-07T06:00:00.900Z'), canonicalAdvance: advance },
    );

    await poller.reconcileOnce();

    expect(advance).not.toHaveBeenCalled();
  });

  it('reports the advance as not wired when the runtime has no canonical root', async () => {
    const poller = new GitHubMergeReconciliationPoller(
      () => [policy],
      feedWith(updates),
      memoryState().store,
      { reconcile: vi.fn(async () => ({ status: 'reconciled' as const, record: reconciledRecord(282, MERGE_SHA) })) },
      { now: (): Date => new Date('2026-10-07T06:00:00.900Z') },
    );

    const result = await poller.reconcileOnce();

    expect(result.repositories[0]?.canonicalAdvance).toEqual({ status: 'skipped', reason: 'not_wired' });
  });

  it('picks the merge commit by mergedAt, not by feed order', async () => {
    const advance = vi.fn(async () => ({
      status: 'advanced' as const,
      ref: 'refs/remotes/origin/main',
      commitSha: MERGE_SHA,
      manifestId: 'man:v1:x',
      reusedPaths: 0,
      changedPaths: 0,
    }));
    const olderMerge = 'e'.repeat(40);
    const newerMerge = 'f'.repeat(40);
    const poller = new GitHubMergeReconciliationPoller(
      () => [policy],
      feedWith([
        // A comment on #282 moved it later in the feed, but #283 merged last.
        { pullRequest: 283, updatedAt: '2026-10-07T06:00:01Z', mergedAt: '2026-10-07T06:00:01Z' },
        { pullRequest: 282, updatedAt: '2026-10-07T06:00:05Z', mergedAt: '2026-10-07T06:00:00Z' },
      ]),
      memoryState().store,
      {
        reconcile: vi.fn(async ({ pullRequest }: { readonly pullRequest: number }) => ({
          status: 'reconciled' as const,
          record: reconciledRecord(pullRequest, pullRequest === 282 ? olderMerge : newerMerge),
        })),
      },
      { now: (): Date => new Date('2026-10-07T06:00:00.900Z'), canonicalAdvance: advance },
    );

    await poller.reconcileOnce();

    expect(advance).toHaveBeenCalledWith({ policy, expectedCommitSha: newerMerge });
  });

  it('reports a skipped advance with its reason when a merge needs inspection', async () => {
    const advance = vi.fn();
    const poller = new GitHubMergeReconciliationPoller(
      () => [policy],
      feedWith(updates),
      memoryState().store,
      { reconcile: vi.fn(async () => ({ status: 'inspect_required' as const, reason: 'receipt_store_error' })) },
      { now: (): Date => new Date('2026-10-07T06:00:00.900Z'), canonicalAdvance: advance },
    );

    const result = await poller.reconcileOnce();

    expect(advance).not.toHaveBeenCalled();
    expect(result.repositories[0]?.canonicalAdvance).toEqual({ status: 'skipped', reason: 'inspect_required' });
  });

  it('hands every completed pass to the summary observer, and survives a throwing observer', async () => {
    const seen: MergeReconciliationPollSummary[] = [];
    const poller = new GitHubMergeReconciliationPoller(
      () => [policy],
      feedWith(updates),
      memoryState().store,
      { reconcile: vi.fn(async () => ({ status: 'reconciled' as const, record: reconciledRecord(282, MERGE_SHA) })) },
      {
        now: (): Date => new Date('2026-10-07T06:00:00.900Z'),
        onSummary: (summary): void => {
          seen.push(summary);
          throw new Error('observer exploded');
        },
      },
    );

    const result = await poller.reconcileOnce();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.repositories[0]?.reconciled).toBe(1);
    // The observer's failure must not change the pass result.
    expect(result.repositories[0]?.status).toBe('ok');
  });
});
