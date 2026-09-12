import { request as httpRequest } from 'node:http';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ControlPlaneServer } from './web-server.js';
import { GatewayService } from '@unified-mpc/cf-gateway';
import {
  InstallerService,
  McpConfigLoader,
  PrunerService,
  IdeSyncService,
  SkillCatalog,
  DEFAULT_EXTENSIONS_SETTINGS,
} from '@unified-mpc/extensions';

describe('ControlPlaneServer - Local Web Control Plane & Telemetry', () => {
  const capabilityToken = 'test-capability-token';
  const gatewayOptions = { localPort: 0, tunnelProvider: async (): Promise<{ url: string; stop(): Promise<void> }> => ({ url: 'https://fixture.example.trycloudflare.com', stop: async (): Promise<void> => {} }), healthProbe: async (): Promise<number> => 200 };
  let server: ControlPlaneServer;
  let gateway: GatewayService;
  let port: number;

  beforeEach(async () => {
    gateway = new GatewayService(gatewayOptions);
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
      capabilityToken,
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

  it('requires startup capability for mutations and does not expose it in status or logs', async () => {
    const denied = await fetch(`http://127.0.0.1:${port}/api/chatgpt-gateway/start`, {
      method: 'POST', headers: { Origin: `http://127.0.0.1:${port}` },
    });
    expect(denied.status).toBe(401);
    const status = await fetch(`http://127.0.0.1:${port}/api/status`);
    const logs = await fetch(`http://127.0.0.1:${port}/api/logs`);
    expect(await status.text()).not.toContain(capabilityToken);
    expect(await logs.text()).not.toContain(capabilityToken);
  });

  it('rejects wrong capability values', async () => {
    const denied = await fetch(`http://127.0.0.1:${port}/api/chatgpt-gateway/stop`, {
      method: 'POST', headers: { Origin: `http://127.0.0.1:${port}`, 'x-unified-mpc-capability': 'wrong' },
    });
    expect(denied.status).toBe(401);
  });

  it('rotates capability on restart and accepts dashboard cookie', async () => {
    const first = await fetch(`http://127.0.0.1:${port}/`);
    const cookie = first.headers.get('set-cookie');
    expect(cookie).toContain('unified_mpc_capability=');
    const allowed = await fetch(`http://127.0.0.1:${port}/api/chatgpt-gateway/stop`, {
      method: 'POST',
      headers: { Origin: `http://127.0.0.1:${port}`, Cookie: cookie!.split(';')[0]! },
    });
    expect(allowed.status).toBe(200);
  });

  it('rejects a capability cookie issued by a previous server process', async () => {
    const first = new ControlPlaneServer({ port: 0, gateway });
    await first.listen();
    const landing = await fetch(`http://127.0.0.1:${first.port}/`);
    const oldCookie = landing.headers.get('set-cookie')!.split(';')[0]!;
    await first.close();

    const second = new ControlPlaneServer({ port: 0, gateway });
    await second.listen();
    try {
      const denied = await fetch(`http://127.0.0.1:${second.port}/api/chatgpt-gateway/stop`, {
        method: 'POST',
        headers: { Origin: `http://127.0.0.1:${second.port}`, Cookie: oldCookie },
      });
      expect(denied.status).toBe(401);
    } finally {
      await second.close();
    }
  });

  it('blocks non-localhost origins with 403 Forbidden (Origin Policy Guard)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/status`, {
      headers: { Origin: 'https://malicious-attacker.com' },
    });
    expect(res.status).toBe(403);
  });

  it('rejects mutation requests without an Origin header', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/servers/prune`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverId: 'server_missing_origin' }),
    });
    expect(res.status).toBe(403);
  });

  it('rejects requests with a foreign Host header even when Origin is loopback', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest({
        hostname: '127.0.0.1',
        port,
        path: '/api/status',
        headers: {
          Host: 'evil.example',
          Origin: `http://127.0.0.1:${port}`,
        },
      }, (response) => {
        response.resume();
        response.once('end', () => resolve(response.statusCode ?? 0));
      });
      request.once('error', reject);
      request.end();
    });
    expect(status).toBe(403);
  });

  it('rejects raw PID pruning input without a server-issued ownership proof', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/servers/prune`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}`, 'x-unified-mpc-capability': capabilityToken },
      body: JSON.stringify({ name: 'fixture', pid: process.pid }),
    });
    expect(res.status).toBe(403);
  });

  it('allows loopback localhost origins', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/status`, {
      headers: { Origin: `http://127.0.0.1:${port}`, 'x-unified-mpc-capability': capabilityToken },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('healthy');
  });

  it('enforces hard gating: GET /api/chatgpt-web/connect returns 412 Precondition Failed when bridge is STOPPED', async () => {
    expect(gateway.status().state).toBe('STOPPED');

    const res = await fetch(`http://127.0.0.1:${port}/api/chatgpt-web/connect`, {
      headers: { Origin: `http://127.0.0.1:${port}`, 'x-unified-mpc-capability': capabilityToken },
    });
    expect(res.status).toBe(412);
    const body = await res.json();
    expect(body.error).toContain('Bridge must be in BRIDGE_HEALTHY state');
  });

  it('allows GET /api/chatgpt-web/connect with 200 OK when bridge is BRIDGE_HEALTHY', async () => {
    await gateway.start();
    expect(gateway.status().state).toBe('BRIDGE_HEALTHY');

    const res = await fetch(`http://127.0.0.1:${port}/api/chatgpt-web/connect`, {
      headers: { Origin: `http://127.0.0.1:${port}`, 'x-unified-mpc-capability': capabilityToken },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.leaseToken).toBeDefined();
    expect(body.tunnelUrl).toBeDefined();
    expect(body.mcpUrl).toBe('https://fixture.example.trycloudflare.com/mcp');
  });

  it('lists servers with opaque IDs and prunes by ownership proof, never request PID', async () => {
    let captured: Record<string, unknown> | undefined;
    const serverCatalog = {
      discover: async () => [{
        name: 'owned-server',
        source: 'fixture',
        enabled: true,
        excluded: false,
        config: { command: 'node' },
      }],
    } as unknown as McpConfigLoader;
    const pruner = {
      pruneServer: async (input: Record<string, unknown>) => {
        captured = input;
        return {
          ok: true as const,
          value: { name: String(input.name), updatedConfigFiles: [], processTerminated: false, removedPaths: [], recoveryStatus: 'completed', recoveryIds: [] },
        };
      },
    } as unknown as PrunerService;
    const ownedServer = new ControlPlaneServer({ port: 0, gateway, serverCatalog, pruner, capabilityToken });
    await ownedServer.listen();
    try {
      const listed = await fetch(`http://127.0.0.1:${ownedServer.port}/api/servers`);
      expect(listed.status).toBe(200);
      const server = (await listed.json()).servers[0];
      expect(server.serverId).toMatch(/^server_/);
      expect(server).not.toHaveProperty('pid');

      const pruned = await fetch(`http://127.0.0.1:${ownedServer.port}/api/servers/prune`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${ownedServer.port}`, 'x-unified-mpc-capability': capabilityToken },
        body: JSON.stringify({ serverId: server.serverId, pid: process.pid }),
      });
      expect(pruned.status).toBe(200);
      expect(captured).toEqual({ name: 'owned-server', targets: ['all'] });
    } finally {
      await ownedServer.close();
    }
  });

  it('returns 500 for a route dependency rejection and remains available', async () => {
    const failingCatalog = { discover: async () => { throw new Error('synthetic catalog failure'); } } as unknown as McpConfigLoader;
    const failingServer = new ControlPlaneServer({ port: 0, gateway, serverCatalog: failingCatalog, capabilityToken });
    await failingServer.listen();
    try {
      const failed = await fetch(`http://127.0.0.1:${failingServer.port}/api/servers`);
      expect(failed.status).toBe(500);
      const healthy = await fetch(`http://127.0.0.1:${failingServer.port}/api/status`);
      expect(healthy.status).toBe(200);
    } finally {
      await failingServer.close();
    }
  });

  it('returns 422 for unsupported install targets and 400 for malformed JSON', async () => {
    const unsupported = await fetch(`http://127.0.0.1:${port}/api/servers/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}`, 'x-unified-mpc-capability': capabilityToken },
      body: JSON.stringify({ name: 'fixture', transport: 'stdio', command: 'node', targets: ['unknown'] }),
    });
    expect(unsupported.status).toBe(422);
    const malformed = await fetch(`http://127.0.0.1:${port}/api/servers/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}`, 'x-unified-mpc-capability': capabilityToken },
      body: '{',
    });
    expect(malformed.status).toBe(400);
  });

  it('rejects unregistered workspace mutations and caller-supplied purge paths', async () => {
    const workspace = '/tmp/unregistered-workspace';
    const skill = await fetch(`http://127.0.0.1:${port}/api/skills/prune`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}`, 'x-unified-mpc-capability': capabilityToken },
      body: JSON.stringify({ name: 'fixture', scope: 'workspace', workspaceRoot: workspace, targets: ['cursor'] }),
    });
    expect(skill.status).toBe(403);

    const serverCatalog = {
      discover: async () => [{ name: 'owned-server', source: 'fixture', enabled: true, excluded: false, config: { command: 'node' } }],
    } as unknown as McpConfigLoader;
    const ownedServer = new ControlPlaneServer({ port: 0, gateway, serverCatalog, capabilityToken });
    await ownedServer.listen();
    try {
      const listed = await fetch(`http://127.0.0.1:${ownedServer.port}/api/servers`);
      const server = (await listed.json()).servers[0];
      const prune = await fetch(`http://127.0.0.1:${ownedServer.port}/api/servers/prune`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${ownedServer.port}`, 'x-unified-mpc-capability': capabilityToken },
        body: JSON.stringify({ serverId: server.serverId, purgeDataDirs: ['/tmp'] }),
      });
      expect(prune.status).toBe(403);
    } finally {
      await ownedServer.close();
    }
  });

  it('rejects skill source traversal and symlink escape from registered workspace', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'web-confinement-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'web-outside-'));
    await mkdir(path.join(root, 'skill'), { recursive: true });
    await writeFile(path.join(root, 'skill', 'SKILL.md'), '---\nname: fixture\ndescription: fixture\n---\n', 'utf8');
    await writeFile(path.join(outside, 'SKILL.md'), '---\nname: fixture\ndescription: outside\n---\n', 'utf8');
    await symlink(outside, path.join(root, 'escape'));
    const confined = new ControlPlaneServer({ port: 0, gateway, workspaceRoots: [root], capabilityToken });
    await confined.listen();
    try {
      const headers = { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${confined.port}`, 'x-unified-mpc-capability': capabilityToken };
      const traversal = await fetch(`http://127.0.0.1:${confined.port}/api/skills/install`, {
        method: 'POST', headers,
        body: JSON.stringify({ name: 'fixture', source: path.join(root, '..', path.basename(outside)), targets: ['cursor'] }),
      });
      expect(traversal.status).toBe(403);
      const symlinkEscape = await fetch(`http://127.0.0.1:${confined.port}/api/skills/install`, {
        method: 'POST', headers,
        body: JSON.stringify({ name: 'fixture', source: path.join(root, 'escape'), targets: ['cursor'] }),
      });
      expect(symlinkEscape.status).toBe(403);
    } finally {
      await confined.close();
      await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]);
    }
  });

  it('returns policy table on GET /api/policies', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/policies`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.policies)).toBe(true);
    expect(data.policies.some((p: { priority: string }) => p.priority === 'P1')).toBe(true);
  });

  it('returns recorded telemetry events on GET /api/logs', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/logs`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.logs)).toBe(true);
    expect(data.logs.length).toBeGreaterThan(0);
    expect(data.logs[0]).toHaveProperty('time');
    expect(data.logs[0]).toHaveProperty('level');
    expect(data.logs[0]).toHaveProperty('msg');
  });
});

