import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { PrivateFdStdioClientTransport } from './private-fd-stdio-transport.js';

const fixture = fileURLToPath(new URL('../tests/fixtures/private-fd-mcp-server.mjs', import.meta.url));
const privateSecret = Buffer.from(JSON.stringify({
  secret_b64url: Buffer.alloc(32, 37).toString('base64url'),
  owner_id: 'unified-worker-1',
  authority_generation: 11,
  workspace_roots: { '14fc20d1-5836-4faf-aed6-0df6a9633a38': '/tmp/registered' },
}), 'utf8');

function options(bootstrap: Buffer) {
  return { command: process.execPath, args: [fixture], bootstrap };
}

describe('PrivateFdStdioClientTransport real child process', () => {
  it('passes private JSON on fd3 and connects a real SDK MCP Client over stdin/stdout', async () => {
    const bootstrap = Buffer.from(privateSecret);
    const transport = new PrivateFdStdioClientTransport(options(bootstrap));
    const client = new Client({ name: 'private-fd-test', version: '1.0.0' }, { capabilities: {} });
    try {
      await client.connect(transport);
      expect(transport.pid).toBeGreaterThan(0);
      const catalog = await client.listTools();
      expect(catalog.tools.map((tool) => tool.name)).toContain('bootstrap_probe');
      const reply = await client.callTool({ name: 'bootstrap_probe', arguments: {} });
      const data = JSON.parse((reply.content as { text: string }[])[0]!.text) as Record<string, unknown>;
      expect(data).toMatchObject({
        ready: true, fd: 3, strict: true, workspaceCount: 1, leaked: false,
      });
      expect(bootstrap.every((byte) => byte === 0)).toBe(true);
    } finally {
      await client.close();
    }
    expect(transport.pid).toBeNull();
  }, 20_000);

  it('rejects empty, oversized, and non-buffer private bootstrap before launch', async () => {
    for (const bad of [Buffer.alloc(0), Buffer.alloc(128 * 1024 + 1)]) {
      const transport = new PrivateFdStdioClientTransport(options(bad));
      await expect(transport.start()).rejects.toThrow('private_fd_bootstrap_denied');
      expect(transport.pid).toBeNull();
    }
    const untyped = { ...options(Buffer.from(privateSecret)), bootstrap: 'key-not-buffer' };
    const transport = new PrivateFdStdioClientTransport(untyped as never);
    await expect(transport.start()).rejects.toThrow('private_fd_bootstrap_denied');
    expect(transport.pid).toBeNull();
  });

  it('denies a second start, and close is safe and idempotent', async () => {
    const transport = new PrivateFdStdioClientTransport(options(Buffer.from(privateSecret)));
    try {
      await transport.start();
      expect(transport.pid).toBeGreaterThan(0);
      await expect(transport.start()).rejects.toThrow('private_fd_bootstrap_denied');
    } finally {
      await transport.close();
      await transport.close();
    }
    expect(transport.pid).toBeNull();
    await expect(transport.start()).rejects.toThrow('private_fd_bootstrap_denied');
  }, 10_000);

  it('handles a missing executable without leaving a live child or private key material', async () => {
    const bootstrap = Buffer.from(privateSecret);
    const transport = new PrivateFdStdioClientTransport({
      ...options(bootstrap), command: '/definitely-missing-private-fd-executable',
    });
    await expect(transport.start()).rejects.toThrow();
    expect(bootstrap.every((byte) => byte === 0)).toBe(true);
    expect(transport.pid).toBeNull();
    await transport.close();
  });

  it('bounded-close kills a child that ignores stdin EOF', async () => {
    const bootstrap = Buffer.from(privateSecret);
    const transport = new PrivateFdStdioClientTransport({
      command: process.execPath,
      args: ['-e', 'process.stdin.resume();setInterval(()=>{},1000)'],
      bootstrap,
    });
    await transport.start();
    const start = Date.now();
    await transport.close();
    expect(Date.now() - start).toBeLessThan(6_000);
    expect(transport.pid).toBeNull();
  }, 10_000);

  it('fails closed when Linux fd3 support is not available', async () => {
    const transport = new PrivateFdStdioClientTransport({
      ...options(Buffer.from(privateSecret)), platform: 'win32',
    });
    await expect(transport.start()).rejects.toThrow('private_fd_bootstrap_denied');
    expect(transport.pid).toBeNull();
  });
});
