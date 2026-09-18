import { realpath, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { appError, err, ok, type Result, type WorkspaceId } from '@unified-mpc/domain';
import type { Workspace } from './workspace-types.js';
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
}

export interface WorkspaceServiceOptions {
  /** Test/fixture override; production composition uses the real host. */
  readonly platform?: NodeJS.Platform;
}

export class WorkspaceService {
  public constructor(
    private readonly repository: WorkspaceRepository,
    private readonly options: WorkspaceServiceOptions = {},
  ) {}

  public async add(displayName: string, rootPath: string): Promise<Result<Workspace>> {
    if (displayName.trim().length === 0 || rootPath.trim().length === 0) {
      return err(appError('INVALID_INPUT', 'Workspace name and root path are required'));
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
      const restored: Workspace = {
        id: archived[0]!.id,
        displayName: displayName.trim(),
        rootPath: absoluteRootPath,
        realRootPath: canonicalRootPath,
        createdAt: archived[0]!.createdAt,
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
      createdAt: new Date().toISOString(),
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

  public delete(id: WorkspaceId): Promise<void> {
    return this.repository.delete(id);
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
