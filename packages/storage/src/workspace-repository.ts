import type { Workspace } from '@unified-mpc/workspace';
import type { SqliteDatabase } from './database.js';

interface WorkspaceRow {
  readonly id: string;
  readonly display_name: string;
  readonly root_path: string;
  readonly real_root_path: string;
  readonly created_at: string;
  readonly archived_at: string | null;
  readonly workspace_kind: 'project' | 'goal' | 'temporary' | 'inspection';
  readonly owner_session_id: string | null;
  readonly owner_job_id: string | null;
  readonly auto_cleanup: number;
  readonly expires_at: string | null;
  readonly unavailable_since: string | null;
  readonly goal_id: string | null;
  readonly parent_workspace_id: string | null;
  readonly goal_workspace_kind: 'git_worktree' | 'snapshot' | null;
  readonly parent_source: 'committed_head' | 'named_revision' | 'checkpoint' | 'patch' | null;
  readonly base_revision: string | null;
  readonly branch_name: string | null;
  readonly checkpoint_id: string | null;
  readonly integration_state: 'pending' | 'integrated' | 'conflict' | 'unknown' | null;
}

const workspaceColumns = [
  'id',
  'display_name',
  'root_path',
  'real_root_path',
  'created_at',
  'archived_at',
  'workspace_kind',
  'owner_session_id',
  'owner_job_id',
  'auto_cleanup',
  'expires_at',
  'unavailable_since',
  'goal_id',
  'parent_workspace_id',
  'goal_workspace_kind',
  'parent_source',
  'base_revision',
  'branch_name',
  'checkpoint_id',
  'integration_state',
].join(', ');

export class SqliteWorkspaceRepository {
  public constructor(private readonly database: SqliteDatabase) {}

  /** Runtime-visible workspaces only. Archived registrations are intentionally outside the active trust boundary. */
  public async list(): Promise<Workspace[]> {
    const rows = this.database.connection.prepare(
      `SELECT ${workspaceColumns} FROM workspaces WHERE archived_at IS NULL ORDER BY created_at, id`,
    ).all();
    return this.toWorkspaceList(rows);
  }

  /** Runtime-visible lookup only. Use getAny() from trusted management surfaces. */
  public async get(id: string): Promise<Workspace | null> {
    const row = this.database.connection.prepare(
      `SELECT ${workspaceColumns} FROM workspaces WHERE id = ? AND archived_at IS NULL`,
    ).get(id);
    return this.toWorkspace(row);
  }

  /** Trusted management view including archived registrations. */
  public async listAll(): Promise<Workspace[]> {
    const rows = this.database.connection.prepare(
      `SELECT ${workspaceColumns} FROM workspaces ORDER BY archived_at IS NOT NULL, created_at, id`,
    ).all();
    return this.toWorkspaceList(rows);
  }

  /** Trusted management lookup including archived registrations. */
  public async getAny(id: string): Promise<Workspace | null> {
    const row = this.database.connection.prepare(`SELECT ${workspaceColumns} FROM workspaces WHERE id = ?`).get(id);
    return this.toWorkspace(row);
  }

  public async insert(workspace: Workspace): Promise<void> {
    this.database.connection.prepare(
      'INSERT INTO workspaces (id, display_name, root_path, real_root_path, created_at, archived_at, workspace_kind, owner_session_id, owner_job_id, auto_cleanup, expires_at, unavailable_since, goal_id, parent_workspace_id, goal_workspace_kind, parent_source, base_revision, branch_name, checkpoint_id, integration_state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      workspace.id,
      workspace.displayName,
      workspace.rootPath,
      workspace.realRootPath,
      workspace.createdAt,
      workspace.archivedAt ?? null,
      workspace.lifecycleKind ?? 'project',
      workspace.ownerSessionId ?? null,
      workspace.ownerJobId ?? null,
      workspace.autoCleanup === true ? 1 : 0,
      workspace.expiresAt ?? null,
      workspace.unavailableSince ?? null,
      workspace.goalId ?? null,
      workspace.parentWorkspaceId ?? null,
      workspace.goalWorkspaceKind ?? null,
      workspace.parentSource ?? null,
      workspace.baseRevision ?? null,
      workspace.branchName ?? null,
      workspace.checkpointId ?? null,
      workspace.integrationState ?? null,
    );
  }

