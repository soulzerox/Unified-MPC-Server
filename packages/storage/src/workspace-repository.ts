import type { Workspace, WorkspaceWriterLease } from '@unified-mpc/workspace';
import type { WorkspaceAdmissionReceipt, WorkspaceBaseRebaseReceipt } from '@unified-mpc/domain';
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
  readonly parent_source: 'committed_head' | 'named_revision' | 'checkpoint' | 'patch' | 'snapshot' | null;
  readonly base_ref: string | null;
  readonly base_revision: string | null;
  readonly branch_name: string | null;
  readonly checkpoint_id: string | null;
  readonly integration_state: 'pending' | 'integrated' | 'conflict' | 'unknown' | null;
  readonly writer_lease_id: string | null;
  readonly writer_lease_owner_id: string | null;
  readonly writer_lease_generation: number | null;
  readonly writer_lease_expires_at: string | null;
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
  'base_ref',
  'base_revision',
  'branch_name',
  'checkpoint_id',
  'integration_state',
  'writer_lease_id',
  'writer_lease_owner_id',
  'writer_lease_generation',
  'writer_lease_expires_at',
].join(', ');

export class SqliteWorkspaceRepository {
  public constructor(private readonly database: SqliteDatabase) {}

  public async getAdmissionReceipt(workspaceId: string): Promise<WorkspaceAdmissionReceipt | null> {
    const row = this.database.connection.prepare(
      'SELECT receipt_json FROM workspace_admission_receipts WHERE workspace_id = ?',
    ).get(workspaceId) as { receipt_json: string } | undefined;
    if (row === undefined) return null;
    try {
      const receipt: unknown = JSON.parse(row.receipt_json);
      return isWorkspaceAdmissionReceipt(receipt) && receipt.workspaceId === workspaceId ? receipt : null;
    } catch {
      return null;
    }
  }

  public async compareAndSwapAdmissionReceipt(
    workspaceId: string,
    expectedAdmissionGeneration: number,
    writeLeaseGeneration: number,
    receipt: WorkspaceAdmissionReceipt,
  ): Promise<boolean> {
    if (receipt.workspaceId !== workspaceId
      || receipt.writeLeaseGeneration !== writeLeaseGeneration
      || receipt.admissionGeneration !== expectedAdmissionGeneration + 1
      || !Number.isSafeInteger(expectedAdmissionGeneration) || expectedAdmissionGeneration < 0
      || !Number.isSafeInteger(writeLeaseGeneration) || writeLeaseGeneration < 1
      || !isWorkspaceAdmissionReceipt(receipt)) return false;
    let receiptJson: string;
    try {
      receiptJson = JSON.stringify(receipt);
    } catch {
      return false;
    }
    if (Buffer.byteLength(receiptJson, 'utf8') > 16_384) return false;

    this.database.connection.exec('BEGIN IMMEDIATE;');
    try {
      const workspace = this.database.connection.prepare(
        'SELECT writer_lease_id, writer_lease_generation, writer_lease_expires_at FROM workspaces WHERE id = ? AND archived_at IS NULL',
      ).get(workspaceId) as { writer_lease_id: string | null; writer_lease_generation: number | null; writer_lease_expires_at: string | null } | undefined;
      const stored = this.database.connection.prepare(
        'SELECT admission_generation FROM workspace_admission_receipts WHERE workspace_id = ?',
      ).get(workspaceId) as { admission_generation: number } | undefined;
      if (workspace === undefined || workspace.writer_lease_id === null
        || workspace.writer_lease_generation !== writeLeaseGeneration
        || workspace.writer_lease_expires_at === null || workspace.writer_lease_expires_at <= receipt.createdAt
        || (stored?.admission_generation ?? 0) !== expectedAdmissionGeneration) {
        this.database.connection.exec('ROLLBACK;');
        return false;
      }

      this.database.connection.prepare(
        `INSERT INTO workspace_admission_receipts (workspace_id, admission_generation, write_lease_generation, receipt_json, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET
           admission_generation = excluded.admission_generation,
           write_lease_generation = excluded.write_lease_generation,
           receipt_json = excluded.receipt_json,
           updated_at = excluded.updated_at
         WHERE workspace_admission_receipts.admission_generation = ?`,
      ).run(workspaceId, receipt.admissionGeneration, writeLeaseGeneration, receiptJson, receipt.createdAt, expectedAdmissionGeneration);
      this.database.connection.exec('COMMIT;');
      return true;
    } catch (error) {
      this.database.connection.exec('ROLLBACK;');
      throw error;
    }
  }

