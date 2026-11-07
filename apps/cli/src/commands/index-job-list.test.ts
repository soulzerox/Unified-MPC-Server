import { describe, expect, it } from 'vitest';
import type { ThaiRagIndexJob, ThaiRagIndexJobListing } from '@unified-mpc/thai-rag';
import {
  formatIndexJobList,
  indexJobListExitCode,
  parseIndexJobListArgs,
} from './index-job-list.js';

const WS = '11111111-1111-4111-8111-111111111111';

const RUNNING: ThaiRagIndexJob = {
  jobId: 'idx_umcp_live',
  workspaceId: WS,
  ownerId: 'unified-mpc:42',
  providerJobId: 'idx_provider',
  status: 'running',
  force: false,
  reindexReason: 'explicit_request',
  startedAt: '2026-11-01T00:00:00.000Z',
  progressAt: '2026-11-01T00:00:30.000Z',
  indexedFiles: 3,
  skippedFiles: 1,
  totalFiles: 4,
  cacheHitFiles: 1,
  cacheHitChunks: 7,
  cacheMissFiles: 1,
  cacheMissChunks: 3,
  newEmbeddedFiles: 1,
  newEmbeddedChunks: 3,
  cacheMissReasons: { changed: 2, artifact_missing: 1 },
};

const FAILED: ThaiRagIndexJob = {
  jobId: 'idx_umcp_bad',
  workspaceId: WS,
  ownerId: 'unified-mpc:42',
  status: 'failed',
  force: true,
  reindexReason: 'alias_created_or_repaired',
  startedAt: '2026-10-31T00:00:00.000Z',
  finishedAt: '2026-10-31T00:00:05.000Z',
  error: 'Native Thai-RAG code_index failed:\n  workspace path is not a directory.',
};

function listing(overrides: Partial<ThaiRagIndexJobListing> = {}): ThaiRagIndexJobListing {
  return {
    jobs: [RUNNING, FAILED],
    totalRowCount: 3,
    matchingRowCount: 2,
    legacyRowCount: 1,
    ...overrides,
  };
}

describe('parseIndexJobListArgs', () => {
  it('parses the job list verb with and without options', () => {
    expect(parseIndexJobListArgs(['job', 'list'])).toEqual({
      ok: true,
      value: { kind: 'index-job-list', json: false },
    });
    expect(parseIndexJobListArgs(['job', 'list', '--json', '--workspace', WS, '--limit', '5'])).toEqual({
      ok: true,
      value: { kind: 'index-job-list', json: true, workspaceId: WS, limit: 5 },
    });
  });

  it('rejects a different verb, unknown flags, duplicate flags and missing values', () => {
    expect(parseIndexJobListArgs(['jobs', 'list'])).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(parseIndexJobListArgs(['job', 'status'])).toMatchObject({ ok: false });
    expect(parseIndexJobListArgs(['job', 'list', '--all'])).toMatchObject({ ok: false });
    expect(parseIndexJobListArgs(['job', 'list', '--json', '--json'])).toMatchObject({ ok: false });
    expect(parseIndexJobListArgs(['job', 'list', '--workspace'])).toMatchObject({ ok: false });
    expect(parseIndexJobListArgs(['job', 'list', '--workspace', WS, '--workspace', WS])).toMatchObject({ ok: false });
    expect(parseIndexJobListArgs(['job', 'list', '--limit'])).toMatchObject({ ok: false });
    expect(parseIndexJobListArgs(['job', 'list', '--limit', '1', '--limit', '2'])).toMatchObject({ ok: false });
  });

  it('refuses a workspace scope that is not a canonical UUID and a limit outside 1..200', () => {
    expect(parseIndexJobListArgs(['job', 'list', '--workspace', 'Unified-MPC-Server'])).toMatchObject({ ok: false });
    expect(parseIndexJobListArgs(['job', 'list', '--workspace', '--json'])).toMatchObject({ ok: false });
    expect(parseIndexJobListArgs(['job', 'list', '--limit', '0'])).toMatchObject({ ok: false });
    expect(parseIndexJobListArgs(['job', 'list', '--limit', '201'])).toMatchObject({ ok: false });
    expect(parseIndexJobListArgs(['job', 'list', '--limit', '-1'])).toMatchObject({ ok: false });
    expect(parseIndexJobListArgs(['job', 'list', '--limit', '1.5'])).toMatchObject({ ok: false });
  });
});

describe('formatIndexJobList', () => {
  it('prints an empty ledger as a zero count with no detail lines', () => {
    expect(formatIndexJobList({
      jobs: [],
      totalRowCount: 0,
      matchingRowCount: 0,
      legacyRowCount: 0,
    })).toBe('jobs 0');
  });

  it('prints the live job first, then history, with only the metrics each row recorded', () => {
    expect(formatIndexJobList(listing()).split('\n')).toEqual([
      'jobs 2',
      'legacy-unavailable 1',
      `  idx_umcp_live running workspace ${WS} owner unified-mpc:42 provider idx_provider`
        + ' reason explicit_request started 2026-11-01T00:00:00.000Z progress 2026-11-01T00:00:30.000Z',
      '    files indexed=3 skipped=1 total=4',
      '    cache hit-files=1 hit-chunks=7 miss-files=1 miss-chunks=3 new-files=1 new-chunks=3',
      '    miss-reasons artifact_missing=1 changed=2',
      `  idx_umcp_bad failed workspace ${WS} owner unified-mpc:42`
        + ' reason alias_created_or_repaired started 2026-10-31T00:00:00.000Z finished 2026-10-31T00:00:05.000Z',
      '    error Native Thai-RAG code_index failed: workspace path is not a directory.',
    ]);
  });

  it('renders an absent metric as absent instead of claiming zero', () => {
    const unmeasured: ThaiRagIndexJob = {
      jobId: 'idx_umcp_unmeasured',
      workspaceId: WS,
      status: 'interrupted',
      force: false,
      startedAt: '2026-10-30T00:00:00.000Z',
      finishedAt: '2026-10-30T00:01:00.000Z',
      error: 'Provider restarted before the indexing job completed (owner-lost-restarted)',
    };
    expect(formatIndexJobList({
      jobs: [unmeasured],
      totalRowCount: 1,
      matchingRowCount: 1,
      legacyRowCount: 0,
    }).split('\n')).toEqual([
      'jobs 1',
      `  idx_umcp_unmeasured interrupted workspace ${WS} reason unrecorded`
        + ' started 2026-10-30T00:00:00.000Z finished 2026-10-30T00:01:00.000Z',
      '    error Provider restarted before the indexing job completed (owner-lost-restarted)',
    ]);
  });

  it('says when the bounded listing is shorter than the matching history', () => {
    expect(formatIndexJobList(listing({
      jobs: [RUNNING],
      matchingRowCount: 12,
      legacyRowCount: 0,
    })).split('\n').slice(0, 2)).toEqual(['jobs 12', 'shown 1']);
  });

  it('always exits zero for a readable ledger', () => {
    expect(indexJobListExitCode()).toBe(0);
  });
});
