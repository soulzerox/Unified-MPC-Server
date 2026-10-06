import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appError, err, ok, type Result } from '@unified-mpc/domain';
import { DirectGitRunner, type GitRunner } from '@unified-mpc/git';
import {
  CanonicalExtensionRegistry,
  evaluateCanonicalExtensionCompatibility,
  type CanonicalExtensionCandidate,
  type CanonicalExtensionCompatibility,
  type CanonicalExtensionCompatibilityState,
  type CanonicalExtensionProvenance,
} from './canonical-extension-registry.js';
import { CanonicalMcpMigrationCutoverStateStore } from './canonical-mcp-migration-cutover-state.js';
import { CanonicalSkillMigrationCutoverStateStore } from './canonical-skill-migration-cutover-state.js';
import { fingerprintCanonicalSkillDirectory } from './canonical-skill-migration-stager.js';
import { parseSkillMarkdown } from './skill-catalog.js';
import { exclusionReason, stripJsonComments } from './mcp-config-loader.js';
import { fingerprintExternalMcpValue } from './mcp-session-manager.js';
import { writeAtomic } from './ide-sync.js';
import { withConfigMutationTransaction } from './config-mutation-lock.js';

export type InstallTarget = 'unified-mpc' | 'antigravity' | 'cursor' | 'claude' | 'codex' | 'cline' | 'opencode' | 'all';
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
  readonly sourceRevision?: string;
  readonly sourceContentSha256?: string;
}

export interface InstallerServiceOptions {
  readonly homeDir?: string;
  readonly appDataDir?: string;
  readonly workspaceRoot?: string;
  readonly dataDir?: string;
  readonly gitRunner?: GitRunner;
  readonly platform?: NodeJS.Platform;
  readonly architecture?: string;
  readonly availableCommands?: ReadonlySet<string>;
}

interface DeclaredCompatibilityEvaluation {
  readonly state: CanonicalExtensionCompatibilityState;
  readonly compatibility?: CanonicalExtensionCompatibility;
  readonly availableCommands: ReadonlySet<string>;
}

const MANAGED_MCP_VERSION_RETENTION = 3;

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
  const supportedTargets = ['unified-mpc', ...ALL_TARGETS, 'all'] as const;
  const supported = new Set<string>(supportedTargets);
  const invalid = [...new Set(targets.filter((target) => !supported.has(target)))];
  if (invalid.length === 0) return undefined;
  return appError(
    'UNSUPPORTED_TARGET',
    `Unsupported target(s): ${invalid.join(', ')}. Supported targets: ${supportedTargets.join(', ')}`,
    false,
    { invalidTargets: invalid.join(', '), supportedTargets: supportedTargets.join(', ') },
  );
}

export class InstallerService {
  private readonly home: string;
  private readonly appData: string;
  private readonly workspace: string | undefined;
  private readonly dataDir: string;
  private readonly gitRunner: GitRunner;
  private readonly platform: NodeJS.Platform;
  private readonly architecture: string;
  private readonly availableCommands: ReadonlySet<string> | undefined;

