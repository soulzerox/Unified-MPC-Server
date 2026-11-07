import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GatewayService } from '@unified-mpc/cf-gateway';
import { renderDashboardHtml } from './dashboard-html.js';
import { ControlPlaneServer, type CanonicalLifecycleProbe } from './web-server.js';

const snapshot = {
  revisions: {
    total: 1,
    revisions: [{
      manifestId: 'man:v1:' + 'a'.repeat(64),
      repositoryId: 'repo_abc123',
      revisionId: 'rev:v1:' + 'b'.repeat(64),
      commitSha: 'c'.repeat(40),
      treeOid: 'd'.repeat(40),
      targetRef: 'refs/remotes/origin/main',
      entryCount: 12,
      createdAt: '2026-11-01T00:00:00.000Z',
      refs: ['refs/remotes/origin/main'],
      pins: ['goal-base'],
      overlayGoalIds: [],
      indexJobOperationIds: [],
    }],
  },
  gc: {
    status: 'healthy',
    lease: { status: 'free' },
    quarantine: {
      total: 1,
      due: 1,
      inGrace: 0,
      returned: 1,
      rows: [{
        target: {
          kind: 'artifact-key',
          repositoryId: 'repo_abc123',
          artifactKey: 'file:v1:' + 'e'.repeat(64),
        },
        quarantinedAt: '2026-11-01T00:00:00.000Z',
        graceMs: 60_000,
        expiresAt: '2026-11-01T00:01:00.000Z',
        due: true,
      }],
    },
  },
};

async function withServer(
  probe: CanonicalLifecycleProbe | undefined,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'canonical-lifecycle-web-'));
  const server = new ControlPlaneServer({
    port: 0,
    dataDir: root,
    gateway: new GatewayService({ localPort: 0 }),
    mcpIdentityProbe: async (): Promise<null> => null,
    ...(probe === undefined ? {} : { canonicalLifecycleProbe: probe }),
  });
  try {
    await server.listen();
    await run('http://127.0.0.1:' + server.port);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}

describe('canonical store lifecycle projection', () => {
  it('serves the revision history and GC report the CLI supplies', async () => {
    await withServer(async () => snapshot, async (baseUrl) => {
      const response = await fetch(baseUrl + '/api/canonical-lifecycle');
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({
        available: true,
        scope: 'canonical-store',
        revisions: snapshot.revisions,
        gc: snapshot.gc,
      });
    });
  });

  it('forwards a valid limit to the probe', async () => {
    const seen: Array<{ readonly limit?: number } | undefined> = [];
    await withServer(async (options) => {
      seen.push(options);
      return snapshot;
    }, async (baseUrl) => {
      const response = await fetch(baseUrl + '/api/canonical-lifecycle?limit=1');
      expect(response.status).toBe(200);
    });
    expect(seen).toEqual([{ limit: 1 }]);
  });

  it('rejects an invalid limit before the store is touched', async () => {
    let calls = 0;
    await withServer(async () => {
      calls += 1;
      return snapshot;
    }, async (baseUrl) => {
      for (const value of ['0', '201', '-1', '1.0', '+1', 'abc', '']) {
        const response = await fetch(baseUrl + '/api/canonical-lifecycle?limit=' + encodeURIComponent(value));
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'limit must be an integer from 1 to 200' });
      }
      // Repeated parameters are ambiguous; the first value is not trusted.
      for (const query of ['limit=1&limit=201', 'limit=5&limit=5']) {
        const response = await fetch(baseUrl + '/api/canonical-lifecycle?' + query);
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'limit must be an integer from 1 to 200' });
      }
    });
    expect(calls).toBe(0);
  });

  it('reports unavailable when no probe is wired', async () => {
    await withServer(undefined, async (baseUrl) => {
      const response = await fetch(baseUrl + '/api/canonical-lifecycle');
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        available: false,
        scope: 'canonical-store',
        error: 'Canonical store lifecycle detail unavailable',
      });
    });
  });

  it('reports unavailable instead of failing the dashboard when the probe throws', async () => {
    await withServer(async () => {
      throw new Error('canonical store root is unreadable at /home/operator/secret');
    }, async (baseUrl) => {
      const response = await fetch(baseUrl + '/api/canonical-lifecycle');
      expect(response.status).toBe(503);
      const body = await response.json() as { available: boolean; error: string };
      expect(body.available).toBe(false);
      expect(body.error).toBe('Canonical store lifecycle detail unavailable');
      expect(JSON.stringify(body)).not.toContain('/home/operator/secret');
    });
  });

  it('renders a lifecycle card that loads on demand instead of polling', () => {
    const html = renderDashboardHtml();
    expect(html).toContain('id="canonical-lifecycle-card"');
    expect(html).toContain('id="canonical-lifecycle-refresh-btn"');
    expect(html).toContain('id="canonical-lifecycle"');
    expect(html).toContain("fetchWithTimeout('/api/canonical-lifecycle')");
    expect(html).toContain('loadCanonicalLifecycle();');
    expect(html).not.toContain('setInterval(loadCanonicalLifecycle');
    expect(html).toContain("'revisions ' + String(revisions.length)");
    expect(html).toContain("' of ' + String(revisionTotal)");
    expect(html).toContain("' · showing ' + String(quarantineReturned) + ' of ' + String(quarantineTotal)");
    expect(html).toContain("'gc status: '");
    expect(html).toContain("'quarantine '");
    expect(html).toContain("'loaded ' + new Date().toLocaleTimeString()");
  });
});
