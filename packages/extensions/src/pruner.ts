import { readFile, readdir, rm, stat, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appError, err, ok, type Result } from '@unified-mpc/domain';
import type { InstallScope, InstallTarget } from './installer.js';
import { stripJsonComments } from './mcp-config-loader.js';
import { writeAtomic } from './ide-sync.js';
import type { McpSessionManager } from './mcp-session-manager.js';

export interface PruneSkillInput {
  readonly name: string;
  readonly targets?: readonly InstallTarget[];
  readonly scope?: InstallScope;
  readonly workspaceRoot?: string;
}

export interface PruneSkillResult {
  readonly name: string;
  readonly removedPaths: readonly string[];
}

export interface PruneServerInput {
  readonly name: string;
  readonly targets?: readonly InstallTarget[];
  readonly scope?: InstallScope;
  readonly workspaceRoot?: string;
  readonly forceKill?: boolean;
  readonly purgeDataDirs?: readonly string[];
  readonly pid?: number;
}

export interface PruneServerResult {
  readonly name: string;
  readonly updatedConfigFiles: readonly string[];
  readonly processTerminated: boolean;
  readonly removedPaths: readonly string[];
}

export interface PrunerServiceOptions {
  readonly homeDir?: string;
  readonly appDataDir?: string;
  readonly workspaceRoot?: string;
  readonly sessionManager?: McpSessionManager;
}

const ALL_TARGETS: readonly InstallTarget[] = [
  'antigravity',
  'cline',
  'cursor',
  'claude',
  'opencode',
  'codex',
];

export class PrunerService {
  private readonly home: string;
  private readonly appData: string;
  private readonly workspace: string | undefined;
  private readonly sessionManager: McpSessionManager | undefined;

  public constructor(options: PrunerServiceOptions = {}) {
    this.home = options.homeDir ?? os.homedir();
    this.appData = options.appDataDir?.trim() ?? path.join(this.home, '.config');
    this.workspace = options.workspaceRoot?.trim();
    this.sessionManager = options.sessionManager;
  }

