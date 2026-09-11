import { describe, expect, it } from 'vitest';
import { ok, err } from '@unified-mpc/domain';
import { parseCliArgs, runCli, type CliDependencies } from './index.js';

describe('CLI argument parser', () => {
  it('parses workspace, MCP, doctor, and Codex doctor commands', () => {
    expect(parseCliArgs(['workspace', 'add', '/home/qwerty/project'])).toEqual({
      ok: true,
      value: { kind: 'workspace-add', rootPath: '/home/qwerty/project' },
    });
    expect(parseCliArgs(['mcp', '--http', '--workspace', 'workspace-1'])).toEqual({
      ok: true,
      value: { kind: 'mcp-http', workspaceReference: 'workspace-1' },
    });
    expect(parseCliArgs(['doctor'])).toEqual({ ok: true, value: { kind: 'doctor' } });
    expect(parseCliArgs(['codex', 'doctor'])).toEqual({ ok: true, value: { kind: 'codex-doctor' } });
  });

  it('parses bifurcated install commands', () => {
    expect(parseCliArgs(['install', 'skill', 'my-skill', '/path/to/skill'])).toEqual({
      ok: true,
      value: {
        kind: 'install-skill',
        name: 'my-skill',
        source: '/path/to/skill',
        targets: ['all'],
        scope: 'global',
      },
    });

    expect(parseCliArgs(['install', 'server', 'sqlite', '--command', 'uvx', '--args', 'mcp-server-sqlite'])).toEqual({
      ok: true,
      value: {
        kind: 'install-server',
        name: 'sqlite',
        transport: 'stdio',
        command: 'uvx',
        args: ['mcp-server-sqlite'],
        targets: ['all'],
        scope: 'global',
      },
    });
  });

  it('parses bifurcated prune commands', () => {
    expect(parseCliArgs(['prune', 'skill', 'my-skill'])).toEqual({
      ok: true,
      value: {
        kind: 'prune-skill',
        name: 'my-skill',
        targets: ['all'],
      },
    });

    expect(parseCliArgs(['prune', 'server', 'sqlite', '--targets', 'cline'])).toEqual({
      ok: true,
      value: {
        kind: 'prune-server',
        name: 'sqlite',
        targets: ['cline'],
        killProcess: true,
      },
    });
  });

  it('parses sync command', () => {
    expect(parseCliArgs(['sync', '--targets', 'antigravity,cursor'])).toEqual({
      ok: true,
      value: {
        kind: 'sync',
        targets: ['antigravity', 'cursor'],
      },
    });
  });

  it('parses web command', () => {
    expect(parseCliArgs(['web', '--port', '18765'])).toEqual({
      ok: true,
      value: {
        kind: 'web',
        host: '127.0.0.1',
        port: 18765,
      },
    });
  });

  it('parses tools list and call commands', () => {
    expect(parseCliArgs(['tools', 'list'])).toEqual({
      ok: true,
      value: { kind: 'tools-list' },
    });

    expect(parseCliArgs(['tools', 'call', 'echo', '{"text":"hello"}'])).toEqual({
      ok: true,
      value: {
        kind: 'tools-call',
        toolName: 'echo',
        args: { text: 'hello' },
      },
    });
  });

  it('rejects ambiguous MCP transport flags', () => {
    const parsed = parseCliArgs(['mcp', '--stdio', '--http']);
    expect(parsed.ok).toBe(false);
  });
});

