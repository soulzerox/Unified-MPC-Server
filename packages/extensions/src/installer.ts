import { cp, mkdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appError, err, ok, type Result } from '@unified-mpc/domain';
import { parseSkillMarkdown } from './skill-catalog.js';
import { exclusionReason, stripJsonComments } from './mcp-config-loader.js';
import { writeAtomic } from './ide-sync.js';

export type InstallTarget = 'antigravity' | 'cursor' | 'claude' | 'codex' | 'cline' | 'opencode' | 'all';
export type InstallScope = 'global' | 'workspace';

export interface InstallSkillInput {
  readonly name: string;
  readonly source: string;
  readonly targets: readonly InstallTarget[];
  readonly scope?: InstallScope;
  readonly workspaceRoot?: string;
}

export interface InstallSkillResult {
  readonly name: string;
  readonly installedPaths: readonly string[];
  readonly targets: readonly InstallTarget[];
}

export interface InstallServerInput {
  readonly name: string;
  readonly transport: 'stdio' | 'sse' | 'http';
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly url?: string;
  readonly cwd?: string;
  readonly targets: readonly InstallTarget[];
  readonly scope?: InstallScope;
  readonly workspaceRoot?: string;
}

export interface InstallServerResult {
  readonly name: string;
  readonly targets: readonly InstallTarget[];
  readonly updatedConfigFiles: readonly string[];
}

export interface InstallerServiceOptions {
  readonly homeDir?: string;
  readonly appDataDir?: string;
  readonly workspaceRoot?: string;
}

const ALL_TARGETS: readonly InstallTarget[] = [
  'antigravity',
  'cline',
  'cursor',
  'claude',
  'opencode',
  'codex',
];

export class InstallerService {
  private readonly home: string;
  private readonly appData: string;
  private readonly workspace: string | undefined;

  public constructor(options: InstallerServiceOptions = {}) {
    this.home = options.homeDir ?? os.homedir();
    this.appData = options.appDataDir?.trim() ?? path.join(this.home, '.config');
    this.workspace = options.workspaceRoot?.trim();
  }

  public async installSkill(input: InstallSkillInput): Promise<Result<InstallSkillResult>> {
    const skillName = input.name.trim();
    if (skillName.length === 0 || !/^[A-Za-z0-9_-]+$/.test(skillName)) {
      return err(appError('INVALID_INPUT', `Invalid skill name: "${input.name}"`));
    }

    const resolvedSource = path.resolve(input.source);
    let sourceSkillFile: string;
    let sourceSkillDir: string;

    try {
      const sourceStat = await stat(resolvedSource);
      if (sourceStat.isDirectory()) {
        sourceSkillDir = resolvedSource;
        sourceSkillFile = path.join(resolvedSource, 'SKILL.md');
      } else {
        sourceSkillDir = path.dirname(resolvedSource);
        sourceSkillFile = resolvedSource;
      }

      const fileStat = await stat(sourceSkillFile);
      if (!fileStat.isFile()) {
        return err(appError('FILE_NOT_FOUND', `SKILL.md not found at ${sourceSkillFile}`));
      }
    } catch {
      return err(appError('FILE_NOT_FOUND', `Skill source or SKILL.md not found at ${resolvedSource}`));
    }

    // Validate frontmatter
    try {
      const content = await readFile(sourceSkillFile, 'utf8');
      parseSkillMarkdown(content, skillName);
    } catch (error) {
      return err(appError('INVALID_INPUT', `Failed to parse skill markdown: ${error instanceof Error ? error.message : String(error)}`));
    }

    const scope: InstallScope = input.scope ?? 'global';
    const workspaceRoot = input.workspaceRoot?.trim() ?? this.workspace;

    if (scope === 'workspace' && (workspaceRoot === undefined || workspaceRoot.length === 0)) {
      return err(appError('WORKSPACE_NOT_FOUND', 'Workspace root is required for workspace-scoped skill installation'));
    }

    const resolvedTargets = this.expandTargets(input.targets);
    const installedPaths: string[] = [];

    for (const target of resolvedTargets) {
      const targetDir = this.skillTargetDirectory(target, scope, skillName, workspaceRoot);
      if (targetDir === undefined) continue;

      await mkdir(targetDir, { recursive: true });
      await cp(sourceSkillDir, targetDir, { recursive: true });
      installedPaths.push(path.join(targetDir, 'SKILL.md'));
    }

    return ok({
      name: skillName,
      installedPaths,
      targets: input.targets,
    });
  }

  private expandTargets(targets: readonly InstallTarget[]): readonly InstallTarget[] {
    if (targets.includes('all')) {
      return ALL_TARGETS;
    }
    const unique = new Set<InstallTarget>();
    for (const t of targets) {
      if (t !== 'all') unique.add(t);
    }
    return [...unique];
  }

  private skillTargetDirectory(
    target: InstallTarget,
    scope: InstallScope,
    skillName: string,
    workspaceRoot?: string,
  ): string | undefined {
    if (scope === 'workspace') {
      if (workspaceRoot === undefined) return undefined;
      switch (target) {
        case 'antigravity':
          return path.join(workspaceRoot, '.gemini', 'skills', skillName);
        case 'cline':
          return path.join(workspaceRoot, '.cline', 'skills', skillName);
        case 'cursor':
          return path.join(workspaceRoot, '.cursor', 'skills', skillName);
        case 'claude':
          return path.join(workspaceRoot, '.claude', 'skills', skillName);
        case 'opencode':
          return path.join(workspaceRoot, '.opencode', 'skills', skillName);
        case 'codex':
          return path.join(workspaceRoot, '.codex', 'skills', skillName);
        default:
          return undefined;
      }
    }

    // Global scope
    switch (target) {
      case 'antigravity':
        return path.join(this.home, '.gemini', 'config', 'skills', skillName);
      case 'cline':
        return path.join(this.home, '.cline', 'skills', skillName);
      case 'cursor':
        return path.join(this.home, '.cursor', 'skills', skillName);
      case 'claude':
        return path.join(this.home, '.claude', 'skills', skillName);
      case 'opencode':
        return path.join(this.home, '.config', 'opencode', 'skill', skillName);
      case 'codex':
        return path.join(this.home, '.codex', 'skills', skillName);
      default:
        return undefined;
    }
  }

