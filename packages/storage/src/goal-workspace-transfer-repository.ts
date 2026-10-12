import type { WorkspaceAdmissionReceipt } from '@unified-mpc/domain';
import type { SqliteDatabase } from './database.js';

/**
 * Trusted storage-layer preparation for an owner-approved Goal Workspace
 * relocation. This is intentionally NOT an admission, worktree move, or
 * mutation of the original Goal/Workspace. The caller must first verify
 * externally pinned retention and exact new Git workspace source.
 */
export interface GoalWorkspaceTransferIntentRequest {
  readonly operationId: string;
  readonly goalId: string;
  readonly goalKey: string;
  readonly fromWorkspaceId: string;
  readonly toWorkspaceId: string;
  readonly expectedRevision: number;
  readonly expectedAdmissionGeneration: number;
  readonly leaseGeneration: number;
  /** SHA-256 of the actual current owner Goal lease token, not the token. */
  readonly leaseTokenHash: string;
  readonly ownerClientId: string;
  readonly ownerSessionId: string;
  readonly expectedOldHead: string;
  readonly expectedOldBranch: string;
  /** Trusted first-party read-back digest pinned outside the retention tree. */
  readonly retainedManifestSha256: string;
  readonly now: string;
}

export type GoalWorkspaceTransferIntent = Omit<GoalWorkspaceTransferIntentRequest, 'leaseTokenHash'> & {
  readonly status: 'prepared' | 'completed' | 'cancelled';
};

/** Read-only startup/reconnect classification. Never grants write permission. */
export interface GoalWorkspaceTransferRecoveryObservation {
  readonly operationId: string;
  readonly goalId?: string;
  readonly oldWorkspaceId?: string;
  readonly newWorkspaceId?: string;
  readonly state:
    | 'missing_or_unverified'
    | 'prepared_requires_fresh_owner_verification'
    | 'prepared_stale_owner_review'
    | 'committed_runtime_admission_required'
    | 'committed_inconsistent_owner_review'
    | 'cancelled';
}


interface GoalRow {
  workspace_id: string;
  goal_key: string;
  owner_client_id: string;
  status: string;
  revision: number;
  lease_generation: number;
  lease_token_hash: string | null;
  lease_owner_client_id: string | null;
  lease_owner_session_id: string | null;
  lease_expires_at: string | null;
}

interface WorkspaceRow {
  workspace_kind: string;
  archived_at: string | null;
  goal_id: string | null;
  parent_workspace_id: string | null;
  owner_session_id: string | null;
  branch_name: string | null;
  real_root_path: string;
  writer_lease_id: string | null;
  writer_lease_owner_id: string | null;
  writer_lease_generation: number | null;
  writer_lease_expires_at: string | null;
}

interface AdmissionRow {
  admission_generation: number;
  write_lease_generation: number;
  receipt_json: string;
}

interface CustodyRow {
  readonly operation_id: string;
  readonly goal_id: string;
  readonly old_workspace_id: string;
  readonly new_workspace_id: string;
  readonly goal_revision: number;
  readonly admission_generation: number;
  readonly lease_generation: number;
  readonly manifest_sha256: string;
  readonly pin_json: string;
  readonly status: string;
}

/** Transaction-scoped immutable pin check, independent of the retention folder. */
function matchingPinnedCustody(
  db: SqliteDatabase['connection'],
  request: Pick<GoalWorkspaceTransferIntentRequest, 'operationId' | 'goalId' | 'fromWorkspaceId'
    | 'toWorkspaceId' | 'expectedRevision' | 'expectedAdmissionGeneration' | 'leaseGeneration'
    | 'retainedManifestSha256' | 'ownerClientId' | 'ownerSessionId' | 'expectedOldHead' | 'expectedOldBranch'>,
): boolean {
  const row = db.prepare(`
    SELECT operation_id, goal_id, old_workspace_id, new_workspace_id, goal_revision,
      admission_generation, lease_generation, manifest_sha256, pin_json, status
    FROM goal_workspace_retention_custody WHERE operation_id = ?
  `).get(request.operationId) as CustodyRow | undefined;
  if (row === undefined || row.status !== 'pinned'
    || row.goal_id !== request.goalId || row.old_workspace_id !== request.fromWorkspaceId
    || row.new_workspace_id !== request.toWorkspaceId
    || row.goal_revision !== request.expectedRevision
    || row.admission_generation !== request.expectedAdmissionGeneration
    || row.lease_generation !== request.leaseGeneration
    || row.manifest_sha256 !== request.retainedManifestSha256) return false;
  try {
    const pin: unknown = JSON.parse(row.pin_json);
    if (pin === null || typeof pin !== 'object') return false;
    const p = pin as Record<string, unknown>;
    return p.operationId === request.operationId && p.goalId === request.goalId
      && p.expectedGoalId === request.goalId && p.expectedWorkspaceId === request.fromWorkspaceId
      && p.newWorkspaceId === request.toWorkspaceId
      && p.expectedRevision === request.expectedRevision
      && p.expectedAdmissionGeneration === request.expectedAdmissionGeneration
      && p.leaseGeneration === request.leaseGeneration
      && p.expectedManifestSha256 === request.retainedManifestSha256
      && p.expectedHead === request.expectedOldHead && p.expectedBranch === request.expectedOldBranch
      && p.ownerClientId === request.ownerClientId && p.ownerSessionId === request.ownerSessionId
      && typeof p.retentionPath === 'string' && p.retentionPath.length > 0;
  } catch {
    return false;
  }
}

