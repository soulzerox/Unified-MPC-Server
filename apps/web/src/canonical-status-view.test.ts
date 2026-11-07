import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GatewayService } from '@unified-mpc/cf-gateway';
import { renderDashboardHtml } from './dashboard-html.js';
import { ControlPlaneServer } from './web-server.js';

const report = {
  status: 'degraded',
  refs: [{
    ref: 'refs/remotes/origin/main',
    manifestId: 'man:v1:' + 'a'.repeat(64),
    commitSha: 'b'.repeat(40),
    treeOid: 'c'.repeat(40),
    manifestCreatedAt: '2026-11-01T00:00:00.000Z',
    manifestEntryCount: 12,
    manifestExists: true,
    pinned: true,
    pinReasons: ['goal-base'],
  }],
  overlays: [{
    goalWorkspaceId: 'goal-1',
    baseManifestId: 'man:v1:' + 'a'.repeat(64),
    baseCommitSha: 'b'.repeat(40),
    baseTreeOid: 'c'.repeat(40),
    baseManifestExists: true,
    baseMatchesLiveRef: false,
    modifiedCount: 2,
    addedCount: 1,
    deletedCount: 0,
    updatedAt: '2026-11-02T00:00:00.000Z',
  }],
  jobs: [{
    operationId: 'op-1',
    manifestId: 'man:v1:' + 'd'.repeat(64),
    status: 'open',
    openedAt: '2026-11-03T00:00:00.000Z',
    updatedAt: '2026-11-03T00:00:00.000Z',
    manifestExists: false,
  }],
  manifestCount: 2,
  pinCount: 1,
  overlayCount: 1,
  quarantinedCount: 0,
  activeJobCount: 1,
  danglingRefs: [],
  missingOverlayBases: [],
  orphanedPins: [],
};

async function withServer(
  probe: (() => Promise<unknown>) | undefined,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'canonical-status-web-'));
  const server = new ControlPlaneServer({
    port: 0,
    dataDir: root,
    gateway: new GatewayService({ localPort: 0 }),
    mcpIdentityProbe: async (): Promise<null> => null,
    ...(probe === undefined ? {} : { canonicalStatusProbe: probe }),
  });
  try {
    await server.listen();
    await run('http://127.0.0.1:' + server.port);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}

describe('canonical store status projection', () => {
  it('serves the read-only report the CLI supplies', async () => {
    await withServer(async () => report, async (baseUrl) => {
      const response = await fetch(baseUrl + '/api/canonical-status');
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({
        available: true,
        scope: 'canonical-store',
        status: report,
      });
    });
  });

  it('reports unavailable when no probe is wired', async () => {
    await withServer(undefined, async (baseUrl) => {
      const response = await fetch(baseUrl + '/api/canonical-status');
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        available: false,
        scope: 'canonical-store',
        error: 'Canonical store status unavailable',
      });
    });
  });

  it('reports unavailable instead of failing the dashboard when the probe throws', async () => {
    await withServer(async () => {
      throw new Error('canonical store root is unreadable');
    }, async (baseUrl) => {
      const response = await fetch(baseUrl + '/api/canonical-status');
      expect(response.status).toBe(503);
      const body = await response.json() as { available: boolean; error: string };
      expect(body.available).toBe(false);
      expect(body.error).toBe('Canonical store status unavailable');
    });
  });

  it('renders a canonical status card that polls the endpoint', () => {
    const html = renderDashboardHtml();
    expect(html).toContain('id="canonical-status-card"');
    expect(html).toContain('id="canonical-status-refresh-btn"');
    expect(html).toContain('id="canonical-status"');
    expect(html).toContain("fetchWithTimeout('/api/canonical-status')");
    expect(html).toContain('setInterval(loadCanonicalStatus, 15000)');
    expect(html).toContain("' · manifests '");
    expect(html).toContain("' · pins '");
    expect(html).toContain("' · overlays '");
    expect(html).toContain("' base=' + base");
    expect(html).toContain("' manifest=' + (job.manifestExists ? 'present' : 'missing')");
    expect(html).toContain("'blockers dangling-refs='");
  });
});
