import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InstallerService, type InstallSkillInput } from './installer.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function fixtureGitRunner(fixtureDir: string): { run(args: readonly string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> } {
  return {
    async run(args: readonly string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
      if (args[0] !== 'clone') return { exitCode: 1, stdout: '', stderr: `unsupported git command: ${args[0] ?? ''}` };
      const destination = args.at(-1);
      if (destination === undefined) return { exitCode: 1, stdout: '', stderr: 'missing clone destination' };
      await cp(fixtureDir, destination, { recursive: true });
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  };
}

describe('InstallerService - Skill Ingestion Pipeline', () => {
  it('materializes an HTTPS Git repository before installing a skill', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'installer-remote-skill-'));
    temporaryRoots.push(root);
    const fixture = path.join(root, 'fixture');
    const home = path.join(root, 'home');
    await mkdir(fixture, { recursive: true });
    await writeFile(path.join(fixture, 'SKILL.md'), '---\nname: remote-skill\ndescription: Remote fixture\n---\n# Remote Skill\n', 'utf8');

    const installer = new InstallerService({ homeDir: home, gitRunner: fixtureGitRunner(fixture) });
    const result = await installer.installSkill({
      name: 'remote-skill',
      source: 'https://github.com/example/remote-skill.git',
      targets: ['cursor'],
    });

    expect(result.ok).toBe(true);
    expect(await readFile(path.join(home, '.cursor', 'skills', 'remote-skill', 'SKILL.md'), 'utf8')).toContain('# Remote Skill');
  });

  it('does not copy Git metadata from a remote skill checkout into installed targets', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'installer-remote-skill-git-'));
    temporaryRoots.push(root);
    const fixture = path.join(root, 'fixture');
    const home = path.join(root, 'home');
    await mkdir(path.join(fixture, '.git'), { recursive: true });
    await writeFile(path.join(fixture, 'SKILL.md'), '---\nname: remote-skill\ndescription: Remote fixture\n---\n# Remote Skill\n', 'utf8');
    await writeFile(path.join(fixture, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');

    const result = await new InstallerService({ homeDir: home, gitRunner: fixtureGitRunner(fixture) }).installSkill({
      name: 'remote-skill',
      source: 'https://github.com/example/remote-skill.git',
      targets: ['cursor'],
    });

    expect(result.ok).toBe(true);
    await expect(readFile(path.join(home, '.cursor', 'skills', 'remote-skill', '.git', 'HEAD'), 'utf8')).rejects.toThrow();
  });

  it('rejects symlinks from untrusted remote skill repositories', async () => {
    const { symlink } = await import('node:fs/promises');
    const root = await mkdtemp(path.join(os.tmpdir(), 'installer-remote-skill-link-'));
    temporaryRoots.push(root);
    const fixture = path.join(root, 'fixture');
    const home = path.join(root, 'home');
    const outside = path.join(root, 'outside.txt');
    await mkdir(fixture, { recursive: true });
    await writeFile(path.join(fixture, 'SKILL.md'), '---\nname: remote-skill\ndescription: Remote fixture\n---\n# Remote Skill\n', 'utf8');
    await writeFile(outside, 'outside\n', 'utf8');
    await symlink(outside, path.join(fixture, 'outside-link'));

    const result = await new InstallerService({ homeDir: home, gitRunner: fixtureGitRunner(fixture) }).installSkill({
      name: 'remote-skill',
      source: 'https://github.com/example/remote-skill.git',
      targets: ['cursor'],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_INPUT');
      expect(result.error.message).toContain('symbolic links');
    }
  });

  it('returns FILE_NOT_FOUND when source does not contain SKILL.md', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'installer-test-'));
    temporaryRoots.push(root);
    const home = path.join(root, 'home');
    const emptySource = path.join(root, 'empty-dir');
    await mkdir(home, { recursive: true });
    await mkdir(emptySource, { recursive: true });

    const installer = new InstallerService({ homeDir: home });
    const input: InstallSkillInput = {
      name: 'broken-skill',
      source: emptySource,
      targets: ['antigravity'],
    };

    const result = await installer.installSkill(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FILE_NOT_FOUND');
      expect(result.error.message).toContain('SKILL.md');
    }
  });

  it('installs skill into global targets (antigravity, cline, cursor, claude, opencode)', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'installer-test-'));
    temporaryRoots.push(root);
    const home = path.join(root, 'home');
    const sourceDir = path.join(root, 'source-skill');
    await mkdir(home, { recursive: true });
    await mkdir(sourceDir, { recursive: true });

    await writeFile(
      path.join(sourceDir, 'SKILL.md'),
      '---\nname: my-skill\ndescription: Test skill description\n---\n# My Skill\nRun commands.\n',
      'utf8',
    );
    await writeFile(path.join(sourceDir, 'helper.sh'), '#!/bin/bash\necho "hello"\n', 'utf8');

    const installer = new InstallerService({ homeDir: home });
    const result = await installer.installSkill({
      name: 'my-skill',
      source: sourceDir,
      targets: ['antigravity', 'cline', 'cursor', 'claude', 'opencode'],
      scope: 'global',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.name).toBe('my-skill');
    expect(result.value.installedPaths).toHaveLength(5);

    // Verify Antigravity global
    const agSkill = path.join(home, '.gemini', 'config', 'skills', 'my-skill', 'SKILL.md');
    const agContent = await readFile(agSkill, 'utf8');
    expect(agContent).toContain('# My Skill');

    // Verify Cline global
    const clineSkill = path.join(home, '.cline', 'skills', 'my-skill', 'SKILL.md');
    const clineContent = await readFile(clineSkill, 'utf8');
    expect(clineContent).toContain('# My Skill');

    // Verify Cursor global
    const cursorSkill = path.join(home, '.cursor', 'skills', 'my-skill', 'SKILL.md');
    const cursorContent = await readFile(cursorSkill, 'utf8');
    expect(cursorContent).toContain('# My Skill');

    // Verify Claude global
    const claudeSkill = path.join(home, '.claude', 'skills', 'my-skill', 'SKILL.md');
    const claudeContent = await readFile(claudeSkill, 'utf8');
    expect(claudeContent).toContain('# My Skill');

    // Verify OpenCode global
    const opencodeSkill = path.join(home, '.config', 'opencode', 'skill', 'my-skill', 'SKILL.md');
    const opencodeContent = await readFile(opencodeSkill, 'utf8');
    expect(opencodeContent).toContain('# My Skill');

    // Verify companion files copied
    const helperFile = path.join(home, '.gemini', 'config', 'skills', 'my-skill', 'helper.sh');
    const helperContent = await readFile(helperFile, 'utf8');
    expect(helperContent).toContain('echo "hello"');
  });

  it('installs skill into workspace targets when scope is workspace', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'installer-test-ws-'));
    temporaryRoots.push(root);
    const home = path.join(root, 'home');
    const workspace = path.join(root, 'workspace');
    const sourceDir = path.join(root, 'ws-skill');
    await mkdir(home, { recursive: true });
    await mkdir(workspace, { recursive: true });
    await mkdir(sourceDir, { recursive: true });

    await writeFile(
      path.join(sourceDir, 'SKILL.md'),
      '---\nname: ws-tool\ndescription: Workspace tool\n---\n# WS Tool\n',
      'utf8',
    );

    const installer = new InstallerService({
      homeDir: home,
      workspaceRoot: workspace,
    });

    const result = await installer.installSkill({
      name: 'ws-tool',
      source: sourceDir,
      targets: ['all'],
      scope: 'workspace',
      workspaceRoot: workspace,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Verify workspace paths
    const wsAg = path.join(workspace, '.gemini', 'skills', 'ws-tool', 'SKILL.md');
    expect(await readFile(wsAg, 'utf8')).toContain('# WS Tool');

    const wsCline = path.join(workspace, '.cline', 'skills', 'ws-tool', 'SKILL.md');
    expect(await readFile(wsCline, 'utf8')).toContain('# WS Tool');

    const wsCursor = path.join(workspace, '.cursor', 'skills', 'ws-tool', 'SKILL.md');
    expect(await readFile(wsCursor, 'utf8')).toContain('# WS Tool');

    const wsClaude = path.join(workspace, '.claude', 'skills', 'ws-tool', 'SKILL.md');
    expect(await readFile(wsClaude, 'utf8')).toContain('# WS Tool');

    const wsOpenCode = path.join(workspace, '.opencode', 'skills', 'ws-tool', 'SKILL.md');
    expect(await readFile(wsOpenCode, 'utf8')).toContain('# WS Tool');
  });
});

