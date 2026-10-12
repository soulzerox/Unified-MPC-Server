import type { SqliteDatabase } from './database.js';

/**
 * Exact owner-bound Host Approval capability for one Goal relocation step.
 * Only a trusted host fence may submit one; MCP callers never construct this.
 */
export interface GoalRelocationApprovalRecord {
  readonly approvalId: string;
  readonly goalId: string;
  readonly operationId: string;
  readonly action: 'attest_custody' | 'relocate_goal';
  readonly fromWorkspaceId: string;
  readonly toWorkspaceId: string;
  readonly ownerClientId: string;
  readonly ownerSessionId: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

interface ApprovalRow {
  approval_id: string;
  goal_id: string;
  operation_id: string;
  action: string;
  from_workspace_id: string;
  to_workspace_id: string;
  owner_client_id: string;
  owner_session_id: string;
  issued_at: number;
  expires_at: number;
  admission_generation: number | null;
  lease_generation: number | null;
  consumed_at: number | null;
}

const SELECT_APPROVAL = `
  SELECT approval_id, goal_id, operation_id, action, from_workspace_id, to_workspace_id,
    owner_client_id, owner_session_id, issued_at, expires_at,
    admission_generation, lease_generation, consumed_at
  FROM goal_relocation_approvals WHERE approval_id = ?
`;

function validRecord(record: GoalRelocationApprovalRecord): boolean {
  return record.approvalId.length > 0 && record.approvalId.length <= 128
    && record.goalId.length > 0 && record.goalId.length <= 128
    && record.operationId.length > 0 && record.operationId.length <= 128
    && (record.action === 'attest_custody' || record.action === 'relocate_goal')
    && record.fromWorkspaceId.length > 0 && record.toWorkspaceId.length > 0
    && record.fromWorkspaceId !== record.toWorkspaceId
    && record.ownerClientId.length > 0 && record.ownerClientId.length <= 256
    && record.ownerSessionId.length > 0 && record.ownerSessionId.length <= 256
    && Number.isSafeInteger(record.issuedAt) && record.issuedAt >= 0
    && Number.isSafeInteger(record.expiresAt) && record.expiresAt > record.issuedAt;
}

function sameBinding(row: ApprovalRow, record: GoalRelocationApprovalRecord): boolean {
  return row.goal_id === record.goalId && row.operation_id === record.operationId
    && row.action === record.action && row.from_workspace_id === record.fromWorkspaceId
    && row.to_workspace_id === record.toWorkspaceId
    && row.owner_client_id === record.ownerClientId && row.owner_session_id === record.ownerSessionId;
}

/**
 * Transaction-scoped spend of a capability. Runs on the caller's open
 * transaction so approval consumption and the Goal Workspace CAS either both
 * land or both roll back; a spent capability never outlives the mutation it
 * authorised.
 *
 * Fails closed on unknown, differently-bound, expired, or already consumed
 * approval. The UPDATE's `consumed_at IS NULL` guard is the replay barrier.
 */
export function consumeGoalRelocationApproval(
  conn: SqliteDatabase['connection'],
  record: GoalRelocationApprovalRecord,
  now: number,
  admissionGeneration: number,
  leaseGeneration: number,
): boolean {
  if (!validRecord(record) || !Number.isSafeInteger(now)
    || !Number.isSafeInteger(admissionGeneration) || admissionGeneration < 1
    || !Number.isSafeInteger(leaseGeneration) || leaseGeneration < 1) return false;
  const row = conn.prepare(SELECT_APPROVAL).get(record.approvalId) as ApprovalRow | undefined;
  if (row === undefined || !sameBinding(row, record) || row.consumed_at !== null
    || row.expires_at <= now) return false;
  const consumed = conn.prepare(`
    UPDATE goal_relocation_approvals
    SET consumed_at = ?, admission_generation = ?, lease_generation = ?
    WHERE approval_id = ? AND consumed_at IS NULL
  `).run(now, admissionGeneration, leaseGeneration, record.approvalId);
  return Number(consumed.changes) === 1;
}

/**
 * Durable single-use capability ledger. Recording is idempotent per exact
 * binding so a host retry cannot widen an earlier approval; consumption binds
 * the capability to the live admission generation and lease generation exactly
 * once, so replays and stale bindings fail closed.
 */
export class SqliteGoalRelocationApprovalRepository {
  public constructor(private readonly database: SqliteDatabase) {}

  /** Idempotent per (approvalId, exact binding). Never rewinds a consumed row. */
  public async record(record: GoalRelocationApprovalRecord): Promise<boolean> {
    if (!validRecord(record)) return false;
    const conn = this.database.connection;
    conn.exec('BEGIN IMMEDIATE;');
    try {
      const existing = conn.prepare(SELECT_APPROVAL).get(record.approvalId) as ApprovalRow | undefined;
      if (existing !== undefined) {
        conn.exec('ROLLBACK;');
        return sameBinding(existing, record) && existing.consumed_at === null;
      }
      // An approval may only exist for a real Goal. Checked here so a forged
      // binding fails closed instead of raising a raw constraint error.
      if (conn.prepare('SELECT id FROM goals WHERE id = ?').get(record.goalId) === undefined) {
        conn.exec('ROLLBACK;');
        return false;
      }
      const inserted = conn.prepare(`
        INSERT INTO goal_relocation_approvals (
          approval_id, goal_id, operation_id, action, from_workspace_id, to_workspace_id,
          owner_client_id, owner_session_id, issued_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(record.approvalId, record.goalId, record.operationId, record.action,
        record.fromWorkspaceId, record.toWorkspaceId, record.ownerClientId,
        record.ownerSessionId, record.issuedAt, record.expiresAt);
      if (Number(inserted.changes) !== 1) {
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
   * Standalone spend for callers that own no other mutation. Prefer
   * `consumeGoalRelocationApproval` inside an already open transaction.
   */
  public async consume(record: GoalRelocationApprovalRecord, now: number,
    admissionGeneration: number, leaseGeneration: number): Promise<boolean> {
    if (!Number.isSafeInteger(now)) return false;
    const conn = this.database.connection;
    conn.exec('BEGIN IMMEDIATE;');
    try {
      const ok = consumeGoalRelocationApproval(conn, record, now, admissionGeneration, leaseGeneration);
      conn.exec(ok ? 'COMMIT;' : 'ROLLBACK;');
      return ok;
    } catch (error) {
      conn.exec('ROLLBACK;');
      throw error;
    }
  }

  /** Host-only diagnostic read. Never a grant of authority. */
  public async read(approvalId: string): Promise<(GoalRelocationApprovalRecord & {
    readonly consumedAt: number | null;
    readonly admissionGeneration: number | null;
    readonly leaseGeneration: number | null;
  }) | null> {
    if (typeof approvalId !== 'string' || approvalId.length === 0 || approvalId.length > 128) return null;
    const row = this.database.connection.prepare(SELECT_APPROVAL).get(approvalId) as ApprovalRow | undefined;
    if (row === undefined || (row.action !== 'attest_custody' && row.action !== 'relocate_goal')) return null;
    return {
      approvalId: row.approval_id, goalId: row.goal_id, operationId: row.operation_id,
      action: row.action, fromWorkspaceId: row.from_workspace_id, toWorkspaceId: row.to_workspace_id,
      ownerClientId: row.owner_client_id, ownerSessionId: row.owner_session_id,
      issuedAt: row.issued_at, expiresAt: row.expires_at,
      consumedAt: row.consumed_at, admissionGeneration: row.admission_generation,
      leaseGeneration: row.lease_generation,
    };
  }
}