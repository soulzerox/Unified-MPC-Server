import path from 'node:path';
import type { SqliteDatabase } from './database.js';

/**
 * Metadata stored independently from retention/files and manifest.json.
 * The digest is meaningful only after the trusted application verifier has
 * reopened and hashed every file; this repository does NOT attest to bytes.
 */
export interface GoalWorkspaceCustodyPin {
  readonly operationId: string;
  readonly goalId: string;
  readonly expectedGoalId: string;
  readonly expectedWorkspaceId: string;
  readonly newWorkspaceId: string;
  readonly retentionPath: string;
  readonly expectedManifestSha256: string;
  readonly expectedHead: string;
  readonly expectedBranch: string;
  readonly ownerClientId: string;
  readonly ownerSessionId: string;
  readonly expectedRevision: number;
  readonly expectedAdmissionGeneration: number;
  readonly leaseGeneration: number;
  readonly pinnedAt: string;
}

export interface RecordVerifiedGoalWorkspaceCustodyRequest extends GoalWorkspaceCustodyPin {
  /** Supplied only for transactional equality with the live owner; never persisted. */
  readonly leaseTokenHash: string;
}

interface GoalRow {
  readonly workspace_id: string;
  readonly status: string;
  readonly revision: number;
  readonly lease_generation: number;
  readonly owner_client_id: string;
  readonly lease_owner_client_id: string | null;
  readonly lease_owner_session_id: string | null;
  readonly lease_token_hash: string | null;
  readonly lease_expires_at: string | null;
}

interface WorkspaceRow {
  readonly workspace_kind: string;
  readonly goal_id: string | null;
  readonly archived_at: string | null;
  readonly parent_workspace_id: string | null;
  readonly owner_session_id: string | null;
  readonly branch_name: string | null;
  readonly real_root_path: string;
  readonly writer_lease_owner_id: string | null;
  readonly writer_lease_generation: number | null;
  readonly writer_lease_expires_at: string | null;
}
interface AdmissionRow {
  readonly admission_generation: number;
  readonly receipt_json: string;
}

