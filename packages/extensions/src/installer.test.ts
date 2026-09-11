import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InstallerService, type InstallSkillInput } from './installer.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('InstallerService - Skill Ingestion Pipeline', () => {
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

