import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_EXTENSIONS_SETTINGS } from './types.js';
import { defaultApplicationDataDirectory, exclusionReason, McpConfigLoader } from './mcp-config-loader.js';
import { parseExtensionsSettings } from './allowlist.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('McpConfigLoader', () => {
  it('discovers Cursor MCP servers and substitutes workspaceFolder', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-mcp-cfg-'));
    temporaryRoots.push(home);
    await mkdir(path.join(home, '.cursor'), { recursive: true });
    await writeFile(path.join(home, '.cursor', 'mcp.json'), JSON.stringify({
      mcpServers: {
        playwright: {
          command: 'npx',
          args: ['-y', '@playwright/mcp', '--cwd', '${workspaceFolder}'],
        },
        'unified-mpc': {
          command: 'unified-mpc.exe',
          args: ['--mcp-stdio'],
        },
      },
    }), 'utf8');

    const loader = new McpConfigLoader({
      homeDir: home,
      appDataDir: path.join(home, 'AppData', 'Roaming'),
      workspaceRoot: 'E:\\project',
      settings: DEFAULT_EXTENSIONS_SETTINGS,
    });
    const servers = await loader.discover();
    expect(servers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'playwright',
        enabled: true,
        config: expect.objectContaining({
          args: expect.arrayContaining(['E:\\project']),
        }),
      }),
      expect.objectContaining({
        name: 'unified-mpc',
        enabled: false,
        excluded: true,
      }),
    ]));
  });

  it.runIf(process.platform === 'win32' || process.platform === 'darwin' || process.platform === 'linux')('discovers Claude Desktop MCP config from the current native host default location', async () => {
    const platform = process.platform as 'win32' | 'darwin' | 'linux';
    const home = await mkdtemp(path.join(os.tmpdir(), `unified-mpc-mcp-${platform}-`));
    temporaryRoots.push(home);
    const appData = defaultApplicationDataDirectory(platform, home, {});
    const pathApi = platform === 'win32' ? path.win32 : path.posix;
    const configPath = pathApi.join(appData, 'Claude', 'claude_desktop_config.json');
    await mkdir(pathApi.dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({
      mcpServers: { serena: { command: 'serena', args: ['start-mcp-server', '--context', 'chatgpt'] } },
    }), 'utf8');

    const loader = new McpConfigLoader({
      homeDir: home,
      platform,
      settings: DEFAULT_EXTENSIONS_SETTINGS,
      env: {},
    });
    await expect(loader.discover()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'serena', source: 'claude-desktop', enabled: true, excluded: false }),
    ]));
  });

  it('keeps application-data discovery paths platform-native and ignores relative environment overrides', () => {
    expect(defaultApplicationDataDirectory('linux', '/home/alice', { XDG_CONFIG_HOME: 'relative' }))
      .toBe('/home/alice/.config');
    expect(defaultApplicationDataDirectory('linux', '/home/alice', { XDG_CONFIG_HOME: '/srv/config' }))
      .toBe('/srv/config');
  });

  it.runIf(process.platform === 'linux')('uses XDG_CONFIG_HOME for Claude Desktop discovery on Linux', async () => {
    const rawRoot = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-linux-xdg-'));
    temporaryRoots.push(rawRoot);
    const root = rawRoot.replaceAll('\\', '/');
    const xdg = path.posix.join(root, 'custom-config');
    const configPath = path.posix.join(xdg, 'Claude', 'claude_desktop_config.json');
    await mkdir(path.posix.dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({ mcpServers: { context7: { command: 'ctx7' } } }), 'utf8');

    const servers = await new McpConfigLoader({
      homeDir: root,
      platform: 'linux',
      settings: DEFAULT_EXTENSIONS_SETTINGS,
      env: { XDG_CONFIG_HOME: xdg },
    }).discover();
    expect(servers).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'context7', source: 'claude-desktop', enabled: true }),
    ]));
  });

  it('lets explicit unified-mpc settings override the same server discovered from Cursor', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-override-'));
    temporaryRoots.push(home);
    await mkdir(path.join(home, '.cursor'), { recursive: true });
    await writeFile(path.join(home, '.cursor', 'mcp.json'), JSON.stringify({
      mcpServers: { serena: { command: 'cursor-serena', args: ['old'] } },
    }), 'utf8');
    const settings = {
      ...DEFAULT_EXTENSIONS_SETTINGS,
      extraMcpServers: { serena: { command: 'settings-serena', args: ['new'], type: 'stdio' } },
    };
    const servers = await new McpConfigLoader({ homeDir: home, appDataDir: path.join(home, 'appdata'), settings }).discover();
    expect(servers.filter((server) => server.name === 'serena')).toEqual([
      expect.objectContaining({ source: 'unified-mpc-settings', config: expect.objectContaining({ command: 'settings-serena', args: ['new'] }) }),
    ]);
  });

  it('canonicalizes surrounding MCP server-name whitespace before dedupe and allowlist evaluation', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-name-normalize-'));
    temporaryRoots.push(home);
    await mkdir(path.join(home, '.cursor'), { recursive: true });
    await writeFile(path.join(home, '.cursor', 'mcp.json'), JSON.stringify({
      mcpServers: { ' serena ': { command: 'cursor-serena' } },
    }), 'utf8');
    const settings = {
      ...DEFAULT_EXTENSIONS_SETTINGS,
      disabledServers: ['serena'],
      extraMcpServers: { serena: { command: 'settings-serena' } },
    };
    const servers = await new McpConfigLoader({ homeDir: home, appDataDir: path.join(home, 'appdata'), settings }).discover();
    expect(servers.filter((server) => server.name === 'serena')).toEqual([
      expect.objectContaining({
        name: 'serena',
        source: 'unified-mpc-settings',
        enabled: false,
        excluded: false,
        config: expect.objectContaining({ command: 'settings-serena' }),
      }),
    ]);
  });

  it('repairs legacy Serena boolean flags that were persisted without a value', () => {
    const settings = parseExtensionsSettings(JSON.stringify({
      extraMcpServers: {
        serena: {
          command: 'C:\\Users\\User\\.local\\bin\\serena.exe',
          args: [
            'start-mcp-server',
            '--context', 'chatgpt',
            '--open-web-dashboard', 'false',
            '--enable-gui-log-window',
            '--trace-lsp-communication', 'true',
          ],
        },
      },
    }));

    expect(settings.extraMcpServers.serena?.args).toEqual([
      'start-mcp-server',
      '--context', 'chatgpt',
      '--open-web-dashboard', 'false',
      '--enable-gui-log-window', 'false',
      '--trace-lsp-communication', 'true',
    ]);
  });

  it('does not rewrite similarly named flags for non-Serena MCP servers', () => {
    const settings = parseExtensionsSettings(JSON.stringify({
      extraMcpServers: {
        helper: {
          command: 'helper.exe',
          args: ['start-mcp-server', '--enable-gui-log-window'],
        },
      },
    }));

    expect(settings.extraMcpServers.helper?.args).toEqual(['start-mcp-server', '--enable-gui-log-window']);
  });

  it('honors disabledServers in enable_all mode', async () => {
    const settings = parseExtensionsSettings(JSON.stringify({
      mode: 'enable_all',
      disabledServers: ['playwright'],
    }));
    expect(settings.disabledServers).toEqual(['playwright']);
    expect(exclusionReason('helper', { command: 'node' })).toBeUndefined();
  });

  it('excludes names that cannot form an unambiguous external MCP namespace', () => {
    expect(exclusionReason('valid-server_1', { command: 'node' })).toBeUndefined();
    expect(exclusionReason('bad/server', { command: 'node' })).toContain('stable external namespace');
    expect(exclusionReason(' bad server ', { command: 'node' })).toContain('stable external namespace');
    expect(exclusionReason('', { command: 'node' })).toContain('stable external namespace');
  });

  it('discovers downstream MCP servers across all universal clients (Antigravity, Cline, OpenCode, OMP, workspace)', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'unified-mcp-multi-discovery-'));
    temporaryRoots.push(home);
    const workspace = path.join(home, 'workspace');
    await mkdir(workspace, { recursive: true });

    // 1. Antigravity global
    const agConfigDir = path.join(home, '.gemini', 'config');
    await mkdir(agConfigDir, { recursive: true });
    await writeFile(path.join(agConfigDir, 'mcp_config.json'), JSON.stringify({
      mcpServers: { 'antigravity-global-server': { command: 'node', args: ['ag-server.js'] } },
    }), 'utf8');

    // 2. Antigravity workspace
    const agWsDir = path.join(workspace, '.gemini');
    await mkdir(agWsDir, { recursive: true });
    await writeFile(path.join(agWsDir, 'mcp.json'), JSON.stringify({
      mcpServers: { 'antigravity-ws-server': { command: 'node', args: ['ag-ws.js'] } },
    }), 'utf8');

    // 3. Cline global (VS Code settings)
    const clineConfigDir = path.join(home, '.config', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings');
    await mkdir(clineConfigDir, { recursive: true });
    await writeFile(path.join(clineConfigDir, 'cline_mcp_settings.json'), JSON.stringify({
      mcpServers: { 'cline-global-server': { command: 'node', args: ['cline-server.js'] } },
    }), 'utf8');

    // 4. Cline workspace
    const clineWsDir = path.join(workspace, '.cline');
    await mkdir(clineWsDir, { recursive: true });
    await writeFile(path.join(clineWsDir, 'mcp.json'), JSON.stringify({
      mcpServers: { 'cline-ws-server': { command: 'node', args: ['cline-ws.js'] } },
    }), 'utf8');

    // 5. OpenCode global (JSONC with comment)
    const opencodeConfigDir = path.join(home, '.config', 'opencode');
    await mkdir(opencodeConfigDir, { recursive: true });
    await writeFile(path.join(opencodeConfigDir, 'opencode.jsonc'), `// OpenCode configuration\n{\n  "mcpServers": {\n    "opencode-global-server": {\n      "command": "node",\n      "args": ["opencode-server.js"]\n    }\n  }\n}\n`, 'utf8');

    // 6. OpenCode workspace
    const opencodeWsDir = path.join(workspace, '.opencode');
    await mkdir(opencodeWsDir, { recursive: true });
    await writeFile(path.join(opencodeWsDir, 'mcp.json'), JSON.stringify({
      mcpServers: { 'opencode-ws-server': { command: 'node', args: ['opencode-ws.js'] } },
    }), 'utf8');

    // 7. OMP global
    const ompConfigDir = path.join(home, '.omp');
    await mkdir(ompConfigDir, { recursive: true });
    await writeFile(path.join(ompConfigDir, 'config.json'), JSON.stringify({
      mcpServers: { 'omp-global-server': { command: 'node', args: ['omp-server.js'] } },
    }), 'utf8');

    // 8. Workspace Cursor & Claude
    const cursorWsDir = path.join(workspace, '.cursor');
    await mkdir(cursorWsDir, { recursive: true });
    await writeFile(path.join(cursorWsDir, 'mcp.json'), JSON.stringify({
      mcpServers: { 'cursor-ws-server': { command: 'node', args: ['cursor-ws.js'] } },
    }), 'utf8');

    const claudeWsDir = path.join(workspace, '.claude');
    await mkdir(claudeWsDir, { recursive: true });
    await writeFile(path.join(claudeWsDir, 'mcp.json'), JSON.stringify({
      mcpServers: { 'claude-ws-server': { command: 'node', args: ['claude-ws.js'] } },
    }), 'utf8');

    const loader = new McpConfigLoader({
      homeDir: home,
      workspaceRoot: workspace,
      settings: DEFAULT_EXTENSIONS_SETTINGS,
    });

    const discovered = await loader.discover();
    const discoveredNames = discovered.map((s) => s.name);

    expect(discoveredNames).toContain('antigravity-global-server');
    expect(discoveredNames).toContain('antigravity-ws-server');
    expect(discoveredNames).toContain('cline-global-server');
    expect(discoveredNames).toContain('cline-ws-server');
    expect(discoveredNames).toContain('opencode-global-server');
    expect(discoveredNames).toContain('opencode-ws-server');
    expect(discoveredNames).toContain('omp-global-server');
    expect(discoveredNames).toContain('cursor-ws-server');
    expect(discoveredNames).toContain('claude-ws-server');
  });
});