/** The independently sealed evidence and the verified custody pin must
 * refer to the SAME retained bytes and source/destination under one operation.
 * This is checked inside both prepare and commit SQLite transactions.
 */
function matchingSealedEvidence(
  db: SqliteDatabase['connection'],
  request: Pick<GoalWorkspaceTransferIntentRequest, 'operationId' | 'goalId' | 'fromWorkspaceId'
    | 'toWorkspaceId' | 'expectedRevision' | 'expectedAdmissionGeneration' | 'leaseGeneration'
    | 'retainedManifestSha256' | 'expectedOldHead' | 'expectedOldBranch'>,
): boolean {
  const evidence = db.prepare(`
    SELECT goal_id, source_workspace_id, destination_workspace_id,
      expected_revision, expected_admission_generation, lease_generation,
      manifest_sha256, evidence_json, status
    FROM goal_workspace_retention_evidence WHERE operation_id = ?
  `).get(request.operationId) as {
    goal_id: string; source_workspace_id: string; destination_workspace_id: string;
    expected_revision: number; expected_admission_generation: number; lease_generation: number;
    manifest_sha256: string; evidence_json: string; status: string;
  } | undefined;
  const custody = db.prepare(`
    SELECT pin_json FROM goal_workspace_retention_custody WHERE operation_id = ? AND status = 'pinned'
  `).get(request.operationId) as { pin_json: string } | undefined;
  if (evidence?.status !== 'sealed' || custody === undefined
    || evidence.goal_id !== request.goalId
    || evidence.source_workspace_id !== request.fromWorkspaceId
    || evidence.destination_workspace_id !== request.toWorkspaceId
    || evidence.expected_revision !== request.expectedRevision
    || evidence.expected_admission_generation !== request.expectedAdmissionGeneration
    || evidence.lease_generation !== request.leaseGeneration
    || evidence.manifest_sha256 !== request.retainedManifestSha256) return false;
  try {
    const source: unknown = JSON.parse(evidence.evidence_json);
    const pinned: unknown = JSON.parse(custody.pin_json);
    if (source === null || typeof source !== 'object'
      || pinned === null || typeof pinned !== 'object') return false;
    const s = source as Record<string, unknown>;
    const c = pinned as Record<string, unknown>;
    return s.operationId === request.operationId
      && s.expectedGoalId === request.goalId
      && s.expectedWorkspaceId === request.fromWorkspaceId
      && s.newWorkspaceId === request.toWorkspaceId
      && s.expectedHead === request.expectedOldHead
      && s.expectedBranch === request.expectedOldBranch
      && s.expectedManifestSha256 === request.retainedManifestSha256
      && typeof s.retentionPath === 'string' && s.retentionPath.length > 0
      && s.retentionPath === c.retentionPath;
  } catch {
    return false;
  }
}

