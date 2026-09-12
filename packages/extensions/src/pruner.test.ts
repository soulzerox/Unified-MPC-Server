import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InstallerService } from './installer.js';
import { PrunerService } from './pruner.js';
import type { McpSessionManager } from './mcp-session-manager.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('PrunerService - Skill Pruning Pipeline', () => {
  it('removes skill directory across global targets (antigravity, cline, cursor, claude, opencode)', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pruner-test-'));
    temporaryRoots.push(root);
    const home = path.join(root, 'home');
    await mkdir(home, { recursive: true });

    // Pre-create skill directories across all targets
    const agSkillDir = path.join(home, '.gemini', 'config', 'skills', 'old-skill');
    const clineSkillDir = path.join(home, '.cline', 'skills', 'old-skill');
    const cursorSkillDir = path.join(home, '.cursor', 'skills', 'old-skill');
    const claudeSkillDir = path.join(home, '.claude', 'skills', 'old-skill');
    const opencodeSkillDir = path.join(home, '.config', 'opencode', 'skill', 'old-skill');

    for (const dir of [agSkillDir, clineSkillDir, cursorSkillDir, claudeSkillDir, opencodeSkillDir]) {
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'SKILL.md'), '# Old Skill\n', 'utf8');
      await writeFile(path.join(dir, 'extra.txt'), 'extra\n', 'utf8');
    }

    const pruner = new PrunerService({ homeDir: home });
    const result = await pruner.pruneSkill({
      name: 'old-skill',
      targets: ['antigravity', 'cline', 'cursor', 'claude', 'opencode'],
      scope: 'global',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.name).toBe('old-skill');
    expect(result.value.removedPaths).toHaveLength(5);

    // Verify all directories are completely removed (zero lingering artifacts)
    for (const dir of [agSkillDir, clineSkillDir, cursorSkillDir, claudeSkillDir, opencodeSkillDir]) {
      await expect(stat(dir)).rejects.toThrow();
    }
  });

  it('removes skill directory across workspace targets when scope is workspace', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pruner-ws-test-'));
    temporaryRoots.push(root);
    const home = path.join(root, 'home');
    const workspace = path.join(root, 'workspace');
    await mkdir(home, { recursive: true });
    await mkdir(workspace, { recursive: true });

    // Pre-create workspace skill directories
    const wsAgSkill = path.join(workspace, '.gemini', 'skills', 'ws-skill');
    const wsClineSkill = path.join(workspace, '.cline', 'skills', 'ws-skill');
    const wsCursorSkill = path.join(workspace, '.cursor', 'skills', 'ws-skill');
    const wsClaudeSkill = path.join(workspace, '.claude', 'skills', 'ws-skill');
    const wsOpenCodeSkill = path.join(workspace, '.opencode', 'skills', 'ws-skill');

    for (const dir of [wsAgSkill, wsClineSkill, wsCursorSkill, wsClaudeSkill, wsOpenCodeSkill]) {
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'SKILL.md'), '# WS Skill\n', 'utf8');
    }

    const pruner = new PrunerService({ homeDir: home, workspaceRoot: workspace });
    const result = await pruner.pruneSkill({
      name: 'ws-skill',
      targets: ['all'],
      scope: 'workspace',
      workspaceRoot: workspace,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    for (const dir of [wsAgSkill, wsClineSkill, wsCursorSkill, wsClaudeSkill, wsOpenCodeSkill]) {
      await expect(stat(dir)).rejects.toThrow();
    }
  });

  it('is idempotent when target skill directory does not exist', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pruner-idempotent-'));
    temporaryRoots.push(root);
    const home = path.join(root, 'home');
    await mkdir(home, { recursive: true });

    const pruner = new PrunerService({ homeDir: home });
    const result = await pruner.pruneSkill({
      name: 'non-existent-skill',
      targets: ['antigravity', 'cursor'],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.removedPaths).toEqual([]);
  });

  it('rejects invalid skill names and path traversal attempts with INVALID_INPUT', async () => {
    const pruner = new PrunerService({ homeDir: '/tmp' });
    const cases = ['', '   ', '../../etc', 'invalid/name', 'skill name', 'name$*'];
    for (const name of cases) {
      const result = await pruner.pruneSkill({ name, targets: ['antigravity'] });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INVALID_INPUT');
      }
    }
  });

  it('rejects unsupported skill targets instead of reporting success', async () => {
    const result = await new PrunerService({ homeDir: '/tmp' }).pruneSkill({
      name: 'fixture',
      targets: ['unknown' as never],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('UNSUPPORTED_TARGET');
  });
});