  public constructor(options: InstallerServiceOptions = {}) {
    this.home = options.homeDir ?? os.homedir();
    this.appData = options.appDataDir?.trim() ?? path.join(this.home, '.config');
    this.workspace = options.workspaceRoot?.trim();
    this.dataDir = options.dataDir?.trim() ?? path.join(this.home, '.local', 'share', 'unified-mpc');
    this.gitRunner = options.gitRunner ?? new DirectGitRunner();
    this.platform = options.platform ?? process.platform;
    this.architecture = options.architecture?.trim() || process.arch;
    this.availableCommands = options.availableCommands;
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

  public async installBundledSkill(input: {
    readonly name: string;
    readonly source: string;
  }): Promise<Result<InstallSkillResult>> {
    const skillName = input.name.trim();
    if (
      skillName.length === 0
      || !/^[A-Za-z0-9_-]+$/.test(skillName)
      || ['constructor', '__proto__', 'prototype'].includes(skillName.toLowerCase())
    ) {
      return err(appError('INVALID_INPUT', `Invalid skill name: "${input.name}"`));
    }
    const resolvedSource = path.resolve(input.source);
    return this.installSkillFromResolvedSource(
      { name: skillName, source: resolvedSource, targets: ['unified-mpc'] },
      skillName,
      resolvedSource,
      { originType: 'bundled', origin: resolvedSource },
    );
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
    canonicalProvenance?: CanonicalExtensionProvenance,
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

    const compatibility = await this.validateDeclaredCompatibility(sourceSkillDir);
    if (!compatibility.ok) return err(compatibility.error);

    const scope: InstallScope = input.scope ?? 'global';
    const workspaceRoot = input.workspaceRoot?.trim() ?? this.workspace;
    if (scope === 'workspace' && (workspaceRoot === undefined || workspaceRoot.length === 0)) {
      return err(appError('WORKSPACE_NOT_FOUND', 'Workspace root is required for workspace-scoped skill installation'));
    }

    const installedPaths: string[] = [];
    const targets = this.expandTargets(input.targets);
    if (targets.includes('unified-mpc')) {
      const promoted = await new CanonicalSkillMigrationCutoverStateStore({ dataDir: this.dataDir })
        .promoteActiveGenerationToDirectStore();
      if (!promoted.ok) return err(promoted.error);
      const canonical = await this.installCanonicalSkill(
        skillName,
        input.source,
        sourceSkillDir,
        canonicalProvenance,
      );
      if (!canonical.ok) return err(canonical.error);
      installedPaths.push(canonical.value);
    }

    for (const target of targets) {
      if (target === 'unified-mpc') continue;
      const targetDir = this.skillTargetDirectory(target, scope, skillName, workspaceRoot);
      if (targetDir === undefined) continue;
      await mkdir(targetDir, { recursive: true });
      await cp(sourceSkillDir, targetDir, { recursive: true });
      installedPaths.push(path.join(targetDir, 'SKILL.md'));
    }
    return ok({ name: skillName, installedPaths, targets: input.targets });
  }

  private async installCanonicalSkill(
    skillName: string,
    inputSource: string,
    sourceSkillDir: string,
    provenanceOverride?: CanonicalExtensionProvenance,
  ): Promise<Result<string>> {
    const stagingRoot = path.join(
      this.dataDir,
      'extensions',
      'state',
      'skill-install-staging',
    );
    let stagingContainer: string;
    try {
      await mkdir(stagingRoot, { recursive: true });
      stagingContainer = await mkdtemp(path.join(stagingRoot, `${skillName}-`));
    } catch (error: unknown) {
      return err(appError(
        'INTERNAL_ERROR',
        `Failed to create canonical Skill staging directory: ${error instanceof Error ? error.message : String(error)}`,
        true,
      ));
    }

    const stagedSkillDir = path.join(stagingContainer, 'skill');
    try {
      const sourceGitPath = path.join(path.resolve(sourceSkillDir), '.git');
      await cp(sourceSkillDir, stagedSkillDir, {
        recursive: true,
        filter: (sourcePath) => path.resolve(sourcePath) !== sourceGitPath,
      });

      const stagedFingerprint = await fingerprintCanonicalSkillDirectory(stagedSkillDir);
      if (!stagedFingerprint.ok) return err(stagedFingerprint.error);

      try {
        parseSkillMarkdown(
          await readFile(path.join(stagedSkillDir, 'SKILL.md'), 'utf8'),
          skillName,
        );
      } catch (error: unknown) {
        return err(appError(
          'INVALID_INPUT',
          `Failed to validate staged canonical Skill markdown: ${error instanceof Error ? error.message : String(error)}`,
        ));
      }

      const compatibility = await this.validateDeclaredCompatibility(stagedSkillDir);
      if (!compatibility.ok) return err(compatibility.error);

      const remoteSource = parseHttpsGitSource(inputSource);
      const candidate: CanonicalExtensionCandidate = {
        kind: 'skill',
        id: `skill:${skillName}`,
        name: skillName,
        fingerprint: stagedFingerprint.value,
        enabled: true,
        provenance: provenanceOverride === undefined
          ? {
              originType: remoteSource === undefined ? 'local-import' : 'github',
              origin: remoteSource?.href ?? path.resolve(inputSource),
              contentSha256: stagedFingerprint.value,
            }
          : {
              ...provenanceOverride,
              contentSha256: stagedFingerprint.value,
            },
        ...(compatibility.value.compatibility === undefined
          ? {}
          : { compatibility: compatibility.value.compatibility }),
      };

      const activeSkillDir = path.join(this.dataDir, 'extensions', 'skills', skillName);
      const backupRoot = path.join(
        this.dataDir,
        'extensions',
        'state',
        'skill-install-backups',
      );
      let backupPath: string | undefined;
      let previousMoved = false;
      let stagedActivated = false;

      const persisted = await new CanonicalExtensionRegistry({ dataDir: this.dataDir }).upsertAtomically(
        candidate,
        {
          platform: this.platform,
          architecture: this.architecture,
          availableCommands: compatibility.value.availableCommands,
        },
        [],
        async () => {
          const currentFingerprint = await fingerprintCanonicalSkillDirectory(activeSkillDir);
          if (currentFingerprint.ok && currentFingerprint.value === stagedFingerprint.value) {
            return;
          }
          if (!currentFingerprint.ok && currentFingerprint.error.code !== 'FILE_NOT_FOUND') {
            throw new Error(
              `Existing canonical Skill copy is not safe to replace: ${currentFingerprint.error.message}`,
            );
          }

          await mkdir(path.dirname(activeSkillDir), { recursive: true });
          if (currentFingerprint.ok) {
            await mkdir(backupRoot, { recursive: true });
            backupPath = path.join(backupRoot, `${skillName}-${randomUUID()}`);
            await rename(activeSkillDir, backupPath);
            previousMoved = true;
          }

          await rename(stagedSkillDir, activeSkillDir);
          stagedActivated = true;

          const activatedFingerprint = await fingerprintCanonicalSkillDirectory(activeSkillDir);
          if (
            !activatedFingerprint.ok
            || activatedFingerprint.value !== stagedFingerprint.value
          ) {
            throw new Error(
              activatedFingerprint.ok
                ? 'Activated canonical Skill fingerprint does not match staged content'
                : `Failed to verify activated canonical Skill: ${activatedFingerprint.error.message}`,
            );
          }
        },
        async () => {
          if (stagedActivated) {
            await rm(activeSkillDir, { recursive: true, force: true });
            stagedActivated = false;
          }
          if (previousMoved && backupPath !== undefined) {
            await rename(backupPath, activeSkillDir);
            previousMoved = false;
          }
        },
      );
      if (!persisted.ok) return err(persisted.error);

      if (previousMoved && backupPath !== undefined) {
        await rm(backupPath, { recursive: true, force: true }).catch(() => undefined);
      }
      return ok(path.join(activeSkillDir, 'SKILL.md'));
    } catch (error: unknown) {
      return err(appError(
        'INTERNAL_ERROR',
        `Failed to install canonical Skill: ${error instanceof Error ? error.message : String(error)}`,
        true,
      ));
    } finally {
      await rm(stagingContainer, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async validateDeclaredCompatibility(
    sourceRoot: string,
  ): Promise<Result<DeclaredCompatibilityEvaluation>> {
    const declared = await readDeclaredCompatibility(sourceRoot);
    if (!declared.ok) return err(declared.error);
    if (declared.value === undefined) {
      return ok({
        state: 'unknown',
        availableCommands: this.availableCommands ?? new Set<string>(),
      });
    }

    const requiredCommands = declared.value.requiresCommands ?? [];
    const availableCommands = this.availableCommands
      ?? await detectAvailableCommands(requiredCommands, this.platform);
    const evaluated = evaluateCanonicalExtensionCompatibility(declared.value, {
      platform: this.platform,
      architecture: this.architecture,
      availableCommands,
    });

    if (evaluated.state === 'incompatible_platform') {
      return err(appError(
        'UNSUPPORTED_PLATFORM',
        `Extension compatibility does not include current platform ${this.platform}; declared platforms: ${(declared.value.platforms ?? []).join(', ') || '<none>'}`,
        false,
        {
          platform: this.platform,
          declaredPlatforms: (declared.value.platforms ?? []).join(','),
        },
      ));
    }
    if (evaluated.state === 'incompatible_architecture') {
      return err(appError(
        'UNSUPPORTED_PLATFORM',
        `Extension compatibility does not include current architecture ${this.architecture}; declared architectures: ${(declared.value.architectures ?? []).join(', ') || '<none>'}`,
        false,
        {
          architecture: this.architecture,
          declaredArchitectures: (declared.value.architectures ?? []).join(','),
        },
      ));
    }
    if (evaluated.state === 'missing_dependency') {
      return err(appError(
        'EXECUTABLE_NOT_FOUND',
        `Extension requires unavailable command(s): ${evaluated.missingCommands.join(', ')}`,
        false,
        { missingCommands: evaluated.missingCommands.join(',') },
      ));
    }
    if (evaluated.state === 'conflict') {
      return err(appError('INVALID_INPUT', 'Extension compatibility metadata is conflicting'));
    }
    return ok({
      state: evaluated.state,
      compatibility: declared.value,
      availableCommands,
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
    if (target === 'unified-mpc') {
      return path.join(this.dataDir, 'extensions', 'skills', skillName);
    }
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
    let managedProvenanceJson: string | undefined;
    let sourceRevision: string | undefined;
    let sourceContentSha256: string | undefined;
    let declaredCompatibility: CanonicalExtensionCompatibility | undefined;
    let compatibilityCommands = this.availableCommands ?? new Set<string>();
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
        managedProvenanceJson = materialized.value.provenanceJson;
        sourceRevision = materialized.value.revision;
        sourceContentSha256 = materialized.value.contentSha256;
        const compatibility = await this.validateDeclaredCompatibility(managedSourcePath);
        if (!compatibility.ok) {
          await rm(managedVersionRoot, { recursive: true, force: true }).catch(() => undefined);
          return err(compatibility.error);
        }
        declaredCompatibility = compatibility.value.compatibility;
        compatibilityCommands = compatibility.value.availableCommands;
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

    const expandedTargets = this.expandTargets(input.targets);
    if (expandedTargets.includes('unified-mpc')) {
      const promoted = await new CanonicalMcpMigrationCutoverStateStore({ dataDir: this.dataDir })
        .promoteActiveGenerationToDirectStore();
      if (!promoted.ok) {
        if (managedVersionRoot !== undefined) {
          await rm(managedVersionRoot, { recursive: true, force: true }).catch(() => undefined);
        }
        return err(promoted.error);
      }
    }
    const configFiles = expandedTargets
      .map((target) => this.serverTargetConfigFile(target, scope, workspaceRoot))
      .filter((configFile): configFile is string => configFile !== undefined);
    const currentMarkerFile = managedVersionRoot === undefined
      ? undefined
      : path.join(this.dataDir, 'extensions', 'mcp', serverName, 'current.json');
    if (managedVersionRoot !== undefined) {
      const references = {
        version: 1,
        configFiles: [...configFiles],
      } as const;
      await writeAtomic(path.join(managedVersionRoot, 'references.json'), `${JSON.stringify(references, null, 2)}\n`);
    }
    const transactionFiles = currentMarkerFile === undefined ? configFiles : [...configFiles, currentMarkerFile];
    const updatedConfigFiles: string[] = [];
    const writeInstallationFiles = async (): Promise<void> => {
      for (const configFile of configFiles) {
        await injectServerIntoConfigFile(configFile, serverName, serverEntry);
        updatedConfigFiles.push(configFile);
      }
      if (currentMarkerFile !== undefined && managedProvenanceJson !== undefined) {
        await writeAtomic(currentMarkerFile, managedProvenanceJson);
      }
    };

    if (expandedTargets.includes('unified-mpc')) {
      const provenance = input.source !== undefined
        ? {
            originType: 'github' as const,
            origin: parseHttpsGitSource(input.source)?.href ?? input.source.trim(),
            ...(sourceRevision === undefined ? {} : { revision: sourceRevision }),
            ...(sourceContentSha256 === undefined ? {} : { contentSha256: sourceContentSha256 }),
          }
        : input.transport === 'stdio'
          ? {
              originType: 'managed' as const,
              origin: 'unified-mpc:mcp_install',
            }
          : {
              originType: 'url' as const,
              origin: new URL(input.url!).href,
            };
      const candidate: CanonicalExtensionCandidate = {
        kind: 'mcp_server',
        id: `mcp:${serverName}`,
        name: serverName,
        fingerprint: fingerprintExternalMcpValue(serverEntry),
        enabled: true,
        provenance,
        ...(declaredCompatibility === undefined ? {} : { compatibility: declaredCompatibility }),
      };
      const persisted = await new CanonicalExtensionRegistry({ dataDir: this.dataDir }).upsertAtomically(
        candidate,
        {
          platform: this.platform,
          architecture: this.architecture,
          availableCommands: compatibilityCommands,
        },
        transactionFiles,
        writeInstallationFiles,
      );
      if (!persisted.ok) {
        if (managedVersionRoot !== undefined) {
          await rm(managedVersionRoot, { recursive: true, force: true }).catch(() => undefined);
        }
        return err(persisted.error);
      }
    } else {
      try {
        await withConfigMutationTransaction(transactionFiles, writeInstallationFiles);
      } catch (error: unknown) {
        if (managedVersionRoot !== undefined) {
          await rm(managedVersionRoot, { recursive: true, force: true }).catch(() => undefined);
        }
        return err(appError(
          'INTERNAL_ERROR',
          `Failed to update server config: ${error instanceof Error ? error.message : String(error)}`,
        ));
      }
    }

    if (managedVersionRoot !== undefined) {
      await this.pruneUnreferencedManagedVersions(serverName, managedVersionRoot).catch(() => undefined);
    }

    return ok({
      name: serverName,
      targets: input.targets,
      updatedConfigFiles,
      ...(managedSourcePath === undefined ? {} : { managedSourcePath }),
      ...(sourceRevision === undefined ? {} : { sourceRevision }),
      ...(sourceContentSha256 === undefined ? {} : { sourceContentSha256 }),
    });
  }

  private async materializeServerSource(
    serverName: string,
    source: string,
  ): Promise<Result<{
    readonly path: string;
    readonly versionRoot: string;
    readonly revision: string;
    readonly contentSha256: string;
    readonly provenanceJson: string;
  }>> {
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

    const revisionResult = await this.gitRunner.run(['rev-parse', 'HEAD'], repositoryPath, { timeoutMs: 30_000 });
    const revision = revisionResult.stdout.trim().toLowerCase();
    if (revisionResult.exitCode !== 0 || !/^[a-f0-9]{7,64}$/.test(revision)) {
      await rm(versionRoot, { recursive: true, force: true }).catch(() => undefined);
      return err(appError('INVALID_INPUT', `Failed to resolve MCP repository revision: ${boundedGitError(revisionResult.stderr)}`));
    }

    try {
      const contentSha256 = await hashManagedSourceContent(repositoryPath);
      const provenance = {
        version: 1,
        source: remote.href,
        revision,
        contentSha256,
        versionId: path.basename(versionRoot),
      } as const;
      const provenanceJson = `${JSON.stringify(provenance, null, 2)}\n`;
      await writeAtomic(path.join(versionRoot, 'provenance.json'), provenanceJson);
      return ok({ path: repositoryPath, versionRoot, revision, contentSha256, provenanceJson });
    } catch (error: unknown) {
      await rm(versionRoot, { recursive: true, force: true }).catch(() => undefined);
      return err(appError('INTERNAL_ERROR', `Failed to record MCP source provenance: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  private async pruneUnreferencedManagedVersions(serverName: string, currentVersionRoot: string): Promise<void> {
    const versionsDirectory = path.join(this.dataDir, 'extensions', 'mcp', serverName, 'versions');
    let entries;
    try {
      entries = await readdir(versionsDirectory, { withFileTypes: true });
    } catch (error: unknown) {
      if (isMissingPath(error)) return;
      throw error;
    }

    const versions = await Promise.all(entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('version-'))
      .map(async (entry) => {
        const versionRoot = path.join(versionsDirectory, entry.name);
        return { versionRoot, mtimeMs: (await stat(versionRoot)).mtimeMs };
      }));
    const recentOthers = versions
      .filter((entry) => entry.versionRoot !== currentVersionRoot)
      .sort((left, right) => right.mtimeMs - left.mtimeMs)
      .slice(0, Math.max(0, MANAGED_MCP_VERSION_RETENTION - 1));
    const retained = new Set([currentVersionRoot, ...recentOthers.map((entry) => entry.versionRoot)]);

    for (const version of versions) {
      if (retained.has(version.versionRoot)) continue;
      if (await this.managedVersionHasLiveReference(version.versionRoot)) continue;
      await rm(version.versionRoot, { recursive: true, force: true });
    }
  }

  private async managedVersionHasLiveReference(versionRoot: string): Promise<boolean> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path.join(versionRoot, 'references.json'), 'utf8')) as unknown;
    } catch {
      return true;
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.configFiles) || !parsed.configFiles.every((entry) => typeof entry === 'string')) {
      return true;
    }
    for (const configFile of parsed.configFiles as string[]) {
      try {
        if ((await readFile(configFile, 'utf8')).includes(versionRoot)) return true;
      } catch (error: unknown) {
        if (!isMissingPath(error)) return true;
      }
    }
    return false;
  }

  private serverTargetConfigFile(
    target: InstallTarget,
    scope: InstallScope,
    workspaceRoot?: string,
  ): string | undefined {
    if (target === 'unified-mpc') {
      return path.join(this.dataDir, 'extensions', 'mcp', 'registry.json');
    }
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

const SUPPORTED_EXTENSION_PLATFORMS = new Set<NodeJS.Platform>(['linux', 'darwin', 'win32']);

async function readDeclaredCompatibility(
  sourceRoot: string,
): Promise<Result<CanonicalExtensionCompatibility | undefined>> {
  const manifestPath = path.join(sourceRoot, 'manifest.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown;
  } catch (error: unknown) {
    if (isMissingPath(error)) return ok(undefined);
    if (error instanceof SyntaxError) {
      return err(appError('INVALID_INPUT', `Extension compatibility manifest is invalid JSON: ${manifestPath}`));
    }
    return err(appError(
      'INTERNAL_ERROR',
      `Failed to read extension compatibility manifest: ${error instanceof Error ? error.message : String(error)}`,
      true,
    ));
  }
  if (!isRecord(parsed)) {
    return err(appError('INVALID_INPUT', `Extension compatibility manifest must contain an object: ${manifestPath}`));
  }
  if (parsed.compatibility === undefined) return ok(undefined);
  if (!isRecord(parsed.compatibility)) {
    return err(appError('INVALID_INPUT', 'Extension compatibility metadata must contain an object'));
  }

  const compatibility = parsed.compatibility;
  const allowedKeys = new Set(['platforms', 'architectures', 'requiresCommands', 'optionalCommands']);
  const unknownKeys = Object.keys(compatibility).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) {
    return err(appError(
      'INVALID_INPUT',
      `Extension compatibility metadata contains unknown field(s): ${unknownKeys.sort().join(', ')}`,
    ));
  }

  const platforms = decodeCompatibilityList(compatibility.platforms, 'platforms', (value) => (
    SUPPORTED_EXTENSION_PLATFORMS.has(value as NodeJS.Platform)
  ));
  if (!platforms.ok) return err(platforms.error);
  const architectures = decodeCompatibilityList(
    compatibility.architectures,
    'architectures',
    (value) => /^[A-Za-z0-9._-]+$/.test(value),
  );
  if (!architectures.ok) return err(architectures.error);
  const requiresCommands = decodeCompatibilityList(
    compatibility.requiresCommands,
    'requiresCommands',
    isSafeCommandName,
  );
  if (!requiresCommands.ok) return err(requiresCommands.error);
  const optionalCommands = decodeCompatibilityList(
    compatibility.optionalCommands,
    'optionalCommands',
    isSafeCommandName,
  );
  if (!optionalCommands.ok) return err(optionalCommands.error);

  return ok({
    ...(platforms.value === undefined ? {} : { platforms: platforms.value as readonly NodeJS.Platform[] }),
    ...(architectures.value === undefined ? {} : { architectures: architectures.value }),
    ...(requiresCommands.value === undefined ? {} : { requiresCommands: requiresCommands.value }),
    ...(optionalCommands.value === undefined ? {} : { optionalCommands: optionalCommands.value }),
  });
}

function decodeCompatibilityList(
  value: unknown,
  field: string,
  validate: (entry: string) => boolean,
): Result<readonly string[] | undefined> {
  if (value === undefined) return ok(undefined);
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    return err(appError('INVALID_INPUT', `Extension compatibility ${field} must be an array of strings`));
  }
  const normalized = [...new Set(value.map((entry) => entry.trim()))].sort((left, right) => left.localeCompare(right));
  if (normalized.some((entry) => entry.length === 0 || !validate(entry))) {
    return err(appError('INVALID_INPUT', `Extension compatibility ${field} contains an invalid value`));
  }
  return ok(normalized);
}

function isSafeCommandName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value);
}

async function detectAvailableCommands(
  commands: readonly string[],
  platform: NodeJS.Platform,
): Promise<ReadonlySet<string>> {
  const available = new Set<string>();
  for (const command of commands) {
    if (await commandExistsOnPath(command, platform)) available.add(command);
  }
  return available;
}

async function commandExistsOnPath(command: string, platform: NodeJS.Platform): Promise<boolean> {
  const searchPath = process.env.PATH ?? '';
  if (searchPath.length === 0) return false;
  const extensions = platform === 'win32'
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((entry) => entry.length > 0)
    : [''];
  for (const directory of searchPath.split(path.delimiter).filter((entry) => entry.length > 0)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, platform === 'win32' ? `${command}${extension}` : command);
      try {
        await access(candidate, platform === 'win32' ? constants.F_OK : constants.X_OK);
        return true;
      } catch {
        continue;
      }
    }
  }
  return false;
}

async function hashManagedSourceContent(repositoryPath: string): Promise<string> {
  const hash = createHash('sha256');
  const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => !(relativeDirectory.length === 0 && entry.name === '.git'))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = relativeDirectory.length === 0 ? entry.name : `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) {
        hash.update(`dir\0${relativePath}\0`);
        await visit(absolutePath, relativePath);
        continue;
      }
      if (entry.isFile()) {
        hash.update(`file\0${relativePath}\0`);
        hash.update(await readFile(absolutePath));
        hash.update('\0');
        continue;
      }
      if (entry.isSymbolicLink()) {
        hash.update(`symlink\0${relativePath}\0${await readlink(absolutePath)}\0`);
        continue;
      }
      throw new Error(`Unsupported repository entry type: ${relativePath}`);
    }
  };
  await visit(repositoryPath, '');
  return hash.digest('hex');
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

