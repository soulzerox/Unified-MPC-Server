import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appError, err, ok, type Result } from '@unified-mpc/domain';
import type { InstallScope, InstallTarget } from './installer.js';
import { stripJsonComments } from './mcp-config-loader.js';
import { writeAtomic } from './ide-sync.js';
import type { McpSessionManager } from './mcp-session-manager.js';
import { withConfigMutationTransaction } from './config-mutation-lock.js';

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
  readonly purgeDataDirs?: readonly string[];
}

export interface PruneServerResult {
  readonly name: string;
  readonly updatedConfigFiles: readonly string[];
  readonly processTerminated: boolean;
  readonly removedPaths: readonly string[];
  readonly recoveryStatus: 'completed';
  readonly recoveryIds: readonly string[];
}

export interface PrunerServiceOptions {
  readonly homeDir?: string;
  readonly appDataDir?: string;
  readonly workspaceRoot?: string;
  /** Recovery Center workspace identity for workspace-scoped server pruning. */
  readonly workspaceId?: string;
  readonly sessionManager?: McpSessionManager;
  readonly recoveryTrashRoot?: string;
}

const ALL_TARGETS: readonly InstallTarget[] = [
  'antigravity',
  'cline',
  'cursor',
  'claude',
  'opencode',
  'codex',
];

function validateTargets(targets: readonly InstallTarget[] | undefined): ReturnType<typeof appError> | undefined {
  if (!targets || targets.length === 0) return appError('INVALID_INPUT', 'At least one target must be specified');
  const supported = new Set<string>([...ALL_TARGETS, 'all']);
  const invalid = [...new Set(targets.filter((target) => !supported.has(target)))];
  if (invalid.length === 0) return undefined;
  return appError(
    'UNSUPPORTED_TARGET',
    `Unsupported target(s): ${invalid.join(', ')}. Supported targets: ${[...ALL_TARGETS, 'all'].join(', ')}`,
    false,
    { invalidTargets: invalid.join(', '), supportedTargets: [...ALL_TARGETS, 'all'].join(', ') },
  );
}

export class PrunerService {
  private readonly home: string;
  private readonly appData: string;
  private readonly workspace: string | undefined;
  private readonly workspaceId: string | undefined;
  private readonly sessionManager: McpSessionManager | undefined;
  private readonly recoveryTrashRoot: string;