describe('PrunerService - Server Pruning Pipeline', () => {
  it('purges server entry from global configs while preserving other servers', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pruner-srv-test-'));
    temporaryRoots.push(root);
    const home = path.join(root, 'home');
    const appData = path.join(home, '.config');
    await mkdir(home, { recursive: true });

    // 1. Antigravity config with target server and keeper server
    const agDir = path.join(home, '.gemini', 'config');
    await mkdir(agDir, { recursive: true });
    await writeFile(path.join(agDir, 'mcp_config.json'), JSON.stringify({
      mcpServers: {
        'doomed-server': { command: 'node', args: ['doomed.js'] },
        'keep-server': { command: 'node', args: ['keep.js'] },
      },
    }), 'utf8');

    // 2. Cursor config
    const cursorDir = path.join(home, '.cursor');
    await mkdir(cursorDir, { recursive: true });
    await writeFile(path.join(cursorDir, 'mcp.json'), JSON.stringify({
      mcpServers: {
        'doomed-server': { command: 'node' },
      },
    }), 'utf8');

    // 3. Claude config
    const claudeDir = path.join(appData, 'Claude');
    await mkdir(claudeDir, { recursive: true });
    await writeFile(path.join(claudeDir, 'claude_desktop_config.json'), JSON.stringify({
      mcpServers: {
        'doomed-server': { command: 'node' },
        'claude-keeper': { command: 'keeper' },
      },
    }), 'utf8');

    // 4. Cline config
    const clineDir = path.join(appData, 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings');
    await mkdir(clineDir, { recursive: true });
    await writeFile(path.join(clineDir, 'cline_mcp_settings.json'), JSON.stringify({
      mcpServers: {
        'doomed-server': { command: 'node' },
      },
    }), 'utf8');

    // 5. OpenCode config
    const opencodeDir = path.join(home, '.config', 'opencode');
    await mkdir(opencodeDir, { recursive: true });
    await writeFile(path.join(opencodeDir, 'opencode.json'), JSON.stringify({
      mcpServers: {
        'doomed-server': { command: 'node' },
      },
    }), 'utf8');

    const pruner = new PrunerService({ homeDir: home, appDataDir: appData });
    const result = await pruner.pruneServer({
      name: 'doomed-server',
      targets: ['antigravity', 'cursor', 'claude', 'cline', 'opencode'],
      scope: 'global',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.name).toBe('doomed-server');
    expect(result.value.updatedConfigFiles).toHaveLength(5);

    // Verify 'doomed-server' is purged while keeper servers remain untouched
    const agConfig = JSON.parse(await readFile(path.join(agDir, 'mcp_config.json'), 'utf8'));
    expect(agConfig.mcpServers['doomed-server']).toBeUndefined();
    expect(agConfig.mcpServers['keep-server']).toBeDefined();

    const cursorConfig = JSON.parse(await readFile(path.join(cursorDir, 'mcp.json'), 'utf8'));
    expect(cursorConfig.mcpServers['doomed-server']).toBeUndefined();

    const claudeConfig = JSON.parse(await readFile(path.join(claudeDir, 'claude_desktop_config.json'), 'utf8'));
    expect(claudeConfig.mcpServers['doomed-server']).toBeUndefined();
    expect(claudeConfig.mcpServers['claude-keeper']).toBeDefined();

    const clineConfig = JSON.parse(await readFile(path.join(clineDir, 'cline_mcp_settings.json'), 'utf8'));
    expect(clineConfig.mcpServers['doomed-server']).toBeUndefined();

    const opencodeConfig = JSON.parse(await readFile(path.join(opencodeDir, 'opencode.json'), 'utf8'));
    expect(opencodeConfig.mcpServers['doomed-server']).toBeUndefined();
  });

  it('purges server entry and associated data dirs and broken symlinks', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pruner-cleanup-test-'));
    temporaryRoots.push(root);
    const home = path.join(root, 'home');
    const dataDir = path.join(home, 'runtime-data');
    await mkdir(home, { recursive: true });
    await mkdir(dataDir, { recursive: true });
    await writeFile(path.join(dataDir, 'cache.bin'), 'data', 'utf8');

    const pruner = new PrunerService({ homeDir: home, workspaceId: 'workspace-1' });
    const result = await pruner.pruneServer({
      name: 'cached-server',
      targets: ['antigravity'],
      scope: 'workspace',
      workspaceRoot: home,
      purgeDataDirs: [dataDir],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.removedPaths).toContain(dataDir);
    await expect(stat(dataDir)).rejects.toThrow();
  });

  it('rejects purge paths that traverse a symlink outside an allowed root', async () => {
    const { symlink } = await import('node:fs/promises');
    const root = await mkdtemp(path.join(os.tmpdir(), 'pruner-symlink-boundary-test-'));
    temporaryRoots.push(root);
    const home = path.join(root, 'home');
    const outside = path.join(root, 'outside');
    const victim = path.join(outside, 'victim');
    await mkdir(home, { recursive: true });
    await mkdir(victim, { recursive: true });
    await symlink(outside, path.join(home, 'link'));

    const result = await new PrunerService({ homeDir: home, workspaceId: 'workspace-1' }).pruneServer({
      name: 'fixture',
      targets: ['antigravity'],
      scope: 'workspace',
      workspaceRoot: home,
      purgeDataDirs: [path.join(home, 'link', 'victim')],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('PERMISSION_DENIED');
    await expect(stat(victim)).resolves.toBeDefined();
  });

  it('scans and purges broken dangling symlinks', async () => {
    const { symlink } = await import('node:fs/promises');
    const { cleanOrphanedArtifacts } = await import('./pruner.js');
    const root = await mkdtemp(path.join(os.tmpdir(), 'pruner-symlink-test-'));
    temporaryRoots.push(root);

    const scanDir = path.join(root, 'scan-me');
    await mkdir(scanDir, { recursive: true });

    // Valid file and valid symlink
    const validTarget = path.join(root, 'valid-target.txt');
    await writeFile(validTarget, 'hello', 'utf8');
    const validLink = path.join(scanDir, 'valid-link');
    await symlink(validTarget, validLink);

    // Broken symlink pointing to non-existent target
    const brokenLink = path.join(scanDir, 'broken-link');
    await symlink(path.join(root, 'non-existent-target.txt'), brokenLink);

    const removed = await cleanOrphanedArtifacts([scanDir]);
    expect(removed).toContain(brokenLink);
    expect(removed).not.toContain(validLink);

    // Broken link is gone
    const { lstat } = await import('node:fs/promises');
    await expect(lstat(brokenLink)).rejects.toThrow();

    // Valid link remains
    const validStat = await lstat(validLink);
    expect(validStat.isSymbolicLink()).toBe(true);
  });

  it('rejects invalid server names and path traversal attempts with INVALID_INPUT', async () => {
    const pruner = new PrunerService({ homeDir: '/tmp' });
    const cases = ['', '   ', '../../etc', 'invalid/name', 'server name', 'name$*'];
    for (const name of cases) {
      const result = await pruner.pruneServer({ name, targets: ['antigravity'] });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INVALID_INPUT');
      }
    }
  });

  it('rejects unsafe purgeDataDirs outside allowed root boundaries (path traversal guard)', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pruner-guard-test-'));
    temporaryRoots.push(root);
    const home = path.join(root, 'home');
    const safeDataDir = path.join(home, '.config', 'my-server-data');
    await mkdir(safeDataDir, { recursive: true });

    const pruner = new PrunerService({ homeDir: home, workspaceId: 'workspace-1' });

    // Attempting to purge unsafe paths (system root, /etc, parent traversal, home itself)
    const unsafePaths = ['/etc', '/usr', '/', home, path.join(home, '..')];
    for (const unsafePath of unsafePaths) {
      const result = await pruner.pruneServer({
        name: 'test-server',
        targets: ['antigravity'],
        scope: 'workspace',
        workspaceRoot: home,
        purgeDataDirs: [unsafePath],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('PERMISSION_DENIED');
      }
    }
  });

  it('rejects recoverable server pruning without a workspace identity', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pruner-recovery-test-'));
    temporaryRoots.push(root);
    const home = path.join(root, 'home');
    const dataDir = path.join(home, '.config', 'server-data');
    const recoveryRoot = path.join(root, 'recovery-trash');
    await mkdir(dataDir, { recursive: true });
    await writeFile(path.join(dataDir, 'state.json'), '{"safe":true}\n', 'utf8');

    const result = await new PrunerService({ homeDir: home, recoveryTrashRoot: recoveryRoot }).pruneServer({
      name: 'fixture',
      targets: ['antigravity'],
      purgeDataDirs: [dataDir],
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'WORKSPACE_NOT_FOUND' } });
    await expect(stat(dataDir)).resolves.toBeDefined();
  });

  it('rejects recoverable server pruning without workspace scope and root', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pruner-recovery-scope-'));
    temporaryRoots.push(root);
    const dataDir = path.join(root, 'data');
    await mkdir(dataDir, { recursive: true });
    const result = await new PrunerService({ homeDir: root, workspaceId: 'workspace-1' }).pruneServer({
      name: 'fixture', targets: ['antigravity'], purgeDataDirs: [dataDir],
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'WORKSPACE_NOT_FOUND' } });
    await expect(stat(dataDir)).resolves.toBeDefined();
  });

  it('writes workspace-scoped recovery metadata when workspace identity is provided', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pruner-recovery-workspace-'));
    temporaryRoots.push(root);
    const home = path.join(root, 'home');
    const dataDir = path.join(home, '.config', 'server-data');
    const recoveryRoot = path.join(root, 'recovery-trash');
    await mkdir(dataDir, { recursive: true });
    await writeFile(path.join(dataDir, 'state.json'), '{"safe":true}\n', 'utf8');

    const result = await new PrunerService({
      homeDir: home,
      recoveryTrashRoot: recoveryRoot,
      workspaceId: 'workspace-1',
    }).pruneServer({
      name: 'fixture',
      targets: ['antigravity'],
      workspaceRoot: home,
      scope: 'workspace',
      purgeDataDirs: [dataDir],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const recoveryBase = path.join(recoveryRoot, 'workspace-1', result.value.recoveryIds[0]!);
    await expect(readFile(path.join(recoveryBase, 'metadata.json'), 'utf8')).resolves.toMatchObject(
      /"version": 2[\s\S]*"workspaceId": "workspace-1"[\s\S]*"state": "moved"[\s\S]*"relativePath":/,
    );
    await expect(stat(path.join(recoveryBase, 'payload', 'state.json'))).resolves.toBeDefined();
  });

  it('rejects workspace data recovery without an explicit workspace identity', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pruner-recovery-missing-workspace-'));
    temporaryRoots.push(root);
    const home = path.join(root, 'home');
    const dataDir = path.join(home, '.config', 'server-data');
    await mkdir(dataDir, { recursive: true });
    await writeFile(path.join(dataDir, 'state.json'), '{"safe":true}\n', 'utf8');

    const result = await new PrunerService({ homeDir: home }).pruneServer({
      name: 'fixture',
      targets: ['antigravity'],
      workspaceRoot: home,
      scope: 'workspace',
      purgeDataDirs: [dataDir],
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'WORKSPACE_NOT_FOUND' } });
    await expect(stat(dataDir)).resolves.toBeDefined();
  });

  it('restores moved data when session termination fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pruner-recovery-rollback-'));
    temporaryRoots.push(root);
    const home = path.join(root, 'home');
    const dataDir = path.join(home, '.config', 'server-data');
    await mkdir(dataDir, { recursive: true });
    await writeFile(path.join(dataDir, 'state.json'), 'preserve me', 'utf8');
    const result = await new PrunerService({
      homeDir: home,
      recoveryTrashRoot: path.join(root, 'recovery-trash'),
      workspaceId: 'workspace-1',
      sessionManager: { dropServer: async (): Promise<void> => { throw new Error('stop failed'); } } as unknown as McpSessionManager,
    }).pruneServer({ name: 'fixture', targets: ['antigravity'], scope: 'workspace', workspaceRoot: home, purgeDataDirs: [dataDir] });

    expect(result).toMatchObject({ ok: false, error: { details: { recoveryStatus: 'partial' } } });
    expect(await readFile(path.join(dataDir, 'state.json'), 'utf8')).toBe('preserve me');
  });

  it('purges server entry from workspace configs when scope is workspace', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pruner-ws-srv-test-'));
    temporaryRoots.push(root);
    const home = path.join(root, 'home');
    const workspace = path.join(root, 'workspace');
    await mkdir(home, { recursive: true });
    await mkdir(workspace, { recursive: true });

    // Create workspace config files for antigravity and cursor
    const agDir = path.join(workspace, '.gemini');
    await mkdir(agDir, { recursive: true });
    await writeFile(path.join(agDir, 'mcp.json'), JSON.stringify({
      mcpServers: { 'ws-server': { command: 'node' } },
    }), 'utf8');

    const cursorDir = path.join(workspace, '.cursor');
    await mkdir(cursorDir, { recursive: true });
    await writeFile(path.join(cursorDir, 'mcp.json'), JSON.stringify({
      mcpServers: { 'ws-server': { command: 'node' } },
    }), 'utf8');

    const pruner = new PrunerService({ homeDir: home, workspaceRoot: workspace });
    const result = await pruner.pruneServer({
      name: 'ws-server',
      targets: ['antigravity', 'cursor'],
      scope: 'workspace',
      workspaceRoot: workspace,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.updatedConfigFiles).toHaveLength(2);
    const agConfig = JSON.parse(await readFile(path.join(agDir, 'mcp.json'), 'utf8'));
    expect(agConfig.mcpServers['ws-server']).toBeUndefined();
  });

  it('fails closed and preserves malformed server config', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pruner-malformed-config-'));
    temporaryRoots.push(root);
    const home = path.join(root, 'home');
    const configFile = path.join(home, '.cursor', 'mcp.json');
    await mkdir(path.dirname(configFile), { recursive: true });
    await writeFile(configFile, '{ malformed', 'utf8');

    const result = await new PrunerService({ homeDir: home }).pruneServer({
      name: 'fixture',
      targets: ['cursor'],
      scope: 'global',
    });

    expect(result.ok).toBe(false);
    expect(await readFile(configFile, 'utf8')).toBe('{ malformed');
  });

  it('drops server session from McpSessionManager during pruning', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pruner-session-test-'));
    temporaryRoots.push(root);
    const home = path.join(root, 'home');
    await mkdir(home, { recursive: true });

    let droppedServerName: string | undefined;
    const fakeSessionManager = {
      dropServer: async (name: string): Promise<void> => {
        droppedServerName = name;
      },
    };

    const pruner = new PrunerService({
      homeDir: home,
      sessionManager: fakeSessionManager as unknown as McpSessionManager,
    });

    const result = await pruner.pruneServer({
      name: 'active-session-server',
      targets: ['antigravity'],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(droppedServerName).toBe('active-session-server');
    expect(result.value.processTerminated).toBe(true);
  });

  it('fails closed when session termination fails', async () => {
    const sessionManager = { dropServer: async (): Promise<void> => { throw new Error('termination failed'); } };
    const result = await new PrunerService({ sessionManager: sessionManager as unknown as McpSessionManager }).pruneServer({
      name: 'active-session-server',
      targets: ['antigravity'],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INTERNAL_ERROR');
  });

  it('fails closed and restores config when session termination fails after config purge', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pruner-session-rollback-'));
    temporaryRoots.push(root);
    const home = path.join(root, 'home');
    const configFile = path.join(home, '.cursor', 'mcp.json');
    await mkdir(path.dirname(configFile), { recursive: true });
    const original = JSON.stringify({ mcpServers: { 'active-session-server': { command: 'node' } } });
    await writeFile(configFile, original, 'utf8');
    const sessionManager = { dropServer: async (): Promise<void> => { throw new Error('termination failed'); } };

    const result = await new PrunerService({
      homeDir: home,
      sessionManager: sessionManager as unknown as McpSessionManager,
    }).pruneServer({ name: 'active-session-server', targets: ['cursor'], scope: 'global' });

    expect(result.ok).toBe(false);
    expect(await readFile(configFile, 'utf8')).toBe(original);
  });

  it('serializes concurrent install and prune mutations without losing updates', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mutation-lock-test-'));
    temporaryRoots.push(root);
    const home = path.join(root, 'home');
    const cursorDir = path.join(home, '.cursor');
    const configFile = path.join(cursorDir, 'mcp.json');
    await mkdir(cursorDir, { recursive: true });

    const existingServers = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [`old-${index}`, { command: 'old' }]),
    );
    await writeFile(configFile, JSON.stringify({ mcpServers: existingServers }), 'utf8');

    const installer = new InstallerService({ homeDir: home });
    const pruner = new PrunerService({ homeDir: home });
    const operations = [
      ...Array.from({ length: 10 }, (_, index) => installer.installServer({
        name: `new-${index}`,
        transport: 'stdio' as const,
        command: 'node',
        targets: ['cursor' as const],
      })),
      ...Array.from({ length: 10 }, (_, index) => pruner.pruneServer({
        name: `old-${index}`,
        targets: ['cursor' as const],
        scope: 'global' as const,
      })),
    ];

    const results = await Promise.all(operations);
    expect(results.every((result) => result.ok)).toBe(true);
    const content = JSON.parse(await readFile(configFile, 'utf8')) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(content.mcpServers)).toHaveLength(10);
    for (let index = 0; index < 10; index += 1) {
      expect(content.mcpServers[`new-${index}`]).toBeDefined();
      expect(content.mcpServers[`old-${index}`]).toBeUndefined();
    }
  });
});

