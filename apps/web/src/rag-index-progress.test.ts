import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GatewayService } from '@unified-mpc/cf-gateway';
import { renderDashboardHtml } from './dashboard-html.js';
import { ControlPlaneServer, parseRagIndexJobs, summarizeRagIndexJobs } from './web-server.js';

const ws = '11111111-1111-4111-8111-111111111111';
const upperWs = 'ABCDEF01-2345-4678-9ABC-DEF012345678';
const example = {
  schemaVersion: 3,
  jobs: [
    {
      jobId: 'idx_umcp_1234567890abcdef', workspaceId: ws, ownerId: 'owner-a', status: 'running', force: false,
      indexedFiles: 3, skippedFiles: 2, totalFiles: 5,
      cacheHitFiles: 2, cacheHitChunks: 8,
      cacheMissFiles: 1, cacheMissChunks: 2,
      newEmbeddedFiles: 1, newEmbeddedChunks: 2,
      cacheMissReasons: { artifact_missing: 2 },
      reindexReason: 'startup_verification',
      startedAt: '2026-10-01T15:00:00Z', providerJobId: 'secret-provider',
      result: { workspace: '/private/location' },
    },
    {
      jobId: 'idx_umcp_bbbbbbbbbbbbbbbb', workspaceId: ws, ownerId: 'owner-a', status: 'completed',
      indexedFiles: 4, skippedFiles: 1, totalFiles: 5,
      startedAt: '2026-09-30T15:00:00Z', finishedAt: '2026-09-30T16:00:00Z',
    },
    {
      jobId: 'untrusted-job', workspaceId: ws, ownerId: 'owner-a', status: 'running',
      startedAt: '2026-10-01T16:00:00Z',
    },
  ],
};

describe('headless-safe native Thai-RAG progress', () => {
  it('sanitizes records, marks post-file finalization, and omits secrets', () => {
    const jobs = parseRagIndexJobs(example);
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      jobId: 'idx_umcp_1234567890abcdef', stage: 'finalizing', progressPercent: 100,
      force: false, pendingFiles: 0,
      indexedFiles: 3, skippedFiles: 2, totalFiles: 5,
      cacheHitFiles: 2, cacheHitChunks: 8,
      cacheMissFiles: 1, cacheMissChunks: 2,
      newEmbeddedFiles: 1, newEmbeddedChunks: 2,
      cacheMissReasons: { artifact_missing: 2 },
      reindexReason: 'startup_verification',
    });
    expect(JSON.stringify(jobs)).not.toContain('secret-provider');
    expect(JSON.stringify(jobs)).not.toContain('/private/location');
    expect(parseRagIndexJobs({ jobs: [{ ...example.jobs[0], totalFiles: 0 }] })[0]).toMatchObject({
      stage: 'scanning',
    });
  });

  it('sanitizes terminal failure text, keeps active rows first and counts legacy rows', () => {
    const summary = summarizeRagIndexJobs({
      schemaVersion: 3,
      jobs: [
        {
          jobId: 'idx_umcp_failed00000000', workspaceId: ws, ownerId: 'owner-a', status: 'failed',
          startedAt: '2026-10-01T10:00:00Z', finishedAt: '2026-10-01T10:05:00Z',
          error: '  Provider\n\tcrashed\u0007  while embedding  ',
        },
        { jobId: 'legacy-row', workspaceId: 'legacy-unavailable', status: 'legacy-unavailable', legacyData: {} },
        {
          // Un-migrated v1/v2 row: canonical workspace and status but no owner,
          // which the store's parseJob already classifies as legacy.
          jobId: 'idx_umcp_unmigrated00000', workspaceId: ws, status: 'completed',
          startedAt: '2026-09-15T10:00:00Z', finishedAt: '2026-09-15T10:05:00Z',
        },
        {
          // Pre-contract row whose workspace is a path, not a canonical UUID.
          jobId: 'idx_umcp_pathworkspace00', workspaceId: '/home/operator/repo', ownerId: 'owner-a',
          status: 'completed', startedAt: '2026-09-16T10:00:00Z', finishedAt: '2026-09-16T10:05:00Z',
        },
        {
          // Uppercase workspace UUID: the store only accepts lowercase, so the
          // dashboard must count it as legacy instead of attributing it.
          jobId: 'idx_umcp_uppercaseuuid000', workspaceId: upperWs, ownerId: 'owner-a',
          status: 'completed', startedAt: '2026-09-17T10:00:00Z', finishedAt: '2026-09-17T10:05:00Z',
        },
        {
          jobId: 'idx_umcp_running0000000', workspaceId: ws, ownerId: 'owner-a', status: 'running',
          startedAt: '2026-09-01T10:00:00Z',
        },
        {
          // Not legacy: attributable row whose job id is not renderable.
          jobId: 'untrusted', workspaceId: ws, ownerId: 'owner-a', status: 'running',
          startedAt: '2026-10-02T10:00:00Z',
        },
      ],
    });
    expect(summary.jobs.map((job) => job.jobId)).toEqual(['idx_umcp_running0000000', 'idx_umcp_failed00000000']);
    expect(summary.jobs[1]).toMatchObject({
      stage: 'failed',
      error: 'Provider crashed while embedding',
      finishedAt: '2026-10-01T10:05:00Z',
    });
    expect(summary.legacyRowCount).toBe(4);

    const long = summarizeRagIndexJobs({
      jobs: [{
        jobId: 'idx_umcp_longerror00000', workspaceId: ws, ownerId: 'owner-a', status: 'failed',
        startedAt: '2026-10-01T10:00:00Z', error: 'x'.repeat(500),
      }],
    });
    expect(long.jobs[0]?.error).toHaveLength(400);
  });

  it('serves an owner-written ledger through the existing localhost read-only API', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rag-progress-web-'));
    const folder = path.join(root, 'thai-rag');
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, 'index-jobs.json'), JSON.stringify(example));
    const gateway = new GatewayService({ localPort: 0 });
    const server = new ControlPlaneServer({
      port: 0, dataDir: root, gateway,
       mcpIdentityProbe: async (): Promise<null> => null,
    });
    try {
      await server.listen();
      const response = await fetch('http://127.0.0.1:' + server.port + '/api/rag-index-jobs');
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const data = await response.json() as { available: boolean; jobs: unknown[]; legacyRowCount: number };
      expect(data.available).toBe(true);
      expect(data.jobs).toHaveLength(2);
      expect(data.legacyRowCount).toBe(0);
      expect(JSON.stringify(data)).not.toContain('/private/location');
      expect(JSON.stringify(data)).not.toContain('secret-provider');
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('renders an accessible progress bar that polls independently of Tk DISPLAY', () => {
    const html = renderDashboardHtml();
    expect(html).toContain('id="rag-index-jobs"');
    expect(html).toContain("fetchWithTimeout('/api/rag-index-jobs')");
    expect(html).toContain("document.createElement('progress')");
    expect(html).toContain('aria-label');
    expect(html).toContain('setInterval(loadRagIndexJobs, 5000)');
    expect(html).toContain('Finalizing index');
    expect(html).toContain('cache-hit');
    expect(html).toContain('Reason: ');
    expect(html).toContain('jobId=');
    expect(html).toContain('force=');
    expect(html).toContain('pending ');
    expect(html).toContain("' · Error: '");
    expect(html).toContain('legacy index job row(s) cannot be attributed');
    expect(html).not.toContain(" + ' reused)'");
  });
});