  public async invalidateAdmissionReceipt(
    workspaceId: string,
    expectedAdmissionGeneration: number,
    reason: string,
    invalidatedAt: string = new Date().toISOString(),
  ): Promise<boolean> {
    if (reason.length > 256) return false;
    this.database.connection.exec('BEGIN IMMEDIATE;');
    try {
      const row = this.database.connection.prepare(
        'SELECT admission_generation, receipt_json FROM workspace_admission_receipts WHERE workspace_id = ?',
      ).get(workspaceId) as { admission_generation: number; receipt_json: string } | undefined;
      if (row === undefined || row.admission_generation !== expectedAdmissionGeneration) {
        this.database.connection.exec('ROLLBACK;');
        return false;
      }
      let stored: unknown;
      try {
        stored = JSON.parse(row.receipt_json);
      } catch {
        this.database.connection.exec('ROLLBACK;');
        return false;
      }
      if (!isWorkspaceAdmissionReceipt(stored) || stored.workspaceId !== workspaceId) {
        this.database.connection.exec('ROLLBACK;');
        return false;
      }

      const receipt = { ...stored, invalidatedAt, invalidationReason: reason };
      const receiptJson = JSON.stringify(receipt);
      if (Buffer.byteLength(receiptJson, 'utf8') > 16_384) {
        this.database.connection.exec('ROLLBACK;');
        return false;
      }
      const result = this.database.connection.prepare(
        'UPDATE workspace_admission_receipts SET receipt_json = ?, updated_at = ? WHERE workspace_id = ? AND admission_generation = ?',
      ).run(receiptJson, invalidatedAt, workspaceId, expectedAdmissionGeneration);
      this.database.connection.exec('COMMIT;');
      return Number(result.changes) === 1;
    } catch (error) {
      this.database.connection.exec('ROLLBACK;');
      throw error;
    }
  }

  public async getBaseRebaseReceipt(workspaceId: string): Promise<WorkspaceBaseRebaseReceipt | null> {
    const row = this.database.connection.prepare(
      'SELECT receipt_json FROM workspace_base_rebase_receipts WHERE workspace_id = ?',
    ).get(workspaceId) as { receipt_json: string } | undefined;
    if (row === undefined) return null;
    if (Buffer.byteLength(row.receipt_json, 'utf8') > 16_384) {
      throw new Error('Stored guarded rebase receipt exceeds the trusted size limit');
    }
    let receipt: unknown;
    try {
      receipt = JSON.parse(row.receipt_json);
    } catch {
      throw new Error('Stored guarded rebase receipt is malformed');
    }
    if (!isWorkspaceBaseRebaseReceipt(receipt) || receipt.workspaceId !== workspaceId) {
      throw new Error('Stored guarded rebase receipt failed validation');
    }
    return receipt;
  }

