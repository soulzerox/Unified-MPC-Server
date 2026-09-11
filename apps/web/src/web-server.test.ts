import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ControlPlaneServer } from './web-server.js';
import { GatewayService } from '@unified-mpc/cf-gateway';
import { InstallerService, PrunerService, IdeSyncService, SkillCatalog, DEFAULT_EXTENSIONS_SETTINGS } from '@unified-mpc/extensions';

describe('ControlPlaneServer - Local Web Control Plane & Telemetry', () => {
  let server: ControlPlaneServer;
  let gateway: GatewayService;
  let port: number;

  beforeEach(async () => {
    gateway = new GatewayService({ localPort: 0 });
    const installer = new InstallerService();
    const pruner = new PrunerService();
    const ideSync = new IdeSyncService();
    const skillCatalog = new SkillCatalog({ settings: DEFAULT_EXTENSIONS_SETTINGS });

    server = new ControlPlaneServer({
      port: 0, // OS assigned random available port
      gateway,
      installer,
      pruner,
      ideSync,
      skillCatalog,
    });

    await server.listen();
    port = server.port;
  });

  afterEach(async () => {
    await server.close();
  });

  it('serves the Obsidian Telemetry dashboard HTML on GET /', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Unified-MPC-Server');
    expect(html).toContain('#090A0C'); // Canvas color from DESIGN.md
    expect(html).toContain('Dashboard');
    expect(html).toContain('Servers');
    expect(html).toContain('Skills');
    expect(html).toContain('Install');
    expect(html).toContain('Policies');
  });

  it('blocks non-localhost origins with 403 Forbidden (Origin Policy Guard)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/status`, {
      headers: { Origin: 'https://malicious-attacker.com' },
    });
    expect(res.status).toBe(403);
  });

  it('allows loopback localhost origins', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/status`, {
      headers: { Origin: `http://127.0.0.1:${port}` },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('healthy');
  });

  it('enforces hard gating: GET /api/chatgpt-web/connect returns 412 Precondition Failed when bridge is STOPPED', async () => {
    expect(gateway.status().state).toBe('STOPPED');

    const res = await fetch(`http://127.0.0.1:${port}/api/chatgpt-web/connect`);
    expect(res.status).toBe(412);
    const body = await res.json();
    expect(body.error).toContain('Bridge must be in BRIDGE_HEALTHY state');
  });

  it('allows GET /api/chatgpt-web/connect with 200 OK when bridge is BRIDGE_HEALTHY', async () => {
    await gateway.start();
    expect(gateway.status().state).toBe('BRIDGE_HEALTHY');

    const res = await fetch(`http://127.0.0.1:${port}/api/chatgpt-web/connect`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.leaseToken).toBeDefined();
    expect(body.tunnelUrl).toBeDefined();
  });

  it('returns policy table on GET /api/policies', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/policies`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.policies)).toBe(true);
    expect(data.policies.some((p: any) => p.priority === 'P1')).toBe(true);
  });
});
