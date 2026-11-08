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
      ownerId: 'unified-mpc:4242',
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
    expect(serialized).not.toContain('unified-mpc:4242');
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

  it('redacts host paths and job-id tokens from terminal failure text', () => {
    expect(sanitizeIndexJobError("ENOENT: no such file or directory, open '/home/alpha/Unified MPC/src/a.ts'"))
      .toBe("ENOENT: no such file or directory, open '<path>'");
    expect(sanitizeIndexJobError("cannot read 'file:///home/alpha/a b.ts'"))
      .toBe("cannot read '<path>'");
    expect(sanitizeIndexJobError('cannot read file:///home/alpha/secret.ts now'))
      .toBe('cannot read <path> now');
    expect(sanitizeIndexJobError('spawn C:\\Users\\alpha\\code ENOENT'))
      .toBe('spawn <path> ENOENT');
    expect(sanitizeIndexJobError('open \\\\server\\share\\a.ts failed'))
      .toBe('open <path> failed');
    expect(sanitizeIndexJobError('cannot open /home/alpha/secret.ts for reading'))
      .toBe('cannot open <path> for reading');
    expect(sanitizeIndexJobError('fetch https://example.com/a/b failed'))
      .toBe('fetch https://example.com/a/b failed');
    expect(sanitizeIndexJobError("failed at 'https://example.com/a/b'"))
      .toBe("failed at 'https://example.com/a/b'");
    expect(sanitizeIndexJobError("tracking 'refs/remotes/origin/main' is stale"))
      .toBe("tracking 'refs/remotes/origin/main' is stale");
    expect(sanitizeIndexJobError('cancel failed for idx_e92d1940'))
      .toBe('cancel failed for <job-id>');
  });

  it('hardens quoted and colon-adjacent path forms (#210 review follow-up)', () => {
    expect(sanitizeIndexJobError("open '/home/O'Brien/x.ts' failed"))
      .toBe("open '<path>' failed");
    expect(sanitizeIndexJobError("can't open '/home/alpha/a.ts'"))
      .toBe("can't open '<path>'");
    expect(sanitizeIndexJobError('open path:/home/alpha/x failed'))
      .toBe('open path:<path> failed');
    expect(sanitizeIndexJobError('open file:/home/alpha/x failed'))
      .toBe('open file:<path> failed');
    expect(sanitizeIndexJobError("open '~/secret/a b.ts' failed"))
      .toBe("open '<path>' failed");
    expect(sanitizeIndexJobError('open ~/secret/a.ts now'))
      .toBe('open <path> now');
  });

  it('redacts a quoted path that closes before punctuation', () => {
    expect(sanitizeIndexJobError("open 'C:\\Users\\John Doe\\x.ts'}"))
      .toBe("open '<path>'}");
    expect(sanitizeIndexJobError('{"file":"/home/alpha/My Repo/a.ts"}'))
      .toBe('{"file":"<path>"}');
    expect(sanitizeIndexJobError("open 'src/My File.ts'!"))
      .toBe("open '<path>'!");
  });

  it('never leaks a path tail when a quote pair is malformed (#210 review follow-up)', () => {
    expect(sanitizeIndexJobError(`open ' {"file": "/home/My Repo/a.ts"}`))
      .toBe(`open ' {"file": "<path>"}`);
    expect(sanitizeIndexJobError('open "/home/My Repo/a.ts"-cache'))
      .toBe('open "<path>"-cache');
    expect(sanitizeIndexJobError("open '/home/My Repo/a.ts's copy"))
      .toBe("open '<path>'s copy");
    expect(sanitizeIndexJobError('open \\"/home/My Repo/a.ts\\" failed'))
      .toBe('open \\"<path>" failed');
  });

  it('redacts the residual malformed-quote forms from the #687 review', () => {
    expect(sanitizeIndexJobError("open '/home/O'Brien Repo/a.ts's copy"))
      .toBe("open '<path>'s copy");
    expect(sanitizeIndexJobError("open '/home/My Repo/a.ts"))
      .toBe("open '<path>'");
    expect(sanitizeIndexJobError("open ' /home/My Repo/a.ts"))
      .toBe("open '<path>'");
    expect(sanitizeIndexJobError("open 'C:\\Users\\My Name\\x.ts"))
      .toBe("open '<path>'");
  });

  it('closes the residual malformed-quote forms from the #688 review', () => {
    expect(sanitizeIndexJobError("open 'https://example.com/x''/home/My Repo/a.ts's copy"))
      .toBe("open 'https://example.com/x''<path>'s copy");
    expect(sanitizeIndexJobError("open 'https://example.com/x''/home/My Repo/a.ts' failed"))
      .toBe("open 'https://example.com/x''<path>' failed");
    expect(sanitizeIndexJobError("open 'file:/home/My Repo/a.ts"))
      .toBe("open '<path>'");
    expect(sanitizeIndexJobError("open 'path:/home/My Repo/a.ts"))
      .toBe("open '<path>'");
  });

  it('splits a safe URL from a path that shares one quote (#689 review follow-up)', () => {
    expect(sanitizeIndexJobError("open 'https://example.com/x'/home/My Repo/a.ts'"))
      .toBe("open 'https://example.com/x'<path>'");
    expect(sanitizeIndexJobError('open "https://example.com/x"/home/My Repo/a.ts"'))
      .toBe('open "https://example.com/x"<path>"');
    expect(sanitizeIndexJobError("open 'https://example.com/x\"/home/My Repo/a.ts\"'"))
      .toBe("open 'https://example.com/x\"<path>'");
  });

  it('redacts the whole span when the inner-quote prefix is not one URL token (#690 review)', () => {
    expect(sanitizeIndexJobError("open '/home/My Repo/a.ts'/etc/secret'"))
      .toBe("open '<path>'");
    expect(sanitizeIndexJobError("open '/home/My Repo'/secrets/a.ts'"))
      .toBe("open '<path>'");
    expect(sanitizeIndexJobError('open "/home/My Repo/a.ts"/etc/secret"'))
      .toBe('open "<path>"');
    expect(sanitizeIndexJobError("open 'C:\\Users\\My Name\\a.ts'/etc/secret'"))
      .toBe("open '<path>'");
    expect(sanitizeIndexJobError("open 'https://example.com/x y'/home/My Repo/a.ts'"))
      .toBe("open '<path>'");
  });

  it('redacts path:// URIs and protocol-relative shares (#691 review follow-up)', () => {
    expect(sanitizeIndexJobError("open 'path://home/My Repo/a.ts' failed"))
      .toBe("open '<path>' failed");
    expect(sanitizeIndexJobError('open path://home/alpha/a.ts failed'))
      .toBe('open path:<path> failed');
    expect(sanitizeIndexJobError('open //server/share/a.ts failed'))
      .toBe('open <path> failed');
    expect(sanitizeIndexJobError('open //HOST/Share/File failed'))
      .toBe('open <path> failed');
    expect(sanitizeIndexJobError('fetch https://example.com/a/b?x=1 failed'))
      .toBe('fetch https://example.com/a/b?x=1 failed');
  });

  it('never spans two adjacent quoted tokens', () => {
    expect(sanitizeIndexJobError("see 'note' at 'https://example.com/a/b'"))
      .toBe("see 'note' at 'https://example.com/a/b'");
    expect(sanitizeIndexJobError("stale 'main' at 'refs/heads/main'"))
      .toBe("stale 'main' at 'refs/heads/main'");
  });

  it('stays linear on quote-dense text without a closing quote', () => {
    const dense = "'word ".repeat(200_000);
    const startedAt = performance.now();
    expect(sanitizeIndexJobError(dense)).toBeDefined();
    expect(performance.now() - startedAt).toBeLessThan(2_000);
  });

  it('projects a failed row without its host path or provider job id', () => {
    const projected = projectIndexJobHistory(listing([{
      jobId: 'idx_umcp_failed',
      workspaceId,
      status: 'failed',
      force: false,
      startedAt: '2026-11-01T00:00:00.000Z',
      finishedAt: '2026-11-01T00:05:00.000Z',
      error: "Native Thai-RAG index_status failed: open '/home/alpha/My Repos/a.ts' (job idx_e92d1940)",
    }]));

    expect(projected.jobs[0]).toMatchObject({
      jobId: 'idx_umcp_failed',
      status: 'failed',
      error: "Native Thai-RAG index_status failed: open '<path>' (job <job-id>)",
    });
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain('/home/alpha');
    expect(serialized).not.toContain('idx_e92d1940');
    expect(serialized).toContain('idx_umcp_failed');
  });

  it('never lists a legacy-unavailable row and keeps the listing counts', () => {
    const projected = projectIndexJobHistory(listing([
      { jobId: 'legacy-row', workspaceId: 'legacy-unavailable', status: 'legacy-unavailable', force: false },
    ], { totalRowCount: 3, matchingRowCount: 1, legacyRowCount: 2 }));

    expect(projected.jobs).toEqual([]);
    expect(projected).toMatchObject({ totalRowCount: 3, matchingRowCount: 1, legacyRowCount: 2 });
  });
});