  public constructor(options: PrunerServiceOptions = {}) {
    this.home = options.homeDir ?? os.homedir();
    this.appData = options.appDataDir?.trim() ?? path.join(this.home, '.config');
    this.workspace = options.workspaceRoot?.trim();
    this.workspaceId = options.workspaceId?.trim();
    this.sessionManager = options.sessionManager;
    this.recoveryTrashRoot = options.recoveryTrashRoot ?? path.join(this.home, '.unified-mpc', 'recovery-trash');
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

    const targetError = validateTargets(input.targets ?? ['all']);
    if (targetError !== undefined) return err(targetError);

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
      } catch (error: unknown) {
        if (isMissingPath(error)) continue;
        return err(appError('INTERNAL_ERROR', `Failed to remove skill path '${targetDir}': ${error instanceof Error ? error.message : String(error)}`));
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
    if (input.purgeDataDirs !== undefined && input.purgeDataDirs.length > 0 && this.workspaceId === undefined) {
      return err(appError('WORKSPACE_NOT_FOUND', 'Workspace identity is required for recoverable server pruning'));
    }
    if (input.purgeDataDirs !== undefined && input.purgeDataDirs.length > 0
      && (scope !== 'workspace' || workspaceRoot === undefined || workspaceRoot.length === 0)) {
      return err(appError('WORKSPACE_NOT_FOUND', 'Workspace scope and root are required for recoverable server pruning'));
    }
    const recoveryWorkspaceRoot = workspaceRoot ?? this.workspace;

    const targetError = validateTargets(input.targets ?? ['all']);
    if (targetError !== undefined) return err(targetError);

    // Validate purgeDataDirs against path traversal and symlink boundaries before mutation.
    if (input.purgeDataDirs !== undefined) {
      for (const dir of input.purgeDataDirs) {
        if (!(await this.isSafePurgePath(dir, workspaceRoot))) {
          return err(appError('PERMISSION_DENIED', `Unsafe purge data directory outside allowed boundaries: "${dir}"`));
        }
      }
    }

    const targets = this.expandTargets(input.targets ?? ['all']);
    const configFiles = targets
      .map((target) => this.serverTargetConfigFile(target, scope, workspaceRoot))
      .filter((configFile): configFile is string => configFile !== undefined);
    const updatedConfigFiles: string[] = [];
    const removedPaths: string[] = [];
    const recoveryIds: string[] = [];
    const movedData: Array<{ readonly source: string; readonly recoveryPath: string }> = [];
    let processTerminated = false;
    let recoveryStatus: 'partial' | 'rollback_failed' = 'partial';

    try {
      await withConfigMutationTransaction(configFiles, async () => {
        for (const configFile of configFiles) {
          if (await purgeServerFromConfigFile(configFile, serverName)) {
            updatedConfigFiles.push(configFile);
          }
        }

        if (input.purgeDataDirs !== undefined) {
          for (const dir of input.purgeDataDirs) {
            const s = await lstat(dir);
            if (s.isSymbolicLink()) continue;
            if (s.isDirectory() || s.isFile()) {
              const recoveryId = randomUUID();
              const recoveryDir = path.join(this.recoveryTrashRoot, this.workspaceId!, recoveryId);
              const recoveryPath = path.join(recoveryDir, 'payload');
              await mkdir(recoveryDir, { recursive: true, mode: 0o700 });
              const metadata = {
                version: 2,
                kind: 'deleted' as const,
                state: 'prepared' as const,
                recoveryId,
                workspaceId: this.workspaceId!,
                relativePath: path.relative(recoveryWorkspaceRoot!, dir),
                deletedAt: new Date().toISOString(),
                isDirectory: s.isDirectory(),
              };
              await writeFile(path.join(recoveryDir, 'metadata.json'), `${JSON.stringify(metadata)}\n`, { mode: 0o600 });
              await rename(dir, recoveryPath);
              movedData.push({ source: dir, recoveryPath });
              await writeFile(path.join(recoveryDir, 'metadata.json'), `${JSON.stringify({ ...metadata, state: 'moved' })}\n`, { mode: 0o600 });
              recoveryIds.push(recoveryId);
              removedPaths.push(dir);
            }
          }
        }

        // Terminate session only after filesystem mutations succeed; config rollback cannot restore a process.
        if (this.sessionManager !== undefined) {
          await this.sessionManager.dropServer(serverName);
          processTerminated = true;
        }
      });
    } catch (error: unknown) {
      try {
        for (const moved of [...movedData].reverse()) {
          await mkdir(path.dirname(moved.source), { recursive: true });
          await rename(moved.recoveryPath, moved.source);
          await rm(path.dirname(moved.recoveryPath), { recursive: true, force: true });
        }
      } catch {
        recoveryStatus = 'rollback_failed';
      }
      return err(appError(
        'INTERNAL_ERROR',
        `Failed to prune server '${serverName}': ${error instanceof Error ? error.message : String(error)}`,
        recoveryStatus !== 'rollback_failed',
        { recoveryStatus },
      ));
    }

    return ok({
      name: serverName,
      updatedConfigFiles,
      processTerminated,
      removedPaths,
      recoveryStatus: 'completed',
      recoveryIds,
    });
  }

  private async isSafePurgePath(dir: string, workspaceRoot?: string): Promise<boolean> {
    const trimmed = dir.trim();
    if (trimmed.length === 0) return false;
    const resolved = path.resolve(trimmed);
    const rootDir = path.parse(resolved).root;

    // Never allow root or dangerous system directories
    if (resolved === rootDir || resolved === '/') return false;
    const DANGEROUS_SYSTEM_DIRS = ['/etc', '/usr', '/bin', '/sbin', '/lib', '/boot', '/dev', '/proc', '/sys', '/var', '/root'];
    if (DANGEROUS_SYSTEM_DIRS.some((d) => resolved === d || resolved.startsWith(d + path.sep))) return false;

    // Never allow wiping home or workspace directly
    if (resolved === path.resolve(this.home)) return false;
    if (resolved === path.resolve(this.appData)) return false;
    if (workspaceRoot !== undefined && resolved === path.resolve(workspaceRoot)) return false;

    const allowedParents = [
      path.resolve(this.home),
      path.resolve(this.appData),
      ...(workspaceRoot ? [path.resolve(workspaceRoot)] : []),
    ];
    if (!allowedParents.some((parent) => resolved.startsWith(parent + path.sep))) return false;

    // lstat every existing component. realpath/stat would follow a hostile parent symlink.
    let current = resolved;
    while (true) {
      try {
        const metadata = await lstat(current);
        if (metadata.isSymbolicLink()) return false;
        await realpath(current);
      } catch (error: unknown) {
        if (!isMissingPath(error)) return false;
      }
      if (current === rootDir) break;
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return true;
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

function isMissingPath(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT';
}

async function purgeServerFromConfigFile(configFile: string, serverName: string): Promise<boolean> {
  try {
    const raw = await readFile(configFile, 'utf8');
    const cleanJson = stripJsonComments(raw);
    const parsed: unknown = JSON.parse(cleanJson);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('Configuration root must be an object');
    }
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
  } catch (error: unknown) {
    if (isMissingPath(error)) return false;
    throw error;
  }
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

