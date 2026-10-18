import { describe, expect, it } from 'vitest';
import { McpSessionManager, type McpClientSession } from './mcp-session-manager.js';

const MOCK_CONFIG = { command: 'node', args: ['mock.js'] };
const STALL_CEILING_MS = 50;
const RACE_BUDGET_MS = 400;

function neverSettles<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

function wedgedSession(): McpClientSession {
  return {
    listTools: async () => [{ name: 'ping', description: 'Ping tool' }],
    listResources: async () => [],
    callTool: async () => ({}),
    close: () => neverSettles<void>(),
  };
}

async function raceAgainstStall(promise: Promise<unknown>): Promise<'settled' | 'stalled'> {
  return Promise.race([
    promise.then(() => 'settled' as const),
    new Promise<'stalled'>((resolve) => {
      setTimeout(() => resolve('stalled'), RACE_BUDGET_MS);
    }),
  ]);
}

describe('McpSessionManager wedged-child teardown', () => {
  it('dropServer() drains while a wedged child session close never settles', async () => {
    const manager = new McpSessionManager({
      clientFactory: { connect: async (): Promise<McpClientSession> => wedgedSession() },
      closeTimeoutMs: STALL_CEILING_MS,
    });
    const described = await manager.describe('mock', MOCK_CONFIG);
    expect(described.ok).toBe(true);
    expect(manager.isConnected('mock')).toBe(true);

    await expect(raceAgainstStall(manager.dropServer('mock'))).resolves.toBe('settled');
    expect(manager.isConnected('mock')).toBe(false);
  });

  it('close() drains while a wedged child session close never settles', async () => {
    const manager = new McpSessionManager({
      clientFactory: { connect: async (): Promise<McpClientSession> => wedgedSession() },
      closeTimeoutMs: STALL_CEILING_MS,
    });
    const described = await manager.describe('mock', MOCK_CONFIG);
    expect(described.ok).toBe(true);

    await expect(raceAgainstStall(manager.close())).resolves.toBe('settled');
  });

  it('dropServer() still resolves via the session close itself without waiting out the ceiling', async () => {
    let closes = 0;
    const session: McpClientSession = {
      listTools: async () => [{ name: 'ping', description: 'Ping tool' }],
      listResources: async () => [],
      callTool: async () => ({}),
      close: async () => {
        closes += 1;
      },
    };
    const manager = new McpSessionManager({
      clientFactory: { connect: async (): Promise<McpClientSession> => session },
      closeTimeoutMs: 60_000,
    });
    await manager.describe('mock', MOCK_CONFIG);

    await expect(raceAgainstStall(manager.dropServer('mock'))).resolves.toBe('settled');
    expect(closes).toBe(1);
    expect(manager.isConnected('mock')).toBe(false);
  });
});
