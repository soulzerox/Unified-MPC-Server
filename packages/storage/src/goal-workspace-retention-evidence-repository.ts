import path from 'node:path';
import type { SqliteDatabase } from './database.js';

/** Metadata from a first-party sealed-and-independently-rehashed operation. */
export interface GoalWorkspaceRetentionTrustedEvidence {
  readonly operationId: string;
  readonly expectedGoalId: string;
  readonly expectedWorkspaceId: string;
  readonly newWorkspaceId: string;
  readonly retentionPath: string;
  readonly expectedManifestSha256: string;
  readonly expectedHead: string;
  readonly expectedBranch: string;
}

export interface SealGoalWorkspaceEvidenceRequest extends GoalWorkspaceRetentionTrustedEvidence {
  readonly ownerClientId: string;
  readonly ownerSessionId: string;
  readonly expectedRevision: number;
  readonly expectedAdmissionGeneration: number;
  readonly leaseGeneration: number;
  /** Compared to live Goal lease, never persisted. */
  readonly leaseTokenHash: string;
  readonly now: string;
}

interface GoalRow {
  workspace_id: string; status: string; revision: number;
  owner_client_id: string; lease_owner_client_id: string | null;
  lease_owner_session_id: string | null; lease_token_hash: string | null;
  lease_generation: number; lease_expires_at: string | null;
}
interface WorkspaceRow {
  workspace_kind: string; archived_at: string | null; goal_id: string | null;
  parent_workspace_id: string | null; owner_session_id: string | null;
  branch_name: string | null; real_root_path: string;
  writer_lease_owner_id: string | null; writer_lease_generation: number | null;
  writer_lease_expires_at: string | null;
}

interface AdmissionRow { admission_generation: number; receipt_json: string; }

function contains(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep)
    && !path.isAbsolute(relative));
}

function validEvidence(e: GoalWorkspaceRetentionTrustedEvidence): boolean {
  return typeof e.operationId === 'string' && e.operationId.length > 0 && e.operationId.length <= 128
    && typeof e.expectedGoalId === 'string' && e.expectedGoalId.length > 0
    && typeof e.expectedWorkspaceId === 'string' && e.expectedWorkspaceId.length > 0
    && typeof e.newWorkspaceId === 'string' && e.newWorkspaceId.length > 0
    && e.expectedWorkspaceId !== e.newWorkspaceId
    && typeof e.expectedHead === 'string' && /^[a-f0-9]{40,64}$/.test(e.expectedHead)
    && typeof e.expectedManifestSha256 === 'string' && /^[a-f0-9]{64}$/.test(e.expectedManifestSha256)
    && typeof e.expectedBranch === 'string' && e.expectedBranch.length > 0 && e.expectedBranch.length <= 256
    && typeof e.retentionPath === 'string' && path.isAbsolute(e.retentionPath)
    && e.retentionPath.length <= 4096 && path.resolve(e.retentionPath) === e.retentionPath;
}

function pinnedEvidence(e: SealGoalWorkspaceEvidenceRequest): GoalWorkspaceRetentionTrustedEvidence {
  return {
    operationId: e.operationId, expectedGoalId: e.expectedGoalId,
    expectedWorkspaceId: e.expectedWorkspaceId, newWorkspaceId: e.newWorkspaceId,
    retentionPath: e.retentionPath, expectedManifestSha256: e.expectedManifestSha256,
    expectedHead: e.expectedHead, expectedBranch: e.expectedBranch,
  };
}

export class SqliteGoalWorkspaceRetentionEvidenceRepository {
  public constructor(private readonly database: SqliteDatabase) {}