  public async compareAndSwapBaseRebaseReceipt(
    workspaceId: string,
    expectedReceiptRevision: number,
    expectedAdmissionGeneration: number,
    writeLeaseGeneration: number,
    receipt: WorkspaceBaseRebaseReceipt,
  ): Promise<boolean> {
    if (!Number.isSafeInteger(expectedReceiptRevision) || expectedReceiptRevision < 0
      || !Number.isSafeInteger(expectedAdmissionGeneration) || expectedAdmissionGeneration < 1
      || !Number.isSafeInteger(writeLeaseGeneration) || writeLeaseGeneration < 1
      || receipt.workspaceId !== workspaceId
      || receipt.receiptRevision !== expectedReceiptRevision + 1
      || receipt.admissionGeneration !== expectedAdmissionGeneration
      || receipt.writeLeaseGeneration !== writeLeaseGeneration
      || !isWorkspaceBaseRebaseReceipt(receipt)) return false;
    let receiptJson: string;
    try {
      receiptJson = JSON.stringify(receipt);
    } catch {
      return false;
    }
    if (Buffer.byteLength(receiptJson, 'utf8') > 16_384) return false;
    const timestamp = receipt.finishedAt ?? receipt.startedAt;

    this.database.connection.exec('BEGIN IMMEDIATE;');
    try {
      const workspace = this.database.connection.prepare(
        'SELECT writer_lease_id, writer_lease_generation, writer_lease_expires_at FROM workspaces WHERE id = ? AND archived_at IS NULL',
      ).get(workspaceId) as { writer_lease_id: string | null; writer_lease_generation: number | null; writer_lease_expires_at: string | null } | undefined;
      const admission = this.database.connection.prepare(
        'SELECT admission_generation FROM workspace_admission_receipts WHERE workspace_id = ?',
      ).get(workspaceId) as { admission_generation: number } | undefined;
      const stored = this.database.connection.prepare(
        'SELECT receipt_revision, receipt_json FROM workspace_base_rebase_receipts WHERE workspace_id = ?',
      ).get(workspaceId) as { receipt_revision: number; receipt_json: string } | undefined;
      if (workspace === undefined || workspace.writer_lease_id === null
        || workspace.writer_lease_generation !== writeLeaseGeneration
        || workspace.writer_lease_expires_at === null || workspace.writer_lease_expires_at <= timestamp
        || admission?.admission_generation !== expectedAdmissionGeneration
        || (stored?.receipt_revision ?? 0) !== expectedReceiptRevision) {
        this.database.connection.exec('ROLLBACK;');
        return false;
      }
      if (stored !== undefined && receipt.status !== 'started') {
        try {
          const previous: unknown = JSON.parse(stored.receipt_json);
          if (!isWorkspaceBaseRebaseReceipt(previous) || previous.operationId !== receipt.operationId) {
            this.database.connection.exec('ROLLBACK;');
            return false;
          }
        } catch {
          this.database.connection.exec('ROLLBACK;');
          return false;
        }
      }

      const result = this.database.connection.prepare(
        `INSERT INTO workspace_base_rebase_receipts
          (workspace_id, receipt_revision, admission_generation, write_lease_generation, receipt_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET
           receipt_revision = excluded.receipt_revision,
           admission_generation = excluded.admission_generation,
           write_lease_generation = excluded.write_lease_generation,
           receipt_json = excluded.receipt_json,
           updated_at = excluded.updated_at
         WHERE workspace_base_rebase_receipts.receipt_revision = ?`,
      ).run(
        workspaceId,
        receipt.receiptRevision,
        expectedAdmissionGeneration,
        writeLeaseGeneration,
        receiptJson,
        timestamp,
        expectedReceiptRevision,
      );
      this.database.connection.exec('COMMIT;');
      return Number(result.changes) === 1;
    } catch (error) {
      this.database.connection.exec('ROLLBACK;');
      throw error;
    }
  }

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
      'INSERT INTO workspaces (id, display_name, root_path, real_root_path, created_at, archived_at, workspace_kind, owner_session_id, owner_job_id, auto_cleanup, expires_at, unavailable_since, goal_id, parent_workspace_id, goal_workspace_kind, parent_source, base_ref, base_revision, branch_name, checkpoint_id, integration_state, writer_lease_id, writer_lease_owner_id, writer_lease_generation, writer_lease_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
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
      workspace.baseRef ?? null,
      workspace.baseRevision ?? null,
      workspace.branchName ?? null,
      workspace.checkpointId ?? null,
      workspace.integrationState ?? null,
      workspace.writerLease?.leaseId ?? null,
      workspace.writerLease?.ownerId ?? null,
      workspace.writerLease?.generation ?? null,
      workspace.writerLease?.expiresAt ?? null,
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
        'INSERT INTO workspaces (id, display_name, root_path, real_root_path, created_at, archived_at, workspace_kind, owner_session_id, owner_job_id, auto_cleanup, expires_at, unavailable_since, goal_id, parent_workspace_id, goal_workspace_kind, parent_source, base_ref, base_revision, branch_name, checkpoint_id, integration_state, writer_lease_id, writer_lease_owner_id, writer_lease_generation, writer_lease_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
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
        workspace.baseRef ?? null,
        workspace.baseRevision ?? null,
        workspace.branchName ?? null,
        workspace.checkpointId ?? null,
        workspace.integrationState ?? null,
        workspace.writerLease?.leaseId ?? null,
        workspace.writerLease?.ownerId ?? null,
        workspace.writerLease?.generation ?? null,
        workspace.writerLease?.expiresAt ?? null,
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
        'UPDATE workspaces SET display_name = ?, root_path = ?, real_root_path = ?, workspace_kind = ?, owner_session_id = ?, owner_job_id = ?, auto_cleanup = ?, expires_at = ?, unavailable_since = ?, goal_id = ?, parent_workspace_id = ?, goal_workspace_kind = ?, parent_source = ?, base_ref = ?, base_revision = ?, branch_name = ?, checkpoint_id = ?, integration_state = ?, writer_lease_id = ?, writer_lease_owner_id = ?, writer_lease_generation = ?, writer_lease_expires_at = ?, archived_at = NULL WHERE id = ?',
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
        workspace.baseRef ?? null,
        workspace.baseRevision ?? null,
        workspace.branchName ?? null,
        workspace.checkpointId ?? null,
        workspace.integrationState ?? null,
        workspace.writerLease?.leaseId ?? null,
        workspace.writerLease?.ownerId ?? null,
        workspace.writerLease?.generation ?? null,
        workspace.writerLease?.expiresAt ?? null,
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

