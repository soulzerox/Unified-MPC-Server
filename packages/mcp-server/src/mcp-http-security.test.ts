import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/client';
import { request as httpRequest } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_MCP_HTTP_BODY_BYTES, startMcpHttp, type McpHttpServerHandle } from './http.js';

describe('MCP localhost HTTP security boundary', () => {
  let handle: McpHttpServerHandle;

  beforeEach(async () => {
    handle = await startMcpHttp({
      port: 0,
      maxBodyBytes: 128,
      services: {},
      actor: { clientId: 'http-security-test', clientName: 'http-security-test' },
    });
  });

  afterEach(async () => {
    await handle.close();
  });

  it('allows local origins and denies an untrusted origin', async () => {
    const allowed = await fetch(handle.endpoint, { headers: { Origin: `http://localhost:${handle.address.port}` } });
    const denied = await fetch(handle.endpoint, { headers: { Origin: 'http://evil.example' } });

    expect(allowed.status).not.toBe(403);
    expect(denied.status).toBe(403);
  });

  it('allows a configured public hostname and origin without enabling wildcard access', async () => {
    const publicHandle = await startMcpHttp({
      port: 0,
      services: {},
      actor: { clientId: 'public-host-test', clientName: 'public-host-test' },
      allowedHostnames: ['mcp.example.com'],
      allowedOrigins: ['https://mcp.example.com'],
    });
    try {
      const requestStatus = (host: string, origin: string): Promise<number> => new Promise((resolve, reject) => {
        const request = httpRequest({
          hostname: '127.0.0.1',
          port: publicHandle.address.port,
          path: '/_unified-mpc/identity',
          headers: { Host: host, Origin: origin },
        }, (response) => {
          response.resume();
          response.once('end', () => resolve(response.statusCode ?? 0));
        });
        request.once('error', reject);
        request.end();
      });
      const allowed = await requestStatus(`mcp.example.com:${publicHandle.address.port}`, 'https://mcp.example.com');
      const denied = await requestStatus(`other.example.com:${publicHandle.address.port}`, 'https://other.example.com');
      expect(allowed).toBe(200);
      expect(denied).toBe(403);
    } finally {
      await publicHandle.close();
    }
  });

  it('exposes immutable build provenance without replacing the semantic app version', async () => {
    const buildProvenance = {
      version: '4.61.0',
      buildVersion: '4.61.0+0123456789ab',
      buildCommit: '0123456789abcdef0123456789abcdef01234567',
      buildShortCommit: '0123456789ab',
      buildTime: '2026-09-21T09:00:00.000Z',
      buildDirty: false,
    };
    const provenanceHandle = await startMcpHttp({
      port: 0,
      services: {},
      actor: { clientId: 'build-provenance-test', clientName: 'build-provenance-test' },
      buildProvenance,
    });
    try {
      const response = await fetch(new URL('/_unified-mpc/identity', provenanceHandle.endpoint));
      expect(response.status).toBe(200);
      expect(response.headers.get('x-unified-mpc-build')).toBe(buildProvenance.buildShortCommit);
      await expect(response.json()).resolves.toMatchObject({
        product: 'Unified-MPC-Server',
        service: 'desktop-mcp',
        protocol: 1,
        version: '4.61.0',
        ...buildProvenance,
      });
    } finally {
      await provenanceHandle.close();
    }
  });

  it('keeps loopback identity reachable when public allowlists are provided dynamically', async () => {
    const publicHandle = await startMcpHttp({
      port: 0,
      services: {},
      actor: { clientId: 'loopback-health-test', clientName: 'loopback-health-test' },
      allowedHostnamesProvider: () => ['mcp.example.com'],
      allowedOriginsProvider: () => ['https://mcp.example.com'],
    });
    try {
      const identity = await fetch(new URL('/_unified-mpc/identity', publicHandle.endpoint));
      expect(identity.status).toBe(200);
    } finally {
      await publicHandle.close();
    }
  });

  it('fails closed instead of silently rebinding when a requested fixed port is occupied', async () => {
    const first = await startMcpHttp({
      port: 0,
      services: {},
      actor: { clientId: 'fixed-port-owner', clientName: 'fixed-port-owner' },
    });
    try {
      const attempt = await startMcpHttp({
        port: first.address.port,
        services: {},
        actor: { clientId: 'fixed-port-contender', clientName: 'fixed-port-contender' },
      }).then(async (second) => {
        await second.close();
        return 'rebound' as const;
      }).catch(() => 'rejected' as const);

      expect(attempt).toBe('rejected');
    } finally {
      await first.close();
    }
  });

  it('rejects bodies over the configured limit', async () => {
    const response = await fetch(handle.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: 'http://localhost' },
      body: JSON.stringify({ payload: 'x'.repeat(MAX_MCP_HTTP_BODY_BYTES) }),
    });

    expect(response.status).toBe(413);
  });

  it('lets the SDK reject malformed and header/body-mismatched modern requests', async () => {
    const malformed = await fetch(handle.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'MCP-Protocol-Version': '2026-07-28',
        Origin: 'http://localhost',
      },
      body: '{not-json',
    });
    const mismatch = await fetch(handle.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'MCP-Protocol-Version': '2025-11-25',
        Origin: 'http://localhost',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'server/discover',
        params: {
          _meta: {
            [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
            [CLIENT_INFO_META_KEY]: { name: 'security-test', version: '0.1.0' },
            [CLIENT_CAPABILITIES_META_KEY]: {},
          },
        },
      }),
    });

    expect(malformed.status).toBeGreaterThanOrEqual(400);
    expect(mismatch.status).toBeGreaterThanOrEqual(400);
  });
});
