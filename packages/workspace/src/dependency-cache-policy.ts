import { createHash } from 'node:crypto';
import { access, lstat, mkdir, readFile, readlink, rm } from 'node:fs/promises';
import path from 'node:path';

export const WORKTREE_DEPENDENCY_POLICY_VERSION = 1 as const;

export type DependencyInstallMode = 'frozen' | 'mutable';
export type DependencyDataClass = 'shared_reusable' | 'worktree_local' | 'repo_shared';
export type DependencyEcosystem =
  | 'node-pnpm'
  | 'node-npm'
  | 'node-yarn'
  | 'node-bun'
  | 'python-uv'
  | 'python-pip'
  | 'go'
  | 'rust'
  | 'unknown';
export type ExistingWorktreeDisposition = 'adopt' | 'rebootstrap' | 'grandfather';
export type DependencyMigrationStatus = 'pending' | 'grandfathered' | 'ready' | 'completed' | 'blocked';

export interface DependencyPolicyFileSystem {
  exists(filePath: string): Promise<boolean>;
  readText(filePath: string): Promise<string>;
  lstat(filePath: string): Promise<{ isSymbolicLink(): boolean }>;
  readLink(filePath: string): Promise<string>;
  ensureDirectory(directoryPath: string): Promise<void>;
  removePath(targetPath: string): Promise<void>;
}

