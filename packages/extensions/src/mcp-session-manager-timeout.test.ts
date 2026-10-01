import { describe, expect, it } from 'vitest';
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

  it('retains default drop-on-timeout outside the opt-in index session', async () => {
    const { factory, counts } = mockFactory();
    const manager = new McpSessionManager({ clientFactory: factory, callTimeoutMs: 30, validateToolSchemas: false });
    await expect(manager.call('native', { command: '/mock/index-provider' }, 'index_status', {}))
      .resolves.toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    expect(manager.isConnected('native')).toBe(false);
    expect(counts).toEqual({ connects: 1, calls: 1, closes: 1 });
    await manager.close();
  });
});