describe('CLI execution dispatcher', () => {
  const baseDependencies: CliDependencies = {
    status: async () => ({ workspaceCount: 1 }),
    workspaceAdd: async () => err({ code: 'INTERNAL_ERROR', message: 'unused', recoverable: true }),
    workspaceList: async () => [],
    mcpStdio: async () => err({ code: 'INTERNAL_ERROR', message: 'unused', recoverable: true }),
    mcpHttp: async () => err({ code: 'INTERNAL_ERROR', message: 'unused', recoverable: true }),
    doctor: async () => ({ checks: [], exitCode: 0 }),
    codexDoctor: async () => ok({ status: { installed: true, binaryPath: '/usr/local/bin/codex', version: '1.0.0' } }),
  };

  it('executes install skill command', async () => {
    const output: string[] = [];
    const deps: CliDependencies = {
      ...baseDependencies,
      installSkill: async (input) => ok({
        name: input.name,
        installedPaths: ['/home/user/.gemini/antigravity/skills/my-skill/SKILL.md'],
        targets: input.targets,
      }),
      write: (text) => output.push(text),
    };

    const code = await runCli(['install', 'skill', 'my-skill', '/path/to/skill'], deps);
    expect(code).toBe(0);
    expect(output[0]).toContain('Installed skill "my-skill"');
  });

  it('executes install server command', async () => {
    const output: string[] = [];
    const deps: CliDependencies = {
      ...baseDependencies,
      installServer: async (input) => ok({
        name: input.name,
        targets: input.targets,
        updatedConfigFiles: ['/home/user/.cline/cline_mcp_settings.json'],
      }),
      write: (text) => output.push(text),
    };

    const code = await runCli(['install', 'server', 'sqlite', '--command', 'uvx'], deps);
    expect(code).toBe(0);
    expect(output[0]).toContain('Installed server "sqlite"');
  });

  it('executes prune skill command', async () => {
    const output: string[] = [];
    const deps: CliDependencies = {
      ...baseDependencies,
      pruneSkill: async (input) => ok({
        name: input.name,
        removedPaths: ['/home/user/.gemini/antigravity/skills/my-skill'],
      }),
      write: (text) => output.push(text),
    };

    const code = await runCli(['prune', 'skill', 'my-skill'], deps);
    expect(code).toBe(0);
    expect(output[0]).toContain('Pruned skill "my-skill"');
  });

  it('executes prune server command', async () => {
    const output: string[] = [];
    const deps: CliDependencies = {
      ...baseDependencies,
      pruneServer: async (input) => ok({
        name: input.name,
        updatedConfigFiles: ['/home/user/.cline/cline_mcp_settings.json'],
        processTerminated: true,
        removedPaths: [],
      }),
      write: (text) => output.push(text),
    };

    const code = await runCli(['prune', 'server', 'sqlite'], deps);
    expect(code).toBe(0);
    expect(output[0]).toContain('Pruned server "sqlite"');
  });

  it('executes sync command', async () => {
    const output: string[] = [];
    const deps: CliDependencies = {
      ...baseDependencies,
      sync: async () => ok({
        updatedFiles: ['/home/user/.cursor/rules/00-mandatory-policy.mdc'],
        compiledPolicy: '<!-- MCP-POLICY-START -->',
      }),
      write: (text) => output.push(text),
    };

    const code = await runCli(['sync'], deps);
    expect(code).toBe(0);
    expect(output[0]).toContain('Synchronized policy across 1 file(s)');
  });

  it('executes web command', async () => {
    const output: string[] = [];
    const deps: CliDependencies = {
      ...baseDependencies,
      web: async (options) => ok({
        handle: { close: async () => {} },
        url: `http://${options?.host ?? '127.0.0.1'}:${options?.port ?? 18765}`,
      }),
      write: (text) => output.push(text),
    };

    const code = await runCli(['web', '--port', '18765'], deps);
    expect(code).toBe(0);
    expect(output[0]).toBe('Control Plane running on http://127.0.0.1:18765');
  });

  it('executes tools list command', async () => {
    const output: string[] = [];
    const deps: CliDependencies = {
      ...baseDependencies,
      toolsList: async () => [
        { name: 'read_file', description: 'Read a file' },
        { name: 'write_file', description: 'Write a file' },
      ],
      write: (text) => output.push(text),
    };

    const code = await runCli(['tools', 'list'], deps);
    expect(code).toBe(0);
    expect(output).toEqual(['read_file\tRead a file', 'write_file\tWrite a file']);
  });

  it('executes tools call command', async () => {
    const output: string[] = [];
    const deps: CliDependencies = {
      ...baseDependencies,
      toolsCall: async (name, args) => ok({ executed: name, args }),
      write: (text) => output.push(text),
    };

    const code = await runCli(['tools', 'call', 'echo', '{"hello":"world"}'], deps);
    expect(code).toBe(0);
    expect(JSON.parse(output[0]!)).toEqual({ executed: 'echo', args: { hello: 'world' } });
  });

  it('prints sanitized Codex discovery diagnostics from codex doctor', async () => {
    const output: string[] = [];
    const dependencies: CliDependencies = {
      ...baseDependencies,
      codexDoctor: async () => err({
        code: 'CODEX_NOT_AVAILABLE',
        message: 'Codex --version check failed',
        recoverable: true,
        details: {
          stage: '--version',
          executablePath: '/usr/local/bin/codex',
          spawnErrorCode: 'EACCES',
          exitCode: -1,
        },
      }),
      writeError: (text) => output.push(text),
    };

    const exitCode = await runCli(['codex', 'doctor'], dependencies);

    expect(exitCode).toBe(1);
    expect(output).toEqual(['Codex --version check failed (stage=--version, executable=/usr/local/bin/codex, spawnErrorCode=EACCES, exitCode=-1)']);
  });
});
