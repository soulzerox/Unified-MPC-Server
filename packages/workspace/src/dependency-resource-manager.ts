import { createHash } from 'node:crypto';
import path from 'node:path';

export const DEPENDENCY_RESOURCE_MANAGER_VERSION = 1 as const;

export type DependencyResourceLinkMode = 'symlink' | 'hardlink' | 'reflink' | 'copy' | 'local';
export type DependencyRuntimeView = 'global_virtual_store' | 'centralized_env' | 'local';
export type DependencyMigrationPhase =
  | 'legacy_detected'
  | 'migration_pending'
  | 'waiting_for_idle'
  | 'preparing_shared_runtime'
  | 'validating'
  | 'activating'
  | 'reclaiming_legacy_bytes'
  | 'migrated'
  | 'migration_blocked';

export interface DependencyResourceManagerInput {
  readonly rootPath: string;
  readonly sharedCacheRoot: string;
  readonly ecosystem: string;
  readonly packageManager: string;
  readonly packageManagerVersion?: string;
  readonly runtimeVersion?: string;
  readonly manifestDigest?: string;
  readonly lockfileDigest?: string;
  readonly migrationDisposition: 'adopt' | 'rebootstrap' | 'grandfather';
}

export interface DependencyResourcePlan {
  readonly version: typeof DEPENDENCY_RESOURCE_MANAGER_VERSION;
  readonly resourcePoolId: string;
  readonly resourcePoolPath: string;
  readonly runtimeView: DependencyRuntimeView;
  readonly linkMode: DependencyResourceLinkMode;
  readonly crossFilesystem: 'unknown';
  readonly compatibilityIdentity: string;
  readonly migrationPhase: DependencyMigrationPhase;
  readonly enforced: true;
  readonly managerArguments: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly fallbackReason?: string;
}

/**
 * Parent-owned #63 dependency resource policy.
 *
 * Mutable runtime trees are never shared directly between independently
 * versioned worktrees. Native graph/environment sharing is enabled only when
 * the package manager version proves that the required isolation primitive is
 * supported; otherwise the #34 cache-only layout is retained.
 */
export function resolveDependencyResourcePlan(input: DependencyResourceManagerInput): DependencyResourcePlan {
  const sharedCacheRoot = path.resolve(input.sharedCacheRoot);
  let resourcePoolPath = sharedCacheRoot;
  let runtimeView: DependencyRuntimeView = 'local';
  let linkMode: DependencyResourceLinkMode = 'local';
  let managerArguments: readonly string[] = [];
  let environment: Readonly<Record<string, string>> = {};
  let fallbackReason: string | undefined;

  if (input.ecosystem === 'node-pnpm') {
    resourcePoolPath = path.join(sharedCacheRoot, 'pnpm', 'store');
    if (supportsPnpmGlobalVirtualStore(input.packageManagerVersion)) {
      runtimeView = 'global_virtual_store';
      linkMode = 'symlink';
      managerArguments = ['--config.enable-global-virtual-store=true'];
      resourcePoolPath = path.join(resourcePoolPath, 'links');
    } else {
      fallbackReason = input.packageManagerVersion === undefined
        ? 'pnpm version is not pinned, so global virtual-store support cannot be proven.'
        : `pnpm@${input.packageManagerVersion} predates the supported global virtual-store boundary (10.12.1).`;
    }
  } else if (input.ecosystem === 'python-uv') {
    resourcePoolPath = path.join(sharedCacheRoot, 'python', 'uv');
    if (supportsUvCentralizedProjectEnvs(input.runtimeVersion)) {
      runtimeView = 'centralized_env';
      linkMode = 'symlink';
      environment = { UV_PREVIEW_FEATURES: 'centralized-project-envs' };
    } else {
      fallbackReason = input.runtimeVersion === undefined
        ? 'uv runtime version has not been probed, so centralized project environments cannot be claimed.'
        : `uv@${input.runtimeVersion} predates centralized-project-envs support (0.11.25).`;
    }
  } else if (input.ecosystem === 'node-npm') {
    resourcePoolPath = path.join(sharedCacheRoot, 'npm', 'cache');
    fallbackReason = 'npm has no graph-addressed shared node_modules runtime; cache sharing remains the safe boundary.';
  } else if (input.ecosystem === 'python-pip') {
    resourcePoolPath = path.join(sharedCacheRoot, 'python', 'pip');
    fallbackReason = 'standard venvs remain worktree-local; only pip package/download caches are shared.';
  } else if (input.ecosystem === 'go') {
    resourcePoolPath = path.join(sharedCacheRoot, 'go');
    fallbackReason = 'Go shares module/build caches natively while project runtime output remains local.';
  } else if (input.ecosystem === 'rust') {
    resourcePoolPath = path.join(sharedCacheRoot, 'cargo', 'home');
    fallbackReason = 'Cargo registry/source caches are shared while branch-sensitive target output remains local.';
  } else {
    fallbackReason = 'No shared runtime adapter is available for this ecosystem.';
  }

  const compatibilityIdentity = stableIdentity([
    path.resolve(input.rootPath),
    input.ecosystem,
    input.packageManager,
    input.packageManagerVersion ?? '',
    input.runtimeVersion ?? '',
    input.manifestDigest ?? '',
    input.lockfileDigest ?? '',
    runtimeView,
  ]);
  const resourcePoolId = stableIdentity([input.ecosystem, resourcePoolPath, runtimeView]);

  return {
    version: DEPENDENCY_RESOURCE_MANAGER_VERSION,
    resourcePoolId,
    resourcePoolPath,
    runtimeView,
    linkMode,
    crossFilesystem: 'unknown',
    compatibilityIdentity,
    migrationPhase: migrationPhaseForDisposition(input.migrationDisposition),
    enforced: true,
    managerArguments,
    environment,
    ...(fallbackReason === undefined ? {} : { fallbackReason }),
  };
}

export function supportsPnpmGlobalVirtualStore(version: string | undefined): boolean {
  return versionAtLeast(version, [10, 12, 1]);
}

export function supportsUvCentralizedProjectEnvs(version: string | undefined): boolean {
  return versionAtLeast(version, [0, 11, 25]);
}

export function migrationPhaseForDisposition(
  disposition: DependencyResourceManagerInput['migrationDisposition'],
): DependencyMigrationPhase {
  if (disposition === 'adopt') return 'preparing_shared_runtime';
  if (disposition === 'rebootstrap') return 'migration_pending';
  return 'waiting_for_idle';
}

export function parseRuntimeVersion(output: string, executable: string): string | undefined {
  const trimmed = output.trim();
  const candidate = trimmed.startsWith(`${executable} `) ? trimmed.slice(executable.length + 1) : trimmed;
  return /^(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(candidate)?.[1];
}

function versionAtLeast(version: string | undefined, minimum: readonly [number, number, number]): boolean {
  if (version === undefined) return false;
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (match === null) return false;
  const actual = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index]! > minimum[index]!) return true;
    if (actual[index]! < minimum[index]!) return false;
  }
  return true;
}

function stableIdentity(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 24);
}
