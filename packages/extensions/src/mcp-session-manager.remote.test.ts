import { beforeEach, describe, expect, it, vi } from 'vitest';

const transportState = vi.hoisted(() => ({
  connected: [] as string[],
  httpUrls: [] as string[],
  sseUrls: [] as string[],
  requestOptions: [] as Array<Record<string, unknown>>,
}));

vi.mock('@modelcontextprotocol/client', () => {
  class StreamableHTTPClientTransport {
    constructor(url: URL) {
      transportState.httpUrls.push(url.href);
      transportState.connected.push('http');
    }
  }
  class SSEClientTransport {
    constructor(url: URL) {
      transportState.sseUrls.push(url.href);
      transportState.connected.push('sse');
    }
  }
  class Client {
    async connect(): Promise<void> {}
    async close(): Promise<void> {}
    async listTools(): Promise<{ tools: Array<{ name: string; description: string }> }> { return { tools: [{ name: 'slow', description: 'Slow tool' }] }; }
    async listResources(): Promise<{ resources: never[] }> { return { resources: [] }; }
    async callTool(_request: unknown, options?: Record<string, unknown>): Promise<unknown> { transportState.requestOptions.push(options ?? {}); return { content: [{ type: 'text', text: 'ok' }] }; }
  }
  return { Client, StreamableHTTPClientTransport, SSEClientTransport };
});

vi.mock('@modelcontextprotocol/client/stdio', () => ({
  StdioClientTransport: class StdioClientTransport {
    stderr = undefined;
    constructor() {
      transportState.connected.push('stdio');
    }
  },
}));

import { defaultMcpClientFactory, McpSessionManager } from './mcp-session-manager.js';
import type { McpServerLaunchConfig } from './types.js';

describe('defaultMcpClientFactory remote transports', () => {
  beforeEach(() => {
    transportState.connected.length = 0;
    transportState.httpUrls.length = 0;
    transportState.sseUrls.length = 0;
    transportState.requestOptions.length = 0;
  });

  it('passes the configured manager timeout to the MCP SDK request', async () => {
    const manager = new McpSessionManager({ clientFactory: defaultMcpClientFactory, callTimeoutMs: 180_000 });

    await expect(manager.call('remote', {
      type: 'http',
      url: 'https://mcp.example.com/rpc',
    } as McpServerLaunchConfig, 'slow', {})).resolves.toMatchObject({ ok: true });
    expect(transportState.requestOptions[0]).toMatchObject({ timeout: 180_000 });

    await manager.close();
  });

  it('uses Streamable HTTP for type=http URL configs', async () => {
    const session = await defaultMcpClientFactory.connect({
      type: 'http',
      url: 'https://mcp.example.com/rpc',
    } as McpServerLaunchConfig);

    expect(transportState.connected).toEqual(['http']);
    expect(transportState.httpUrls).toEqual(['https://mcp.example.com/rpc']);
    await session.close();
  });

  it('uses SSE for type=sse URL configs', async () => {
    const session = await defaultMcpClientFactory.connect({
      type: 'sse',
      url: 'https://mcp.example.com/events',
    } as McpServerLaunchConfig);

    expect(transportState.connected).toEqual(['sse']);
    expect(transportState.sseUrls).toEqual(['https://mcp.example.com/events']);
    await session.close();
  });
});
