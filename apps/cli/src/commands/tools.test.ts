import { describe, expect, it } from 'vitest';
import { ok, type Result } from '@unified-mpc/domain';
import { runToolsList, runToolsCall, parseToolsArgs } from './tools.js';

describe('tools CLI commands', () => {
  describe('parseToolsArgs', () => {
    it('parses tools list', () => {
      const parsed = parseToolsArgs(['list']);
      expect(parsed).toEqual({
        ok: true,
        value: { kind: 'tools-list' },
      });
    });

    it('parses tools call with json args', () => {
      const parsed = parseToolsArgs(['call', 'echo', '{"message":"hello"}']);
      expect(parsed).toEqual({
        ok: true,
        value: {
          kind: 'tools-call',
          toolName: 'echo',
          args: { message: 'hello' },
        },
      });
    });

    it('parses tools call without args as empty object', () => {
      const parsed = parseToolsArgs(['call', 'ping']);
      expect(parsed).toEqual({
        ok: true,
        value: {
          kind: 'tools-call',
          toolName: 'ping',
          args: {},
        },
      });
    });

    it('returns error on missing subcommand', () => {
      const parsed = parseToolsArgs([]);
      expect(parsed.ok).toBe(false);
    });

    it('returns error on missing tool name for call', () => {
      const parsed = parseToolsArgs(['call']);
      expect(parsed.ok).toBe(false);
    });

    it('returns error on invalid json arguments', () => {
      const parsed = parseToolsArgs(['call', 'echo', '{invalid json']);
      expect(parsed.ok).toBe(false);
    });
  });

  describe('runToolsList', () => {
    it('returns tools from registry or service', async () => {
      const fakeTools = [
        { name: 'read_file', description: 'Read file contents' },
        { name: 'write_file', description: 'Write file contents' },
      ];
      const service = {
        list: (): Array<{ name: string; description: string }> => fakeTools,
      };

      const result = await runToolsList(service);
      expect(result).toEqual(fakeTools);
    });
  });

  describe('runToolsCall', () => {
    it('invokes tool via execute method', async () => {
      let executedTool = '';
      let executedArgs: Record<string, unknown> | undefined;
      const service = {
        execute: async (name: string, input: unknown): Promise<Result<{ result: string }, unknown>> => {
          executedTool = name;
          executedArgs = input as Record<string, unknown>;
          return ok({ result: 'success' });
        },
      };

      const result = await runToolsCall(service, 'echo', { message: 'hello' });
      expect(result.ok).toBe(true);
      expect(executedTool).toBe('echo');
      expect(executedArgs).toEqual({ message: 'hello' });
    });
  });
});