  public async insertIfAvailable(workspace: Workspace): Promise<boolean> {
    this.database.connection.exec('BEGIN IMMEDIATE;');
    try {
      const existing = this.database.connection.prepare(
        'SELECT 1 FROM workspaces WHERE archived_at IS NULL AND real_root_path = ? LIMIT 1',
      ).get(workspace.realRootPath);
      if (existing !== undefined) {
        this.database.connection.exec('ROLLBACK;');
        return false;
      }
      this.database.connection.prepare(
        'INSERT INTO workspaces (id, display_name, root_path, real_root_path, created_at, archived_at, workspace_kind, owner_session_id, owner_job_id, auto_cleanup, expires_at, unavailable_since, goal_id, parent_workspace_id, goal_workspace_kind, parent_source, base_revision, branch_name, checkpoint_id, integration_state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        workspace.id,
        workspace.displayName,
        workspace.rootPath,
        workspace.realRootPath,
        workspace.createdAt,
        workspace.archivedAt ?? null,
        workspace.lifecycleKind ?? 'project',
        workspace.ownerSessionId ?? null,
        workspace.ownerJobId ?? null,
        workspace.autoCleanup === true ? 1 : 0,
        workspace.expiresAt ?? null,
        workspace.unavailableSince ?? null,
        workspace.goalId ?? null,
        workspace.parentWorkspaceId ?? null,
        workspace.goalWorkspaceKind ?? null,
        workspace.parentSource ?? null,
        workspace.baseRevision ?? null,
        workspace.branchName ?? null,
        workspace.checkpointId ?? null,
        workspace.integrationState ?? null,
      );
      this.database.connection.exec('COMMIT;');
      return true;
    } catch (error) {
      this.database.connection.exec('ROLLBACK;');
      throw error;
    }
  }

  public async archive(id: string, archivedAt: string = new Date().toISOString()): Promise<void> {
    this.database.connection.prepare('UPDATE workspaces SET archived_at = ? WHERE id = ?').run(archivedAt, id);
  }

  public async archiveMany(ids: readonly string[], archivedAt: string = new Date().toISOString()): Promise<void> {
    this.database.connection.exec('BEGIN IMMEDIATE;');
    try {
      const statement = this.database.connection.prepare('UPDATE workspaces SET archived_at = ? WHERE id = ?');
      for (const id of ids) statement.run(archivedAt, id);
      this.database.connection.exec('COMMIT;');
    } catch (error) {
      this.database.connection.exec('ROLLBACK;');
      throw error;
    }
  }

  public async restore(id: string, workspace?: Workspace): Promise<void> {
    if (workspace === undefined) {
      this.database.connection.prepare('UPDATE workspaces SET archived_at = NULL WHERE id = ?').run(id);
      return;
    }
    this.database.connection.exec('BEGIN IMMEDIATE;');
    try {
      const existing = this.database.connection.prepare(
        'SELECT 1 FROM workspaces WHERE archived_at IS NULL AND real_root_path = ? AND id <> ? LIMIT 1',
      ).get(workspace.realRootPath, id);
      if (existing !== undefined) throw new Error('Workspace root is already registered');
      this.database.connection.prepare(
        'UPDATE workspaces SET display_name = ?, root_path = ?, real_root_path = ?, workspace_kind = ?, owner_session_id = ?, owner_job_id = ?, auto_cleanup = ?, expires_at = ?, unavailable_since = ?, goal_id = ?, parent_workspace_id = ?, goal_workspace_kind = ?, parent_source = ?, base_revision = ?, branch_name = ?, checkpoint_id = ?, integration_state = ?, archived_at = NULL WHERE id = ?',
      ).run(
        workspace.displayName,
        workspace.rootPath,
        workspace.realRootPath,
        workspace.lifecycleKind ?? 'project',
        workspace.ownerSessionId ?? null,
        workspace.ownerJobId ?? null,
        workspace.autoCleanup === true ? 1 : 0,
        workspace.expiresAt ?? null,
        workspace.unavailableSince ?? null,
        workspace.goalId ?? null,
        workspace.parentWorkspaceId ?? null,
        workspace.goalWorkspaceKind ?? null,
        workspace.parentSource ?? null,
        workspace.baseRevision ?? null,
        workspace.branchName ?? null,
        workspace.checkpointId ?? null,
        workspace.integrationState ?? null,
        id,
      );
      this.database.connection.exec('COMMIT;');
    } catch (error) {
      this.database.connection.exec('ROLLBACK;');
      throw error;
    }
  }

