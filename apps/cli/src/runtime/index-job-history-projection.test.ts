import { describe, expect, it } from 'vitest';
import type { ThaiRagIndexJobListing } from '@unified-mpc/thai-rag';
import { projectIndexJobHistory, sanitizeIndexJobError } from './index-job-history-projection.js';

const workspaceId = '11111111-1111-4111-8111-111111111111';

function listing(jobs: ThaiRagIndexJobListing['jobs'], overrides: Partial<ThaiRagIndexJobListing> = {}): ThaiRagIndexJobListing {
  return {
    jobs,
    totalRowCount: jobs.length,
    matchingRowCount: jobs.length,
    legacyRowCount: 0,
    ...overrides,
  };
}

describe('index job history projection', () => {
  it('keeps recorded counters and drops provider-only fields', () => {
    const projected = projectIndexJobHistory(listing([{
      jobId: 'idx_umcp_a',
      workspaceId,
      ownerId: 'owner-a',
      ownerProcessIdentity: 'pid:1234',
      providerJobId: 'provider-secret',
      status: 'running',
      force: false,
      reindexReason: 'startup_verification',
      startedAt: '2026-11-01T00:00:00.000Z',
      progressAt: '2026-11-01T00:01:00.000Z',
      indexedFiles: 3,
      skippedFiles: 2,
      totalFiles: 5,
      cacheHitFiles: 2,
      cacheHitChunks: 8,
      cacheMissFiles: 1,
      cacheMissChunks: 2,
      newEmbeddedFiles: 1,
      newEmbeddedChunks: 2,
      cacheMissReasons: { artifact_missing: 2 },
      result: { workspace: '/private/location' },
    }]));

    expect(projected.jobs).toEqual([{
      jobId: 'idx_umcp_a',
      workspaceId,
      ownerId: 'owner-a',
      status: 'running',
      force: false,
      reindexReason: 'startup_verification',
      startedAt: '2026-11-01T00:00:00.000Z',
      progressAt: '2026-11-01T00:01:00.000Z',
      indexedFiles: 3,
      skippedFiles: 2,
      totalFiles: 5,
      cacheHitFiles: 2,
      cacheHitChunks: 8,
      cacheMissFiles: 1,
      cacheMissChunks: 2,
      newEmbeddedFiles: 1,
      newEmbeddedChunks: 2,
      cacheMissReasons: { artifact_missing: 2 },
    }]);
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain('provider-secret');
    expect(serialized).not.toContain('/private/location');
    expect(serialized).not.toContain('pid:1234');
  });

  it('keeps absent counters absent instead of claiming zero', () => {
    const projected = projectIndexJobHistory(listing([{
      jobId: 'idx_umcp_legacy_shape',
      workspaceId,
      status: 'completed',
      force: true,
      startedAt: '2026-11-01T00:00:00.000Z',
      finishedAt: '2026-11-01T00:00:10.000Z',
    }]));

    expect(projected.jobs[0]).toEqual({
      jobId: 'idx_umcp_legacy_shape',
      workspaceId,
      status: 'completed',
      force: true,
      startedAt: '2026-11-01T00:00:00.000Z',
      finishedAt: '2026-11-01T00:00:10.000Z',
    });
  });

  it('sanitizes and bounds terminal failure text', () => {
    expect(sanitizeIndexJobError('  Provider\n\tcrashed\u0007  while embedding  ')).toBe('Provider crashed while embedding');
    expect(sanitizeIndexJobError('   \n\t ')).toBeUndefined();
    expect(sanitizeIndexJobError('x'.repeat(500))).toHaveLength(400);

    const projected = projectIndexJobHistory(listing([{
      jobId: 'idx_umcp_failed',
      workspaceId,
      status: 'failed',
      force: false,
      startedAt: '2026-11-01T00:00:00.000Z',
      finishedAt: '2026-11-01T00:05:00.000Z',
      error: '  Provider\n\tcrashed\u0007  while embedding  ',
    }]));
    expect(projected.jobs[0]).toMatchObject({ status: 'failed', error: 'Provider crashed while embedding' });
  });

  it('never lists a legacy-unavailable row and keeps the listing counts', () => {
    const projected = projectIndexJobHistory(listing([
      { jobId: 'legacy-row', workspaceId: 'legacy-unavailable', status: 'legacy-unavailable', force: false },
    ], { totalRowCount: 3, matchingRowCount: 1, legacyRowCount: 2 }));

    expect(projected.jobs).toEqual([]);
    expect(projected).toMatchObject({ totalRowCount: 3, matchingRowCount: 1, legacyRowCount: 2 });
  });
});