  public async acquireGoalWriterLease(id: string, leaseId: string, ownerId: string, now: string, expiresAt: string): Promise<WorkspaceWriterLease | null> {
    this.database.connection.exec('BEGIN IMMEDIATE;');
    try {
      const row = this.database.connection.prepare(
        'SELECT writer_lease_id, writer_lease_generation, writer_lease_expires_at FROM workspaces WHERE id = ? AND archived_at IS NULL',
      ).get(id) as { writer_lease_id: string | null; writer_lease_generation: number | null; writer_lease_expires_at: string | null } | undefined;
      if (row === undefined) {
        this.database.connection.exec('ROLLBACK;');
        return null;
      }
      if (row.writer_lease_id !== null && row.writer_lease_expires_at !== null && row.writer_lease_expires_at > now && row.writer_lease_id !== leaseId) {
        this.database.connection.exec('ROLLBACK;');
        return null;
      }
      const generation = (row.writer_lease_generation ?? 0) + (row.writer_lease_id === leaseId ? 0 : 1);
      this.database.connection.prepare(
        'UPDATE workspaces SET writer_lease_id = ?, writer_lease_owner_id = ?, writer_lease_generation = ?, writer_lease_expires_at = ? WHERE id = ? AND archived_at IS NULL',
      ).run(leaseId, ownerId, generation, expiresAt, id);
      this.database.connection.exec('COMMIT;');
      return { leaseId, ownerId, generation, expiresAt };
    } catch (error) {
      this.database.connection.exec('ROLLBACK;');
      throw error;
    }
  }

