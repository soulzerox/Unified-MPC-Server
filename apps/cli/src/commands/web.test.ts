import { describe, expect, it } from 'vitest';
import { runWeb, parseWebArgs } from './web.js';

describe('web CLI command', () => {
  describe('parseWebArgs', () => {
    it('parses empty args with loopback web port', () => {
      const parsed = parseWebArgs([]);
      expect(parsed).toEqual({
        ok: true,
        value: {
          kind: 'web',
          port: 3000,
        },
      });
    });

    it('parses custom port and rejects custom host', () => {
      const parsed = parseWebArgs(['--port', '19000']);
      expect(parsed).toEqual({
        ok: true,
        value: {
          kind: 'web',
          port: 19000,
        },
      });
      expect(parseWebArgs(['--host', '0.0.0.0'])).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });
  });

  describe('runWeb', () => {
    it('starts control plane server and returns handle with bound url', async () => {
      const result = await runWeb({ port: 0 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.url).toContain('http://127.0.0.1:');
        await result.value.handle.close();
      }
    });
  });
});