class NodeDependencyPolicyFileSystem implements DependencyPolicyFileSystem {
  public async exists(filePath: string): Promise<boolean> {
    try {
      await access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  public readText(filePath: string): Promise<string> {
    return readFile(filePath, 'utf8');
  }

  public lstat(filePath: string): Promise<{ isSymbolicLink(): boolean }> {
    return lstat(filePath);
  }

  public readLink(filePath: string): Promise<string> {
    return readlink(filePath);
  }

  public async ensureDirectory(directoryPath: string): Promise<void> {
    await mkdir(directoryPath, { recursive: true });
  }

  public async removePath(targetPath: string): Promise<void> {
    await rm(targetPath, { recursive: true, force: true });
  }
}

export interface ExistingWorktreeSignals {
  readonly isNew?: boolean;
  readonly cleanInactive?: boolean;
  readonly dirty?: boolean;
  readonly active?: boolean;
  readonly processOwned?: boolean;
  readonly leased?: boolean;
}

export interface ExistingWorktreeClassification {
  readonly disposition: ExistingWorktreeDisposition;
  readonly reason: string;
  readonly mayReplaceMutableRuntimeState: boolean;
}

export interface DependencyMetadataSnapshot {
  readonly manifestDigest?: string;
  readonly lockfileDigest?: string;
  readonly packageManagerSpec?: string;
}

export interface DependencyMetadataEvaluation {
  readonly state:
    | 'untracked'
    | 'unchanged'
    | 'manifest_changed_lockfile_unchanged'
    | 'lockfile_changed'
    | 'package_manager_changed';
  readonly compatibleWithFrozenMode: boolean;
  readonly requiresRebootstrap: boolean;
  readonly reason?: string;
}

export interface DependencyPathDescriptor {
  readonly class: DependencyDataClass;
  readonly label: string;
  readonly path: string;
}

export interface DependencyInstallCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly phase: 'setup' | 'install';
}

export interface DependencyVersionCheck {
  readonly executable: string;
  readonly args: readonly string[];
  readonly expectedVersion: string;
}

export interface WorktreeDependencyDiagnostics {
  readonly policyVersion: typeof WORKTREE_DEPENDENCY_POLICY_VERSION;
  readonly strategyId: string;
  readonly ecosystem: DependencyEcosystem;
  readonly packageManager: string;
  readonly packageManagerVersion?: string;
  readonly packageManagerSpec?: string;
  readonly sharedStoreIdentity?: string;
  readonly localRuntimeIdentity: string;
  readonly installMode: DependencyInstallMode;
  readonly migrationDisposition: ExistingWorktreeDisposition;
  readonly lockfilePaths: readonly string[];
  readonly blockingReasons: readonly string[];
}

export interface WorktreeDependencyStrategy {
  readonly policyVersion: typeof WORKTREE_DEPENDENCY_POLICY_VERSION;
  readonly status: 'ready' | 'blocked' | 'unsupported';
  readonly strategyId: string;
  readonly ecosystem: DependencyEcosystem;
  readonly packageManager: string;
  readonly packageManagerVersion?: string;
  readonly packageManagerSpec?: string;
  readonly rootPath: string;
  readonly installMode: DependencyInstallMode;
  readonly manifestPaths: readonly string[];
  readonly lockfilePaths: readonly string[];
  readonly metadata: DependencyMetadataSnapshot;
  readonly paths: readonly DependencyPathDescriptor[];
  readonly sharedPaths: readonly string[];
  readonly worktreeLocalPaths: readonly string[];
  readonly repoSharedPaths: readonly string[];
  readonly commands: readonly DependencyInstallCommand[];
  readonly versionCheck?: DependencyVersionCheck;
  readonly migration: ExistingWorktreeClassification;
  readonly directCrossWorktreeMutableSymlinkAllowed: false;
  readonly sharedStorePruneRequiresZeroActiveReferences: true;
  readonly blockingReasons: readonly string[];
  readonly diagnostics: WorktreeDependencyDiagnostics;
}

export interface ResolveDependencyStrategyInput {
  readonly rootPath: string;
  readonly sharedCacheRoot: string;
  readonly installMode?: DependencyInstallMode;
  readonly worktree?: ExistingWorktreeSignals;
  readonly baseline?: DependencyMetadataSnapshot;
  readonly fileSystem?: DependencyPolicyFileSystem;
}

export interface MutableRuntimeIsolationResult {
  readonly safe: boolean;
  readonly checkedPaths: readonly string[];
  readonly violations: readonly {
    readonly path: string;
    readonly target: string;
    readonly reason: 'mutable_runtime_symlink_outside_worktree';
  }[];
}

export interface DependencyBootstrapPlan {
  readonly status: 'ready' | 'blocked' | 'unsupported';
  readonly strategy: WorktreeDependencyStrategy;
  readonly isolation: MutableRuntimeIsolationResult;
  readonly metadataEvaluation: DependencyMetadataEvaluation;
}

export interface DependencyMigrationState {
  readonly version: typeof WORKTREE_DEPENDENCY_POLICY_VERSION;
  readonly strategyId: string;
  readonly ecosystem: DependencyEcosystem;
  readonly packageManager: string;
  readonly packageManagerVersion?: string;
  readonly disposition: ExistingWorktreeDisposition;
  readonly status: DependencyMigrationStatus;
  readonly manifestDigest?: string;
  readonly lockfileDigest?: string;
  readonly packageManagerSpec?: string;
  readonly lastBootstrapResult?: 'pending' | 'reused' | 'installed' | 'failed';
}

interface DetectedProject {
  readonly ecosystem: DependencyEcosystem;
  readonly packageManager: string;
  readonly packageManagerVersion?: string;
  readonly packageManagerSpec?: string;
  readonly manifestPaths: readonly string[];
  readonly lockfilePaths: readonly string[];
  readonly blockingReasons: readonly string[];
}

const NODE_LOCKFILES = {
  pnpm: ['pnpm-lock.yaml'],
  npm: ['package-lock.json', 'npm-shrinkwrap.json'],
  yarn: ['yarn.lock'],
  bun: ['bun.lock', 'bun.lockb'],
} as const;

export function classifyExistingWorktree(signals: ExistingWorktreeSignals = {}): ExistingWorktreeClassification {
  if (signals.isNew === true) {
    return {
      disposition: 'adopt',
      reason: 'New managed worktrees adopt the dependency/cache policy immediately.',
      mayReplaceMutableRuntimeState: true,
    };
  }

  if (signals.dirty || signals.active || signals.processOwned || signals.leased) {
    return {
      disposition: 'grandfather',
      reason: 'Active, dirty, leased, or process-owned worktrees keep their mutable runtime view until a safe lifecycle boundary.',
      mayReplaceMutableRuntimeState: false,
    };
  }

  if (signals.cleanInactive === true) {
    return {
      disposition: 'rebootstrap',
      reason: 'Clean inactive managed worktrees may be re-bootstrapped without changing Git content.',
      mayReplaceMutableRuntimeState: true,
    };
  }

  return {
    disposition: 'grandfather',
    reason: 'Worktree lifecycle is unknown; mutable runtime state remains untouched until inactivity is proven.',
    mayReplaceMutableRuntimeState: false,
  };
}

export function evaluateDependencyMetadata(
  current: DependencyMetadataSnapshot,
  baseline?: DependencyMetadataSnapshot,
): DependencyMetadataEvaluation {
  if (baseline === undefined) {
    return { state: 'untracked', compatibleWithFrozenMode: true, requiresRebootstrap: true };
  }

  if ((current.packageManagerSpec ?? '') !== (baseline.packageManagerSpec ?? '')) {
    return {
      state: 'package_manager_changed',
      compatibleWithFrozenMode: false,
      requiresRebootstrap: true,
      reason: 'Package-manager selection/version changed and requires explicit dependency-update mode.',
    };
  }

  const manifestChanged = (current.manifestDigest ?? '') !== (baseline.manifestDigest ?? '');
  const lockfileChanged = (current.lockfileDigest ?? '') !== (baseline.lockfileDigest ?? '');

  if (manifestChanged && !lockfileChanged) {
    return {
      state: 'manifest_changed_lockfile_unchanged',
      compatibleWithFrozenMode: false,
      requiresRebootstrap: true,
      reason: 'Manifest changed while lockfile stayed unchanged; frozen install must fail instead of rewriting dependency metadata.',
    };
  }

  if (lockfileChanged) {
    return { state: 'lockfile_changed', compatibleWithFrozenMode: true, requiresRebootstrap: true };
  }

  return { state: 'unchanged', compatibleWithFrozenMode: true, requiresRebootstrap: false };
}

export async function resolveDependencyStrategy(input: ResolveDependencyStrategyInput): Promise<WorktreeDependencyStrategy> {
  const fileSystem = input.fileSystem ?? new NodeDependencyPolicyFileSystem();
  const rootPath = path.resolve(input.rootPath);
  const sharedCacheRoot = path.resolve(input.sharedCacheRoot);
  const installMode = input.installMode ?? 'frozen';
  const detected = await detectProject(rootPath, fileSystem);
  const manifestDigest = await digestExistingFiles(rootPath, detected.manifestPaths, fileSystem);
  const lockfileDigest = await digestExistingFiles(rootPath, detected.lockfilePaths, fileSystem);
  const metadata: DependencyMetadataSnapshot = {
    ...(manifestDigest === undefined ? {} : { manifestDigest }),
    ...(lockfileDigest === undefined ? {} : { lockfileDigest }),
    ...(detected.packageManagerSpec === undefined ? {} : { packageManagerSpec: detected.packageManagerSpec }),
  };

  const consistency = evaluateDependencyMetadata(metadata, input.baseline);
  const blockingReasons = [...detected.blockingReasons];
  if (installMode === 'frozen' && detected.ecosystem.startsWith('node-') && detected.lockfilePaths.length === 0) {
    blockingReasons.push(`Frozen ${detected.packageManager} bootstrap requires its lockfile.`);
  }
  if (installMode === 'frozen' && !consistency.compatibleWithFrozenMode && consistency.reason !== undefined) {
    blockingReasons.push(consistency.reason);
  }

  return buildStrategy({
    rootPath,
    sharedCacheRoot,
    installMode,
    detected,
    migration: classifyExistingWorktree(input.worktree),
    metadata,
    blockingReasons,
  });
}

export async function prepareDependencyBootstrap(input: ResolveDependencyStrategyInput): Promise<DependencyBootstrapPlan> {
  const fileSystem = input.fileSystem ?? new NodeDependencyPolicyFileSystem();
  const strategy = await resolveDependencyStrategy({ ...input, fileSystem });
  const isolation = await validateMutableRuntimeIsolation(strategy, fileSystem);
  const metadataEvaluation = evaluateDependencyMetadata(strategy.metadata, input.baseline);
  const status = strategy.status === 'ready' && (
    !strategy.migration.mayReplaceMutableRuntimeState
    || !isolation.safe
    || (strategy.installMode === 'frozen' && !metadataEvaluation.compatibleWithFrozenMode)
  )
    ? 'blocked'
    : strategy.status;

  if (status === 'ready') {
    await Promise.all(strategy.sharedPaths.map(async (entry) => fileSystem.ensureDirectory(entry)));
  }

  return { status, strategy, isolation, metadataEvaluation };
}

export async function validateMutableRuntimeIsolation(
  strategy: WorktreeDependencyStrategy,
  fileSystem: DependencyPolicyFileSystem = new NodeDependencyPolicyFileSystem(),
): Promise<MutableRuntimeIsolationResult> {
  const checkedPaths: string[] = [];
  const violations: MutableRuntimeIsolationResult['violations'][number][] = [];

  for (const localPath of strategy.worktreeLocalPaths.filter((entry) => ['node_modules', '.venv'].includes(path.basename(entry)))) {
    checkedPaths.push(localPath);
    if (!(await fileSystem.exists(localPath))) continue;
    if (!(await fileSystem.lstat(localPath)).isSymbolicLink()) continue;

    const target = path.resolve(path.dirname(localPath), await fileSystem.readLink(localPath));
    if (!isPathInside(strategy.rootPath, target)) {
      violations.push({ path: localPath, target, reason: 'mutable_runtime_symlink_outside_worktree' });
    }
  }

  return { safe: violations.length === 0, checkedPaths, violations };
}

export async function cleanupWorktreeRuntime(input: {
  readonly strategy: WorktreeDependencyStrategy;
  readonly worktree?: ExistingWorktreeSignals;
  readonly execute?: boolean;
  readonly fileSystem?: DependencyPolicyFileSystem;
}): Promise<{
  readonly status: 'planned' | 'completed' | 'deferred';
  readonly removedPaths: readonly string[];
  readonly removablePaths: readonly string[];
  readonly preservedSharedPaths: readonly string[];
  readonly reason?: string;
}> {
  const classification = classifyExistingWorktree(input.worktree);
  const removablePaths = input.strategy.worktreeLocalPaths;

  if (!classification.mayReplaceMutableRuntimeState) {
    return {
      status: 'deferred',
      removedPaths: [],
      removablePaths,
      preservedSharedPaths: input.strategy.sharedPaths,
      reason: classification.reason,
    };
  }

  if (input.execute !== true) {
    return {
      status: 'planned',
      removedPaths: [],
      removablePaths,
      preservedSharedPaths: input.strategy.sharedPaths,
    };
  }

  const fileSystem = input.fileSystem ?? new NodeDependencyPolicyFileSystem();
  for (const targetPath of removablePaths) {
    await fileSystem.removePath(targetPath);
  }

  return {
    status: 'completed',
    removedPaths: removablePaths,
    removablePaths,
    preservedSharedPaths: input.strategy.sharedPaths,
  };
}

export function canPruneSharedDependencyStore(activeReferenceCount: number): {
  readonly allowed: boolean;
  readonly reason: string;
} {
  if (!Number.isInteger(activeReferenceCount) || activeReferenceCount < 0) {
    return { allowed: false, reason: 'Shared-store pruning requires a trustworthy non-negative active reference count.' };
  }

  return activeReferenceCount === 0
    ? { allowed: true, reason: 'No active worktree references are known.' }
    : { allowed: false, reason: 'Shared-store pruning is deferred while active worktrees may reference store content.' };
}

export function migrationStateFromStrategy(
  strategy: WorktreeDependencyStrategy,
  status: DependencyMigrationStatus,
  lastBootstrapResult: DependencyMigrationState['lastBootstrapResult'] = 'pending',
): DependencyMigrationState {
  return {
    version: WORKTREE_DEPENDENCY_POLICY_VERSION,
    strategyId: strategy.strategyId,
    ecosystem: strategy.ecosystem,
    packageManager: strategy.packageManager,
    ...(strategy.packageManagerVersion === undefined ? {} : { packageManagerVersion: strategy.packageManagerVersion }),
    disposition: strategy.migration.disposition,
    status,
    ...(strategy.metadata.manifestDigest === undefined ? {} : { manifestDigest: strategy.metadata.manifestDigest }),
    ...(strategy.metadata.lockfileDigest === undefined ? {} : { lockfileDigest: strategy.metadata.lockfileDigest }),
    ...(strategy.metadata.packageManagerSpec === undefined ? {} : { packageManagerSpec: strategy.metadata.packageManagerSpec }),
    ...(lastBootstrapResult === undefined ? {} : { lastBootstrapResult }),
  };
}

export function serializeDependencyMigrationState(state: DependencyMigrationState): string {
  return JSON.stringify(state);
}

export function parseDependencyMigrationState(value: unknown): DependencyMigrationState | undefined {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return undefined;
    }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (record.version !== WORKTREE_DEPENDENCY_POLICY_VERSION
    || typeof record.strategyId !== 'string'
    || !isDependencyEcosystem(record.ecosystem)
    || typeof record.packageManager !== 'string'
    || !isExistingWorktreeDisposition(record.disposition)
    || !isDependencyMigrationStatus(record.status)
    || !isOptionalString(record.packageManagerVersion)
    || !isOptionalString(record.manifestDigest)
    || !isOptionalString(record.lockfileDigest)
    || !isOptionalString(record.packageManagerSpec)
    || (record.lastBootstrapResult !== undefined
      && !['pending', 'reused', 'installed', 'failed'].includes(String(record.lastBootstrapResult)))) {
    return undefined;
  }