  public async setUnavailableSince(id: string, unavailableSince: string | null): Promise<void> {
    this.database.connection.prepare('UPDATE workspaces SET unavailable_since = ? WHERE id = ?').run(unavailableSince, id);
  }

  public async delete(id: string): Promise<void> {
    this.database.connection.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
  }

  private toWorkspaceList(rows: readonly unknown[]): Workspace[] {
    return rows.flatMap((row) => {
      const workspace = this.toWorkspace(row);
      return workspace === null ? [] : [workspace];
    });
  }

  private toWorkspace(value: unknown): Workspace | null {
    if (!this.isWorkspaceRow(value)) return null;
    return {
      id: value.id,
      displayName: value.display_name,
      rootPath: value.root_path,
      realRootPath: value.real_root_path,
      createdAt: value.created_at,
      ...(value.workspace_kind === 'project' ? {} : { lifecycleKind: value.workspace_kind }),
      ...(value.owner_session_id === null ? {} : { ownerSessionId: value.owner_session_id }),
      ...(value.owner_job_id === null ? {} : { ownerJobId: value.owner_job_id }),
      ...(value.auto_cleanup === 0 ? {} : { autoCleanup: true }),
      ...(value.expires_at === null ? {} : { expiresAt: value.expires_at }),
      ...(value.unavailable_since === null ? {} : { unavailableSince: value.unavailable_since }),
      ...(value.archived_at === null ? {} : { archivedAt: value.archived_at }),
      ...(value.goal_id === null ? {} : { goalId: value.goal_id }),
      ...(value.parent_workspace_id === null ? {} : { parentWorkspaceId: value.parent_workspace_id }),
      ...(value.goal_workspace_kind === null ? {} : { goalWorkspaceKind: value.goal_workspace_kind }),
      ...(value.parent_source === null ? {} : { parentSource: value.parent_source }),
      ...(value.base_revision === null ? {} : { baseRevision: value.base_revision }),
      ...(value.branch_name === null ? {} : { branchName: value.branch_name }),
      ...(value.checkpoint_id === null ? {} : { checkpointId: value.checkpoint_id }),
      ...(value.integration_state === null ? {} : { integrationState: value.integration_state }),
    };
  }

  private isWorkspaceRow(value: unknown): value is WorkspaceRow {
    if (typeof value !== 'object' || value === null) return false;
    if (!('id' in value) || !('display_name' in value) || !('root_path' in value)
      || !('real_root_path' in value) || !('created_at' in value) || !('archived_at' in value)
      || !('workspace_kind' in value) || !('owner_session_id' in value) || !('owner_job_id' in value)
      || !('auto_cleanup' in value) || !('expires_at' in value) || !('unavailable_since' in value)) return false;
    return typeof value.id === 'string'
      && typeof value.display_name === 'string'
      && typeof value.root_path === 'string'
      && typeof value.real_root_path === 'string'
      && typeof value.created_at === 'string'
      && (value.archived_at === null || typeof value.archived_at === 'string')
      && (value.workspace_kind === 'project' || value.workspace_kind === 'goal' || value.workspace_kind === 'temporary' || value.workspace_kind === 'inspection')
      && (value.owner_session_id === null || typeof value.owner_session_id === 'string')
      && (value.owner_job_id === null || typeof value.owner_job_id === 'string')
      && (value.auto_cleanup === 0 || value.auto_cleanup === 1)
      && (value.expires_at === null || typeof value.expires_at === 'string')
      && (value.unavailable_since === null || typeof value.unavailable_since === 'string')
      && (value.goal_id === null || typeof value.goal_id === 'string')
      && (value.parent_workspace_id === null || typeof value.parent_workspace_id === 'string')
      && (value.goal_workspace_kind === null || value.goal_workspace_kind === 'git_worktree' || value.goal_workspace_kind === 'snapshot')
      && (value.parent_source === null || value.parent_source === 'committed_head' || value.parent_source === 'named_revision' || value.parent_source === 'checkpoint' || value.parent_source === 'patch')
      && (value.base_revision === null || typeof value.base_revision === 'string')
      && (value.branch_name === null || typeof value.branch_name === 'string')
      && (value.checkpoint_id === null || typeof value.checkpoint_id === 'string')
      && (value.integration_state === null || value.integration_state === 'pending' || value.integration_state === 'integrated' || value.integration_state === 'conflict' || value.integration_state === 'unknown');
  }
}