function contained(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

function validPin(p: GoalWorkspaceCustodyPin): boolean {
  return typeof p.operationId === 'string' && p.operationId.length > 0 && p.operationId.length <= 128
    && typeof p.goalId === 'string' && p.goalId.length > 0 && p.goalId === p.expectedGoalId
    && typeof p.expectedWorkspaceId === 'string' && p.expectedWorkspaceId.length > 0
    && typeof p.newWorkspaceId === 'string' && p.newWorkspaceId.length > 0
    && p.expectedWorkspaceId !== p.newWorkspaceId
    && typeof p.ownerClientId === 'string' && p.ownerClientId.length > 0
    && typeof p.ownerSessionId === 'string' && p.ownerSessionId.length > 0
    && typeof p.expectedBranch === 'string' && p.expectedBranch.length > 0 && p.expectedBranch.length <= 256
    && /^[a-f0-9]{40,64}$/.test(p.expectedHead)
    && /^[a-f0-9]{64}$/.test(p.expectedManifestSha256)
    && typeof p.retentionPath === 'string' && path.isAbsolute(p.retentionPath)
    && path.resolve(p.retentionPath) === p.retentionPath
    && p.retentionPath.length <= 4096
    && Number.isSafeInteger(p.expectedRevision) && p.expectedRevision >= 0
    && Number.isSafeInteger(p.expectedAdmissionGeneration) && p.expectedAdmissionGeneration >= 1
    && Number.isSafeInteger(p.leaseGeneration) && p.leaseGeneration >= 1
    && typeof p.pinnedAt === 'string' && Number.isFinite(Date.parse(p.pinnedAt));
}

function stablePin(request: RecordVerifiedGoalWorkspaceCustodyRequest): GoalWorkspaceCustodyPin {
  return {
    operationId: request.operationId,
    goalId: request.goalId,
    expectedGoalId: request.expectedGoalId,
    expectedWorkspaceId: request.expectedWorkspaceId,
    newWorkspaceId: request.newWorkspaceId,
    retentionPath: request.retentionPath,
    expectedManifestSha256: request.expectedManifestSha256,
    expectedHead: request.expectedHead,
    expectedBranch: request.expectedBranch,
    ownerClientId: request.ownerClientId,
    ownerSessionId: request.ownerSessionId,
    expectedRevision: request.expectedRevision,
    expectedAdmissionGeneration: request.expectedAdmissionGeneration,
    leaseGeneration: request.leaseGeneration,
    pinnedAt: request.pinnedAt,
  };
}

/**
 * First-party storage boundary for trusted, independently verified pins.
 * No raw lease token/hash is placed on disk; every write compares the live
 * goal lease owner, revision, original registration, and admission receipt.
 */
export class SqliteGoalWorkspaceRetentionCustodyRepository {
  public constructor(private readonly database: SqliteDatabase) {}

  public async recordVerified(request: RecordVerifiedGoalWorkspaceCustodyRequest): Promise<boolean> {
    if (!validPin(request) || typeof request.leaseTokenHash !== 'string'
      || request.leaseTokenHash.length === 0 || request.leaseTokenHash.length > 256) return false;
    const serialized = JSON.stringify(stablePin(request));
    if (Buffer.byteLength(serialized, 'utf8') > 8192) return false;

    const db = this.database.connection;
    db.exec('BEGIN IMMEDIATE;');
    const refuse = (): false => { db.exec('ROLLBACK;'); return false; };
    try {
      const goal = db.prepare(`
        SELECT workspace_id, status, revision, lease_generation, owner_client_id,
          lease_owner_client_id, lease_owner_session_id, lease_token_hash, lease_expires_at
        FROM goals WHERE id = ?
      `).get(request.goalId) as GoalRow | undefined;
      const old = db.prepare(`
        SELECT workspace_kind, goal_id, archived_at, parent_workspace_id,
          owner_session_id, branch_name, real_root_path, writer_lease_owner_id,
          writer_lease_generation, writer_lease_expires_at
        FROM workspaces WHERE id = ?
      `).get(request.expectedWorkspaceId) as WorkspaceRow | undefined;
      const next = db.prepare(`
        SELECT workspace_kind, goal_id, archived_at, parent_workspace_id,
          owner_session_id, branch_name, real_root_path, writer_lease_owner_id,
          writer_lease_generation, writer_lease_expires_at
        FROM workspaces WHERE id = ?
      `).get(request.newWorkspaceId) as WorkspaceRow | undefined;
      const admission = db.prepare(`
        SELECT admission_generation, receipt_json
        FROM workspace_admission_receipts WHERE workspace_id = ?
      `).get(request.expectedWorkspaceId) as AdmissionRow | undefined;
      let receipt: unknown = null;
      try { if (admission !== undefined) receipt = JSON.parse(admission.receipt_json) as unknown; } catch { /* reject */ }
      const attested = receipt !== null && typeof receipt === 'object'
        ? receipt as Record<string, unknown> : null;
      const anotherGoal = db.prepare('SELECT id FROM goals WHERE workspace_id = ? LIMIT 1').get(request.newWorkspaceId);
      if (goal === undefined || goal.status !== 'active'
        || goal.workspace_id !== request.expectedWorkspaceId || goal.revision !== request.expectedRevision
        || goal.lease_generation !== request.leaseGeneration || goal.owner_client_id !== request.ownerClientId
        || goal.lease_owner_client_id !== request.ownerClientId
        || goal.lease_owner_session_id !== request.ownerSessionId
        || goal.lease_token_hash !== request.leaseTokenHash
        || goal.lease_expires_at === null || goal.lease_expires_at <= request.pinnedAt
        || old === undefined || old.workspace_kind !== 'goal' || old.goal_id !== request.goalId
        || old.archived_at !== null || old.branch_name !== request.expectedBranch
        || old.writer_lease_owner_id !== request.ownerClientId + ':' + request.ownerSessionId
        || old.writer_lease_generation !== request.leaseGeneration
        || old.writer_lease_expires_at === null || old.writer_lease_expires_at <= request.pinnedAt
        || next === undefined || next.workspace_kind !== 'temporary' || next.goal_id !== null
        || next.archived_at !== null || next.owner_session_id !== request.ownerSessionId
        || old.parent_workspace_id === null || next.parent_workspace_id !== old.parent_workspace_id
        || anotherGoal !== undefined
        || next.writer_lease_generation !== null
        || contained(old.real_root_path, request.retentionPath)
        || contained(next.real_root_path, request.retentionPath)
        || contained(request.retentionPath, old.real_root_path)
        || contained(request.retentionPath, next.real_root_path)
        || admission === undefined || admission.admission_generation !== request.expectedAdmissionGeneration
        || attested === null || attested.invalidatedAt !== undefined
        || attested.goalId !== request.goalId || attested.workspaceId !== request.expectedWorkspaceId
        || attested.expectedWorkspaceHead !== request.expectedHead
        || attested.observedWorkspaceHead !== request.expectedHead
        || attested.branchName !== request.expectedBranch) return refuse();

      const prior = db.prepare(`
        SELECT operation_id, pin_json FROM goal_workspace_retention_custody
        WHERE goal_id = ? AND status = 'pinned'
      `).get(request.goalId) as { operation_id: string; pin_json: string } | undefined;
      if (prior !== undefined) {
        db.exec('ROLLBACK;');
        return prior.operation_id === request.operationId && prior.pin_json === serialized;
      }
      const inserted = db.prepare(`
        INSERT INTO goal_workspace_retention_custody (
          operation_id, goal_id, old_workspace_id, new_workspace_id, goal_revision,
          admission_generation, lease_generation, manifest_sha256, pin_json, pinned_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        request.operationId, request.goalId, request.expectedWorkspaceId, request.newWorkspaceId,
        request.expectedRevision, request.expectedAdmissionGeneration, request.leaseGeneration,
        request.expectedManifestSha256, serialized, request.pinnedAt,
      );
      if (Number(inserted.changes) !== 1) return refuse();
      db.exec('COMMIT;');
      return true;
    } catch (error) {
      db.exec('ROLLBACK;');
      throw error;
    }
  }

  public async readPinned(operationId: string): Promise<GoalWorkspaceCustodyPin | null> {
    const row = this.database.connection.prepare(
      "SELECT pin_json FROM goal_workspace_retention_custody WHERE operation_id = ? AND status = 'pinned'",
    ).get(operationId) as { pin_json: string } | undefined;
    if (row === undefined || Buffer.byteLength(row.pin_json, 'utf8') > 8192) return null;
    try {
      const candidate: unknown = JSON.parse(row.pin_json);
      return candidate !== null && typeof candidate === 'object' && validPin(candidate as GoalWorkspaceCustodyPin)
        ? candidate as GoalWorkspaceCustodyPin : null;
    } catch {
      return null;
    }
  }
}
