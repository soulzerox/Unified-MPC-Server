import { describe, expect, it } from 'vitest';
import { parseCliArgs } from './index.js';

/**
 * Unknown and incomplete options used to be ignored, so `web --no-open` ran on
 * the default port and exited 0 while SPEC §6 and docs/CLI_REFERENCE.md promise
 * exit code 2 for an unknown flag. These cases pin the rejection.
 */
describe('CLI option validation', () => {
  const rejected: ReadonlyArray<readonly [label: string, args: readonly string[], expected: string]> = [
    ['unknown web flag', ['web', '--no-open'], 'Unknown option: --no-open'],
    ['web port without a value', ['web', '--port'], 'Missing value for option: --port'],
    ['misspelled sync flag', ['sync', '--targest', 'cursor'], 'Unknown option: --targest'],
    ['sync targets without a value', ['sync', '--targets'], 'Missing value for option: --targets'],
    ['unknown install server flag', ['install', 'server', 'sqlite', '--command', 'uvx', '--no-open'], 'Unknown option: --no-open'],
    ['install server command without a value', ['install', 'server', 'sqlite', '--command'], 'Missing value for option: --command'],
    ['install skill without a source', ['install', 'skill', 'my-skill', '--targets', 'all'], 'Skill source must not start with \'-\': "--targets"'],
    ['unknown install skill flag', ['install', 'skill', 'my-skill', '/path/to/skill', '--bogus'], 'Unknown option: --bogus'],
    ['unknown prune server flag', ['prune', 'server', 'sqlite', '--no-kill', '--bogus'], 'Unknown option: --bogus'],
    ['prune scope without a value', ['prune', 'skill', 'my-skill', '--scope'], 'Missing value for option: --scope'],
    ['extra tools list argument', ['tools', 'list', 'extra'], 'Unexpected argument: extra'],
    ['extra tools call argument', ['tools', 'call', 'echo', '{}', 'extra'], 'Unexpected argument: extra'],
    ['unknown flag on a fixed-shape command', ['status', '--json'], 'Unknown option: --json'],
    ['unknown flag on doctor', ['doctor', '--json'], 'Unknown option: --json'],
    ['extra argument after codex doctor', ['codex', 'doctor', 'extra'], 'Unexpected argument: extra'],
  ];

  for (const [label, args, expected] of rejected) {
    it(`rejects ${label}`, () => {
      const parsed = parseCliArgs(args);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.error.code).toBe('INVALID_INPUT');
      expect(parsed.error.message).toContain(expected);
    });
  }

  it('still accepts the documented option forms', () => {
    expect(parseCliArgs(['web', '--port', '3000'])).toMatchObject({ ok: true, value: { kind: 'web', port: 3000 } });
    expect(parseCliArgs(['sync', '--targets', 'cursor,cline'])).toMatchObject({
      ok: true,
      value: { kind: 'sync', targets: ['cursor', 'cline'] },
    });
    expect(parseCliArgs(['prune', 'server', 'sqlite', '--no-kill'])).toMatchObject({
      ok: true,
      value: { kind: 'prune-server', name: 'sqlite', killProcess: false },
    });
    expect(parseCliArgs(['tools', 'call', 'echo', '{"message":"hello"}'])).toMatchObject({
      ok: true,
      value: { kind: 'tools-call', toolName: 'echo', args: { message: 'hello' } },
    });
  });
});
