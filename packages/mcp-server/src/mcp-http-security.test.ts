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
