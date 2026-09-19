import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ok, err } from '@unified-mpc/domain';
import { createDefaultCliDependencies, parseCliArgs, runCli, type CliDependencies } from './index.js';

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
    expect(parseCliArgs(['workspace', 'activate', 'workspace-2'])).toEqual({
      ok: true,
      value: { kind: 'workspace-activate', workspaceReference: 'workspace-2' },
    });
    expect(parseCliArgs(['workspace', 'deactivate', 'workspace-2'])).toEqual({
      ok: true,
      value: { kind: 'workspace-deactivate', workspaceReference: 'workspace-2' },
    });
    expect(parseCliArgs(['workspace', 'use', 'workspace-2'])).toEqual({
      ok: true,
      value: { kind: 'workspace-use', workspaceReference: 'workspace-2' },
    });
    expect(parseCliArgs(['workspace', 'active'])).toEqual({
      ok: true,
      value: { kind: 'workspace-active' },
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

describe('CLI default dependency lifecycle', () => {
  it('does not create SQLite state while executing help', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-cli-lazy-'));
    const previous = process.env.UNIFIED_MPC_DATA_PATH;
    process.env.UNIFIED_MPC_DATA_PATH = root;
    try {
      const output: string[] = [];
      const code = await runCli(['help'], { ...createDefaultCliDependencies(), write: (text) => output.push(text) });
      expect(code).toBe(0);
      expect(output[0]).toContain('Usage: unified-mpc');
      await expect(readdir(root)).resolves.toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.UNIFIED_MPC_DATA_PATH;
      else process.env.UNIFIED_MPC_DATA_PATH = previous;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('projects canonical harness contracts through CLI tools list', async () => {
    const dependencies = createDefaultCliDependencies();
    const tools = await dependencies.toolsList?.();
    const bootstrap = tools?.find((tool) => tool.name === 'workspace_bootstrap');
    const prepare = tools?.find((tool) => tool.name === 'prepare_code_change');
    expect(bootstrap).toMatchObject({
      inputSchema: { type: 'object', additionalProperties: false, required: ['workspaceId'] },
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
    });
    expect(prepare).toMatchObject({
      inputSchema: { type: 'object', additionalProperties: false, required: ['workspaceId', 'filePath'] },
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
    });
  });

  it('executes CLI harness bootstrap, prepare, and mutation with native Thai-RAG wiring', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-cli-harness-'));
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-cli-data-'));
    const previousDataPath = process.env.UNIFIED_MPC_DATA_PATH;
    process.env.UNIFIED_MPC_DATA_PATH = dataPath;
    const components = {
      workerReachable: true,
      sqliteAvailable: true,
      ftsAvailable: true,
      vectorStoreAvailable: true,
      embedderAvailable: true,
      lexicalRetrievalAvailable: true,
      semanticRetrievalAvailable: true,
      activeJobs: [],
    } as const;
    const thaiRagDriver = {
      start: async (): Promise<ReturnType<typeof ok<typeof components>>> => ok(components),
      health: async (): Promise<ReturnType<typeof ok<typeof components>>> => ok(components),
      call: async (): Promise<ReturnType<typeof ok<{ readonly ready: boolean }>>> => ok({ ready: true }),
      stop: async (): Promise<ReturnType<typeof ok<void>>> => ok(undefined),
    };
    try {
      await writeFile(path.join(root, 'AGENTS.md'), '# CLI harness rules\\n');
      const dependencies = createDefaultCliDependencies({ thaiRagDriver });
      const workspace = await dependencies.workspaceAdd(root);
      expect(workspace.ok).toBe(true);
      if (!workspace.ok) return;
      const bootstrap = await dependencies.toolsCall?.('workspace_bootstrap', { workspaceId: workspace.value.id });
      expect(bootstrap).toMatchObject({ ok: true, value: { structuredContent: { ready: true } } });
      const prepared = await dependencies.toolsCall?.('prepare_code_change', { workspaceId: workspace.value.id, filePath: 'src/cli.ts' });
      expect(prepared).toMatchObject({ ok: true, value: { structuredContent: { ready: true, filePath: 'src/cli.ts' } } });
      const mutation = await dependencies.toolsCall?.('write_file', {
        workspaceId: workspace.value.id,
        path: 'src/cli.ts',
        content: 'export const cli = true;\\n',
      });
      expect(mutation).toMatchObject({ ok: true, value: { structuredContent: { path: 'src/cli.ts' } } });
      await expect(readFile(path.join(root, 'src/cli.ts'), 'utf8')).resolves.toBe('export const cli = true;\\n');
    } finally {
      if (previousDataPath === undefined) delete process.env.UNIFIED_MPC_DATA_PATH;
      else process.env.UNIFIED_MPC_DATA_PATH = previousDataPath;
      await rm(root, { recursive: true, force: true });
      await rm(dataPath, { recursive: true, force: true });
    }
  }, 30_000);

  it('wires the standalone tools facade to extension services so child MCP inspection is available', async () => {
    const dependencies = createDefaultCliDependencies();
    const result = await dependencies.toolsCall?.('mcp_list', {});
    expect(result).toMatchObject({ ok: true });
  }, 15_000);
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
        recoveryStatus: 'completed',
        recoveryIds: [],
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

  it('executes sync command forwarding workspaceRoot', async () => {
    let capturedTargets: readonly string[] | undefined;
    let capturedWorkspace: string | undefined;
    const deps: CliDependencies = {
      ...baseDependencies,
      sync: async (targets, workspaceRoot) => {
        capturedTargets = targets;
        capturedWorkspace = workspaceRoot;
        return ok({ updatedFiles: ['/tmp/test/AGENTS.md'] });
      },
      write: () => {},
    };

    const code = await runCli(['sync', '--targets', 'cline', '--workspace', '/custom/workspace'], deps);
    expect(code).toBe(0);
    expect(capturedTargets).toEqual(['cline']);
    expect(capturedWorkspace).toBe('/custom/workspace');
  });

  it('executes web command', async () => {
    const output: string[] = [];
    const deps: CliDependencies = {
      ...baseDependencies,
      web: async (options) => ok({
        handle: { close: async () => {} },
        url: `http://127.0.0.1:${options?.port ?? 3000}`,
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