  public async synchronizeGoalWriterLease(
    id: string,
    goalId: string,
    leaseId: string,
    ownerId: string,
    generation: number,
    expiresAt: string,
    now: string,
  ): Promise<WorkspaceWriterLease | null> {
    if (!Number.isSafeInteger(generation) || generation < 1 || expiresAt <= now) return null;
    this.database.connection.exec('BEGIN IMMEDIATE;');
    try {
      const row = this.database.connection.prepare(
        'SELECT goal_id, writer_lease_id, writer_lease_owner_id, writer_lease_generation FROM workspaces WHERE id = ? AND archived_at IS NULL',
      ).get(id) as {
        goal_id: string | null;
        writer_lease_id: string | null;
        writer_lease_owner_id: string | null;
        writer_lease_generation: number | null;
      } | undefined;
      if (row === undefined || row.goal_id !== goalId) {
        this.database.connection.exec('ROLLBACK;');
        return null;
      }
      const currentGeneration = row.writer_lease_generation ?? 0;
      if (currentGeneration > generation
        || (currentGeneration === generation
          && row.writer_lease_id !== null
          && (row.writer_lease_id !== leaseId || row.writer_lease_owner_id !== ownerId))) {
        this.database.connection.exec('ROLLBACK;');
        return null;
      }
      const result = this.database.connection.prepare(
        `UPDATE workspaces
         SET writer_lease_id = ?, writer_lease_owner_id = ?, writer_lease_generation = ?, writer_lease_expires_at = ?
         WHERE id = ? AND archived_at IS NULL AND goal_id = ?
           AND (writer_lease_generation IS NULL OR writer_lease_generation <= ?)`,
      ).run(leaseId, ownerId, generation, expiresAt, id, goalId, generation);
      if (Number(result.changes) !== 1) {
        this.database.connection.exec('ROLLBACK;');
        return null;
      }
      this.database.connection.exec('COMMIT;');
      return { leaseId, ownerId, generation, expiresAt };
    } catch (error) {
      this.database.connection.exec('ROLLBACK;');
      throw error;
    }
  }

  public async renewGoalWriterLease(id: string, leaseId: string, generation: number, now: string, expiresAt: string): Promise<boolean> {
    const result = this.database.connection.prepare(
      'UPDATE workspaces SET writer_lease_expires_at = ? WHERE id = ? AND archived_at IS NULL AND writer_lease_id = ? AND writer_lease_generation = ? AND writer_lease_expires_at > ?',
    ).run(expiresAt, id, leaseId, generation, now);
    return Number(result.changes) === 1;
  }

  public async releaseGoalWriterLease(id: string, leaseId: string, generation: number): Promise<boolean> {
    const result = this.database.connection.prepare(
      'UPDATE workspaces SET writer_lease_id = NULL, writer_lease_owner_id = NULL, writer_lease_expires_at = NULL WHERE id = ? AND archived_at IS NULL AND writer_lease_id = ? AND writer_lease_generation = ?',
    ).run(id, leaseId, generation);
    return Number(result.changes) === 1;
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
      ...(value.base_ref === null ? {} : { baseRef: value.base_ref }),
      ...(value.base_revision === null ? {} : { baseRevision: value.base_revision }),
      ...(value.branch_name === null ? {} : { branchName: value.branch_name }),
      ...(value.checkpoint_id === null ? {} : { checkpointId: value.checkpoint_id }),
      ...(value.integration_state === null ? {} : { integrationState: value.integration_state }),
      ...(value.writer_lease_id === null || value.writer_lease_owner_id === null || value.writer_lease_generation === null || value.writer_lease_expires_at === null ? {} : {
        writerLease: {
          leaseId: value.writer_lease_id,
          ownerId: value.writer_lease_owner_id,
          generation: value.writer_lease_generation,
          expiresAt: value.writer_lease_expires_at,
        },
      }),
    };
  }

  private isWorkspaceRow(value: unknown): value is WorkspaceRow {
    if (typeof value !== 'object' || value === null) return false;
    if (!('id' in value) || !('display_name' in value) || !('root_path' in value)
      || !('real_root_path' in value) || !('created_at' in value) || !('archived_at' in value)
      || !('workspace_kind' in value) || !('owner_session_id' in value) || !('owner_job_id' in value)
      || !('auto_cleanup' in value) || !('expires_at' in value) || !('unavailable_since' in value)
      || !('goal_id' in value) || !('parent_workspace_id' in value) || !('goal_workspace_kind' in value)
      || !('parent_source' in value) || !('base_revision' in value) || !('branch_name' in value)
      || !('checkpoint_id' in value) || !('integration_state' in value)
      || !('writer_lease_id' in value) || !('writer_lease_owner_id' in value)
      || !('writer_lease_generation' in value) || !('writer_lease_expires_at' in value)) return false;
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
      && (value.parent_source === null || value.parent_source === 'committed_head' || value.parent_source === 'named_revision' || value.parent_source === 'checkpoint' || value.parent_source === 'patch' || value.parent_source === 'snapshot')
      && (value.base_revision === null || typeof value.base_revision === 'string')
      && (value.branch_name === null || typeof value.branch_name === 'string')
      && (value.checkpoint_id === null || typeof value.checkpoint_id === 'string')
      && (value.integration_state === null || value.integration_state === 'pending' || value.integration_state === 'integrated' || value.integration_state === 'conflict' || value.integration_state === 'unknown')
      && (value.writer_lease_id === null || typeof value.writer_lease_id === 'string')
      && (value.writer_lease_owner_id === null || typeof value.writer_lease_owner_id === 'string')
      && (value.writer_lease_generation === null || (typeof value.writer_lease_generation === 'number' && Number.isSafeInteger(value.writer_lease_generation) && value.writer_lease_generation > 0))
      && (value.writer_lease_expires_at === null || typeof value.writer_lease_expires_at === 'string');
  }
}