describe('InstallerService - Server Ingestion Pipeline', () => {
  it('materializes an HTTPS Git repository and derives a stdio command from package.json bin', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'installer-remote-server-'));
    temporaryRoots.push(root);
    const fixture = path.join(root, 'fixture');
    const home = path.join(root, 'home');
    await mkdir(fixture, { recursive: true });
    await writeFile(path.join(fixture, 'package.json'), JSON.stringify({ name: 'remote-mcp', bin: 'server.js' }), 'utf8');
    await writeFile(path.join(fixture, 'server.js'), '#!/usr/bin/env node\n', 'utf8');

    const installer = new InstallerService({ homeDir: home, gitRunner: fixtureGitRunner(fixture) });
    const result = await installer.installServer({
      name: 'remote-mcp',
      transport: 'stdio',
      source: 'https://github.com/example/remote-mcp.git',
      targets: ['cursor'],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.managedSourcePath).toEqual(expect.any(String));
    const config = JSON.parse(await readFile(path.join(home, '.cursor', 'mcp.json'), 'utf8'));
    expect(config.mcpServers['remote-mcp']).toEqual({
      command: process.execPath,
      args: [path.join(result.value.managedSourcePath, 'server.js')],
      cwd: result.value.managedSourcePath,
    });
  });

  it('fails closed for remote MCP packages that require runtime dependency installation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'installer-remote-server-deps-'));
    temporaryRoots.push(root);
    const fixture = path.join(root, 'fixture');
    const home = path.join(root, 'home');
    await mkdir(fixture, { recursive: true });
    await writeFile(path.join(fixture, 'package.json'), JSON.stringify({
      name: 'remote-mcp',
      bin: 'server.js',
      dependencies: { express: '^5.0.0' },
    }), 'utf8');
    await writeFile(path.join(fixture, 'server.js'), '#!/usr/bin/env node\n', 'utf8');

    const result = await new InstallerService({ homeDir: home, gitRunner: fixtureGitRunner(fixture) }).installServer({
      name: 'remote-mcp',
      transport: 'stdio',
      source: 'https://github.com/example/remote-mcp.git',
      targets: ['cursor'],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_INPUT');
      expect(result.error.message).toContain('runtime dependencies');
    }
  });

  it('rejects self-aggregation attempts to install unified-mpc', async () => {
    const installer = new InstallerService();
    const result = await installer.installServer({
      name: 'unified-mpc',
      transport: 'stdio',
      command: 'node',
      targets: ['antigravity'],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_INPUT');
      expect(result.error.message).toContain('Refusing to aggregate unified-mpc itself');
    }
  });

  it('rejects unsupported targets instead of reporting a no-op success', async () => {
    const installer = new InstallerService({ homeDir: '/tmp/unified-mpc-installer-test' });
    const result = await installer.installServer({
      name: 'fixture',
      transport: 'stdio',
      command: 'node',
      targets: ['not-a-target' as never],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('UNSUPPORTED_TARGET');
      expect(result.error.message).toContain('not-a-target');
      expect(result.error.message).toContain('antigravity');
    }
  });

  it('rejects stdio server when command is missing', async () => {
    const installer = new InstallerService();
    const result = await installer.installServer({
      name: 'broken-server',
      transport: 'stdio',
      targets: ['cursor'],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_INPUT');
      expect(result.error.message).toContain('Command is required');
    }
  });

  it('rejects invalid server identifiers, transports, and scopes at runtime', async () => {
    const installer = new InstallerService();
    const cases = [
      { name: 'bad/name', transport: 'stdio', command: 'node', targets: ['cursor'] },
      { name: 'fixture', transport: 'ws', url: 'https://example.com', targets: ['cursor'] },
      { name: 'fixture', transport: 'stdio', command: 'node', targets: ['cursor'], scope: 'machine' },
    ] as const;
    for (const input of cases) {
      const result = await installer.installServer(input as never);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('INVALID_INPUT');
    }
  });

  it('fails closed instead of replacing malformed config with an empty config', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'installer-malformed-'));
    temporaryRoots.push(root);
    const home = path.join(root, 'home');
    const cursorDir = path.join(home, '.cursor');
    await mkdir(cursorDir, { recursive: true });
    const configFile = path.join(cursorDir, 'mcp.json');
    await writeFile(configFile, '{ malformed', 'utf8');

    const result = await new InstallerService({ homeDir: home }).installServer({
      name: 'fixture', transport: 'stdio', command: 'node', targets: ['cursor'], scope: 'global',
    });
    expect(result.ok).toBe(false);
    expect(await readFile(configFile, 'utf8')).toBe('{ malformed');
  });

  it('rolls back earlier target config writes when a later target fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'installer-rollback-'));
    temporaryRoots.push(root);
    const home = path.join(root, 'home');
    const appData = path.join(home, '.config');
    const claudeFile = path.join(appData, 'Claude', 'claude_desktop_config.json');
    await mkdir(path.dirname(claudeFile), { recursive: true });
    await writeFile(claudeFile, '{ malformed', 'utf8');

    const cursorFile = path.join(home, '.cursor', 'mcp.json');
    const result = await new InstallerService({ homeDir: home, appDataDir: appData }).installServer({
      name: 'rollback-server',
      transport: 'stdio',
      command: 'node',
      targets: ['cursor', 'claude'],
      scope: 'global',
    });

    expect(result.ok).toBe(false);
    await expect(readFile(cursorFile, 'utf8')).rejects.toThrow();
    expect(await readFile(claudeFile, 'utf8')).toBe('{ malformed');
  });

  it('installs stdio server into global target configs (antigravity, cursor, claude, cline, opencode)', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'installer-srv-test-'));
    temporaryRoots.push(root);
    const home = path.join(root, 'home');
    const appData = path.join(home, '.config');
    await mkdir(home, { recursive: true });

    // Pre-create some configs to test merging
    const agConfigDir = path.join(home, '.gemini', 'config');
    await mkdir(agConfigDir, { recursive: true });
    await writeFile(path.join(agConfigDir, 'mcp_config.json'), JSON.stringify({
      mcpServers: { 'existing-server': { command: 'existing-bin' } },
    }), 'utf8');

    const installer = new InstallerService({
      homeDir: home,
      appDataDir: appData,
    });

    const result = await installer.installServer({
      name: 'playwright-tool',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@playwright/mcp'],
      env: { DEBUG: 'pw:*' },
      targets: ['antigravity', 'cursor', 'claude', 'cline', 'opencode'],
      scope: 'global',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.name).toBe('playwright-tool');
    expect(result.value.updatedConfigFiles).toHaveLength(5);

    // 1. Antigravity config
    const agContent = JSON.parse(await readFile(path.join(agConfigDir, 'mcp_config.json'), 'utf8'));
    expect(agContent.mcpServers['existing-server']).toBeDefined();
    expect(agContent.mcpServers['playwright-tool']).toEqual({
      command: 'npx',
      args: ['-y', '@playwright/mcp'],
      env: { DEBUG: 'pw:*' },
    });

    // 2. Cursor config
    const cursorFile = path.join(home, '.cursor', 'mcp.json');
    const cursorContent = JSON.parse(await readFile(cursorFile, 'utf8'));
    expect(cursorContent.mcpServers['playwright-tool'].command).toBe('npx');

    // 3. Claude config
    const claudeFile = path.join(appData, 'Claude', 'claude_desktop_config.json');
    const claudeContent = JSON.parse(await readFile(claudeFile, 'utf8'));
    expect(claudeContent.mcpServers['playwright-tool'].command).toBe('npx');

    // 4. Cline config
    const clineFile = path.join(appData, 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json');
    const clineContent = JSON.parse(await readFile(clineFile, 'utf8'));
    expect(clineContent.mcpServers['playwright-tool'].command).toBe('npx');

    // 5. OpenCode config
    const opencodeFile = path.join(home, '.config', 'opencode', 'opencode.json');
    const opencodeContent = JSON.parse(await readFile(opencodeFile, 'utf8'));
    expect(opencodeContent.mcpServers['playwright-tool'].command).toBe('npx');
  });

  it('installs server into workspace target configs when scope is workspace', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'installer-srv-ws-'));
    temporaryRoots.push(root);
    const home = path.join(root, 'home');
    const workspace = path.join(root, 'workspace');
    await mkdir(home, { recursive: true });
    await mkdir(workspace, { recursive: true });

    const installer = new InstallerService({
      homeDir: home,
      workspaceRoot: workspace,
    });

    const result = await installer.installServer({
      name: 'workspace-helper',
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      targets: ['all'],
      scope: 'workspace',
      workspaceRoot: workspace,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Verify workspace configs
    const agWs = JSON.parse(await readFile(path.join(workspace, '.gemini', 'mcp.json'), 'utf8'));
    expect(agWs.mcpServers['workspace-helper'].command).toBe('node');

    const clineWs = JSON.parse(await readFile(path.join(workspace, '.cline', 'mcp.json'), 'utf8'));
    expect(clineWs.mcpServers['workspace-helper'].command).toBe('node');

    const cursorWs = JSON.parse(await readFile(path.join(workspace, '.cursor', 'mcp.json'), 'utf8'));
    expect(cursorWs.mcpServers['workspace-helper'].command).toBe('node');

    const claudeWs = JSON.parse(await readFile(path.join(workspace, '.claude', 'mcp.json'), 'utf8'));
    expect(claudeWs.mcpServers['workspace-helper'].command).toBe('node');

    const opencodeWs = JSON.parse(await readFile(path.join(workspace, '.opencode', 'mcp.json'), 'utf8'));
    expect(opencodeWs.mcpServers['workspace-helper'].command).toBe('node');
  });
});