  return {
    version: WORKTREE_DEPENDENCY_POLICY_VERSION,
    strategyId: record.strategyId,
    ecosystem: record.ecosystem,
    packageManager: record.packageManager,
    ...(record.packageManagerVersion === undefined ? {} : { packageManagerVersion: record.packageManagerVersion }),
    disposition: record.disposition,
    status: record.status,
    ...(record.manifestDigest === undefined ? {} : { manifestDigest: record.manifestDigest }),
    ...(record.lockfileDigest === undefined ? {} : { lockfileDigest: record.lockfileDigest }),
    ...(record.packageManagerSpec === undefined ? {} : { packageManagerSpec: record.packageManagerSpec }),
    ...(record.lastBootstrapResult === undefined
      ? {}
      : { lastBootstrapResult: record.lastBootstrapResult as 'pending' | 'reused' | 'installed' | 'failed' }),
  };
}

async function detectProject(rootPath: string, fileSystem: DependencyPolicyFileSystem): Promise<DetectedProject> {
  if (await fileSystem.exists(path.join(rootPath, 'package.json'))) {
    return detectNodeProject(rootPath, fileSystem);
  }

  const hasPyproject = await fileSystem.exists(path.join(rootPath, 'pyproject.toml'));
  const hasUvLock = await fileSystem.exists(path.join(rootPath, 'uv.lock'));
  const requirements = await existingNames(rootPath, ['requirements.txt', 'requirements-dev.txt'], fileSystem);
  if (hasUvLock || hasPyproject || requirements.length > 0) {
    return {
      ecosystem: hasUvLock ? 'python-uv' : 'python-pip',
      packageManager: hasUvLock ? 'uv' : 'pip',
      manifestPaths: [...(hasPyproject ? ['pyproject.toml'] : []), ...requirements],
      lockfilePaths: hasUvLock ? ['uv.lock'] : requirements,
      blockingReasons: [],
    };
  }

  if (await fileSystem.exists(path.join(rootPath, 'go.mod'))) {
    return {
      ecosystem: 'go',
      packageManager: 'go',
      manifestPaths: ['go.mod'],
      lockfilePaths: await fileSystem.exists(path.join(rootPath, 'go.sum')) ? ['go.sum'] : [],
      blockingReasons: [],
    };
  }

  if (await fileSystem.exists(path.join(rootPath, 'Cargo.toml'))) {
    return {
      ecosystem: 'rust',
      packageManager: 'cargo',
      manifestPaths: ['Cargo.toml'],
      lockfilePaths: await fileSystem.exists(path.join(rootPath, 'Cargo.lock')) ? ['Cargo.lock'] : [],
      blockingReasons: [],
    };
  }

  return {
    ecosystem: 'unknown',
    packageManager: 'unknown',
    manifestPaths: [],
    lockfilePaths: [],
    blockingReasons: [],
  };
}

