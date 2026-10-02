import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GatewayService } from '@unified-mpc/cf-gateway';
import { renderDashboardHtml } from './dashboard-html.js';
import { ControlPlaneServer, parseRagIndexJobs } from './web-server.js';

const ws = '11111111-1111-4111-8111-111111111111';
const example = {
  schemaVersion: 3,
  jobs: [
    {
      jobId: 'idx_umcp_1234567890abcdef', workspaceId: ws, status: 'running',
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
      jobId: 'idx_umcp_bbbbbbbbbbbbbbbb', workspaceId: ws, status: 'completed',
      indexedFiles: 4, skippedFiles: 1, totalFiles: 5,
      startedAt: '2026-09-30T15:00:00Z', finishedAt: '2026-09-30T16:00:00Z',
    },
    { jobId: 'untrusted-job', workspaceId: ws, status: 'running', startedAt: '2026-10-01T16:00:00Z' },
  ],
};

describe('headless-safe native Thai-RAG progress', () => {
  it('sanitizes records, marks post-file finalization, and omits secrets', () => {
    const jobs = parseRagIndexJobs(example);
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      jobId: 'idx_umcp_1234567890abcdef', stage: 'finalizing', progressPercent: 100,
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
      const data = await response.json() as { available: boolean; jobs: unknown[] };
      expect(data.available).toBe(true);
      expect(data.jobs).toHaveLength(2);
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
    expect(html).toContain("fetch('/api/rag-index-jobs')");
    expect(html).toContain("document.createElement('progress')");
    expect(html).toContain('aria-label');
    expect(html).toContain('setInterval(loadRagIndexJobs, 5000)');
    expect(html).toContain('Finalizing index');
    expect(html).toContain('cache-hit');
    expect(html).toContain('Reason: ');
    expect(html).not.toContain(" + ' reused)'");
  });
});
