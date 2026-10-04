import { appError, err, ok, type Result } from '@unified-mpc/domain';
import {
  hostPathApi,
  isAbsoluteHostPath,
  isHostPathWithin,
  normalizeHostPath,
} from './filesystem-root.js';
import { WorkspacePathGuard } from './workspace-path-guard.js';
import type { Workspace } from './workspace-types.js';

export interface ManagedWorktreePathResolution {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly exists: boolean;
}

export function isWithin(rootPath: string, candidatePath: string, platform: NodeJS.Platform = process.platform): boolean {
  return isHostPathWithin(rootPath, candidatePath, platform);
}

export async function resolveManagedWorktreePath(
  workspace: Workspace,
  inputPath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<Result<ManagedWorktreePathResolution>> {
  const normalizedHostPath = normalizeHostPath(inputPath, platform);
  if (normalizedHostPath === null || isAbsoluteHostPath(inputPath, platform)) {
    return err(appError('PATH_OUTSIDE_WORKSPACE', 'Managed worktree path must be relative to the owning workspace'));
  }

  const pathApi = hostPathApi(platform);
  const normalizedPath = normalizedHostPath.split(pathApi.sep).join('/');
  const parts = normalizedPath.split('/');
  const managedPrefix = normalizedPath.startsWith('.worktrees/')
    || normalizedPath.startsWith('.unified-mpc/worktrees/');
  if (!managedPrefix || parts.some((part) => part === '..')) {
    return err(appError('PATH_OUTSIDE_WORKSPACE', 'Managed worktree path must remain under .worktrees or .unified-mpc/worktrees'));
  }

  const guard = new WorkspacePathGuard(undefined, {
    platform,
    trustedWorkspaceAccess: true,
  });
  const target = await guard.resolveForWrite(workspace, normalizedPath);
  if (!target.ok) return err(target.error);
  if (target.value.outsideWorkspace === true) {
    return err(appError('PATH_OUTSIDE_WORKSPACE', 'Managed worktree path is outside the owning workspace'));
  }

  const segments = normalizedPath.split('/').filter((segment) => segment.length > 0);
  for (let index = 1; index <= segments.length; index += 1) {
    const prefix = segments.slice(0, index).join('/');
    const resolved = await guard.resolveForWrite(workspace, prefix);
    if (!resolved.ok) return err(resolved.error);
    if (resolved.value.outsideWorkspace === true) {
      return err(appError('PATH_OUTSIDE_WORKSPACE', 'Managed worktree path is outside the owning workspace'));
    }

    const canonicalHostPath = normalizeHostPath(resolved.value.relativePath, platform);
    if (canonicalHostPath === null) {
      return err(appError('INVALID_INPUT', 'Managed worktree path could not be canonicalized'));
    }
    const canonicalPrefix = canonicalHostPath.split(pathApi.sep).join('/');
    if (!sameManagedPath(prefix, canonicalPrefix, platform)) {
      return err(appError('PATH_OUTSIDE_WORKSPACE', 'Managed worktree path canonicalizes outside its managed root'));
    }
    if (!resolved.value.exists) break;
  }

  return ok({
    relativePath: normalizedPath,
    absolutePath: target.value.absolutePath,
    exists: target.value.exists,
  });
}

function sameManagedPath(left: string, right: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}