function isWorkspaceBaseRebaseReceipt(value: unknown): value is WorkspaceBaseRebaseReceipt {
  if (typeof value !== 'object' || value === null) return false;
  const receipt = value as Partial<WorkspaceBaseRebaseReceipt>;
  const allowedKeys = new Set([
    'operationId', 'receiptRevision', 'workspaceId', 'goalId', 'branchName', 'status',
    'oldHead', 'oldBaseSha', 'newBaseSha', 'checkpointId', 'checkpointRevision', 'checkpointHead',
    'recoveryRef', 'admissionGeneration', 'writeLeaseGeneration', 'remoteGoalRef', 'remoteGoalSha',
    'resultHead', 'conflictedPaths', 'abortSucceeded', 'startedAt', 'finishedAt', 'failureReason',
  ]);
  if (Object.keys(receipt).some((key) => !allowedKeys.has(key))) return false;
  const sha = (input: unknown): input is string => typeof input === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(input);
  const paths = receipt.conflictedPaths;
  return typeof receipt.operationId === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(receipt.operationId)
    && Number.isSafeInteger(receipt.receiptRevision) && (receipt.receiptRevision ?? 0) > 0
    && typeof receipt.workspaceId === 'string' && receipt.workspaceId.length > 0 && receipt.workspaceId.length <= 128
    && typeof receipt.goalId === 'string' && receipt.goalId.length > 0 && receipt.goalId.length <= 128
    && typeof receipt.branchName === 'string' && receipt.branchName.length > 0 && receipt.branchName.length <= 1024 && !receipt.branchName.includes('\0')
    && (receipt.status === 'started' || receipt.status === 'completed' || receipt.status === 'recovery_required')
    && sha(receipt.oldHead) && sha(receipt.oldBaseSha) && sha(receipt.newBaseSha) && sha(receipt.checkpointHead)
    && typeof receipt.checkpointId === 'string' && receipt.checkpointId.length > 0 && receipt.checkpointId.length <= 128 && !receipt.checkpointId.includes('\0')
    && Number.isSafeInteger(receipt.checkpointRevision) && (receipt.checkpointRevision ?? 0) > 0
    && typeof receipt.recoveryRef === 'string'
    && /^refs\/unified-mpc\/recovery\/rebase\/[A-Za-z0-9._-]{1,128}$/.test(receipt.recoveryRef)
    && Number.isSafeInteger(receipt.admissionGeneration) && (receipt.admissionGeneration ?? 0) > 0
    && Number.isSafeInteger(receipt.writeLeaseGeneration) && (receipt.writeLeaseGeneration ?? 0) > 0
    && (receipt.remoteGoalRef === undefined || (typeof receipt.remoteGoalRef === 'string'
      && receipt.remoteGoalRef.length <= 2048 && receipt.remoteGoalRef.startsWith('refs/heads/') && !receipt.remoteGoalRef.includes('\0')))
    && (receipt.remoteGoalSha === undefined || sha(receipt.remoteGoalSha))
    && (receipt.resultHead === undefined || sha(receipt.resultHead))
    && (paths === undefined || (Array.isArray(paths) && paths.length <= 100
      && paths.every((entry) => typeof entry === 'string' && entry.length > 0 && entry.length <= 4096 && !entry.includes('\0'))))
    && (receipt.abortSucceeded === undefined || typeof receipt.abortSucceeded === 'boolean')
    && typeof receipt.startedAt === 'string' && Number.isFinite(Date.parse(receipt.startedAt))
    && (receipt.finishedAt === undefined || (typeof receipt.finishedAt === 'string' && Number.isFinite(Date.parse(receipt.finishedAt))))
    && (receipt.failureReason === undefined || (typeof receipt.failureReason === 'string' && receipt.failureReason.length <= 256))
    && (receipt.status !== 'completed' || (receipt.resultHead !== undefined && receipt.finishedAt !== undefined))
    && (receipt.status !== 'recovery_required' || (receipt.failureReason !== undefined && receipt.finishedAt !== undefined));
}