  /**
   * Owner-checked durable persistence. The caller must FIRST seal, reopen,
   * independently rehash and bind the original Git source through a trusted
   * Host fence. This storage method alone does not verify on-disk bytes.
   */
  public async recordSealed(request: SealGoalWorkspaceEvidenceRequest): Promise<boolean> {
    if (!validEvidence(request) || !request.ownerClientId || !request.ownerSessionId
      || !request.leaseTokenHash || request.leaseTokenHash.length > 256
      || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0
      || !Number.isSafeInteger(request.expectedAdmissionGeneration) || request.expectedAdmissionGeneration < 1
      || !Number.isSafeInteger(request.leaseGeneration) || request.leaseGeneration < 1
      || !Number.isFinite(Date.parse(request.now))) return false;
    const serialized = JSON.stringify(pinnedEvidence(request));
    if (Buffer.byteLength(serialized, 'utf8') > 8192) return false;
    const conn = this.database.connection;
    conn.exec('BEGIN IMMEDIATE;');
    const reject = (): false => { conn.exec('ROLLBACK;'); return false; };
    try {
      const goal = conn.prepare(`
        SELECT workspace_id, status, revision, owner_client_id, lease_owner_client_id,
          lease_owner_session_id, lease_token_hash, lease_generation, lease_expires_at
        FROM goals WHERE id = ?
      `).get(request.expectedGoalId) as GoalRow | undefined;
      const original = conn.prepare(`
        SELECT workspace_kind, archived_at, goal_id, parent_workspace_id,
          owner_session_id, branch_name, real_root_path, writer_lease_owner_id,
          writer_lease_generation, writer_lease_expires_at
        FROM workspaces WHERE id = ?
      `).get(request.expectedWorkspaceId) as WorkspaceRow | undefined;
      const replacement = conn.prepare(`
        SELECT workspace_kind, archived_at, goal_id, parent_workspace_id,
          owner_session_id, branch_name, real_root_path, writer_lease_owner_id,
          writer_lease_generation, writer_lease_expires_at
        FROM workspaces WHERE id = ?
      `).get(request.newWorkspaceId) as WorkspaceRow | undefined;
      const admission = conn.prepare(`
        SELECT admission_generation, receipt_json FROM workspace_admission_receipts
        WHERE workspace_id = ?
      `).get(request.expectedWorkspaceId) as AdmissionRow | undefined;
      const boundGoal = conn.prepare('SELECT id FROM goals WHERE workspace_id = ? LIMIT 1').get(request.newWorkspaceId);
      let receipt: unknown = null;
      try { if (admission !== undefined) receipt = JSON.parse(admission.receipt_json) as unknown; }
      catch { /* fail closed */ }
      const prior = receipt !== null && typeof receipt === 'object'
        ? receipt as Record<string, unknown> : null;
      if (goal?.status !== 'active' || goal.workspace_id !== request.expectedWorkspaceId
        || goal.revision !== request.expectedRevision
        || goal.owner_client_id !== request.ownerClientId
        || goal.lease_owner_client_id !== request.ownerClientId
        || goal.lease_owner_session_id !== request.ownerSessionId
        || goal.lease_generation !== request.leaseGeneration
        || goal.lease_token_hash !== request.leaseTokenHash
        || goal.lease_expires_at === null || goal.lease_expires_at <= request.now
        || original?.workspace_kind !== 'goal' || original.goal_id !== request.expectedGoalId
        || original.archived_at !== null || original.branch_name !== request.expectedBranch
        || original.parent_workspace_id === null
        || original.writer_lease_owner_id !== request.ownerClientId + ':' + request.ownerSessionId
        || original.writer_lease_generation !== request.leaseGeneration
        || original.writer_lease_expires_at === null || original.writer_lease_expires_at <= request.now
        || replacement?.workspace_kind !== 'temporary' || replacement.goal_id !== null
        || replacement.archived_at !== null || replacement.writer_lease_generation !== null
        || replacement.owner_session_id !== request.ownerSessionId
        || replacement.parent_workspace_id !== original.parent_workspace_id
        || replacement.real_root_path === original.real_root_path || boundGoal !== undefined
        || contains(original.real_root_path, request.retentionPath)
        || contains(replacement.real_root_path, request.retentionPath)
        || contains(request.retentionPath, original.real_root_path)
        || contains(request.retentionPath, replacement.real_root_path)
        || admission?.admission_generation !== request.expectedAdmissionGeneration
        || prior === null || prior.invalidatedAt !== undefined
        || prior.goalId !== request.expectedGoalId || prior.workspaceId !== request.expectedWorkspaceId
        || prior.expectedWorkspaceHead !== request.expectedHead
        || prior.observedWorkspaceHead !== request.expectedHead
        || prior.branchName !== request.expectedBranch) return reject();

      const active = conn.prepare(`
        SELECT operation_id, evidence_json FROM goal_workspace_retention_evidence
        WHERE goal_id = ? AND status = 'sealed'
      `).get(request.expectedGoalId) as { operation_id: string; evidence_json: string } | undefined;
      if (active !== undefined) {
        conn.exec('ROLLBACK;');
        return active.operation_id === request.operationId && active.evidence_json === serialized;
      }
      const result = conn.prepare(`
        INSERT INTO goal_workspace_retention_evidence (
          operation_id, goal_id, source_workspace_id, destination_workspace_id,
          expected_revision, expected_admission_generation, lease_generation,
          manifest_sha256, evidence_json, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'sealed', ?)
      `).run(request.operationId, request.expectedGoalId, request.expectedWorkspaceId,
        request.newWorkspaceId, request.expectedRevision, request.expectedAdmissionGeneration,
        request.leaseGeneration, request.expectedManifestSha256, serialized, request.now);
      if (Number(result.changes) !== 1) return reject();
      conn.exec('COMMIT;');
      return true;
    } catch (error) {
      conn.exec('ROLLBACK;');
      throw error;
    }
  }

  /** Host-only durable read. Never read an unpinned digest out of a retention folder. */
  public async getByOperation(operationId: string): Promise<GoalWorkspaceRetentionTrustedEvidence | null> {
    if (!operationId || operationId.length > 128) return null;
    const row = this.database.connection.prepare(`
      SELECT goal_id, source_workspace_id, destination_workspace_id, manifest_sha256,
        evidence_json, status
      FROM goal_workspace_retention_evidence WHERE operation_id = ?
    `).get(operationId) as {
      goal_id: string; source_workspace_id: string; destination_workspace_id: string;
      manifest_sha256: string; evidence_json: string; status: string;
    } | undefined;
    if (row?.status !== 'sealed' || Buffer.byteLength(row.evidence_json, 'utf8') > 8192) return null;
    try {
      const parsed: unknown = JSON.parse(row.evidence_json);
      if (parsed === null || typeof parsed !== 'object') return null;
      const p = parsed as GoalWorkspaceRetentionTrustedEvidence;
      return validEvidence(p) && p.operationId === operationId
        && p.expectedGoalId === row.goal_id
        && p.expectedWorkspaceId === row.source_workspace_id
        && p.newWorkspaceId === row.destination_workspace_id
        && p.expectedManifestSha256 === row.manifest_sha256 ? {
          operationId: p.operationId,
          expectedGoalId: p.expectedGoalId,
          expectedWorkspaceId: p.expectedWorkspaceId,
          newWorkspaceId: p.newWorkspaceId,
          expectedHead: p.expectedHead,
          expectedBranch: p.expectedBranch,
          expectedManifestSha256: p.expectedManifestSha256,
          retentionPath: p.retentionPath,
        } : null;
    } catch {
      return null;
    }
  }
}