function validPersistedIntent(request: Omit<GoalWorkspaceTransferIntentRequest, 'leaseTokenHash'>): boolean {
  return request.operationId.length > 0 && request.operationId.length <= 128
    && request.goalId.length > 0 && request.goalKey.length > 0
    && request.fromWorkspaceId.length > 0 && request.toWorkspaceId.length > 0
    && request.fromWorkspaceId !== request.toWorkspaceId
    && request.ownerClientId.length > 0 && request.ownerSessionId.length > 0
    && /^[a-f0-9]{40,64}$/.test(request.expectedOldHead)
    && /^[a-f0-9]{64}$/.test(request.retainedManifestSha256)
    && request.expectedOldBranch.length > 0 && request.expectedOldBranch.length <= 256
    && Number.isSafeInteger(request.expectedRevision) && request.expectedRevision >= 0
    && Number.isSafeInteger(request.expectedAdmissionGeneration) && request.expectedAdmissionGeneration >= 1
    && Number.isSafeInteger(request.leaseGeneration) && request.leaseGeneration >= 1
    && Number.isFinite(Date.parse(request.now));
}

function validRequest(request: GoalWorkspaceTransferIntentRequest): boolean {
  return validPersistedIntent(request)
    && request.leaseTokenHash.length > 0 && request.leaseTokenHash.length <= 256;
}

export interface GoalWorkspaceTransferCommitRequest {
  readonly operationId: string;
  readonly goalId: string;
  readonly leaseTokenHash: string;
  readonly retainedManifestSha256: string;
  /** Must originate from first-party, independently verified replacement Git state. */
  readonly admissionReceipt: WorkspaceAdmissionReceipt;
  readonly now: string;
}

export class SqliteGoalWorkspaceTransferRepository {
  public constructor(private readonly database: SqliteDatabase) {}

  /** One active CAS reservation per Goal. No source data or writer ownership changes. */
  public async prepare(request: GoalWorkspaceTransferIntentRequest): Promise<boolean> {
    if (!validRequest(request)) return false;
    const serialized = JSON.stringify({ ...request, leaseTokenHash: undefined });
    if (Buffer.byteLength(serialized, 'utf8') > 8192) return false;
    const conn = this.database.connection;
    conn.exec('BEGIN IMMEDIATE;');
    try {
      const goal = conn.prepare(`
        SELECT workspace_id, goal_key, owner_client_id, status, revision, lease_generation,
          lease_token_hash, lease_owner_client_id, lease_owner_session_id, lease_expires_at
        FROM goals WHERE id = ?
      `).get(request.goalId) as GoalRow | undefined;
      const original = conn.prepare(`
        SELECT workspace_kind, archived_at, goal_id, parent_workspace_id, owner_session_id,
          branch_name, real_root_path, writer_lease_id, writer_lease_owner_id,
          writer_lease_generation, writer_lease_expires_at
        FROM workspaces WHERE id = ?
      `).get(request.fromWorkspaceId) as WorkspaceRow | undefined;
      const replacement = conn.prepare(`
        SELECT workspace_kind, archived_at, goal_id, parent_workspace_id, owner_session_id,
          branch_name, real_root_path, writer_lease_id, writer_lease_owner_id,
          writer_lease_generation, writer_lease_expires_at
        FROM workspaces WHERE id = ?
      `).get(request.toWorkspaceId) as WorkspaceRow | undefined;
      const admission = conn.prepare(`
        SELECT admission_generation, write_lease_generation, receipt_json
        FROM workspace_admission_receipts WHERE workspace_id = ?
      `).get(request.fromWorkspaceId) as AdmissionRow | undefined;
      const otherGoal = conn.prepare('SELECT id FROM goals WHERE workspace_id = ? LIMIT 1')
        .get(request.toWorkspaceId);
      let receipt: unknown;
      try { receipt = admission === undefined ? null : JSON.parse(admission.receipt_json) as unknown; } catch { receipt = null; }
      const attested = receipt !== null && typeof receipt === 'object' ? receipt as Record<string, unknown> : null;

      if (goal === undefined || goal.status !== 'active'
        || goal.workspace_id !== request.fromWorkspaceId || goal.goal_key !== request.goalKey
        || goal.revision !== request.expectedRevision || goal.owner_client_id !== request.ownerClientId
        || goal.lease_generation !== request.leaseGeneration || goal.lease_token_hash !== request.leaseTokenHash
        || goal.lease_owner_client_id !== request.ownerClientId || goal.lease_owner_session_id !== request.ownerSessionId
        || goal.lease_expires_at === null || goal.lease_expires_at <= request.now
        || original === undefined || original.workspace_kind !== 'goal' || original.archived_at !== null
        || original.goal_id !== request.goalId || original.parent_workspace_id === null
        || original.branch_name !== request.expectedOldBranch
        || original.writer_lease_id === null
        || original.writer_lease_owner_id !== request.ownerClientId + ':' + request.ownerSessionId
        || original.writer_lease_generation !== request.leaseGeneration
        || original.writer_lease_expires_at === null || original.writer_lease_expires_at <= request.now
        || replacement === undefined || replacement.workspace_kind !== 'temporary'
        || replacement.archived_at !== null || replacement.goal_id !== null
        || replacement.parent_workspace_id !== original.parent_workspace_id
        || replacement.owner_session_id !== request.ownerSessionId
        || replacement.writer_lease_id !== null || replacement.real_root_path === original.real_root_path
        || admission === undefined
        || admission.admission_generation !== request.expectedAdmissionGeneration
        || admission.write_lease_generation > request.leaseGeneration
        || otherGoal !== undefined
        || !matchingPinnedCustody(conn, request)
        || !matchingSealedEvidence(conn, request)
        || attested === null || attested.invalidatedAt !== undefined || attested.workspaceId !== request.fromWorkspaceId
        || attested.goalId !== request.goalId
        || attested.expectedWorkspaceHead !== request.expectedOldHead
        || attested.observedWorkspaceHead !== request.expectedOldHead
        || attested.branchName !== request.expectedOldBranch) {
        conn.exec('ROLLBACK;');
        return false;
      }

      const prior = conn.prepare(
        "SELECT operation_id, request_json FROM goal_workspace_transfer_intents WHERE goal_id = ? AND status = 'prepared'",
      ).get(request.goalId) as { operation_id: string; request_json: string } | undefined;
      if (prior !== undefined) {
        conn.exec('ROLLBACK;');
        return prior.operation_id === request.operationId && prior.request_json === serialized;
      }

      const written = conn.prepare(`
        INSERT INTO goal_workspace_transfer_intents (
          operation_id, goal_id, old_workspace_id, new_workspace_id, expected_goal_revision,
          expected_admission_generation, lease_generation, retained_manifest_sha256,
          request_json, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?)
      `).run(
        request.operationId, request.goalId, request.fromWorkspaceId, request.toWorkspaceId,
        request.expectedRevision, request.expectedAdmissionGeneration, request.leaseGeneration,
        request.retainedManifestSha256, serialized, request.now,
      );
      if (Number(written.changes) !== 1) {
        conn.exec('ROLLBACK;');
        return false;
      }
      conn.exec('COMMIT;');
      return true;
    } catch (error) {
      conn.exec('ROLLBACK;');
      throw error;
    }
  }

