import { realpath, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { appError, err, ok, type Result, type WorkspaceId } from '@unified-mpc/domain';
import { workspaceLifecycleKind, type Workspace, type WorkspaceLifecycleKind } from './workspace-types.js';
import { isPosixMountRoot, resolveHostPath } from './filesystem-root.js';

export interface WorkspaceRepository {
  list(): Promise<Workspace[]>;
  get(id: WorkspaceId): Promise<Workspace | null>;
  insert(workspace: Workspace): Promise<void>;
  insertIfAvailable?(workspace: Workspace): Promise<boolean>;
  delete(id: WorkspaceId): Promise<void>;
  listAll?(): Promise<Workspace[]>;
  getAny?(id: WorkspaceId): Promise<Workspace | null>;
  archive?(id: WorkspaceId, archivedAt?: string): Promise<void>;
  archiveMany?(ids: readonly WorkspaceId[], archivedAt?: string): Promise<void>;
  restore?(id: WorkspaceId, workspace?: Workspace): Promise<void>;
  setUnavailableSince?(id: WorkspaceId, unavailableSince: string | null): Promise<void>;
}

export interface WorkspaceRegistrationOptions {
  readonly lifecycleKind?: WorkspaceLifecycleKind;
  readonly ownerSessionId?: string;
  readonly ownerJobId?: string;
  readonly autoCleanup?: boolean;
  readonly expiresAt?: string;
}

export interface WorkspaceLifecycleReconcileOptions {
  readonly protectedWorkspaceIds?: readonly WorkspaceId[];
  readonly endedOwnerSessionIds?: readonly string[];
  readonly endedOwnerJobIds?: readonly string[];
}

export interface WorkspaceLifecycleReconciliation {
  readonly inspected: number;
  readonly archivedWorkspaceIds: readonly WorkspaceId[];
  readonly unavailableWorkspaceIds: readonly WorkspaceId[];
  readonly skippedProtectedWorkspaceIds: readonly WorkspaceId[];
}

export interface WorkspaceServiceOptions {
  /** Test/fixture override; production composition uses the real host. */
  readonly platform?: NodeJS.Platform;
  readonly now?: () => Date;
}

export class WorkspaceService {
  public constructor(
    private readonly repository: WorkspaceRepository,
    private readonly options: WorkspaceServiceOptions = {},
  ) {}

  public async add(
    displayName: string,
    rootPath: string,
    registration: WorkspaceRegistrationOptions = {},
  ): Promise<Result<Workspace>> {
    if (displayName.trim().length === 0 || rootPath.trim().length === 0) {
      return err(appError('INVALID_INPUT', 'Workspace name and root path are required'));
    }

    const lifecycleKind = registration.lifecycleKind ?? 'project';
    if (lifecycleKind === 'project' && registration.autoCleanup === true) {
      return err(appError('INVALID_INPUT', 'Automatic cleanup is only allowed for temporary or inspection workspaces'));
    }
    if (registration.expiresAt !== undefined && !Number.isFinite(Date.parse(registration.expiresAt))) {
      return err(appError('INVALID_INPUT', 'Workspace expiry must be a valid ISO-compatible timestamp'));
    }

    const platform = this.options.platform ?? process.platform;
    const absoluteRootPath = resolveHostPath(rootPath, platform);
    if (absoluteRootPath === null) {
      return err(appError('INVALID_INPUT', 'Workspace root uses a foreign host path syntax'));
    }
    if (isPosixMountRoot(absoluteRootPath, platform)) {
      return err(appError('INVALID_INPUT', 'A POSIX filesystem mount root cannot be registered as a project'));
    }
    let rootStats;
    try {
      rootStats = await stat(absoluteRootPath);
    } catch {
      return err(appError('WORKSPACE_NOT_FOUND', 'Workspace root was not found'));
    }
    if (!rootStats.isDirectory()) {
      return err(appError('INVALID_INPUT', 'Workspace root must be a directory'));
    }

    let canonicalRootPath: string;
    try {
      canonicalRootPath = await realpath(absoluteRootPath);
    } catch {
      return err(appError('WORKSPACE_NOT_FOUND', 'Workspace root could not be canonicalized'));
    }

    const registrations = await (this.repository.listAll?.() ?? this.repository.list());
    if (registrations.some((workspace) => workspace.archivedAt === undefined
      && samePath(workspace.realRootPath, canonicalRootPath, platform))) {
      return err(appError('CONFLICT', 'Workspace root is already registered', true));
    }

    const archived = registrations.filter((workspace) => workspace.archivedAt !== undefined
      && workspace.archivedAt !== null
      && samePath(workspace.realRootPath, canonicalRootPath, platform));
    if (archived.length > 1) {
      return err(appError('CONFLICT', 'Multiple archived workspace identities match this canonical path; relink requires explicit recovery', true));
    }
    if (archived.length === 1) {
      if (this.repository.restore === undefined) {
        return err(appError('CONFLICT', 'Workspace identity is archived and cannot be relinked by this repository', true));
      }
      const archivedWorkspace = archived[0]!;
      const restored: Workspace = {
        id: archivedWorkspace.id,
        displayName: displayName.trim(),
        rootPath: absoluteRootPath,
        realRootPath: canonicalRootPath,
        createdAt: archivedWorkspace.createdAt,
        ...(lifecycleKind === 'project' ? {} : { lifecycleKind }),
        ...(registration.ownerSessionId === undefined ? {} : { ownerSessionId: registration.ownerSessionId }),
        ...(registration.ownerJobId === undefined ? {} : { ownerJobId: registration.ownerJobId }),
        ...(registration.autoCleanup === true ? { autoCleanup: true } : {}),
        ...(registration.expiresAt === undefined ? {} : { expiresAt: registration.expiresAt }),
      };
      try {
        await this.repository.restore(archived[0]!.id, restored);
      } catch (error: unknown) {
        return err(appError('CONFLICT', `Workspace identity could not be restored: ${errorMessage(error)}`, true));
      }
      return ok(restored);
    }

    const workspace: Workspace = {
      id: randomUUID(),
      displayName: displayName.trim(),
      rootPath: absoluteRootPath,
      realRootPath: canonicalRootPath,
      createdAt: (this.options.now?.() ?? new Date()).toISOString(),
      ...(lifecycleKind === 'project' ? {} : { lifecycleKind }),
      ...(registration.ownerSessionId === undefined ? {} : { ownerSessionId: registration.ownerSessionId }),
      ...(registration.ownerJobId === undefined ? {} : { ownerJobId: registration.ownerJobId }),
      ...(registration.autoCleanup === true ? { autoCleanup: true } : {}),
      ...(registration.expiresAt === undefined ? {} : { expiresAt: registration.expiresAt }),
    };
    try {
      const inserted = this.repository.insertIfAvailable === undefined
        ? (await this.repository.insert(workspace), true)
        : await this.repository.insertIfAvailable(workspace);
      if (!inserted) return err(appError('CONFLICT', 'Workspace root is already registered', true));
    } catch (error: unknown) {
      return err(appError('CONFLICT', `Workspace could not be registered: ${errorMessage(error)}`, true));
    }
    return ok(workspace);
  }

  public list(): Promise<Workspace[]> {
    return this.repository.list();
  }

  public get(id: WorkspaceId): Promise<Workspace | null> {
    return this.repository.get(id);
  }

  /** Remove a registration while retaining its durable identity for relinking. */
  public async unregister(id: WorkspaceId): Promise<Result<void>> {
    if (this.repository.archive === undefined) {
      return err(appError('CONFLICT', 'Workspace registration cannot be removed without durable archival support', true));
    }
    try {
      await this.repository.archive(id);
    } catch (error: unknown) {
      return err(appError('CONFLICT', `Workspace registration could not be archived: ${errorMessage(error)}`, true));
    }
    return ok(undefined);
  }

  public async unregisterMany(ids: readonly WorkspaceId[]): Promise<Result<void>> {
    if (this.repository.archiveMany !== undefined) {
      try {
        await this.repository.archiveMany(ids);
      } catch (error: unknown) {
        return err(appError('CONFLICT', `Workspace registrations could not be archived: ${errorMessage(error)}`, true));
      }
      return ok(undefined);
    }
    for (const id of ids) {
      const result = await this.unregister(id);
      if (!result.ok) return result;
    }
    return ok(undefined);
  }

  public async reconcileLifecycle(
    options: WorkspaceLifecycleReconcileOptions = {},
  ): Promise<Result<WorkspaceLifecycleReconciliation>> {
    const protectedIds = new Set(options.protectedWorkspaceIds ?? []);
    const endedSessions = new Set(options.endedOwnerSessionIds ?? []);
    const endedJobs = new Set(options.endedOwnerJobIds ?? []);
    const now = this.options.now?.() ?? new Date();
    const nowIso = now.toISOString();
    const workspaces = await this.repository.list();
    const archivedWorkspaceIds: WorkspaceId[] = [];
    const unavailableWorkspaceIds: WorkspaceId[] = [];
    const skippedProtectedWorkspaceIds: WorkspaceId[] = [];

    for (const workspace of workspaces) {
      const available = await this.isWorkspaceAvailable(workspace);
      const lifecycleKind = workspaceLifecycleKind(workspace);
      const expired = workspace.expiresAt !== undefined
        && workspace.expiresAt !== null
        && Number.isFinite(Date.parse(workspace.expiresAt))
        && Date.parse(workspace.expiresAt) <= now.getTime();
      const ownerEnded = (workspace.ownerSessionId !== undefined
          && workspace.ownerSessionId !== null
          && endedSessions.has(workspace.ownerSessionId))
        || (workspace.ownerJobId !== undefined
          && workspace.ownerJobId !== null
          && endedJobs.has(workspace.ownerJobId));
      const autoCleanupEligible = lifecycleKind !== 'project'
        && workspace.autoCleanup === true
        && (!available || expired || ownerEnded);

      if (autoCleanupEligible && protectedIds.has(workspace.id)) {
        skippedProtectedWorkspaceIds.push(workspace.id);
      } else if (autoCleanupEligible) {
        if (this.repository.archive === undefined) {
          return err(appError('CONFLICT', 'Workspace lifecycle cleanup requires durable archival support', true));
        }
        await this.repository.archive(workspace.id, nowIso);
        archivedWorkspaceIds.push(workspace.id);
        continue;
      }

      if (!available) {
        unavailableWorkspaceIds.push(workspace.id);
        if ((workspace.unavailableSince === undefined || workspace.unavailableSince === null)
          && this.repository.setUnavailableSince !== undefined) {
          await this.repository.setUnavailableSince(workspace.id, nowIso);
        }
      } else if (workspace.unavailableSince !== undefined
        && workspace.unavailableSince !== null
        && this.repository.setUnavailableSince !== undefined) {
        await this.repository.setUnavailableSince(workspace.id, null);
      }
    }

    return ok({
      inspected: workspaces.length,
      archivedWorkspaceIds,
      unavailableWorkspaceIds,
      skippedProtectedWorkspaceIds,
    });
  }

  public delete(id: WorkspaceId): Promise<void> {
    return this.repository.delete(id);
  }

  private async isWorkspaceAvailable(workspace: Workspace): Promise<boolean> {
    const platform = this.options.platform ?? process.platform;
    try {
      const [stats, canonicalRootPath] = await Promise.all([
        stat(workspace.rootPath),
        realpath(workspace.rootPath),
      ]);
      return stats.isDirectory() && samePath(canonicalRootPath, workspace.realRootPath, platform);
    } catch {
      return false;
    }
  }
}

function samePath(left: string, right: string, platform: NodeJS.Platform): boolean {
  const normalize = (value: string): string => {
    const resolved = resolveHostPath(value, platform) ?? value.trim();
    return platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