function isWorkspaceAdmissionReceipt(value: unknown): value is WorkspaceAdmissionReceipt {
  if (typeof value !== 'object' || value === null) return false;
  const receipt = value as Partial<WorkspaceAdmissionReceipt>;
  const allowedKeys = new Set([
    'admissionId', 'projectId', 'workspaceId', 'goalId', 'workspaceKind', 'repositoryIdentity',
    'gitCommonDirIdentity', 'worktreeIdentity', 'branchName', 'expectedWorkspaceHead',
    'observedWorkspaceHead', 'baseRef', 'expectedBaseSha', 'resolvedBaseSha', 'remoteGoalRef',
    'remoteGoalSha', 'mergeBaseSha', 'dirtyState', 'dirtyFingerprint', 'stagedFingerprint',
    'untrackedFingerprint', 'checkpointId', 'checkpointRevision', 'writeLeaseGeneration',
    'runtimeDeploymentId', 'runtimeGeneration', 'runtimeBuildVersion', 'runtimeBuildCommit',
    'runtimeBuildDirty', 'runtimeProtocolGeneration', 'runtimeStartedAt', 'workflowVersion',
    'admissionGeneration', 'createdAt', 'expiresAt', 'invalidatedAt', 'invalidationReason',
  ]);
  if (Object.keys(receipt).some((key) => !allowedKeys.has(key))) return false;
  return typeof receipt.admissionId === 'string'
    && typeof receipt.projectId === 'string'
    && typeof receipt.workspaceId === 'string'
    && (receipt.workspaceKind === 'git' || receipt.workspaceKind === 'non_git')
    && typeof receipt.worktreeIdentity === 'string'
    && typeof receipt.expectedWorkspaceHead === 'string'
    && typeof receipt.observedWorkspaceHead === 'string'
    && (receipt.dirtyState === 'clean' || receipt.dirtyState === 'dirty' || receipt.dirtyState === 'unknown')
    && typeof receipt.dirtyFingerprint === 'string'
    && Number.isSafeInteger(receipt.writeLeaseGeneration)
    && typeof receipt.runtimeDeploymentId === 'string'
    && typeof receipt.runtimeGeneration === 'string'
    && typeof receipt.runtimeBuildVersion === 'string'
    && (receipt.runtimeBuildCommit === undefined || typeof receipt.runtimeBuildCommit === 'string')
    && typeof receipt.runtimeBuildDirty === 'boolean'
    && Number.isSafeInteger(receipt.runtimeProtocolGeneration)
    && typeof receipt.runtimeStartedAt === 'string'
    && Number.isSafeInteger(receipt.workflowVersion)
    && Number.isSafeInteger(receipt.admissionGeneration)
    && typeof receipt.createdAt === 'string'
    && (receipt.expiresAt === undefined || typeof receipt.expiresAt === 'string')
    && (receipt.invalidatedAt === undefined || typeof receipt.invalidatedAt === 'string')
    && (receipt.invalidationReason === undefined || (typeof receipt.invalidationReason === 'string' && receipt.invalidationReason.length <= 256));
}