async function detectNodeProject(rootPath: string, fileSystem: DependencyPolicyFileSystem): Promise<DetectedProject> {
  let packageManagerSpec: string | undefined;
  const blockingReasons: string[] = [];

  try {
    const raw: unknown = JSON.parse(await fileSystem.readText(path.join(rootPath, 'package.json')));
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      blockingReasons.push('package.json is not a JSON object.');
    } else {
      const value = (raw as Record<string, unknown>).packageManager;
      if (value !== undefined && typeof value !== 'string') {
        blockingReasons.push('packageManager must be a string.');
      } else if (typeof value === 'string') {
        packageManagerSpec = value.trim();
      }
    }
  } catch {
    blockingReasons.push('package.json is not valid JSON.');
  }

  const declaration = parsePackageManagerSpec(packageManagerSpec);
  if (packageManagerSpec !== undefined && declaration === undefined) {
    blockingReasons.push(`Invalid packageManager declaration: ${packageManagerSpec}`);
  }

  const families: ('pnpm' | 'npm' | 'yarn' | 'bun')[] = [];
  for (const manager of ['pnpm', 'npm', 'yarn', 'bun'] as const) {
    if ((await existingNames(rootPath, NODE_LOCKFILES[manager], fileSystem)).length > 0) families.push(manager);
  }

  if (families.length > 1) {
    blockingReasons.push(`Multiple package-manager lockfile families detected: ${families.join(', ')}.`);
  }

  const manager = declaration?.manager ?? families[0] ?? 'npm';
  if (declaration !== undefined && families.some((candidate) => candidate !== declaration.manager)) {
    blockingReasons.push(`packageManager declares ${declaration.manager} but another manager lockfile is present.`);
  }

  const lockfilePaths = await existingNames(rootPath, NODE_LOCKFILES[manager], fileSystem);
  return {
    ecosystem: `node-${manager}` as DependencyEcosystem,
    packageManager: manager,
    ...(declaration?.version === undefined ? {} : { packageManagerVersion: declaration.version }),
    ...(packageManagerSpec === undefined ? {} : { packageManagerSpec }),
    manifestPaths: ['package.json'],
    lockfilePaths,
    blockingReasons,
  };
}

