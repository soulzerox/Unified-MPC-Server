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

describe('McpSessionManager lane drop', () => {
  function session(): McpClientSession {
    return {
      listTools: async () => [{ name: 'ping', description: 'Ping tool' }],
      listResources: async () => [],
      callTool: async () => ({}),
      close: async () => undefined,
    };
  }

  it('ends a pinned entry, and the next ensure connects instead of reusing', async () => {
    let connects = 0;
    const manager = new McpSessionManager({
      clientFactory: {
        connect: async (): Promise<McpClientSession> => {
          connects += 1;
          return session();
        },
      },
    });
    await manager.describe('mock', MOCK_CONFIG);
    manager.pin('mock');
    expect(manager.isPinned('mock')).toBe(true);

    expect(await manager.dropServer('mock')).toBe(true);
    expect(manager.isConnected('mock')).toBe(false);
    // The pin is the caller's policy, not the entry's: a drop is transport-level
    // and the provider unpins first when pressure decided against the lane.
    expect(manager.isPinned('mock')).toBe(true);

    await manager.describe('mock', MOCK_CONFIG);
    expect(connects).toBe(2);
  });

  it('is a no-op for an unknown name', async () => {
    const manager = new McpSessionManager({ clientFactory: { connect: async (): Promise<McpClientSession> => session() } });
    expect(await manager.dropServer('nobody')).toBe(false);
  });

  it('settles a drop while a connect is pending, so the connect cannot take the lane after it', async () => {
    let connects = 0;
    const manager = new McpSessionManager({
      clientFactory: {
        connect: async (_config, signal): Promise<McpClientSession> => {
          connects += 1;
          if (connects > 1) return session();
          return new Promise<McpClientSession>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('connect aborted')), { once: true });
          });
        },
      },
    });

    const connecting = manager.describe('mock', MOCK_CONFIG);
    // The connect is in `pendingConnections`, not in `sessions`, yet it holds the
    // capability lease already; the drop must end it rather than return early.
    expect(await manager.dropServer('mock')).toBe(true);
    expect((await connecting).ok).toBe(false);
    expect(manager.isConnected('mock')).toBe(false);

    expect((await manager.describe('mock', MOCK_CONFIG)).ok).toBe(true);
    expect(connects).toBe(2);
  });
});
