import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultMcpClientFactory, McpSessionManager, type McpClientSession } from './mcp-session-manager.js';

const fixturePath = fileURLToPath(new URL('../tests/fixtures/external-mcp-server.mjs', import.meta.url));

afterEach(() => {
  delete process.env.UNIFIED_MPC_EXTERNAL_MCP_FIXTURE_ERA;
  delete process.env.UNIFIED_MPC_EXTERNAL_MCP_SECRET;
});

async function connectFixture(era: 'legacy' | 'modern'): ReturnType<typeof defaultMcpClientFactory.connect> {
  return defaultMcpClientFactory.connect({
    command: process.execPath,
    args: [fixturePath],
    env: { UNIFIED_MPC_EXTERNAL_MCP_FIXTURE_ERA: era },
  });
}

describe('McpSessionManager lifecycle reconciliation', () => {
  it('does not resurrect a pending child connection after the server is removed', async () => {
    let releaseConnect!: (session: McpClientSession) => void;
    let connectStarted!: () => void;
    const started = new Promise<void>((resolve) => { connectStarted = resolve; });
    const pendingSession = new Promise<McpClientSession>((resolve) => { releaseConnect = resolve; });
    let closes = 0;
    const session: McpClientSession = {
      listTools: async () => [{ name: 'ping', description: 'Ping tool' }],
      listResources: async () => [],
      callTool: async () => ({ content: [] }),
      close: async () => { closes += 1; },
    };
    const manager = new McpSessionManager({
      clientFactory: {
        connect: async (): Promise<McpClientSession> => {
          connectStarted();
          return pendingSession;
        },
      },
      callTimeoutMs: 5_000,
    });

    const describe = manager.describe('mock', { command: 'node', args: ['mock.js'] });
    await started;
    const reconciliation = manager.reconcile([]);
    releaseConnect(session);

    await reconciliation;
    const result = await describe;
    expect(result.ok).toBe(false);
    expect(manager.isConnected('mock')).toBe(false);
    await expect.poll(() => closes).toBe(1);
    await manager.close();
    expect(closes).toBe(1);
  });
});

describe('default External MCP client protocol negotiation', () => {
  it('connects to a legacy 2025-era stdio MCP server and lists its tools', async () => {
    const session = await connectFixture('legacy');
    try {
      await expect(session.listTools()).resolves.toEqual([
        expect.objectContaining({ name: 'legacy_ping', description: 'legacy external MCP fixture' }),
      ]);
    } finally {
      await session.close();
    }
  }, 20_000);

  it('connects to a modern 2026-07-28 stdio MCP server and lists its tools', async () => {
    const session = await connectFixture('modern');
    try {
      await expect(session.listTools()).resolves.toEqual([
        expect.objectContaining({ name: 'modern_ping' }),
      ]);
    } finally {
      await session.close();
    }
  }, 20_000);

  it('does not inherit host secrets into external MCP children', async () => {
    process.env.UNIFIED_MPC_EXTERNAL_MCP_SECRET = 'not-for-child';
    const session = await connectFixture('legacy');
    try {
      await expect(session.listTools()).resolves.toEqual([
        expect.objectContaining({ name: 'legacy_ping', description: 'legacy external MCP fixture' }),
      ]);
    } finally {
      await session.close();
    }
  }, 20_000);
});
