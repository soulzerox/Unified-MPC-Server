import { request as httpRequest } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ControlPlaneServer } from './web-server.js';
import { GatewayService } from '@unified-mpc/cf-gateway';

const capabilityToken = 'live-edge-stress-capability';
const origin = (port: number): string => `http://127.0.0.1:${port}`;

describe('ControlPlaneServer - live edge and stress smoke', () => {
  let server: ControlPlaneServer;
  let gateway: GatewayService;

  beforeEach(async () => {
    gateway = new GatewayService({
      localPort: 0,
      tunnelProvider: async (): Promise<{ readonly url: string; readonly stop: () => Promise<void> }> => ({ url: 'https://fixture.example.trycloudflare.com', stop: async (): Promise<void> => {} }),
      healthProbe: async (): Promise<number> => 200,
    });
    server = new ControlPlaneServer({ port: 0, gateway, capabilityToken });
    await server.listen();
  });

  afterEach(async () => {
    await server.close();
  });

  const auth = (): HeadersInit => ({
    Origin: origin(server.port),
    'x-unified-mpc-capability': capabilityToken,
  });

  it('answers OPTIONS with CORS metadata only after capability and origin checks', async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/api/status`, { method: 'OPTIONS', headers: auth() });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(origin(server.port));
    expect(response.headers.get('access-control-allow-methods')).toContain('POST');
  });

  it('rejects a loopback-looking Host containing user-info credentials', async () => {
    const response = await new Promise<{ statusCode?: number; body: string }>((resolve, reject) => {
      const request = httpRequest({
        host: '127.0.0.1',
        port: server.port,
        path: '/api/status',
        headers: { Host: `attacker:pw@127.0.0.1:${server.port}` },
      }, (incoming) => {
        let body = '';
        incoming.setEncoding('utf8');
        incoming.on('data', (chunk: string) => { body += chunk; });
        incoming.on('end', () => resolve({ statusCode: incoming.statusCode, body }));
      });
      request.on('error', reject);
      request.end();
    });
    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body)).toEqual({ error: 'Host not allowed: loopback only' });
  });

  it('routes query strings by pathname without changing API response', async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/api/status?redirect=//evil.example/%00`);
    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe('healthy');
  });

  it('returns JSON 404 for unknown and percent-encoded lookalike routes', async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/api/%73tatus/extra`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Endpoint not found' });
  });

  it('rejects mutation before parsing body when Origin is absent', async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/api/policies/sync`, {
      method: 'POST',
      headers: { 'x-unified-mpc-capability': capabilityToken, 'Content-Type': 'application/json' },
      body: '{not-json',
    });
    expect(response.status).toBe(403);
    expect((await response.json()).error).toContain('Origin header required');
  });

  it('rejects malformed percent-encoded capability cookies without throwing', async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/api/chatgpt-gateway/start`, {
      method: 'POST',
      headers: { Origin: origin(server.port), Cookie: 'unified_mpc_capability=%E0%A4%A' },
    });
    expect(response.status).toBe(401);
  });

  it('accepts URL-encoded capability cookie while keeping token out of status', async () => {
    const landing = await fetch(`http://127.0.0.1:${server.port}/`);
    const cookie = landing.headers.get('set-cookie')!.split(';')[0]!;
    const response = await fetch(`http://127.0.0.1:${server.port}/api/chatgpt-gateway/stop`, {
      method: 'POST',
      headers: { Origin: origin(server.port), Cookie: cookie },
    });
    expect(response.status).toBe(200);
    const status = await fetch(`http://127.0.0.1:${server.port}/api/status`);
    expect(await status.text()).not.toContain(capabilityToken);
  });

  it('does not expose capability or lease secrets through gateway status', async () => {
    await gateway.start();
    await fetch(`http://127.0.0.1:${server.port}/api/chatgpt-web/connect`, { method: 'POST', headers: auth() });
    const response = await fetch(`http://127.0.0.1:${server.port}/api/chatgpt-gateway/status`);
    const body = await response.text();
    expect(body).not.toContain(capabilityToken);
    expect(body).not.toContain('lease_');
  });

  it('keeps opaque server ID stable across repeated inventory reads', async () => {
    const first = await fetch(`http://127.0.0.1:${server.port}/api/servers`);
    const second = await fetch(`http://127.0.0.1:${server.port}/api/servers`);
    const firstServers = (await first.json()).servers;
    const secondServers = (await second.json()).servers;
    expect(firstServers).toEqual(secondServers);
  });

  it('applies default all-target policy sync for null JSON body', async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/api/policies/sync`, {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: 'null',
    });
    expect(response.status).toBe(200);
    expect((await response.json()).ok).toBe(true);
  });

  it('does not expose WebUI extension installation endpoints', async () => {
    for (const pathname of ['/api/skills/install', '/api/servers/install']) {
      const response = await fetch(`http://127.0.0.1:${server.port}${pathname}`, {
        method: 'POST',
        headers: { ...auth(), 'Content-Type': 'application/json' },
        body: '{}',
      });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'Endpoint not found' });
    }
  });

  it('returns 400 for primitive skill prune payload', async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/api/skills/prune`, {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: '"skill-name"',
    });
    expect(response.status).toBe(400);
  });

  it('rejects server pruning with an array payload as missing ownership proof', async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/api/servers/prune`, {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: '[]',
    });
    expect(response.status).toBe(403);
    expect((await response.json()).error).toContain('ownership proof');
  });

  it('returns 403 for a server ID after its catalog entry expires', async () => {
    let visible = true;
    const catalog = { discover: async (): Promise<readonly { name: string; source: string; enabled: boolean; excluded: boolean; config: { command: string } }[]> => visible ? [{ name: 'temporary', source: 'fixture', enabled: true, excluded: false, config: { command: 'node' } }] : [] };
    const expiring = new ControlPlaneServer({ port: 0, gateway, serverCatalog: catalog as never, capabilityToken });
    await expiring.listen();
    try {
      const listed = await fetch(`http://127.0.0.1:${expiring.port}/api/servers`);
      const serverId = (await listed.json()).servers[0].serverId;
      visible = false;
      await fetch(`http://127.0.0.1:${expiring.port}/api/servers`);
      const pruned = await fetch(`http://127.0.0.1:${expiring.port}/api/servers/prune`, {
        method: 'POST',
        headers: { ...auth(), Origin: origin(expiring.port), 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverId }),
      });
      expect(pruned.status).toBe(403);
    } finally {
      await expiring.close();
    }
  });

  it('returns 400 for invalid JSON with trailing garbage', async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/api/policies/sync`, {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: '{"targets":["all"]} trailing',
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('malformed JSON');
  });

  it('fails closed for a multibyte body beyond one megabyte', async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/api/policies/sync`, {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload: '界'.repeat(400_000) }),
    });
    expect(response.status).toBe(413);
  });

  it('survives 120 concurrent mixed valid, invalid, and preflight requests', async () => {
    const requests = Array.from({ length: 120 }, (_, index) => {
      const route = index % 5;
      if (route === 0) return fetch(`http://127.0.0.1:${server.port}/api/status`);
      if (route === 1) return fetch(`http://127.0.0.1:${server.port}/api/logs`);
      if (route === 2) return fetch(`http://127.0.0.1:${server.port}/api/status?case=${index}`);
      if (route === 3) return fetch(`http://127.0.0.1:${server.port}/api/not-a-route/${index}`);
      return fetch(`http://127.0.0.1:${server.port}/api/status`, { method: 'OPTIONS', headers: auth() });
    });
    const responses = await Promise.all(requests);
    expect(responses.filter((response) => response.status === 200)).toHaveLength(72);
    expect(responses.filter((response) => response.status === 204)).toHaveLength(24);
    expect(responses.filter((response) => response.status === 404)).toHaveLength(24);
    expect(responses.every((response) => [200, 204, 404].includes(response.status))).toBe(true);
  });
});