function buildStrategy(input: {
  readonly rootPath: string;
  readonly sharedCacheRoot: string;
  readonly installMode: DependencyInstallMode;
  readonly detected: DetectedProject;
  readonly migration: ExistingWorktreeClassification;
  readonly metadata: DependencyMetadataSnapshot;
  readonly blockingReasons: readonly string[];
}): WorktreeDependencyStrategy {
  const { rootPath, sharedCacheRoot, installMode, detected, migration, metadata } = input;
  const paths: DependencyPathDescriptor[] = [
    { class: 'repo_shared', label: 'Git common objects/refs', path: path.join(rootPath, '.git') },
  ];
  const commands: DependencyInstallCommand[] = [];
  const environment: Record<string, string> = {};
  let versionCheck: DependencyVersionCheck | undefined;
  let status: WorktreeDependencyStrategy['status'] = input.blockingReasons.length === 0 ? 'ready' : 'blocked';

  const shared = (label: string, ...segments: readonly string[]): string => {
    const value = path.join(sharedCacheRoot, ...segments);
    paths.push({ class: 'shared_reusable', label, path: value });
    return value;
  };
  const local = (label: string, suffix: string): string => {
    const value = path.join(rootPath, suffix);
    paths.push({ class: 'worktree_local', label, path: value });
    return value;
  };

  if (detected.ecosystem === 'node-pnpm') {
    const store = shared('pnpm content-addressable store', 'pnpm', 'store');
    for (const suffix of ['node_modules', 'dist', 'build', '.next', 'coverage', '.turbo']) {
      local('worktree runtime/output', suffix);
    }
    const manager = detected.packageManagerVersion === undefined ? 'pnpm' : `pnpm@${detected.packageManagerVersion}`;
    commands.push({
      executable: 'corepack',
      args: [
        manager,
        'install',
        ...(installMode === 'frozen' ? ['--frozen-lockfile'] : []),
        '--prefer-offline',
        '--store-dir',
        store,
      ],
      cwd: rootPath,
      environment,
      phase: 'install',
    });
    if (detected.packageManagerVersion !== undefined) {
      versionCheck = {
        executable: 'corepack',
        args: [manager, '--version'],
        expectedVersion: detected.packageManagerVersion,
      };
    }
  } else if (detected.ecosystem === 'node-npm') {
    const cache = shared('npm package/download cache', 'npm', 'cache');
    for (const suffix of ['node_modules', 'dist', 'build', '.next', 'coverage']) {
      local('worktree runtime/output', suffix);
    }
    const manager = detected.packageManagerVersion === undefined ? undefined : `npm@${detected.packageManagerVersion}`;
    commands.push({
      executable: manager === undefined ? 'npm' : 'corepack',
      args: [
        ...(manager === undefined ? [] : [manager]),
        installMode === 'frozen' ? 'ci' : 'install',
        '--prefer-offline',
        '--cache',
        cache,
      ],
      cwd: rootPath,
      environment,
      phase: 'install',
    });
    if (manager !== undefined) {
      versionCheck = { executable: 'corepack', args: [manager, '--version'], expectedVersion: detected.packageManagerVersion! };
    }
  } else if (detected.ecosystem === 'python-uv') {
    const cache = shared('uv package/download cache', 'python', 'uv');
    local('worktree virtual environment', '.venv');
    environment.UV_CACHE_DIR = cache;
    commands.push({
      executable: 'uv',
      args: ['sync', ...(installMode === 'frozen' ? ['--frozen'] : []), '--cache-dir', cache],
      cwd: rootPath,
      environment,
      phase: 'install',
    });
  } else if (detected.ecosystem === 'python-pip') {
    const cache = shared('pip wheel/download cache', 'python', 'pip');
    const venv = local('worktree virtual environment', '.venv');
    environment.PIP_CACHE_DIR = cache;
    const requirements = detected.lockfilePaths[0];
    if (requirements === undefined) {
      status = input.blockingReasons.length === 0 ? 'unsupported' : 'blocked';
    } else {
      commands.push({
        executable: 'python',
        args: ['-m', 'venv', venv],
        cwd: rootPath,
        environment: {},
        phase: 'setup',
      });
      commands.push({
        executable: path.join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
        args: ['-m', 'pip', 'install', '--requirement', path.join(rootPath, requirements), '--cache-dir', cache],
        cwd: rootPath,
        environment,
        phase: 'install',
      });
    }
  } else if (detected.ecosystem === 'go') {
    environment.GOMODCACHE = shared('Go module download cache', 'go', 'mod');
    environment.GOCACHE = shared('Go build cache', 'go', 'build');
    local('project build/runtime output', 'bin');
    commands.push({
      executable: 'go',
      args: ['mod', 'download'],
      cwd: rootPath,
      environment,
      phase: 'install',
    });
  } else if (detected.ecosystem === 'rust') {
    environment.CARGO_HOME = shared('Cargo registry/git cache', 'cargo', 'home');
    local('Cargo target output', 'target');
    commands.push({
      executable: 'cargo',
      args: ['fetch', ...(installMode === 'frozen' ? ['--locked'] : [])],
      cwd: rootPath,
      environment,
      phase: 'install',
    });
  } else if (detected.ecosystem === 'node-yarn' || detected.ecosystem === 'node-bun') {
    local('worktree node_modules view', 'node_modules');
    status = input.blockingReasons.length === 0 ? 'unsupported' : 'blocked';
  } else {
    status = input.blockingReasons.length === 0 ? 'unsupported' : 'blocked';
  }

  const sharedPaths = paths.filter((entry) => entry.class === 'shared_reusable').map((entry) => entry.path);
  const worktreeLocalPaths = paths.filter((entry) => entry.class === 'worktree_local').map((entry) => entry.path);
  const repoSharedPaths = paths.filter((entry) => entry.class === 'repo_shared').map((entry) => entry.path);
  const strategyId = `worktree-deps/v${WORKTREE_DEPENDENCY_POLICY_VERSION}/${detected.ecosystem}`;
  const sharedStoreIdentity = sharedPaths.length === 0 ? undefined : stableIdentity(detected.ecosystem, sharedPaths);
  const localRuntimeIdentity = stableIdentity(rootPath, worktreeLocalPaths);

  return {
    policyVersion: WORKTREE_DEPENDENCY_POLICY_VERSION,
    status,
    strategyId,
    ecosystem: detected.ecosystem,
    packageManager: detected.packageManager,
    ...(detected.packageManagerVersion === undefined ? {} : { packageManagerVersion: detected.packageManagerVersion }),
    ...(detected.packageManagerSpec === undefined ? {} : { packageManagerSpec: detected.packageManagerSpec }),
    rootPath,
    installMode,
    manifestPaths: detected.manifestPaths,
    lockfilePaths: detected.lockfilePaths,
    metadata,
    paths,
    sharedPaths,
    worktreeLocalPaths,
    repoSharedPaths,
    commands,
    ...(versionCheck === undefined ? {} : { versionCheck }),
    migration,
    directCrossWorktreeMutableSymlinkAllowed: false,
    sharedStorePruneRequiresZeroActiveReferences: true,
    blockingReasons: input.blockingReasons,
    diagnostics: {
      policyVersion: WORKTREE_DEPENDENCY_POLICY_VERSION,
      strategyId,
      ecosystem: detected.ecosystem,
      packageManager: detected.packageManager,
      ...(detected.packageManagerVersion === undefined ? {} : { packageManagerVersion: detected.packageManagerVersion }),
      ...(detected.packageManagerSpec === undefined ? {} : { packageManagerSpec: detected.packageManagerSpec }),
      ...(sharedStoreIdentity === undefined ? {} : { sharedStoreIdentity }),
      localRuntimeIdentity,
      installMode,
      migrationDisposition: migration.disposition,
      lockfilePaths: detected.lockfilePaths,
      blockingReasons: input.blockingReasons,
    },
  };
}