  /**
   * Atomic *storage* compare-and-swap: rebind the original Goal to a verified
   * clean replacement and preserve the foreign-dirty source as an active
   * inspection workspace. No filesystem work is done here.
   *
   * SECURITY: only a trusted first-party service may invoke commit after it
   * independently validates retained bytes, Goal owner authorization, exact
   * repository/branch/source identity and new admission observation.
   * A prepared record is never itself writer admission.
   */
  public async commit(request: GoalWorkspaceTransferCommitRequest): Promise<boolean> {
    const replacementAdmission = request.admissionReceipt;
    if (!request.operationId || !request.goalId || !request.leaseTokenHash
      || !/^[a-f0-9]{64}$/.test(request.retainedManifestSha256)
      || !Number.isFinite(Date.parse(request.now))
      || replacementAdmission.workspaceKind !== 'git'
      || replacementAdmission.goalId !== request.goalId
      || replacementAdmission.dirtyState !== 'clean'
      || replacementAdmission.runtimeBuildDirty
      || replacementAdmission.expectedWorkspaceHead !== replacementAdmission.observedWorkspaceHead
      || !/^[a-f0-9]{40,64}$/.test(replacementAdmission.expectedWorkspaceHead)
      || replacementAdmission.checkpointId === undefined
      || !Number.isSafeInteger(replacementAdmission.checkpointRevision)
      || !replacementAdmission.branchName
      || replacementAdmission.admissionGeneration !== 1
      || replacementAdmission.createdAt !== request.now) return false;
    const serializedAdmission = JSON.stringify(replacementAdmission);
    if (Buffer.byteLength(serializedAdmission, 'utf8') > 16_384) return false;

    const conn = this.database.connection;
    conn.exec('BEGIN IMMEDIATE;');
    const refuse = (): false => { conn.exec('ROLLBACK;'); return false; };
    try {
      const record = conn.prepare(
        'SELECT request_json, status FROM goal_workspace_transfer_intents WHERE operation_id = ?',
      ).get(request.operationId) as { request_json: string; status: string } | undefined;
      if (record === undefined) return refuse();
      const stored: unknown = JSON.parse(record.request_json);
      if (stored === null || typeof stored !== 'object') return refuse();
      const prepared = stored as GoalWorkspaceTransferIntent;
      if (!validPersistedIntent(prepared) || prepared.goalId !== request.goalId
        || prepared.retainedManifestSha256 !== request.retainedManifestSha256
        || replacementAdmission.workspaceId !== prepared.toWorkspaceId
        || replacementAdmission.writeLeaseGeneration !== prepared.leaseGeneration) return refuse();
      if (record.status === 'completed') {
        const goal = conn.prepare('SELECT workspace_id, lease_token_hash FROM goals WHERE id = ?')
          .get(request.goalId) as { workspace_id: string; lease_token_hash: string | null } | undefined;
        const receipt = conn.prepare('SELECT receipt_json FROM workspace_admission_receipts WHERE workspace_id = ?')
          .get(prepared.toWorkspaceId) as { receipt_json: string } | undefined;
        const alreadyCommitted = goal?.workspace_id === prepared.toWorkspaceId
          && goal?.lease_token_hash === request.leaseTokenHash
          && receipt?.receipt_json === serializedAdmission;
        conn.exec('ROLLBACK;');
        return alreadyCommitted;
      }
      if (record.status !== 'prepared') return refuse();
      const liveEvidence = {
        operationId: prepared.operationId, goalId: prepared.goalId,
        fromWorkspaceId: prepared.fromWorkspaceId, toWorkspaceId: prepared.toWorkspaceId,
        expectedRevision: prepared.expectedRevision,
        expectedAdmissionGeneration: prepared.expectedAdmissionGeneration,
        leaseGeneration: prepared.leaseGeneration,
        retainedManifestSha256: request.retainedManifestSha256,
        ownerClientId: prepared.ownerClientId, ownerSessionId: prepared.ownerSessionId,
        expectedOldHead: prepared.expectedOldHead, expectedOldBranch: prepared.expectedOldBranch,
      };
      if (!matchingPinnedCustody(conn, liveEvidence)
        || !matchingSealedEvidence(conn, liveEvidence)) return refuse();
      const goal = conn.prepare(`
        SELECT workspace_id, goal_key, owner_client_id, status, revision, lease_generation,
          lease_token_hash, lease_owner_client_id, lease_owner_session_id, lease_expires_at
        FROM goals WHERE id = ?
      `).get(request.goalId) as GoalRow | undefined;
      const old = conn.prepare(`
        SELECT workspace_kind, archived_at, goal_id, parent_workspace_id, owner_session_id,
          branch_name, real_root_path, writer_lease_id, writer_lease_owner_id,
          writer_lease_generation, writer_lease_expires_at
        FROM workspaces WHERE id = ?
      `).get(prepared.fromWorkspaceId) as WorkspaceRow | undefined;
      const next = conn.prepare(`
        SELECT workspace_kind, archived_at, goal_id, parent_workspace_id, owner_session_id,
          branch_name, real_root_path, writer_lease_id, writer_lease_owner_id,
          writer_lease_generation, writer_lease_expires_at
        FROM workspaces WHERE id = ?
      `).get(prepared.toWorkspaceId) as WorkspaceRow | undefined;
      const admission = conn.prepare(`
        SELECT admission_generation, write_lease_generation, receipt_json
        FROM workspace_admission_receipts WHERE workspace_id = ?
      `).get(prepared.fromWorkspaceId) as AdmissionRow | undefined;
      const nextExistingReceipt = conn.prepare(
        'SELECT workspace_id FROM workspace_admission_receipts WHERE workspace_id = ?',
      ).get(prepared.toWorkspaceId);
      const replacementBoundGoal = conn.prepare('SELECT id FROM goals WHERE workspace_id = ? LIMIT 1')
        .get(prepared.toWorkspaceId);
      let priorReceipt: unknown;
      try { priorReceipt = admission === undefined ? null : JSON.parse(admission.receipt_json) as unknown; }
      catch { priorReceipt = null; }
      const oldReceipt = priorReceipt !== null && typeof priorReceipt === 'object'
        ? priorReceipt as Record<string, unknown> : null;
      if (goal === undefined || goal.status !== 'active'
        || goal.workspace_id !== prepared.fromWorkspaceId || goal.goal_key !== prepared.goalKey
        || goal.revision !== prepared.expectedRevision
        || goal.owner_client_id !== prepared.ownerClientId
        || goal.lease_owner_client_id !== prepared.ownerClientId
        || goal.lease_owner_session_id !== prepared.ownerSessionId
        || goal.lease_token_hash !== request.leaseTokenHash
        || goal.lease_generation !== prepared.leaseGeneration
        || goal.lease_expires_at === null || goal.lease_expires_at <= request.now
        || old === undefined || old.archived_at !== null || old.workspace_kind !== 'goal'
        || old.goal_id !== prepared.goalId || old.branch_name !== prepared.expectedOldBranch
        || old.writer_lease_id === null
        || old.writer_lease_owner_id !== prepared.ownerClientId + ':' + prepared.ownerSessionId
        || old.writer_lease_generation !== prepared.leaseGeneration
        || old.writer_lease_expires_at === null || old.writer_lease_expires_at <= request.now
        || next === undefined || next.archived_at !== null || next.workspace_kind !== 'temporary'
        || next.goal_id !== null || next.writer_lease_id !== null
        || next.owner_session_id !== prepared.ownerSessionId
        || next.parent_workspace_id !== old.parent_workspace_id
        || next.real_root_path === old.real_root_path
        || old.parent_workspace_id === null
        || admission === undefined
        || admission.admission_generation !== prepared.expectedAdmissionGeneration
        || admission.write_lease_generation > prepared.leaseGeneration
        || replacementBoundGoal !== undefined
        || oldReceipt === null || oldReceipt.invalidatedAt !== undefined || oldReceipt.goalId !== prepared.goalId
        || oldReceipt.expectedWorkspaceHead !== prepared.expectedOldHead
        || oldReceipt.observedWorkspaceHead !== prepared.expectedOldHead
        || oldReceipt.branchName !== prepared.expectedOldBranch
        || replacementAdmission.projectId !== old.parent_workspace_id
        || replacementAdmission.invalidatedAt !== undefined
        || nextExistingReceipt !== undefined) return refuse();

      const oldWrite = conn.prepare(`
        UPDATE workspaces SET workspace_kind = 'inspection', goal_id = NULL,
          writer_lease_id = NULL, writer_lease_owner_id = NULL, writer_lease_generation = NULL,
          writer_lease_expires_at = NULL, auto_cleanup = 0
        WHERE id = ? AND workspace_kind = 'goal' AND goal_id = ?
          AND writer_lease_generation = ? AND archived_at IS NULL
      `).run(prepared.fromWorkspaceId, prepared.goalId, prepared.leaseGeneration);
      if (Number(oldWrite.changes) !== 1) return refuse();

      const newWrite = conn.prepare(`
        UPDATE workspaces SET workspace_kind = 'goal', goal_id = ?,
          goal_workspace_kind = 'git_worktree', parent_source = 'committed_head',
          branch_name = ?, base_revision = ?, checkpoint_id = ?, integration_state = 'pending',
          writer_lease_id = ?, writer_lease_owner_id = ?, writer_lease_generation = ?,
          writer_lease_expires_at = ?, auto_cleanup = 0
        WHERE id = ? AND workspace_kind = 'temporary' AND goal_id IS NULL
          AND writer_lease_id IS NULL AND archived_at IS NULL
      `).run(
        prepared.goalId, replacementAdmission.branchName,
        replacementAdmission.expectedBaseSha ?? replacementAdmission.resolvedBaseSha ?? null,
        replacementAdmission.checkpointId, old.writer_lease_id, old.writer_lease_owner_id,
        prepared.leaseGeneration, old.writer_lease_expires_at, prepared.toWorkspaceId,
      );
      if (Number(newWrite.changes) !== 1) return refuse();

      const goalWrite = conn.prepare(`
        UPDATE goals SET workspace_id = ?, revision = revision + 1, updated_at = ?
        WHERE id = ? AND workspace_id = ? AND revision = ? AND lease_generation = ?
          AND lease_token_hash = ? AND status = 'active'
      `).run(
        prepared.toWorkspaceId, request.now, prepared.goalId, prepared.fromWorkspaceId,
        prepared.expectedRevision, prepared.leaseGeneration, request.leaseTokenHash,
      );
      if (Number(goalWrite.changes) !== 1) return refuse();

      const invalidated = JSON.stringify({
        ...oldReceipt, invalidatedAt: request.now, invalidationReason: 'goal_workspace_relocated',
      });
      if (Buffer.byteLength(invalidated, 'utf8') > 16_384) return refuse();
      const oldReceiptWrite = conn.prepare(`
        UPDATE workspace_admission_receipts SET receipt_json = ?, updated_at = ?
        WHERE workspace_id = ? AND admission_generation = ?
      `).run(invalidated, request.now, prepared.fromWorkspaceId, prepared.expectedAdmissionGeneration);
      if (Number(oldReceiptWrite.changes) !== 1) return refuse();

      const admissionWrite = conn.prepare(`
        INSERT INTO workspace_admission_receipts (
          workspace_id, admission_generation, write_lease_generation, receipt_json, updated_at
        ) VALUES (?, 1, ?, ?, ?)
      `).run(prepared.toWorkspaceId, prepared.leaseGeneration, serializedAdmission, request.now);
      if (Number(admissionWrite.changes) !== 1) return refuse();
      const intentWrite = conn.prepare(`
        UPDATE goal_workspace_transfer_intents SET status = 'completed'
        WHERE operation_id = ? AND goal_id = ? AND status = 'prepared'
      `).run(prepared.operationId, prepared.goalId);
      if (Number(intentWrite.changes) !== 1) return refuse();
      const custodyWrite = conn.prepare(`
        UPDATE goal_workspace_retention_custody SET status = 'consumed'
        WHERE operation_id = ? AND goal_id = ? AND status = 'pinned'
          AND manifest_sha256 = ? AND lease_generation = ?
      `).run(prepared.operationId, prepared.goalId, request.retainedManifestSha256, prepared.leaseGeneration);
      if (Number(custodyWrite.changes) !== 1) return refuse();
      const sealedWrite = conn.prepare(`
        UPDATE goal_workspace_retention_evidence SET status = 'consumed'
        WHERE operation_id = ? AND goal_id = ? AND status = 'sealed'
          AND manifest_sha256 = ? AND lease_generation = ?
      `).run(prepared.operationId, prepared.goalId, request.retainedManifestSha256, prepared.leaseGeneration);
      if (Number(sealedWrite.changes) !== 1) return refuse();
      conn.exec('COMMIT;');
      return true;
    } catch (error) {
      conn.exec('ROLLBACK;');
      throw error;
    }
  }

