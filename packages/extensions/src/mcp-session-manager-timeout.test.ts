import { describe, expect, it } from 'vitest';
import { MAX_TIMER_DELAY_MS } from '@unified-mpc/domain';
import { McpSessionManager, type McpClientFactory, type McpClientSession } from './mcp-session-manager.js';

function mockFactory(): { factory: McpClientFactory; counts: { connects: number; calls: number; closes: number } } {
  const counts = { connects: 0, calls: 0, closes: 0 };
  const factory: McpClientFactory = {
    async connect(): Promise<McpClientSession> {
      counts.connects += 1;
      return {
        listTools: async () => [{ name: 'index_status', description: 'Read-only status' }],
        listResources: async () => [],
        callTool: async (_name, _args, signal): Promise<unknown> => {
          counts.calls += 1;
          if (counts.calls === 1) {
            await new Promise<never>((_resolve, reject) => {
              signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
            });
          }
          return { content: [] };
        },
        close: async (): Promise<void> => { counts.closes += 1; },
      };
    },
  };
  return { factory, counts };
}

describe('dedicated native index status timeout recovery', () => {
  it('reuses the original provider when explicitly opted in', async () => {
    const { factory, counts } = mockFactory();
    const manager = new McpSessionManager({
      clientFactory: factory,
      callTimeoutMs: 30,
      validateToolSchemas: false,
      preserveReadOnlyStatusSessionOnTimeout: true,
    });
    const config = { command: '/mock/index-provider' };
    await expect(manager.call('native', config, 'index_status', { job_id: 'same-job' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    expect(manager.isConnected('native')).toBe(true);
    await expect(manager.call('native', config, 'index_status', { job_id: 'same-job' }))
      .resolves.toMatchObject({ ok: true });
    expect(counts).toEqual({ connects: 1, calls: 2, closes: 0 });
    await manager.close();
    expect(counts.closes).toBe(1);
  });

  it('honors a per-call timeout without dropping the opted-in status session', async () => {
    const { factory, counts } = mockFactory();
    const manager = new McpSessionManager({
      clientFactory: factory,
      callTimeoutMs: 1_000,
      validateToolSchemas: false,
      preserveReadOnlyStatusSessionOnTimeout: true,
    });
    const config = { command: '/mock/index-provider' };
    await expect(manager.call('native', config, 'index_status', { job_id: 'probe' }, undefined, {}, undefined, 20))
      .resolves.toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    expect(manager.isConnected('native')).toBe(true);
    await expect(manager.call('native', config, 'index_status', { job_id: 'probe' }))
      .resolves.toMatchObject({ ok: true });
    expect(counts).toEqual({ connects: 1, calls: 2, closes: 0 });
    await manager.close();
  });

  it('bounds the catalog refresh by the per-call timeout instead of the session budget', async () => {
    let listToolsCalls = 0;
    let toolCalls = 0;
    const factory: McpClientFactory = {
      async connect(): Promise<McpClientSession> {
        return {
          listTools: async (signal?: AbortSignal): Promise<readonly { name: string; description: string }[]> => {
            listToolsCalls += 1;
            // Call 1 primes the connection and call 2 the warm catalog; the
            // third refresh is the hung worker under test.
            if (listToolsCalls === 3) {
              await new Promise<never>((_resolve, reject) => {
                signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
              });
            }
            return [{ name: 'index_status', description: 'Read-only status' }];
          },
          listResources: async () => [],
          callTool: async (): Promise<unknown> => {
            toolCalls += 1;
            return { content: [] };
          },
          close: async (): Promise<void> => undefined,
        };
      },
    };
    const manager = new McpSessionManager({
      clientFactory: factory,
      callTimeoutMs: 1_000,
      validateToolSchemas: false,
      preserveReadOnlyStatusSessionOnTimeout: true,
    });
    const config = { command: '/mock/index-provider' };
    // Prime the session so the hung catalog refresh is the per-call path, not
    // connection setup (which has its own session-level budget).
    await expect(manager.call('native', config, 'index_status', { job_id: 'warm' }))
      .resolves.toMatchObject({ ok: true });
    const startedAt = Date.now();
    const timedOut = await manager.call('native', config, 'index_status', { job_id: 'hung' }, undefined, {}, undefined, 25);
    // The session budget is 1s; only the per-call deadline may release the
    // call, otherwise a stopped worker holds the read gate for that whole time.
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(timedOut).toMatchObject({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: expect.stringContaining('Timed out refreshing tool catalog') },
    });
    expect(manager.isConnected('native')).toBe(true);
    // The unblocked queue lets the next status poll refresh and answer.
    await expect(manager.call('native', config, 'index_status', { job_id: 'hung' }))
      .resolves.toMatchObject({ ok: true });
    expect(toolCalls).toBe(2);
    await manager.close();
  });

  it('retains default drop-on-timeout outside the opt-in index session', async () => {
    const { factory, counts } = mockFactory();
    const manager = new McpSessionManager({ clientFactory: factory, callTimeoutMs: 30, validateToolSchemas: false });
    await expect(manager.call('native', { command: '/mock/index-provider' }, 'index_status', {}))
      .resolves.toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    expect(manager.isConnected('native')).toBe(false);
    expect(counts).toEqual({ connects: 1, calls: 1, closes: 1 });
    await manager.close();
  });

  it('bounds a deadline past the Node timer range instead of aborting at once', async () => {
    let calls = 0;
    const childTimeouts: Array<number | undefined> = [];
    const factory: McpClientFactory = {
      async connect(): Promise<McpClientSession> {
        return {
          listTools: async () => [{ name: 'index_status', description: 'Read-only status' }],
          listResources: async () => [],
          callTool: async (_name, _args, _signal, timeoutMs): Promise<unknown> => {
            calls += 1;
            childTimeouts.push(timeoutMs);
            await new Promise((resolve) => setTimeout(resolve, 50));
            return { content: [] };
          },
          close: async (): Promise<void> => {},
        };
      },
    };
    // One millisecond past 2^31-1. A Node timer clamps such a delay to 1 ms and
    // warns, so without the bound the call would abort before the child answered:
    // a host asking for a longer deadline would get the shortest one. The child
    // arms its own timer with the same number, so it has to receive the bounded
    // value too, not the configured one.
    const manager = new McpSessionManager({
      clientFactory: factory,
      callTimeoutMs: 2_147_483_648,
      validateToolSchemas: false,
    });
    await expect(manager.call('native', { command: '/mock/index-provider' }, 'index_status', {}))
      .resolves.toMatchObject({ ok: true });
    expect(calls).toBe(1);
    expect(childTimeouts).toEqual([MAX_TIMER_DELAY_MS]);
    await manager.close();
  });

  it('keeps the connection deadline representable outside the call path', async () => {
    // `call()` bounds its own deadline, but connect, the initial tool listing and
    // `listResources` go through the timer's own clamp. Without it a host asking
    // for a longer connection deadline would abort the handshake at ~1 ms.
    let listToolsCalls = 0;
    const factory: McpClientFactory = {
      async connect(): Promise<McpClientSession> {
        return {
          listTools: async (): Promise<readonly { name: string; description: string }[]> => {
            listToolsCalls += 1;
            await new Promise((resolve) => setTimeout(resolve, 50));
            return [{ name: 'index_status', description: 'Read-only status' }];
          },
          listResources: async () => [{ uri: 'mock://resource', name: 'mock' }],
          callTool: async (): Promise<unknown> => ({ content: [] }),
          close: async (): Promise<void> => {},
        };
      },
    };
    const manager = new McpSessionManager({
      clientFactory: factory,
      callTimeoutMs: 2_147_483_648,
      validateToolSchemas: false,
    });
    await expect(manager.listResources('native', { command: '/mock/index-provider' }))
      .resolves.toMatchObject({ ok: true, value: { connected: true } });
    expect(listToolsCalls).toBe(1);
    await manager.close();
  });
});
