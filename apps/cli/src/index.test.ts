import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdtemp, chmod, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { ok, err, type Result } from '@unified-mpc/domain';
import { canonicalManifestId, canonicalRevisionId, computeTreeOid, fileArtifactId } from '@unified-mpc/domain';
import type { ExtensionsService } from '@unified-mpc/extensions';
import {
  ArtifactQuarantineStore,
  CanonicalArtifactStore,
  CanonicalManifestStore,
  CanonicalRefStore,
  GcLeaseStore,
  type StoredManifest,
} from '@unified-mpc/workspace';
import { createDefaultCliDependencies, parseCliArgs, runCli, type CliDependencies } from './index.js';

const sourceRuntimeAdmissionIdentity = {
  runtimeDeploymentId: 'cli-test-deployment',
  runtimeGeneration: 'cli-test-generation',
  runtimeBuildVersion: '4.61.0+0123456789ab',
  runtimeBuildCommit: '0123456789abcdef0123456789abcdef01234567',
  runtimeBuildDirty: false,
  runtimeProtocolGeneration: 1,
  runtimeStartedAt: '2026-09-28T00:00:00.000Z',
} as const;

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
    expect(parseCliArgs(['storage', 'recover'])).toEqual({ ok: true, value: { kind: 'storage-recover' } });
    expect(parseCliArgs(['storage', 'recover', 'extra'])).toMatchObject({ ok: false });
    expect(parseCliArgs(['storage', 'metrics'])).toEqual({ ok: true, value: { kind: 'storage-metrics', json: false } });
    expect(parseCliArgs(['storage', 'metrics', '--json'])).toEqual({ ok: true, value: { kind: 'storage-metrics', json: true } });
    expect(parseCliArgs(['storage', 'metrics', '--json', 'extra'])).toMatchObject({ ok: false });
    expect(parseCliArgs(['storage', 'metrics', '--everything'])).toMatchObject({ ok: false });
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
      expect(output[0]).toContain('install skill <name> <source>');
      expect(output[0]).toContain('install server <name>');
      expect(output[0]).toContain('prune skill <name>');
      expect(output[0]).toContain('prune server <name>');
      expect(output[0]).not.toContain('--name');
      await expect(readdir(root)).resolves.toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.UNIFIED_MPC_DATA_PATH;
      else process.env.UNIFIED_MPC_DATA_PATH = previous;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails visibly before creating a fresh canonical DB when a historical HOME DB contains gateway settings', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-cli-storage-drift-'));
    const canonical = path.join(root, 'canonical');
    const home = path.join(root, 'home');
    const historicalRoot = path.join(home, '.local', 'share', 'unified-mpc');
    await mkdir(historicalRoot, { recursive: true });
    const historicalPath = path.join(historicalRoot, 'unified-mpc.sqlite');
    const historical = new DatabaseSync(historicalPath);
    try {
      historical.exec('CREATE TABLE settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);');
      historical.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
        'cloudflare_public_url',
        'https://historical.example.test',
      );
    } finally {
      historical.close();
    }

    const previousDataPath = process.env.UNIFIED_MPC_DATA_PATH;
    const previousHome = process.env.HOME;
    const previousXdgDataHome = process.env.XDG_DATA_HOME;
    process.env.UNIFIED_MPC_DATA_PATH = canonical;
    process.env.HOME = home;
    process.env.XDG_DATA_HOME = path.join(root, 'xdg');

    try {
      const dependencies = createDefaultCliDependencies();
      await expect(dependencies.workspaceList()).rejects.toThrow(/STORAGE_IDENTITY_DRIFT:/u);
      expect(existsSync(path.join(canonical, 'unified-mpc.sqlite'))).toBe(false);
    } finally {
      if (previousDataPath === undefined) delete process.env.UNIFIED_MPC_DATA_PATH;
      else process.env.UNIFIED_MPC_DATA_PATH = previousDataPath;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = previousXdgDataHome;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails visibly when the canonical SQLite file exists but cannot be inspected', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-cli-storage-corrupt-'));
    const canonical = path.join(root, 'canonical');
    const home = path.join(root, 'home');
    await mkdir(canonical, { recursive: true });
    await writeFile(path.join(canonical, 'unified-mpc.sqlite'), 'not sqlite', 'utf8');

    const previousDataPath = process.env.UNIFIED_MPC_DATA_PATH;
    const previousHome = process.env.HOME;
    const previousXdgDataHome = process.env.XDG_DATA_HOME;
    process.env.UNIFIED_MPC_DATA_PATH = canonical;
    process.env.HOME = home;
    process.env.XDG_DATA_HOME = path.join(root, 'xdg');

    try {
      const dependencies = createDefaultCliDependencies();
      await expect(dependencies.workspaceList()).rejects.toThrow(/STORAGE_IDENTITY_UNAVAILABLE:/u);
    } finally {
      if (previousDataPath === undefined) delete process.env.UNIFIED_MPC_DATA_PATH;
      else process.env.UNIFIED_MPC_DATA_PATH = previousDataPath;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = previousXdgDataHome;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('recovers historical storage through the default CLI dependency without opening the guarded workspace DB first', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-cli-storage-recover-'));
    const canonical = path.join(root, 'canonical');
    const home = path.join(root, 'home');
    const historicalRoot = path.join(home, '.local', 'share', 'unified-mpc');
    await mkdir(historicalRoot, { recursive: true });
    const historicalPath = path.join(historicalRoot, 'unified-mpc.sqlite');
    const historical = new DatabaseSync(historicalPath);
    try {
      historical.exec(`
        CREATE TABLE workspaces (
          id TEXT PRIMARY KEY NOT NULL,
          display_name TEXT NOT NULL,
          root_path TEXT NOT NULL UNIQUE,
          real_root_path TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE settings (
          key TEXT PRIMARY KEY NOT NULL,
          value TEXT NOT NULL
        );
        CREATE TABLE schema_migrations (
          id TEXT PRIMARY KEY NOT NULL
        );
      `);
      historical.prepare('INSERT INTO schema_migrations (id) VALUES (?)').run('001_initial');
      historical.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
        'cloudflare_public_url',
        'https://historical.example.test',
      );
    } finally {
      historical.close();
    }

    const previousDataPath = process.env.UNIFIED_MPC_DATA_PATH;
    const previousHome = process.env.HOME;
    const previousXdgDataHome = process.env.XDG_DATA_HOME;
    process.env.UNIFIED_MPC_DATA_PATH = canonical;
    process.env.HOME = home;
    process.env.XDG_DATA_HOME = path.join(root, 'xdg');

    try {
      const dependencies = createDefaultCliDependencies();
      const result = await dependencies.storageRecover?.();
      expect(result).toMatchObject({
        status: 'recovered',
        sourcePath: historicalPath,
        destinationPath: path.join(canonical, 'unified-mpc.sqlite'),
        provenancePath: expect.any(String),
      });
      await expect(dependencies.workspaceList()).resolves.toEqual([]);
    } finally {
      if (previousDataPath === undefined) delete process.env.UNIFIED_MPC_DATA_PATH;
      else process.env.UNIFIED_MPC_DATA_PATH = previousDataPath;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = previousXdgDataHome;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('projects canonical harness contracts through CLI tools list', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'unified-mcp-cli-tools-'));
    const previousDataPath = process.env.UNIFIED_MPC_DATA_PATH;
    const previousHome = process.env.HOME;
    const previousXdgDataHome = process.env.XDG_DATA_HOME;
    process.env.UNIFIED_MPC_DATA_PATH = dataPath;
    process.env.HOME = dataPath;
    process.env.XDG_DATA_HOME = path.join(dataPath, 'xdg');
    try {
    const dependencies = createDefaultCliDependencies({ runtimeAdmissionIdentity: sourceRuntimeAdmissionIdentity });
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
    } finally {
      await rm(dataPath, { recursive: true, force: true });
      if (previousDataPath === undefined) delete process.env.UNIFIED_MPC_DATA_PATH;
      else process.env.UNIFIED_MPC_DATA_PATH = previousDataPath;
if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = previousXdgDataHome;
    }
  }, 15_000);

  it('executes CLI harness bootstrap, prepare, and mutation with native Thai-RAG wiring', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-cli-harness-'));
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-cli-data-'));
    const previousDataPath = process.env.UNIFIED_MPC_DATA_PATH;
    const previousHome = process.env.HOME;
    const previousXdgDataHome = process.env.XDG_DATA_HOME;
    process.env.UNIFIED_MPC_DATA_PATH = dataPath;
    process.env.HOME = dataPath;
    process.env.XDG_DATA_HOME = path.join(dataPath, 'xdg');
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
      call: async (tool: string, args: Readonly<Record<string, unknown>>): Promise<Result<unknown>> => {
        if (tool !== 'pre_edit_context') return ok({ ready: true });
        // Emulate the provider contract (#346): the ready verdict names the
        // content it analyzed, so the harness can bind it to the real target.
        const requested = typeof args.file_path === 'string' ? args.file_path : '';
        let content = '';
        try {
          content = await readFile(path.join(root, requested), 'utf8');
        } catch {
          content = '';
        }
        return ok({ content: [{ type: 'text', text: JSON.stringify({
          status: 'ok',
          can_proceed: true,
          evidence_state: 'evidence_available',
          evidence_fresh: true,
          target_sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
          evidence: { code_index: 'available', storage: 'available', cpg: 'available' },
        }) }] });
      },
      stop: async (): Promise<ReturnType<typeof ok<void>>> => ok(undefined),
    };
    const extensions: ExtensionsService = {
      listSkills: async () => ok({ skills: [] }),
      readSkill: async (input) => ok({ id: input.skillId, name: 'ask-matt', description: 'test router', source: 'test', trustTier: 'bundled', path: 'ask-matt/SKILL.md', content: '# Ask Matt' }),
      listMcpServers: async () => ok({ servers: [] }),
      runtimePolicySnapshot: async () => ok({ ready: true, policies: [{ priority: 'P1', id: 'session-start:ask-matt', resourceId: 'ask-matt', resourceType: 'skill', mandatory: true, enforcement: 'EVERY_SESSION', directive: 'Load ask-matt.', source: 'configured', available: true, resolvedResourceId: 'ask-matt' }] }),
      bootstrapMandatoryMcpServers: async () => ok({ ready: true, servers: [] }),
      describeMcpServer: async (input) => err({ code: 'INTERNAL_ERROR', message: `unknown server ${input.server}`, recoverable: true }),
      listMcpResources: async (input) => err({ code: 'INTERNAL_ERROR', message: `unknown server ${input.server}`, recoverable: true }),
      callMcpTool: async () => err({ code: 'INTERNAL_ERROR', message: 'no test MCP server', recoverable: true }),
      close: async () => undefined,
    };
    try {
      await writeFile(path.join(root, 'AGENTS.md'), '# CLI harness rules\\n');
      await mkdir(path.join(root, 'src'), { recursive: true });
      await writeFile(path.join(root, 'src', 'cli.ts'), 'export const cli = false;\n');
      const dependencies = createDefaultCliDependencies({
        runtimeAdmissionIdentity: sourceRuntimeAdmissionIdentity,
        thaiRagDriver,
        extensions,
      });
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
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = previousXdgDataHome;
      await rm(root, { recursive: true, force: true });
      await rm(dataPath, { recursive: true, force: true });
    }
  }, 30_000);

  it('wires the standalone tools facade to extension services so child MCP inspection is available', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-cli-mcp-list-'));
    const previousDataPath = process.env.UNIFIED_MPC_DATA_PATH;
    const previousHome = process.env.HOME;
    const previousXdgDataHome = process.env.XDG_DATA_HOME;
    process.env.UNIFIED_MPC_DATA_PATH = dataPath;
    process.env.HOME = dataPath;
    process.env.XDG_DATA_HOME = path.join(dataPath, 'xdg');
    try {
      const dependencies = createDefaultCliDependencies({ runtimeAdmissionIdentity: sourceRuntimeAdmissionIdentity });
      const result = await dependencies.toolsCall?.('mcp_list', {});
      expect(result).toMatchObject({ ok: true });
    } finally {
      await rm(dataPath, { recursive: true, force: true });
      if (previousDataPath === undefined) delete process.env.UNIFIED_MPC_DATA_PATH;
      else process.env.UNIFIED_MPC_DATA_PATH = previousDataPath;
if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = previousXdgDataHome;
    }
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

  it('executes storage recover command and prints provenance', async () => {
    const output: string[] = [];
    const deps: CliDependencies = {
      ...baseDependencies,
      storageRecover: async () => ({
        status: 'recovered',
        sourcePath: '/home/user/.local/share/unified-mpc/unified-mpc.sqlite',
        destinationPath: '/srv/unified-mpc/unified-mpc.sqlite',
        canonicalBackupId: null,
        sourceBackupId: 'backup-source',
        migratedBackupId: 'backup-migrated',
        provenancePath: '/srv/unified-mpc/storage-recovery.json',
      }),
      write: (text) => output.push(text),
    };

    const code = await runCli(['storage', 'recover'], deps);
    expect(code).toBe(0);
    expect(output).toEqual([
      'storage recovered: /home/user/.local/share/unified-mpc/unified-mpc.sqlite -> /srv/unified-mpc/unified-mpc.sqlite',
      'provenance: /srv/unified-mpc/storage-recovery.json',
    ]);
  });

  it('executes storage metrics with bounded physical-space evidence', async () => {
    const output: string[] = [];
    const metrics = {
      measuredAt: '2026-11-03T21:00:00.000Z',
      inMemory: false,
      databasePath: '/srv/unified-mpc/unified-mpc.sqlite',
      databaseBytes: 12_345_678,
      walBytes: 4_096,
      shmBytes: 32_768,
      pageSizeBytes: 4096,
      pageCount: 3014,
      freelistCount: 12,
      freelistBytes: 49_152,
      liveBytes: 12_296_526,
      freelistRatio: 12 / 3014,
      checkpoint: { mode: 'passive', busy: false, walPages: 1, checkpointedPages: 1, truncated: false },
      compactionRecommended: false,
      compactionReason: null,
    };
    const deps: CliDependencies = {
      ...baseDependencies,
      storageMetrics: async () => metrics,
      write: (text) => output.push(text),
    };

    const code = await runCli(['storage', 'metrics'], deps);
    expect(code).toBe(0);
    expect(output).toEqual([
      'database\t/srv/unified-mpc/unified-mpc.sqlite',
      'bytes\tdb=12345678 wal=4096 shm=32768 live=12296526',
      'pages\tsize=4096 count=3014 freelist=12 (49152 bytes, 0.0040)',
      'checkpoint\tmode=passive busy=false walPages=1 checkpointedPages=1 truncated=false',
      'compaction\trecommended=false reason=none',
    ]);

    const json: string[] = [];
    const jsonCode = await runCli(['storage', 'metrics', '--json'], {
      ...baseDependencies,
      storageMetrics: async () => metrics,
      write: (text) => json.push(text),
    });
    expect(jsonCode).toBe(0);
    expect(json).toHaveLength(1);
    expect(JSON.parse(json[0] ?? '{}')).toEqual(metrics);
  });

  it('reports unavailable and failing storage metrics without crashing the CLI dispatcher', async () => {
    const errors: string[] = [];
    const unavailable = await runCli(['storage', 'metrics'], { ...baseDependencies, writeError: (text) => errors.push(text) });
    expect(unavailable).toBe(1);
    expect(errors).toEqual(['Storage metrics service is not available']);

    const thrown: string[] = [];
    const failed = await runCli(['storage', 'metrics'], {
      ...baseDependencies,
      storageMetrics: async () => { throw new Error('database is locked'); },
      writeError: (text) => thrown.push(text),
    });
    expect(failed).toBe(1);
    expect(thrown).toEqual(['database is locked']);
  });

  it('advances the canonical revision index for an exact Git ref', async () => {
    const output: string[] = [];
    const seen: Array<{ ref: string; repositoryId?: string }> = [];
    const report = {
      status: 'promoted' as const,
      repositoryId: 'repo:v1:abc',
      targetRef: 'refs/remotes/origin/main',
      commitSha: 'c'.repeat(40),
      gitTreeOid: 'd'.repeat(40),
      unifiedTreeOid: 'e'.repeat(64),
      revisionId: 'rev:v1:f',
      manifestId: 'man:v1:1',
      reuse: { reusedPaths: ['a.ts', 'b.ts'], newPaths: ['c.ts'], renamedPaths: [], deletedPaths: [] },
      artifacts: { status: 'registered' as const, registered: 1, reused: 2, unclassified: [] },
    };
    const deps: CliDependencies = {
      ...baseDependencies,
      indexRevisionAdvance: async (input) => {
        seen.push(input);
        return report;
      },
      write: (text) => output.push(text),
    };

    const code = await runCli(['index', 'revision', 'advance'], deps);
    expect(code).toBe(0);
    expect(seen).toEqual([{ ref: 'refs/remotes/origin/main' }]);
    expect(output).toHaveLength(1);
    expect(output[0]?.split('\n')).toEqual([
      'canonical refs/remotes/origin/main: promoted',
      `commit ${'c'.repeat(40)}`,
      `tree ${'d'.repeat(40)}`,
      'manifest man:v1:1',
      'repository repo:v1:abc',
      'reuse reused=2 new=1 renamed=0 deleted=0',
      'artifacts reused=2 registered=1 unclassified=0',
    ]);

    const json: string[] = [];
    const jsonCode = await runCli(['index', 'revision', 'advance', '--ref', 'refs/heads/main', '--json'], {
      ...baseDependencies,
      indexRevisionAdvance: async (input) => {
        seen.push(input);
        return report;
      },
      write: (text) => json.push(text),
    });
    expect(jsonCode).toBe(0);
    expect(seen.at(-1)).toEqual({ ref: 'refs/heads/main' });
    expect(JSON.parse(json[0] ?? '{}')).toEqual(report);
  });

  it('fails the canonical index command on refusal, conflict and an unavailable service', async () => {
    const errors: string[] = [];
    const unavailable = await runCli(['index', 'revision', 'advance'], {
      ...baseDependencies,
      writeError: (text) => errors.push(text),
    });
    expect(unavailable).toBe(1);
    expect(errors).toEqual(['Canonical index service is not available']);

    const refused: string[] = [];
    const refusedCode = await runCli(['index', 'revision', 'advance'], {
      ...baseDependencies,
      indexRevisionAdvance: async () => ({ status: 'refused', targetRef: 'refs/remotes/origin/main', reason: 'no remote' }),
      write: (text) => refused.push(text),
    });
    expect(refusedCode).toBe(1);
    expect(refused).toEqual(['canonical refs/remotes/origin/main: refused\nreason no remote']);

    const thrown: string[] = [];
    const thrownCode = await runCli(['index', 'revision', 'advance'], {
      ...baseDependencies,
      indexRevisionAdvance: async () => { throw new Error('git is not installed'); },
      writeError: (text) => thrown.push(text),
    });
    expect(thrownCode).toBe(1);
    expect(thrown).toEqual(['git is not installed']);
  });

  it('reports canonical store status and exits non-zero when degraded', async () => {
    const report = {
      status: 'healthy' as const,
      refs: [{ ref: 'refs/remotes/origin/main', manifestId: 'man:v1:abc', commitSha: 'c'.repeat(40) }],
      manifestCount: 1,
      pinCount: 0,
      overlayCount: 0,
      quarantinedCount: 0,
      activeJobCount: 0,
      danglingRefs: [],
      missingOverlayBases: [],
      orphanedPins: [],
    };
    const output: string[] = [];
    const seen: string[] = [];
    const code = await runCli(['index', 'status'], {
      ...baseDependencies,
      canonicalStatus: async () => {
        seen.push('canonicalStatus');
        return report;
      },
      write: (text) => output.push(text),
    });
    expect(code).toBe(0);
    expect(seen).toEqual(['canonicalStatus']);
    expect(output[0]?.split('\n')).toEqual([
      'canonical store: healthy',
      'refs 1',
      `  refs/remotes/origin/main man:v1:abc commit ${'c'.repeat(40)}`,
      'manifests 1',
      'pins 0',
      'overlays 0',
      'quarantined 0',
      'active-jobs 0',
      'dangling-refs 0',
      'missing-overlay-bases 0',
      'orphaned-pins 0',
    ]);

    const json: string[] = [];
    const jsonCode = await runCli(['index', 'status', '--json'], {
      ...baseDependencies,
      canonicalStatus: async () => report,
      write: (text) => json.push(text),
    });
    expect(jsonCode).toBe(0);
    expect(JSON.parse(json[0] ?? '{}')).toEqual(report);

    const degraded: string[] = [];
    const degradedCode = await runCli(['index', 'status'], {
      ...baseDependencies,
      canonicalStatus: async () => ({ ...report, status: 'degraded', orphanedPins: ['man:v1:orphan'] }),
      write: (text) => degraded.push(text),
    });
    expect(degradedCode).toBe(1);
    expect(degraded[0]).toContain('canonical store: degraded');
    expect(degraded[0]).toContain('orphaned-pins 1\n  man:v1:orphan');
  });

  it('fails the canonical status command when the service is unavailable or throws', async () => {
    const errors: string[] = [];
    const unavailable = await runCli(['index', 'status'], {
      ...baseDependencies,
      writeError: (text) => errors.push(text),
    });
    expect(unavailable).toBe(1);
    expect(errors).toEqual(['Canonical index service is not available']);

    const thrown: string[] = [];
    const thrownCode = await runCli(['index', 'status'], {
      ...baseDependencies,
      canonicalStatus: async () => { throw new Error('STORAGE_IDENTITY_DRIFT: recovery required'); },
      writeError: (text) => thrown.push(text),
    });
    expect(thrownCode).toBe(1);
    expect(thrown).toEqual(['STORAGE_IDENTITY_DRIFT: recovery required']);
  });

  it('lists stored canonical revisions and fails like every other index command', async () => {
    const revision = {
      manifestId: `man:v1:${'a'.repeat(64)}`,
      repositoryId: 'repo_abc123',
      revisionId: `rev:v1:${'b'.repeat(64)}`,
      commitSha: 'c'.repeat(40),
      treeOid: 'd'.repeat(40),
      targetRef: 'refs/remotes/origin/main',
      entryCount: 695,
      createdAt: '2026-10-17T00:00:00.000Z',
      refs: ['refs/remotes/origin/main'],
      pins: [],
      overlayGoalIds: [],
      indexJobOperationIds: [],
    };

    const output: string[] = [];
    const code = await runCli(['index', 'revision', 'list'], {
      ...baseDependencies,
      canonicalRevisionList: async () => ({ revisions: [revision] }),
      write: (text) => output.push(text),
    });
    expect(code).toBe(0);
    expect(output[0]?.split('\n')).toEqual([
      'revisions 1',
      `  ${revision.manifestId} commit ${revision.commitSha} tree ${revision.treeOid} entries 695 created 2026-10-17T00:00:00.000Z`,
      '    refs refs/remotes/origin/main',
    ]);

    const empty: string[] = [];
    const emptyCode = await runCli(['index', 'revision', 'list'], {
      ...baseDependencies,
      canonicalRevisionList: async () => ({ revisions: [] }),
      write: (text) => empty.push(text),
    });
    expect(emptyCode).toBe(0);
    expect(empty).toEqual(['revisions 0']);

    const json: string[] = [];
    const jsonCode = await runCli(['index', 'revision', 'list', '--json'], {
      ...baseDependencies,
      canonicalRevisionList: async () => ({ revisions: [revision] }),
      write: (text) => json.push(text),
    });
    expect(jsonCode).toBe(0);
    expect(JSON.parse(json[0] ?? '{}')).toEqual({ revisions: [revision] });

    const errors: string[] = [];
    const unavailable = await runCli(['index', 'revision', 'list'], {
      ...baseDependencies,
      writeError: (text) => errors.push(text),
    });
    expect(unavailable).toBe(1);
    expect(errors).toEqual(['Canonical index service is not available']);

    const thrown: string[] = [];
    const thrownCode = await runCli(['index', 'revision', 'list'], {
      ...baseDependencies,
      canonicalRevisionList: async () => { throw new Error('STORAGE_IDENTITY_DRIFT: recovery required'); },
      writeError: (text) => thrown.push(text),
    });
    expect(thrownCode).toBe(1);
    expect(thrown).toEqual(['STORAGE_IDENTITY_DRIFT: recovery required']);
  });

  it('pins and unpins operator revisions and fails like every other index command', async () => {
    const manifestId = `man:v1:${'a'.repeat(64)}`;
    const seen: Array<{ action: string; manifestId: string; note?: string }> = [];
    const output: string[] = [];
    const code = await runCli(['index', 'revision', 'pin', manifestId, '--note', 'keep for audit'], {
      ...baseDependencies,
      canonicalRevisionPin: async (input) => {
        seen.push(input);
        return { manifestId, action: 'pinned', pins: ['user-pin'] };
      },
      write: (text) => output.push(text),
    });
    expect(code).toBe(0);
    expect(seen).toEqual([{ action: 'pin', manifestId, note: 'keep for audit' }]);
    expect(output).toEqual([`pinned ${manifestId} reason user-pin\npins user-pin`]);

    const json: string[] = [];
    const jsonCode = await runCli(['index', 'revision', 'unpin', manifestId, '--json'], {
      ...baseDependencies,
      canonicalRevisionPin: async (input) => ({ manifestId: input.manifestId, action: 'unpinned', pins: [] }),
      write: (text) => json.push(text),
    });
    expect(jsonCode).toBe(0);
    expect(JSON.parse(json[0] ?? '{}')).toEqual({ manifestId, action: 'unpinned', pins: [] });

    const usage: string[] = [];
    const usageCode = await runCli(['index', 'revision', 'pin'], {
      ...baseDependencies,
      writeError: (text) => usage.push(text),
    });
    expect(usageCode).toBe(2);
    expect(usage[0]).toContain('index revision pin <manifest-id>');

    const errors: string[] = [];
    const unavailable = await runCli(['index', 'revision', 'pin', manifestId], {
      ...baseDependencies,
      writeError: (text) => errors.push(text),
    });
    expect(unavailable).toBe(1);
    expect(errors).toEqual(['Canonical index service is not available']);

    const thrown: string[] = [];
    const thrownCode = await runCli(['index', 'revision', 'pin', manifestId], {
      ...baseDependencies,
      canonicalRevisionPin: async () => { throw new Error(`unknown revision manifest: ${manifestId}`); },
      writeError: (text) => thrown.push(text),
    });
    expect(thrownCode).toBe(1);
    expect(thrown).toEqual([`unknown revision manifest: ${manifestId}`]);
  });

  it('plans a revision prune in dry-run mode and fails like every other index command', async () => {
    const stale = `man:v1:${'a'.repeat(64)}`;
    const live = `man:v1:${'b'.repeat(64)}`;
    const outputs: string[] = [];
    let seenDryRun: boolean | undefined;
    const code = await runCli(['index', 'revision', 'prune', '--dry-run'], {
      ...baseDependencies,
      indexRevisionPrune: async (input) => {
        seenDryRun = input.dryRun;
        return {
          status: 'planned',
          pruneable: [stale],
          removed: [],
          retained: [{ manifestId: live, reason: 'canonical-ref' }],
        };
      },
      write: (text) => outputs.push(text),
    });
    expect(code).toBe(0);
    expect(seenDryRun).toBe(true);
    expect(outputs).toEqual([
      `planned (dry-run) pruneable 1 retained 1\nprune ${stale}\nretain ${live} canonical-ref`,
    ]);

    const json: string[] = [];
    const jsonCode = await runCli(['index', 'revision', 'prune', '--dry-run', '--json'], {
      ...baseDependencies,
      indexRevisionPrune: async () => ({ status: 'planned', pruneable: [], removed: [], retained: [] }),
      write: (text) => json.push(text),
    });
    expect(jsonCode).toBe(0);
    expect(JSON.parse(json[0] ?? '{}')).toEqual({ status: 'planned', pruneable: [], removed: [], retained: [] });

    const usage: string[] = [];
    const usageCode = await runCli(['index', 'revision', 'prune'], {
      ...baseDependencies,
      writeError: (text) => usage.push(text),
    });
    expect(usageCode).toBe(2);
    expect(usage[0]).toContain('index revision prune --dry-run');

    const errors: string[] = [];
    const unavailable = await runCli(['index', 'revision', 'prune', '--dry-run'], {
      ...baseDependencies,
      writeError: (text) => errors.push(text),
    });
    expect(unavailable).toBe(1);
    expect(errors).toEqual(['Canonical index service is not available']);

    const thrown: string[] = [];
    const thrownCode = await runCli(['index', 'revision', 'prune', '--dry-run'], {
      ...baseDependencies,
      indexRevisionPrune: async () => { throw new Error('canonical store is unreadable'); },
      writeError: (text) => thrown.push(text),
    });
    expect(thrownCode).toBe(1);
    expect(thrown).toEqual(['canonical store is unreadable']);
  });

  it('plans an index GC cycle in dry-run mode with the safety verdict exit code', async () => {
    const content = 'a'.repeat(64);
    const artifactKey = `file:v1:${'b'.repeat(64)}`;
    const outputs: string[] = [];
    let seenDryRun: boolean | undefined;
    let seenGraceMs: number | undefined;
    const code = await runCli(['index', 'gc', '--dry-run'], {
      ...baseDependencies,
      indexGc: async (input) => {
        seenDryRun = input.dryRun;
        seenGraceMs = input.graceMs;
        return {
          status: 'planned',
          reachable: [content],
          unreachable: [content],
          unreachableArtifacts: [{ repositoryId: 'repo_abc123', artifactKey }],
          quarantined: [],
          quarantinedArtifacts: [],
        };
      },
      write: (text) => outputs.push(text),
    });
    expect(code).toBe(0);
    expect(seenDryRun).toBe(true);
    // A dry run carries the default window so the report shape stays stable,
    // even though it stamps no deadline.
    expect(seenGraceMs).toBe(604_800_000);
    expect(outputs).toEqual([
      `planned (dry-run) reachable 1 unreachable 1 artifact-unreachable 1\nunreachable ${content}`
        + `\nartifact-unreachable repo_abc123 ${artifactKey}`,
    ]);

    const applied: string[] = [];
    let appliedGraceMs: number | undefined;
    const appliedCode = await runCli(['index', 'gc', '--apply', '--grace', '12h'], {
      ...baseDependencies,
      indexGc: async (input) => {
        appliedGraceMs = input.graceMs;
        return {
          status: 'planned',
          reachable: [content],
          unreachable: [content],
          unreachableArtifacts: [{ repositoryId: 'repo_abc123', artifactKey }],
          quarantined: [content],
          quarantinedArtifacts: [{ repositoryId: 'repo_abc123', artifactKey }],
        };
      },
      write: (text) => applied.push(text),
    });
    expect(appliedCode).toBe(0);
    expect(appliedGraceMs).toBe(43_200_000);
    expect(applied).toEqual([
      `applied quarantined 1 artifact-quarantined 1\nquarantined ${content}`
        + `\nartifact-quarantined repo_abc123 ${artifactKey}`,
    ]);

    const refused: string[] = [];
    const refusedCode = await runCli(['index', 'gc', '--dry-run'], {
      ...baseDependencies,
      indexGc: async () => ({ status: 'refused', reason: 'no reachability roots supplied' }),
      write: (text) => refused.push(text),
    });
    expect(refusedCode).toBe(1);
    expect(refused).toEqual(['refused no reachability roots supplied']);

    const json: string[] = [];
    const jsonCode = await runCli(['index', 'gc', '--dry-run', '--json'], {
      ...baseDependencies,
      indexGc: async () => ({ status: 'refused', reason: 'missing manifests on disk' }),
      write: (text) => json.push(text),
    });
    expect(jsonCode).toBe(1);
    expect(JSON.parse(json[0] ?? '{}')).toEqual({ status: 'refused', reason: 'missing manifests on disk' });

    const usage: string[] = [];
    const usageCode = await runCli(['index', 'gc'], {
      ...baseDependencies,
      writeError: (text) => usage.push(text),
    });
    expect(usageCode).toBe(2);
    expect(usage[0]).toContain('index gc (--dry-run | --apply');

    const errors: string[] = [];
    const unavailable = await runCli(['index', 'gc', '--dry-run'], {
      ...baseDependencies,
      writeError: (text) => errors.push(text),
    });
    expect(unavailable).toBe(1);
    expect(errors).toEqual(['Canonical index service is not available']);

    const thrown: string[] = [];
    const thrownCode = await runCli(['index', 'gc', '--dry-run'], {
      ...baseDependencies,
      indexGc: async () => { throw new Error('gc lease fence unreadable'); },
      writeError: (text) => thrown.push(text),
    });
    expect(thrownCode).toBe(1);
    expect(thrown).toEqual(['gc lease fence unreadable']);
  });

  it('applies a GC pass through the real canonical stores under the cleanup lease', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-cli-gc-apply-'));
    const dataPath = path.join(root, 'data');
    const canonical = path.join(dataPath, 'canonical');
    const home = path.join(root, 'home');
    const previousDataPath = process.env.UNIFIED_MPC_DATA_PATH;
    const previousHome = process.env.HOME;
    const previousXdgDataHome = process.env.XDG_DATA_HOME;
    process.env.UNIFIED_MPC_DATA_PATH = dataPath;
    process.env.HOME = home;
    process.env.XDG_DATA_HOME = path.join(root, 'xdg');
    try {
      const repositoryId = 'repo_abc123';
      const ref = 'refs/remotes/origin/main';
      const liveHash = '1'.repeat(64);
      const deadHash = 'd'.repeat(64);
      const manifest: StoredManifest = ((): StoredManifest => {
        const entries = [{ path: 'live.ts', contentHash: liveHash }];
        const commitSha = 'c'.repeat(40);
        const treeOid = computeTreeOid(entries);
        const revisionId = canonicalRevisionId({ repositoryId, commitSha, treeOid, targetRef: ref, parents: [] });
        return {
          manifestId: canonicalManifestId({ repositoryId, revisionId, entries }),
          repositoryId,
          revisionId,
          commitSha,
          treeOid,
          targetRef: ref,
          entries,
          createdAt: '2026-11-04T00:00:00.000Z',
        };
      })();
      const manifests = new CanonicalManifestStore(canonical);
      await manifests.put(manifest);
      await new CanonicalRefStore(canonical).promote(ref, {
        expectedCurrent: null,
        current: null,
        target: { commitSha: manifest.commitSha, treeOid: manifest.treeOid, manifestId: manifest.manifestId },
        targetVerified: true,
      });
      const artifacts = new CanonicalArtifactStore(canonical);
      const liveArtifactKey = fileArtifactId({
        sourceContentSha256: liveHash,
        language: 'typescript',
        sourceKind: 'source',
        representationVersion: 'v1',
      });
      await artifacts.put({
        kind: 'file',
        artifactKey: liveArtifactKey,
        repositoryId,
        sourceContentSha256: liveHash,
        language: 'typescript',
        sourceKind: 'source',
        representationVersion: 'v1',
        bindings: [{ path: 'live.ts', manifestId: manifest.manifestId }],
        createdAt: '2026-11-04T00:00:00.000Z',
      });
      const artifactKey = fileArtifactId({
        sourceContentSha256: deadHash,
        language: 'typescript',
        sourceKind: 'source',
        representationVersion: 'v1',
      });
      await artifacts.put({
        kind: 'file',
        artifactKey,
        repositoryId,
        sourceContentSha256: deadHash,
        language: 'typescript',
        sourceKind: 'source',
        representationVersion: 'v1',
        bindings: [],
        createdAt: '2026-11-04T00:00:00.000Z',
      });

      // A held lease must refuse the pass before it writes a single row.
      const lease = new GcLeaseStore(canonical);
      const acquired = await lease.acquire({ ownerId: 'other_gc', now: new Date(), ttlMs: 60_000 });
      if (acquired.status !== 'granted') throw new Error(`expected a granted lease, got ${acquired.status}`);
      const refused: string[] = [];
      const refusedCode = await runCli(['index', 'gc', '--apply'], {
        ...createDefaultCliDependencies(),
        write: (text) => refused.push(text),
        writeError: () => undefined,
      });
      expect(refusedCode).toBe(1);
      expect(refused[0]).toContain('refused gc lease held by other_gc');
      expect(await new ArtifactQuarantineStore(canonical).list()).toEqual([]);
      await lease.release({ ownerId: 'other_gc', generation: acquired.generation });

      const output: string[] = [];
      const applyErrors: string[] = [];
      const code = await runCli(['index', 'gc', '--apply', '--grace', '1h'], {
        ...createDefaultCliDependencies(),
        write: (text) => output.push(text),
        writeError: (text) => applyErrors.push(text),
      });
      expect(applyErrors, applyErrors.join('\n')).toEqual([]);
      expect(code, output.join('\n')).toBe(0);
      expect(output[0]).toContain('applied quarantined 1 artifact-quarantined 1');
      expect(output[0]).toContain(`quarantined ${deadHash}`);
      expect(output[0]).toContain(`artifact-quarantined ${repositoryId} ${artifactKey}`);

      const entries = await new ArtifactQuarantineStore(canonical).list();
      expect(entries).toHaveLength(2);
      expect(entries).toContainEqual(expect.objectContaining({
        kind: 'content-hash',
        hash: deadHash,
        graceMs: 3_600_000,
      }));
      expect(entries).toContainEqual(expect.objectContaining({
        kind: 'artifact-key',
        repositoryId,
        artifactKey,
        graceMs: 3_600_000,
      }));
      // The pass released its lease, so the next run is not blocked by itself.
      expect(await lease.read()).toBeNull();
    } finally {
      if (previousDataPath === undefined) delete process.env.UNIFIED_MPC_DATA_PATH;
      else process.env.UNIFIED_MPC_DATA_PATH = previousDataPath;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = previousXdgDataHome;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('applies quarantine expiry through the real canonical stores and deletes artifact records', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-cli-gc-expire-'));
    const dataPath = path.join(root, 'data');
    const canonical = path.join(dataPath, 'canonical');
    const home = path.join(root, 'home');
    const previousDataPath = process.env.UNIFIED_MPC_DATA_PATH;
    const previousHome = process.env.HOME;
    const previousXdgDataHome = process.env.XDG_DATA_HOME;
    process.env.UNIFIED_MPC_DATA_PATH = dataPath;
    process.env.HOME = home;
    process.env.XDG_DATA_HOME = path.join(root, 'xdg');
    try {
      const repositoryId = 'repo_abc123';
      const ref = 'refs/remotes/origin/main';
      const liveHash = '1'.repeat(64);
      const deadHash = 'd'.repeat(64);
      const entries = [{ path: 'live.ts', contentHash: liveHash }];
      const commitSha = 'c'.repeat(40);
      const treeOid = computeTreeOid(entries);
      const revisionId = canonicalRevisionId({ repositoryId, commitSha, treeOid, targetRef: ref, parents: [] });
      const manifest: StoredManifest = {
        manifestId: canonicalManifestId({ repositoryId, revisionId, entries }),
        repositoryId,
        revisionId,
        commitSha,
        treeOid,
        targetRef: ref,
        entries,
        createdAt: '2026-11-04T00:00:00.000Z',
      };
      await new CanonicalManifestStore(canonical).put(manifest);
      await new CanonicalRefStore(canonical).promote(ref, {
        expectedCurrent: null,
        current: null,
        target: { commitSha: manifest.commitSha, treeOid: manifest.treeOid, manifestId: manifest.manifestId },
        targetVerified: true,
      });
      const artifacts = new CanonicalArtifactStore(canonical);
      const liveArtifactKey = fileArtifactId({
        sourceContentSha256: liveHash,
        language: 'typescript',
        sourceKind: 'source',
        representationVersion: 'v1',
      });
      await artifacts.put({
        kind: 'file',
        artifactKey: liveArtifactKey,
        repositoryId,
        sourceContentSha256: liveHash,
        language: 'typescript',
        sourceKind: 'source',
        representationVersion: 'v1',
        bindings: [{ path: 'live.ts', manifestId: manifest.manifestId }],
        createdAt: '2026-11-04T00:00:00.000Z',
      });
      const deadArtifactKey = fileArtifactId({
        sourceContentSha256: deadHash,
        language: 'typescript',
        sourceKind: 'source',
        representationVersion: 'v1',
      });
      await artifacts.put({
        kind: 'file',
        artifactKey: deadArtifactKey,
        repositoryId,
        sourceContentSha256: deadHash,
        language: 'typescript',
        sourceKind: 'source',
        representationVersion: 'v1',
        bindings: [],
        createdAt: '2026-11-04T00:00:00.000Z',
      });
      const quarantine = new ArtifactQuarantineStore(canonical);
      await quarantine.quarantine([
        deadHash,
        { kind: 'artifact-key', repositoryId, artifactKey: deadArtifactKey },
      ], { now: new Date('2026-11-01T00:00:00.000Z'), graceMs: 60_000 });

      const output: string[] = [];
      const applyErrors: string[] = [];
      const code = await runCli(['index', 'gc', 'expire', '--apply'], {
        ...createDefaultCliDependencies(),
        write: (text) => output.push(text),
        writeError: (text) => applyErrors.push(text),
      });
      expect(applyErrors, applyErrors.join('\n')).toEqual([]);
      expect(code, output.join('\n')).toBe(0);
      expect(output[0]).toContain('applied due 2 released 2 retained 0');
      expect(output[0]).toContain(`released ${deadHash}`);
      expect(output[0]).toContain(`released ${repositoryId} ${deadArtifactKey}`);

      // Artifact-key rows delete the record; content-hash rows release only.
      await expect(artifacts.has(repositoryId, deadArtifactKey)).resolves.toBe(false);
      await expect(artifacts.has(repositoryId, liveArtifactKey)).resolves.toBe(true);
      expect(await quarantine.list()).toEqual([]);
      expect(await new GcLeaseStore(canonical).read()).toBeNull();
    } finally {
      if (previousDataPath === undefined) delete process.env.UNIFIED_MPC_DATA_PATH;
      else process.env.UNIFIED_MPC_DATA_PATH = previousDataPath;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = previousXdgDataHome;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('plans quarantine expiry in dry-run mode without deleting anything', async () => {
    const content = 'a'.repeat(64);
    const artifactKey = `file:v1:${'b'.repeat(64)}`;
    const retainedKey = `file:v1:${'c'.repeat(64)}`;
    const outputs: string[] = [];
    let seenDryRun: boolean | undefined;
    const code = await runCli(['index', 'gc', 'expire', '--dry-run'], {
      ...baseDependencies,
      indexGcExpire: async (input) => {
        seenDryRun = input.dryRun;
        return {
          status: 'planned',
          expired: [content, { kind: 'artifact-key', repositoryId: 'repo_abc123', artifactKey }],
          deleted: [],
          retained: [{ kind: 'artifact-key', repositoryId: 'repo_abc123', artifactKey: retainedKey }],
        };
      },
      write: (text) => outputs.push(text),
    });
    expect(code).toBe(0);
    expect(seenDryRun).toBe(true);
    expect(outputs).toEqual([
      `planned (dry-run) expired 2 retained 1\nexpire ${content}\nexpire repo_abc123 ${artifactKey}`
        + `\nretain repo_abc123 ${retainedKey}`,
    ]);

    const applied: string[] = [];
    let appliedDryRun: boolean | undefined;
    const appliedCode = await runCli(['index', 'gc', 'expire', '--apply'], {
      ...baseDependencies,
      indexGcExpire: async (input) => {
        appliedDryRun = input.dryRun;
        return {
          status: 'planned',
          expired: [content, { kind: 'artifact-key', repositoryId: 'repo_abc123', artifactKey }],
          deleted: [content, { kind: 'artifact-key', repositoryId: 'repo_abc123', artifactKey }],
          retained: [{ kind: 'artifact-key', repositoryId: 'repo_abc123', artifactKey: retainedKey }],
        };
      },
      write: (text) => applied.push(text),
    });
    expect(appliedCode).toBe(0);
    expect(appliedDryRun).toBe(false);
    expect(applied).toEqual([
      `applied due 2 released 2 retained 1\nreleased ${content}\nreleased repo_abc123 ${artifactKey}`
        + `\nretain repo_abc123 ${retainedKey}`,
    ]);

    const refused: string[] = [];
    const refusedCode = await runCli(['index', 'gc', 'expire', '--dry-run'], {
      ...baseDependencies,
      indexGcExpire: async () => ({ status: 'refused', reason: 'no reachability roots supplied' }),
      write: (text) => refused.push(text),
    });
    expect(refusedCode).toBe(1);
    expect(refused).toEqual(['refused no reachability roots supplied']);

    const json: string[] = [];
    const jsonCode = await runCli(['index', 'gc', 'expire', '--dry-run', '--json'], {
      ...baseDependencies,
      indexGcExpire: async () => ({ status: 'planned', expired: [], deleted: [], retained: [] }),
      write: (text) => json.push(text),
    });
    expect(jsonCode).toBe(0);
    expect(JSON.parse(json[0] ?? '{}')).toEqual({ status: 'planned', expired: [], deleted: [], retained: [] });

    const usage: string[] = [];
    const usageCode = await runCli(['index', 'gc', 'expire'], {
      ...baseDependencies,
      writeError: (text) => usage.push(text),
    });
    expect(usageCode).toBe(2);
    expect(usage[0]).toContain('index gc expire (--dry-run | --apply');

    const errors: string[] = [];
    const unavailable = await runCli(['index', 'gc', 'expire', '--dry-run'], {
      ...baseDependencies,
      writeError: (text) => errors.push(text),
    });
    expect(unavailable).toBe(1);
    expect(errors).toEqual(['Canonical index service is not available']);

    const thrown: string[] = [];
    const thrownCode = await runCli(['index', 'gc', 'expire', '--dry-run'], {
      ...baseDependencies,
      indexGcExpire: async () => { throw new Error('quarantine ledger unreadable'); },
      writeError: (text) => thrown.push(text),
    });
    expect(thrownCode).toBe(1);
    expect(thrown).toEqual(['quarantine ledger unreadable']);
  });

  it('reports storage recovery failures without crashing the CLI dispatcher', async () => {
    const errors: string[] = [];
    const deps: CliDependencies = {
      ...baseDependencies,
      storageRecover: async () => { throw new Error('STORAGE_RECOVERY_AMBIGUOUS: choose a source'); },
      writeError: (text) => errors.push(text),
    };

    const code = await runCli(['storage', 'recover'], deps);
    expect(code).toBe(1);
    expect(errors).toEqual(['STORAGE_RECOVERY_AMBIGUOUS: choose a source']);
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

  it('reports startup policy repairs and failures without changing the exit code', async () => {
    const output: string[] = [];
    const errors: string[] = [];
    let received: Parameters<NonNullable<CliDependencies['web']>>[0];
    const deps: CliDependencies = {
      ...baseDependencies,
      web: async (options) => {
        received = options;
        return ok({
          handle: { close: async () => {} },
          url: `http://127.0.0.1:${options?.port ?? 3000}`,
          policyRepair: {
            scanned: 11,
            updated: ['/workspace/AGENTS.md', '/home/user/.claude/CLAUDE.md'],
            unchanged: [],
            skipped: [],
            failed: [{ file: '/home/user/.codex/AGENTS.md', message: 'EACCES' }],
          },
        });
      },
      write: (text) => output.push(text),
      writeError: (text) => errors.push(text),
    };

    const code = await runCli(['web', '--port', '18765'], deps);
    expect(code).toBe(0);
    expect(received).toEqual({ port: 18765, repairManagedPolicies: true });
    expect(output).toEqual([
      'Repaired 2 generated policy artifact(s) at startup',
      'Control Plane running on http://127.0.0.1:18765',
    ]);
    expect(errors).toEqual(['Policy repair failed for /home/user/.codex/AGENTS.md: EACCES']);
  });

  it('reports every failed artifact even when nothing was repaired', async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const deps: CliDependencies = {
      ...baseDependencies,
      web: async (options) => ok({
        handle: { close: async () => {} },
        url: `http://127.0.0.1:${options?.port ?? 3000}`,
        policyRepair: {
          scanned: 11,
          updated: [],
          unchanged: [],
          skipped: [],
          failed: [
            { file: '/workspace/AGENTS.md', message: 'EACCES' },
            { file: '/home/user/.claude/CLAUDE.md', message: 'EISDIR' },
          ],
        },
      }),
      write: (text) => output.push(text),
      writeError: (text) => errors.push(text),
    };

    // A run where every stale artifact was unreadable repairs nothing, so the
    // per-file diagnostics must not hide behind the repaired-count guard.
    const code = await runCli(['web', '--port', '18765'], deps);
    expect(code).toBe(0);
    expect(output).toEqual(['Control Plane running on http://127.0.0.1:18765']);
    expect(errors).toEqual([
      'Policy repair failed for /workspace/AGENTS.md: EACCES',
      'Policy repair failed for /home/user/.claude/CLAUDE.md: EISDIR',
    ]);
  });

  it('reports a whole-run policy repair failure without changing the exit code', async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const deps: CliDependencies = {
      ...baseDependencies,
      web: async (options) => ok({
        handle: { close: async () => {} },
        url: `http://127.0.0.1:${options?.port ?? 3000}`,
        policyRepairError: 'Failed to lock managed policy files: timed out',
      }),
      write: (text) => output.push(text),
      writeError: (text) => errors.push(text),
    };

    const code = await runCli(['web', '--port', '18765'], deps);
    expect(code).toBe(0);
    expect(output).toEqual(['Control Plane running on http://127.0.0.1:18765']);
    expect(errors).toEqual(['Policy repair failed: Failed to lock managed policy files: timed out']);
  });

  it('stays quiet when startup policy repair changed nothing', async () => {
    const output: string[] = [];
    const deps: CliDependencies = {
      ...baseDependencies,
      web: async (options) => ok({
        handle: { close: async () => {} },
        url: `http://127.0.0.1:${options?.port ?? 3000}`,
        policyRepair: { scanned: 11, updated: [], unchanged: [], skipped: [], failed: [] },
      }),
      write: (text) => output.push(text),
    };

    const code = await runCli(['web', '--port', '18765'], deps);
    expect(code).toBe(0);
    expect(output).toEqual(['Control Plane running on http://127.0.0.1:18765']);
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

  it('runs the injected doctor probes instead of the retired hardcoded pass', async () => {
    const output: string[] = [];
    const dependencies = createDefaultCliDependencies({
      doctorProbes: {
        os: async () => ({ status: 'pass', message: 'linux x64' }),
        database: async () => ({ status: 'fail', message: 'database unavailable: disk I/O error' }),
        git: async () => ({ status: 'pass', message: 'Git ready' }),
        ripgrep: async () => ({ status: 'pass', message: 'ripgrep ready' }),
        workspaces: async () => ({ status: 'pass', message: '1 workspace configured' }),
        mcpPort: async () => ({ status: 'pass', message: 'MCP port 18765 is available' }),
        codex: async () => ({ status: 'warn', message: 'Codex is not installed' }),
      },
    });

    const exitCode = await runCli(['doctor'], { ...dependencies, write: (text) => output.push(text) });

    expect(exitCode).toBe(1);
    expect(output.join('\n')).toContain('[FAIL] database: database unavailable: disk I/O error');
  });

  it('runs the real host probes when no override is supplied', async () => {
    const binDirectory = await mkdtemp(path.join(os.tmpdir(), 'doctor-bin-'));
    const dataHome = await mkdtemp(path.join(os.tmpdir(), 'doctor-data-'));
    const previousPath = process.env.PATH;
    const previousDataPath = process.env.UNIFIED_MPC_DATA_PATH;
    const previousHome = process.env.HOME;
    const previousXdgDataHome = process.env.XDG_DATA_HOME;
    try {
      for (const name of ['rg', 'git', 'codex']) {
        const binary = path.join(binDirectory, name);
        await writeFile(binary, '#!/bin/sh\nexit 0\n');
        await chmod(binary, 0o755);
      }
      process.env.PATH = binDirectory;
      process.env.UNIFIED_MPC_DATA_PATH = dataHome;
      // Keep the historical-storage drift check inside the sandbox too.
      process.env.HOME = dataHome;
      process.env.XDG_DATA_HOME = path.join(dataHome, 'xdg');

      const output: string[] = [];
      const exitCode = await runCli(['doctor'], { ...createDefaultCliDependencies(), write: (text) => output.push(text) });

      expect(exitCode, output.join('\n')).toBe(0);
      const lines = output.join('\n').split('\n');
      expect(lines).toHaveLength(7);
      expect(lines).toContain('[PASS] database: Unified MCP core operational');
      expect(lines).toContain(`[PASS] ripgrep: ripgrep ready (${path.join(binDirectory, 'rg')})`);
    } finally {
      process.env.PATH = previousPath;
      if (previousDataPath === undefined) delete process.env.UNIFIED_MPC_DATA_PATH;
      else process.env.UNIFIED_MPC_DATA_PATH = previousDataPath;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = previousXdgDataHome;
      await rm(binDirectory, { recursive: true, force: true });
      await rm(dataHome, { recursive: true, force: true });
    }
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
