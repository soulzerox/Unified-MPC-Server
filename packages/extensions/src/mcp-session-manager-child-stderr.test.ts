import { describe, expect, it } from 'vitest';
import { McpSessionManager } from './mcp-session-manager.js';

const DYING_SERVER = new URL('../tests/fixtures/dying-mcp-server.mjs', import.meta.url);

describe('child MCP failure diagnostics', () => {
  it('surfaces the child stderr tail when a worker dies before handshaking', async () => {
    const manager = new McpSessionManager();
    try {
      const described = await manager.describe('dying', {
        command: process.execPath,
        args: [DYING_SERVER.pathname],
      });
      expect(described.ok).toBe(false);
      if (described.ok) throw new Error('unexpected');
      expect(described.error.message).toContain('native worker exploded');
    } finally {
      await manager.close();
    }
  });
});