function parsePackageManagerSpec(value: string | undefined): {
  readonly manager: 'pnpm' | 'npm' | 'yarn' | 'bun';
  readonly version: string;
} | undefined {
  if (value === undefined) return undefined;
  const match = /^(pnpm|npm|yarn|bun)@([^\s]+)$/.exec(value);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  return { manager: match[1] as 'pnpm' | 'npm' | 'yarn' | 'bun', version: match[2] };
}

async function existingNames(
  rootPath: string,
  names: readonly string[],
  fileSystem: DependencyPolicyFileSystem,
): Promise<string[]> {
  const results = await Promise.all(names.map(async (name) => (
    await fileSystem.exists(path.join(rootPath, name)) ? name : undefined
  )));
  return results.filter((entry): entry is string => entry !== undefined);
}

async function digestExistingFiles(
  rootPath: string,
  names: readonly string[],
  fileSystem: DependencyPolicyFileSystem,
): Promise<string | undefined> {
  if (names.length === 0) return undefined;
  const hash = createHash('sha256');
  let found = false;

  for (const name of [...names].sort()) {
    const target = path.join(rootPath, name);
    if (!(await fileSystem.exists(target))) continue;
    found = true;
    hash.update(name);
    hash.update('\0');
    hash.update(await fileSystem.readText(target));
    hash.update('\0');
  }

  return found ? hash.digest('hex') : undefined;
}

function stableIdentity(prefix: string, paths: readonly string[]): string {
  const hash = createHash('sha256');
  hash.update(prefix);
  for (const entry of [...paths].sort()) {
    hash.update('\0');
    hash.update(path.resolve(entry));
  }
  return `${prefix}:${hash.digest('hex').slice(0, 20)}`;
}

function isPathInside(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isDependencyEcosystem(value: unknown): value is DependencyEcosystem {
  return [
    'node-pnpm',
    'node-npm',
    'node-yarn',
    'node-bun',
    'python-uv',
    'python-pip',
    'go',
    'rust',
    'unknown',
  ].includes(String(value));
}

function isExistingWorktreeDisposition(value: unknown): value is ExistingWorktreeDisposition {
  return value === 'adopt' || value === 'rebootstrap' || value === 'grandfather';
}

function isDependencyMigrationStatus(value: unknown): value is DependencyMigrationStatus {
  return value === 'pending'
    || value === 'grandfathered'
    || value === 'ready'
    || value === 'completed'
    || value === 'blocked';
}
