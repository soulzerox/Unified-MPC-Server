import { describe, expect, it } from 'vitest';
import { runWeb, parseWebArgs } from './web.js';

describe('web CLI command', () => {
  describe('parseWebArgs', () => {
    it('parses empty args with default host and port', () => {
      const parsed = parseWebArgs([]);
      expect(parsed).toEqual({
        ok: true,
        value: {
          kind: 'web',
          host: '127.0.0.1',
          port: 18765,
        },
      });
    });

    it('parses custom host and port', () => {
      const parsed = parseWebArgs(['--port', '19000', '--host', '127.0.0.1']);
      expect(parsed).toEqual({
        ok: true,
        value: {
          kind: 'web',
          host: '127.0.0.1',
          port: 19000,
        },
      });
    });
  });

  describe('runWeb', () => {
    it('starts control plane server and returns handle with bound url', async () => {
      const result = await runWeb({ host: '127.0.0.1', port: 0 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.url).toContain('http://127.0.0.1:');
        await result.value.handle.close();
      }
    });
  });
});

