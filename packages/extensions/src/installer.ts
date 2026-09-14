import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appError, err, ok, type Result } from '@unified-mpc/domain';
import { DirectGitRunner, type GitRunner } from '@unified-mpc/git';
import { parseSkillMarkdown } from './skill-catalog.js';
import { exclusionReason, stripJsonComments } from './mcp-config-loader.js';
import { writeAtomic } from './ide-sync.js';
import { withConfigMutationTransaction } from './config-mutation-lock.js';

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
  readonly source?: string;
  readonly cwd?: string;
  readonly targets: readonly InstallTarget[];
  readonly scope?: InstallScope;
  readonly workspaceRoot?: string;
}

export interface InstallServerResult {
  readonly name: string;
  readonly targets: readonly InstallTarget[];
  readonly updatedConfigFiles: readonly string[];
  readonly managedSourcePath?: string;
}

export interface InstallerServiceOptions {
  readonly homeDir?: string;
  readonly appDataDir?: string;
  readonly workspaceRoot?: string;
  readonly dataDir?: string;
  readonly gitRunner?: GitRunner;
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

export class InstallerService {
  private readonly home: string;
  private readonly appData: string;
  private readonly workspace: string | undefined;
  private readonly dataDir: string;
  private readonly gitRunner: GitRunner;

  public constructor(options: InstallerServiceOptions = {}) {
    this.home = options.homeDir ?? os.homedir();
    this.appData = options.appDataDir?.trim() ?? path.join(this.home, '.config');
    this.workspace = options.workspaceRoot?.trim();
    this.dataDir = options.dataDir?.trim() ?? path.join(this.home, '.local', 'share', 'unified-mpc');
    this.gitRunner = options.gitRunner ?? new DirectGitRunner();
  }