  public async pruneSkill(input: PruneSkillInput): Promise<Result<PruneSkillResult>> {
    const skillName = input.name.trim();
    if (skillName.length === 0 || !/^[A-Za-z0-9_-]+$/.test(skillName)) {
      return err(appError('INVALID_INPUT', `Invalid skill name: "${input.name}"`));
    }

    const workspaceRoot = input.workspaceRoot?.trim() ?? this.workspace;
    const scope: InstallScope = input.scope ?? (workspaceRoot !== undefined && workspaceRoot.length > 0 ? 'workspace' : 'global');

    if (scope === 'workspace' && (workspaceRoot === undefined || workspaceRoot.length === 0)) {
      return err(appError('WORKSPACE_NOT_FOUND', 'Workspace root is required for workspace-scoped skill pruning'));
    }

    const targets = this.expandTargets(input.targets ?? ['all']);
    const removedPaths: string[] = [];

    for (const target of targets) {
      const targetDir = this.skillTargetDirectory(target, scope, skillName, workspaceRoot);
      if (targetDir === undefined) continue;

      try {
        const s = await stat(targetDir);
        if (s.isDirectory() || s.isFile()) {
          await rm(targetDir, { recursive: true, force: true });
          removedPaths.push(targetDir);
        }
      } catch {
        // Path does not exist, ignore (idempotent)
      }
    }

    return ok({
      name: skillName,
      removedPaths,
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

  public async pruneServer(input: PruneServerInput): Promise<Result<PruneServerResult>> {
    const serverName = input.name.trim();
    if (serverName.length === 0 || !/^[A-Za-z0-9_-]+$/.test(serverName)) {
      return err(appError('INVALID_INPUT', `Invalid server name: "${input.name}"`));
    }

    const workspaceRoot = input.workspaceRoot?.trim() ?? this.workspace;
    const scope: InstallScope = input.scope ?? (workspaceRoot !== undefined && workspaceRoot.length > 0 ? 'workspace' : 'global');

    if (scope === 'workspace' && (workspaceRoot === undefined || workspaceRoot.length === 0)) {
      return err(appError('WORKSPACE_NOT_FOUND', 'Workspace root is required for workspace-scoped server pruning'));
    }

    // Validate purgeDataDirs against path traversal and boundary violations
    if (input.purgeDataDirs !== undefined) {
      for (const dir of input.purgeDataDirs) {
        if (!this.isSafePurgePath(dir, workspaceRoot)) {
          return err(appError('PERMISSION_DENIED', `Unsafe purge data directory outside allowed boundaries: "${dir}"`));
        }
      }
    }

    let processTerminated = false;

    // Terminate attached process if PID provided
    if (input.pid !== undefined) {
      processTerminated = await terminateProcess(input.pid, input.forceKill ? 0 : 3000);
    }

    // Drop session if sessionManager available
    if (this.sessionManager !== undefined) {
      await this.sessionManager.dropServer(serverName).catch(() => undefined);
      processTerminated = true;
    }

    const targets = this.expandTargets(input.targets ?? ['all']);
    const updatedConfigFiles: string[] = [];

    for (const target of targets) {
      const configFile = this.serverTargetConfigFile(target, scope, workspaceRoot);
      if (configFile === undefined) continue;

      const modified = await purgeServerFromConfigFile(configFile, serverName);
      if (modified) {
        updatedConfigFiles.push(configFile);
      }
    }

    const removedPaths: string[] = [];
    if (input.purgeDataDirs !== undefined) {
      for (const dir of input.purgeDataDirs) {
        try {
          const s = await stat(dir);
          if (s.isDirectory() || s.isFile()) {
            await rm(dir, { recursive: true, force: true });
            removedPaths.push(dir);
          }
        } catch {
          // Ignore if already deleted
        }
      }
    }

    return ok({
      name: serverName,
      updatedConfigFiles,
      processTerminated,
      removedPaths,
    });
  }

  private isSafePurgePath(dir: string, workspaceRoot?: string): boolean {
    const trimmed = dir.trim();
    if (trimmed.length === 0) return false;
    const resolved = path.resolve(trimmed);
    const rootDir = path.parse(resolved).root;

    // Never allow root or dangerous system directories
    if (resolved === rootDir || resolved === '/') return false;
    const DANGEROUS_SYSTEM_DIRS = ['/etc', '/usr', '/bin', '/sbin', '/lib', '/boot', '/dev', '/proc', '/sys', '/var', '/root'];
    if (DANGEROUS_SYSTEM_DIRS.some((d) => resolved === d || resolved.startsWith(d + path.sep))) {
      return false;
    }

    // Never allow wiping home or workspace directly
    if (resolved === path.resolve(this.home)) return false;
    if (resolved === path.resolve(this.appData)) return false;
    if (workspaceRoot !== undefined && resolved === path.resolve(workspaceRoot)) return false;

    // Must be strictly inside home, appData, or workspace
    const allowedParents = [
      path.resolve(this.home),
      path.resolve(this.appData),
      ...(workspaceRoot ? [path.resolve(workspaceRoot)] : []),
    ];

    return allowedParents.some((parent) => resolved.startsWith(parent + path.sep));
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

async function purgeServerFromConfigFile(configFile: string, serverName: string): Promise<boolean> {
  try {
    const raw = await readFile(configFile, 'utf8');
    const cleanJson = stripJsonComments(raw);
    const parsed: unknown = JSON.parse(cleanJson);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false;
    const doc = parsed as Record<string, unknown>;

    let modified = false;
    for (const key of ['mcpServers', 'mcp']) {
      const servers = doc[key];
      if (typeof servers === 'object' && servers !== null && !Array.isArray(servers)) {
        const record = servers as Record<string, unknown>;
        if (serverName in record) {
          delete record[serverName];
          modified = true;
        }
      }
    }

    if (modified) {
      await writeAtomic(configFile, `${JSON.stringify(doc, null, 2)}\n`);
    }
    return modified;
  } catch {
    return false;
  }
}

export async function terminateProcess(pid: number, timeoutMs = 3000): Promise<boolean> {
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'code' in error && (error as { code: string }).code === 'ESRCH') {
      return true;
    }
    return false;
  }

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 50));
    } catch {
      return true;
    }
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Process might already be dead
  }
  return true;
}

export async function cleanOrphanedArtifacts(dirs: readonly string[]): Promise<readonly string[]> {
  const removed: string[] = [];
  for (const dir of dirs) {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) {
          try {
            await stat(fullPath);
          } catch {
            // Broken symlink
            await unlink(fullPath);
            removed.push(fullPath);
          }
        }
      }
    } catch {
      // Ignore if directory does not exist
    }
  }
  return removed;
}