  /**
   * Recover intent *state* after restart without recovering authorization.
   * Never changes rows, claims a lease, resumes an intent or grants ADMITTED.
   * A 'prepared' operation must go through fresh first-party Host Approval,
   * independent retained-byte verification and current Git truth before retry.
   */
  public async inspectRecovery(operationId: string, now: string): Promise<GoalWorkspaceTransferRecoveryObservation> {
    const missing: GoalWorkspaceTransferRecoveryObservation = {
      operationId, state: 'missing_or_unverified',
    };
    if (operationId.length === 0 || operationId.length > 128
      || !Number.isFinite(Date.parse(now))) return missing;
    const prepared = await this.get(operationId);
    if (prepared === null) return missing;
    const identity = {
      operationId, goalId: prepared.goalId,
      oldWorkspaceId: prepared.fromWorkspaceId,
      newWorkspaceId: prepared.toWorkspaceId,
    };
    if (prepared.status === 'cancelled') return { ...identity, state: 'cancelled' };
    const conn = this.database.connection;
    const goal = conn.prepare(`
      SELECT workspace_id, status, revision, lease_generation,
        lease_owner_client_id, lease_owner_session_id, lease_expires_at
      FROM goals WHERE id = ?
    `).get(prepared.goalId) as {
      workspace_id: string; status: string; revision: number;
      lease_generation: number; lease_owner_client_id: string | null;
      lease_owner_session_id: string | null; lease_expires_at: string | null;
    } | undefined;
    const old = conn.prepare('SELECT workspace_kind, goal_id, archived_at, writer_lease_generation FROM workspaces WHERE id = ?')
      .get(prepared.fromWorkspaceId) as {
        workspace_kind: string; goal_id: string | null; archived_at: string | null;
        writer_lease_generation: number | null;
      } | undefined;
    const next = conn.prepare('SELECT workspace_kind, goal_id, archived_at, writer_lease_generation FROM workspaces WHERE id = ?')
      .get(prepared.toWorkspaceId) as {
        workspace_kind: string; goal_id: string | null; archived_at: string | null;
        writer_lease_generation: number | null;
      } | undefined;
    const custody = conn.prepare('SELECT status, manifest_sha256, lease_generation FROM goal_workspace_retention_custody WHERE operation_id = ?')
      .get(operationId) as { status: string; manifest_sha256: string; lease_generation: number } | undefined;
    const evidence = conn.prepare('SELECT status, manifest_sha256, lease_generation FROM goal_workspace_retention_evidence WHERE operation_id = ?')
      .get(operationId) as { status: string; manifest_sha256: string; lease_generation: number } | undefined;
    if (prepared.status === 'prepared') {
      const valid = goal?.status === 'active' && goal.workspace_id === prepared.fromWorkspaceId
        && goal.revision === prepared.expectedRevision
        && goal.lease_generation === prepared.leaseGeneration
        && goal.lease_owner_client_id === prepared.ownerClientId
        && goal.lease_owner_session_id === prepared.ownerSessionId
        && goal.lease_expires_at !== null && goal.lease_expires_at !== undefined
        && goal.lease_expires_at > now
        && old?.workspace_kind === 'goal' && old.goal_id === prepared.goalId
        && old.archived_at === null && old.writer_lease_generation === prepared.leaseGeneration
        && next?.workspace_kind === 'temporary' && next.goal_id === null
        && next.archived_at === null && next.writer_lease_generation === null
        && custody?.status === 'pinned'
        && custody.lease_generation === prepared.leaseGeneration
        && custody.manifest_sha256 === prepared.retainedManifestSha256
        && evidence?.status === 'sealed'
        && evidence.lease_generation === prepared.leaseGeneration
        && evidence.manifest_sha256 === prepared.retainedManifestSha256;
      return {
        ...identity,
        state: valid ? 'prepared_requires_fresh_owner_verification' : 'prepared_stale_owner_review',
      };
    }
    const receipt = conn.prepare('SELECT receipt_json FROM workspace_admission_receipts WHERE workspace_id = ?')
      .get(prepared.toWorkspaceId) as { receipt_json: string } | undefined;
    let attested: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = receipt === undefined ? null : JSON.parse(receipt.receipt_json);
      if (parsed !== null && typeof parsed === 'object') attested = parsed as Record<string, unknown>;
    } catch { /* invalid stored evidence fails closed */ }
    const consistent = goal?.status === 'active'
      && goal.workspace_id === prepared.toWorkspaceId
      && goal.revision === prepared.expectedRevision + 1
      && old?.workspace_kind === 'inspection' && old.goal_id === null
      && old.archived_at === null && old.writer_lease_generation === null
      && next?.workspace_kind === 'goal' && next.goal_id === prepared.goalId
      && next.archived_at === null && next.writer_lease_generation === prepared.leaseGeneration
      && custody?.status === 'consumed'
      && custody.lease_generation === prepared.leaseGeneration
      && custody.manifest_sha256 === prepared.retainedManifestSha256
      && evidence?.status === 'consumed'
      && evidence.lease_generation === prepared.leaseGeneration
      && evidence.manifest_sha256 === prepared.retainedManifestSha256
      && attested?.goalId === prepared.goalId && attested.workspaceId === prepared.toWorkspaceId
      && attested.dirtyState === 'clean' && attested.invalidatedAt === undefined
      && attested.writeLeaseGeneration === prepared.leaseGeneration;
    return {
      ...identity,
      state: consistent ? 'committed_runtime_admission_required' : 'committed_inconsistent_owner_review',
    };
  }

  public async get(operationId: string): Promise<GoalWorkspaceTransferIntent | null> {
    const row = this.database.connection.prepare(
      'SELECT request_json, status FROM goal_workspace_transfer_intents WHERE operation_id = ?',
    ).get(operationId) as { request_json: string; status: 'prepared' | 'completed' | 'cancelled' } | undefined;
    if (row === undefined || Buffer.byteLength(row.request_json, 'utf8') > 8192) return null;
    try {
      const parsed: unknown = JSON.parse(row.request_json);
      if (parsed === null || typeof parsed !== 'object') return null;
      const candidate = parsed as GoalWorkspaceTransferIntent;
      return validPersistedIntent(candidate) ? { ...candidate, status: row.status } : null;
    } catch {
      return null;
    }
  }
}