  public async installSkill(input: InstallSkillInput): Promise<Result<InstallSkillResult>> {
    const skillName = input.name.trim();
    if (
      skillName.length === 0 ||
      !/^[A-Za-z0-9_-]+$/.test(skillName) ||
      ['constructor', '__proto__', 'prototype'].includes(skillName.toLowerCase())
    ) {
      return err(appError('INVALID_INPUT', `Invalid skill name: "${input.name}"`));
    }
    const targetError = validateTargets(input.targets);
    if (targetError !== undefined) return err(targetError);

    const materialized = await this.materializeSkillSource(input.source);
    if (!materialized.ok) return err(materialized.error);
    try {
      return await this.installSkillFromResolvedSource(input, skillName, materialized.value.path);
    } finally {
      if (materialized.value.cleanupRoot !== undefined) {
        await rm(materialized.value.cleanupRoot, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  private async materializeSkillSource(source: string): Promise<Result<{ readonly path: string; readonly cleanupRoot?: string }>> {
    const remote = parseHttpsGitSource(source);
    if (remote === undefined) {
      if (looksLikeRemoteSource(source)) {
        return err(appError('INVALID_INPUT', 'Remote skill sources must use an HTTPS Git repository URL'));
      }
      return ok({ path: path.resolve(source) });
    }

    const cleanupRoot = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-skill-source-'));
    const repositoryPath = path.join(cleanupRoot, 'repo');
    const cloned = await this.gitRunner.run(['clone', '--depth', '1', '--', remote.href, repositoryPath], cleanupRoot, { timeoutMs: 120_000 });
    if (cloned.exitCode !== 0) {
      await rm(cleanupRoot, { recursive: true, force: true }).catch(() => undefined);
      return err(appError('INVALID_INPUT', `Failed to clone remote skill source: ${boundedGitError(cloned.stderr)}`));
    }
    await rm(path.join(repositoryPath, '.git'), { recursive: true, force: true });
    const safeTree = await this.validateRemoteSkillTree(repositoryPath);
    if (!safeTree.ok) {
      await rm(cleanupRoot, { recursive: true, force: true }).catch(() => undefined);
      return err(safeTree.error);
    }
    return ok({ path: repositoryPath, cleanupRoot });
  }

  private async validateRemoteSkillTree(repositoryPath: string): Promise<Result<undefined>> {
    const pending = [repositoryPath];
    while (pending.length > 0) {
      const directory = pending.pop()!;
      for (const entry of await readdir(directory)) {
        const candidate = path.join(directory, entry);
        const info = await lstat(candidate);
        if (info.isSymbolicLink()) {
          return err(appError('INVALID_INPUT', 'Remote skill repositories must not contain symbolic links'));
        }
        if (info.isDirectory()) pending.push(candidate);
      }
    }
    return ok(undefined);
  }

  private async installSkillFromResolvedSource(
    input: InstallSkillInput,
    skillName: string,
    resolvedSource: string,
  ): Promise<Result<InstallSkillResult>> {
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
      if (!fileStat.isFile()) return err(appError('FILE_NOT_FOUND', `SKILL.md not found at ${sourceSkillFile}`));
    } catch {
      return err(appError('FILE_NOT_FOUND', `Skill source or SKILL.md not found at ${resolvedSource}`));
    }

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

    const installedPaths: string[] = [];
    for (const target of this.expandTargets(input.targets)) {
      const targetDir = this.skillTargetDirectory(target, scope, skillName, workspaceRoot);
      if (targetDir === undefined) continue;
      await mkdir(targetDir, { recursive: true });
      await cp(sourceSkillDir, targetDir, { recursive: true });
      installedPaths.push(path.join(targetDir, 'SKILL.md'));
    }
    return ok({ name: skillName, installedPaths, targets: input.targets });
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
    if (
      serverName.length === 0 ||
      !/^[A-Za-z0-9_-]+$/.test(serverName) ||
      ['constructor', '__proto__', 'prototype'].includes(serverName.toLowerCase())
    ) {
      return err(appError('INVALID_INPUT', `Invalid server name: "${input.name}"`));
    }
    const targetError = validateTargets(input.targets);
    if (targetError !== undefined) return err(targetError);
    if (input.transport !== 'stdio' && input.transport !== 'sse' && input.transport !== 'http') {
      return err(appError('INVALID_INPUT', `Unsupported transport: "${String(input.transport)}"`));
    }

    let managedSourcePath: string | undefined;
    let managedVersionRoot: string | undefined;
    let effectiveCommand = input.command?.trim();
    let effectiveArgs = input.args;
    let effectiveCwd = input.cwd;

    if (input.transport === 'stdio') {
      if (input.source !== undefined) {
        if (effectiveCommand !== undefined && effectiveCommand.length > 0) {
          return err(appError('INVALID_INPUT', 'Specify either source or command for stdio transport, not both'));
        }
        const materialized = await this.materializeServerSource(serverName, input.source);
        if (!materialized.ok) return err(materialized.error);
        managedSourcePath = materialized.value.path;
        managedVersionRoot = materialized.value.versionRoot;
        const launch = await resolveNodePackageLaunch(managedSourcePath, serverName);
        if (!launch.ok) {
          await rm(managedVersionRoot, { recursive: true, force: true }).catch(() => undefined);
          return err(launch.error);
        }
        effectiveCommand = launch.value.command;
        effectiveArgs = launch.value.args;
        effectiveCwd = launch.value.cwd;
      } else if (effectiveCommand === undefined || effectiveCommand.length === 0) {
        return err(appError('INVALID_INPUT', 'Command is required for stdio transport (or provide an HTTPS Git source)'));
      }
    } else {
      if (input.source !== undefined) return err(appError('INVALID_INPUT', 'Repository source is supported only for stdio transport'));
      if (!input.url || input.url.trim().length === 0) return err(appError('INVALID_INPUT', 'URL is required for SSE/HTTP transport'));
      try {
        const parsedUrl = new URL(input.url);
        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
          return err(appError('INVALID_INPUT', `Invalid URL protocol: "${parsedUrl.protocol}". Only HTTP and HTTPS are supported.`));
        }
      } catch {
        return err(appError('INVALID_INPUT', `Malformed URL: "${input.url}"`));
      }
    }

    const checkConfig = input.source === undefined
      ? {
          command: effectiveCommand ?? input.url ?? 'node',
          ...(effectiveArgs !== undefined ? { args: effectiveArgs } : {}),
        }
      : { command: process.execPath };
    const exclusion = exclusionReason(serverName, checkConfig);
    if (exclusion !== undefined) {
      if (managedVersionRoot !== undefined) await rm(managedVersionRoot, { recursive: true, force: true }).catch(() => undefined);
      return err(appError('INVALID_INPUT', exclusion));
    }

    const scope: InstallScope = input.scope ?? 'global';
    if (scope !== 'global' && scope !== 'workspace') {
      if (managedVersionRoot !== undefined) await rm(managedVersionRoot, { recursive: true, force: true }).catch(() => undefined);
      return err(appError('INVALID_INPUT', `Unsupported install scope: "${String(input.scope)}"`));
    }
    const workspaceRoot = input.workspaceRoot?.trim() ?? this.workspace;
    if (scope === 'workspace' && (workspaceRoot === undefined || workspaceRoot.length === 0)) {
      if (managedVersionRoot !== undefined) await rm(managedVersionRoot, { recursive: true, force: true }).catch(() => undefined);
      return err(appError('WORKSPACE_NOT_FOUND', 'Workspace root is required for workspace-scoped server installation'));
    }

    const serverEntry: Record<string, unknown> = {};
    if (input.transport === 'stdio') {
      serverEntry.command = effectiveCommand;
      if (effectiveArgs && effectiveArgs.length > 0) serverEntry.args = effectiveArgs;
      if (input.env && Object.keys(input.env).length > 0) serverEntry.env = input.env;
      if (effectiveCwd) serverEntry.cwd = effectiveCwd;
    } else {
      serverEntry.url = input.url;
      serverEntry.type = input.transport;
    }

    const configFiles = this.expandTargets(input.targets)
      .map((target) => this.serverTargetConfigFile(target, scope, workspaceRoot))
      .filter((configFile): configFile is string => configFile !== undefined);
    const updatedConfigFiles: string[] = [];
    try {
      await withConfigMutationTransaction(configFiles, async () => {
        for (const configFile of configFiles) {
          await injectServerIntoConfigFile(configFile, serverName, serverEntry);
          updatedConfigFiles.push(configFile);
        }
      });
    } catch (error: unknown) {
      if (managedVersionRoot !== undefined) await rm(managedVersionRoot, { recursive: true, force: true }).catch(() => undefined);
      return err(appError('INTERNAL_ERROR', `Failed to update server config: ${error instanceof Error ? error.message : String(error)}`));
    }

    return ok({
      name: serverName,
      targets: input.targets,
      updatedConfigFiles,
      ...(managedSourcePath === undefined ? {} : { managedSourcePath }),
    });
  }

  private async materializeServerSource(
    serverName: string,
    source: string,
  ): Promise<Result<{ readonly path: string; readonly versionRoot: string }>> {
    const remote = parseHttpsGitSource(source);
    if (remote === undefined) return err(appError('INVALID_INPUT', 'MCP repository sources must use an HTTPS Git repository URL'));

    const versionsDirectory = path.join(this.dataDir, 'extensions', 'mcp', serverName, 'versions');
    await mkdir(versionsDirectory, { recursive: true });
    const versionRoot = await mkdtemp(path.join(versionsDirectory, 'version-'));
    const repositoryPath = path.join(versionRoot, 'repo');
    const cloned = await this.gitRunner.run(['clone', '--depth', '1', '--', remote.href, repositoryPath], versionRoot, { timeoutMs: 120_000 });
    if (cloned.exitCode !== 0) {
      await rm(versionRoot, { recursive: true, force: true }).catch(() => undefined);
      return err(appError('INVALID_INPUT', `Failed to clone MCP repository source: ${boundedGitError(cloned.stderr)}`));
    }
    return ok({ path: repositoryPath, versionRoot });
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

function parseHttpsGitSource(source: string): URL | undefined {
  try {
    const parsed = new URL(source.trim());
    if (parsed.protocol !== 'https:' || parsed.username.length > 0 || parsed.password.length > 0) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function looksLikeRemoteSource(source: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(source.trim()) || /^git@/i.test(source.trim());
}

function boundedGitError(stderr: string): string {
  const message = stderr.trim().replace(/\s+/g, ' ');
  return message.length === 0 ? 'git clone failed' : message.slice(0, 512);
}

async function resolveNodePackageLaunch(
  repositoryPath: string,
  serverName: string,
): Promise<Result<{ readonly command: string; readonly args: readonly string[]; readonly cwd: string }>> {
  let manifest: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(repositoryPath, 'package.json'), 'utf8'));
    if (!isRecord(parsed)) return err(appError('INVALID_INPUT', 'Remote MCP package.json must contain an object'));
    manifest = parsed;
  } catch (error) {
    return err(appError('INVALID_INPUT', `Remote MCP repository requires a valid package.json: ${error instanceof Error ? error.message : String(error)}`));
  }

  for (const field of ['dependencies', 'optionalDependencies'] as const) {
    const dependencies = manifest[field];
    if (isRecord(dependencies) && Object.keys(dependencies).length > 0) {
      return err(appError('INVALID_INPUT', 'Remote MCP repositories with runtime dependencies are not auto-installed; provide a self-contained prebuilt package or an explicit command'));
    }
  }

  const bin = packageBinPath(manifest.bin, serverName);
  if (bin === undefined) return err(appError('INVALID_INPUT', 'Remote MCP package.json must declare a single executable bin entry'));
  try {
    const canonicalRoot = await realpath(repositoryPath);
    const canonicalBin = await realpath(path.resolve(repositoryPath, bin));
    const inside = canonicalBin === canonicalRoot || canonicalBin.startsWith(`${canonicalRoot}${path.sep}`);
    if (!inside || !(await stat(canonicalBin)).isFile()) {
      return err(appError('INVALID_INPUT', 'Remote MCP package bin must resolve to a file inside the cloned repository'));
    }
    return ok({ command: process.execPath, args: [canonicalBin], cwd: canonicalRoot });
  } catch {
    return err(appError('INVALID_INPUT', `Remote MCP package bin was not found: ${bin}`));
  }
}

function packageBinPath(value: unknown, serverName: string): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  if (!isRecord(value)) return undefined;
  const named = value[serverName];
  if (typeof named === 'string' && named.trim().length > 0) return named.trim();
  const bins = Object.values(value).filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
  return bins.length === 1 ? bins[0]!.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('Configuration root must be an object');
    }
    doc = parsed as Record<string, unknown>;
  } catch (error: unknown) {
    if (!isMissingPath(error)) throw error;
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

function isMissingPath(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT';
}