  public async installServer(input: InstallServerInput): Promise<Result<InstallServerResult>> {
    const serverName = input.name.trim();
    if (serverName.length === 0) {
      return err(appError('INVALID_INPUT', 'Server name must not be empty'));
    }

    if (input.transport === 'stdio') {
      if (!input.command || input.command.trim().length === 0) {
        return err(appError('INVALID_INPUT', 'Command is required for stdio transport'));
      }
    } else {
      if (!input.url || input.url.trim().length === 0) {
        return err(appError('INVALID_INPUT', 'URL is required for SSE/HTTP transport'));
      }
    }

    const checkConfig = {
      command: input.command ?? input.url ?? 'node',
      ...(input.args !== undefined ? { args: input.args } : {}),
    };
    const exclusion = exclusionReason(serverName, checkConfig);
    if (exclusion !== undefined) {
      return err(appError('INVALID_INPUT', exclusion));
    }

    const scope: InstallScope = input.scope ?? 'global';
    const workspaceRoot = input.workspaceRoot?.trim() ?? this.workspace;

    if (scope === 'workspace' && (workspaceRoot === undefined || workspaceRoot.length === 0)) {
      return err(appError('WORKSPACE_NOT_FOUND', 'Workspace root is required for workspace-scoped server installation'));
    }

    const serverEntry: Record<string, unknown> = {};
    if (input.transport === 'stdio') {
      serverEntry.command = input.command;
      if (input.args && input.args.length > 0) serverEntry.args = input.args;
      if (input.env && Object.keys(input.env).length > 0) serverEntry.env = input.env;
      if (input.cwd) serverEntry.cwd = input.cwd;
    } else {
      serverEntry.url = input.url;
      serverEntry.type = input.transport;
    }

    const resolvedTargets = this.expandTargets(input.targets);
    const updatedConfigFiles: string[] = [];

    for (const target of resolvedTargets) {
      const configFile = this.serverTargetConfigFile(target, scope, workspaceRoot);
      if (configFile === undefined) continue;

      await injectServerIntoConfigFile(configFile, serverName, serverEntry);
      updatedConfigFiles.push(configFile);
    }

    return ok({
      name: serverName,
      targets: input.targets,
      updatedConfigFiles,
    });
  }

  private serverTargetConfigFile(
    target: InstallTarget,
    scope: InstallScope,
    workspaceRoot?: string,
  ): string | undefined {
    if (scope === 'workspace') {
      if (workspaceRoot === undefined) return undefined;
      switch (target) {
        case 'antigravity':
          return path.join(workspaceRoot, '.gemini', 'mcp.json');
        case 'cline':
          return path.join(workspaceRoot, '.cline', 'mcp.json');
        case 'cursor':
          return path.join(workspaceRoot, '.cursor', 'mcp.json');
        case 'claude':
          return path.join(workspaceRoot, '.claude', 'mcp.json');
        case 'opencode':
          return path.join(workspaceRoot, '.opencode', 'mcp.json');
        case 'codex':
          return path.join(workspaceRoot, '.codex', 'mcp.json');
        default:
          return undefined;
      }
    }

    // Global scope
    switch (target) {
      case 'antigravity':
        return path.join(this.home, '.gemini', 'config', 'mcp_config.json');
      case 'cline':
        return path.join(
          this.appData,
          'Code',
          'User',
          'globalStorage',
          'saoudrizwan.claude-dev',
          'settings',
          'cline_mcp_settings.json',
        );
      case 'cursor':
        return path.join(this.home, '.cursor', 'mcp.json');
      case 'claude':
        return path.join(this.appData, 'Claude', 'claude_desktop_config.json');
      case 'opencode':
        return path.join(this.home, '.config', 'opencode', 'opencode.json');
      case 'codex':
        return path.join(this.home, '.codex', 'mcp.json');
      default:
        return undefined;
    }
  }
}

async function injectServerIntoConfigFile(
  configFile: string,
  serverName: string,
  serverEntry: Record<string, unknown>,
): Promise<void> {
  let doc: Record<string, unknown> = { mcpServers: {} };
  try {
    const raw = await readFile(configFile, 'utf8');
    const cleanJson = stripJsonComments(raw);
    const parsed: unknown = JSON.parse(cleanJson);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      doc = parsed as Record<string, unknown>;
    }
  } catch {
    doc = { mcpServers: {} };
  }

  const serversKey = typeof doc.mcp === 'object' && doc.mcp !== null && !Array.isArray(doc.mcp) ? 'mcp' : 'mcpServers';
  let serversObj = doc[serversKey];
  if (typeof serversObj !== 'object' || serversObj === null || Array.isArray(serversObj)) {
    serversObj = {};
    doc[serversKey] = serversObj;
  }

  (serversObj as Record<string, unknown>)[serverName] = serverEntry;

  const content = `${JSON.stringify(doc, null, 2)}\n`;
  await writeAtomic(configFile, content);
}

