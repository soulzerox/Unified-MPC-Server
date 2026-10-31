import {
  isPublishCredentialHostFingerprint,
  isPublishCredentialLeaseId,
  isValidPublishBinding,
  type PublishApprovalAuthorityPort,
  type PublishApprovalBinding,
  type PublishApprovalLookupPort,
  type PublishApprovalRecord,
  type PublishApprovalState,
} from '@unified-mpc/domain';
import type { SqliteDatabase } from './database.js';

// The record type lives in the domain so the application layer can mint and
// spend without importing storage; re-exported here for existing callers.
export type { PublishApprovalRecord };

interface ApprovalRow {
  approval_id: string;
  workspace_id: string;
  remote: string;
  branch: string;
  expected_sha: string;
  approved_by: string;
  approved_at: number;
  expires_at: number;
  consumed_at: number | null;
  push_url_fingerprint: string | null;
  lease_id: string | null;
}

const SELECT_APPROVAL = `
  SELECT approval_id, workspace_id, remote, branch, expected_sha, approved_by,
    approved_at, expires_at, consumed_at, push_url_fingerprint, lease_id
  FROM publish_approvals WHERE approval_id = ?
`;

function bounded(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

/**
 * The receipt store refuses refs that cannot be a plain branch name so a stored
 * capability never carries whitespace, a traversal segment, or an option form.
 * The publish path revalidates against the live remote before it spawns Git.
 */
function validRecord(record: PublishApprovalRecord): boolean {
  if (!(bounded(record.approvalId, 128)
    && isValidPublishBinding(record)
    && bounded(record.approvedBy, 256)
    && Number.isSafeInteger(record.approvedAt) && record.approvedAt >= 0
    && Number.isSafeInteger(record.expiresAt) && record.expiresAt > record.approvedAt)) return false;
  // A credential binding is all-or-nothing: a receipt that names a host set
  // without the lease that answers for it (or the reverse) can never be spent.
  const fingerprint = record.pushUrlFingerprint;
  const leaseId = record.leaseId;
  if (fingerprint === undefined && leaseId === undefined) return true;
  return isPublishCredentialHostFingerprint(fingerprint) && isPublishCredentialLeaseId(leaseId);
}

function sameBinding(row: ApprovalRow, record: PublishApprovalRecord): boolean {
  return row.workspace_id === record.workspaceId
    && row.remote === record.remote
    && row.branch === record.branch
    && row.expected_sha === record.expectedSha;
}

function sameApprovalBinding(row: ApprovalRow, binding: PublishApprovalBinding): boolean {
  return row.workspace_id === binding.workspaceId
    && row.remote === binding.remote
    && row.branch === binding.branch
    && row.expected_sha === binding.expectedSha;
}

/**
 * Transaction-scoped spend of one capability. The caller may run it inside its
 * own open transaction; the repository's standalone `consume` wraps it in
 * `BEGIN IMMEDIATE` and commits before the publish spawns Git. Spending is
 * therefore durable first and fail-closed: a push that fails afterwards leaves
 * the receipt consumed, and replaying it is impossible.
 *
 * The caller supplies only the approval id and the binding it intends to
 * publish, never the row's timestamps or approver. Fails closed on an unknown,
 * differently-bound, expired, or already consumed approval. The
 * `consumed_at IS NULL` guard is the replay barrier.
 */
export function consumePublishApproval(
  conn: SqliteDatabase['connection'],
  approvalId: string,
  binding: PublishApprovalBinding,
  now: number,
): boolean {
  if (!bounded(approvalId, 128) || !isValidPublishBinding(binding)
    || !Number.isSafeInteger(now) || now < 0) return false;
  const row = conn.prepare(SELECT_APPROVAL).get(approvalId) as ApprovalRow | undefined;
  if (row === undefined || !sameApprovalBinding(row, binding) || row.consumed_at !== null
    || row.expires_at <= now) return false;
  const consumed = conn.prepare(`
    UPDATE publish_approvals
    SET consumed_at = ?
    WHERE approval_id = ? AND consumed_at IS NULL
  `).run(now, approvalId);
  return Number(consumed.changes) === 1;
}

/**
 * Durable single-use approval ledger. Recording is idempotent per exact binding
 * so a host retry cannot widen an earlier approval; consumption binds the
 * capability to one publish and nothing can rewind it afterwards.
 */
export class SqlitePublishApprovalRepository implements PublishApprovalLookupPort, PublishApprovalAuthorityPort {
  public constructor(private readonly database: SqliteDatabase) {}

  /** Idempotent per (approvalId, exact binding). Never rewinds a consumed row. */
  public async record(record: PublishApprovalRecord): Promise<boolean> {
    if (!validRecord(record)) return false;
    const conn = this.database.connection;
    conn.exec('BEGIN IMMEDIATE;');
    try {
      const existing = conn.prepare(SELECT_APPROVAL).get(record.approvalId) as ApprovalRow | undefined;
      if (existing !== undefined) {
        conn.exec('ROLLBACK;');
        return sameBinding(existing, record) && existing.consumed_at === null;
      }
      // A capability may only exist for a real workspace. Checked here so a
      // forged binding fails closed instead of raising a raw constraint error.
      if (conn.prepare('SELECT id FROM workspaces WHERE id = ?').get(record.workspaceId) === undefined) {
        conn.exec('ROLLBACK;');
        return false;
      }
      const inserted = conn.prepare(`
        INSERT INTO publish_approvals (
          approval_id, workspace_id, remote, branch, expected_sha, approved_by,
          approved_at, expires_at, push_url_fingerprint, lease_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(record.approvalId, record.workspaceId, record.remote, record.branch,
        record.expectedSha, record.approvedBy, record.approvedAt, record.expiresAt,
        record.pushUrlFingerprint ?? null, record.leaseId ?? null);
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
   * `consumePublishApproval` inside an already open transaction.
   */
  public async consume(approvalId: string, binding: PublishApprovalBinding, now: number): Promise<boolean> {
    if (!Number.isSafeInteger(now) || now < 0) return false;
    const conn = this.database.connection;
    conn.exec('BEGIN IMMEDIATE;');
    try {
      const ok = consumePublishApproval(conn, approvalId, binding, now);
      conn.exec(ok ? 'COMMIT;' : 'ROLLBACK;');
      return ok;
    } catch (error) {
      conn.exec('ROLLBACK;');
      throw error;
    }
  }

  /** Host-only diagnostic read. Never a grant of authority. */
  public async read(approvalId: string): Promise<(PublishApprovalRecord & {
    readonly consumedAt: number | null;
  }) | null> {
    if (typeof approvalId !== 'string' || approvalId.length === 0 || approvalId.length > 128) return null;
    const row = this.database.connection.prepare(SELECT_APPROVAL).get(approvalId) as ApprovalRow | undefined;
    if (row === undefined) return null;
    return {
      approvalId: row.approval_id, workspaceId: row.workspace_id, remote: row.remote,
      branch: row.branch, expectedSha: row.expected_sha, approvedBy: row.approved_by,
      approvedAt: row.approved_at, expiresAt: row.expires_at, consumedAt: row.consumed_at,
      ...(row.push_url_fingerprint === null || row.lease_id === null ? {} : {
        pushUrlFingerprint: row.push_url_fingerprint,
        leaseId: row.lease_id,
      }),
    };
  }

  /**
   * Read-only lifecycle of the exact binding for a preflight answer. Never
   * authority: the publish path must still spend a receipt in its own
   * transaction. A malformed binding or clock fails closed to `missing`, and a
   * live receipt is preferred over an expired or consumed one so a re-approval
   * is visible immediately.
   */
  public async inspect(binding: PublishApprovalBinding, now: number): Promise<PublishApprovalState> {
    if (!validBinding(binding) || !Number.isSafeInteger(now) || now < 0) return 'missing';
    const rows = this.database.connection.prepare(`
      SELECT expires_at, consumed_at
      FROM publish_approvals
      WHERE workspace_id = ? AND remote = ? AND branch = ? AND expected_sha = ?
      ORDER BY approved_at DESC, approval_id DESC
    `).all(binding.workspaceId, binding.remote, binding.branch, binding.expectedSha) as Array<{
      expires_at: number;
      consumed_at: number | null;
    }>;
    if (rows.length === 0) return 'missing';
    if (rows.some((row) => row.consumed_at === null && row.expires_at > now)) return 'pending';
    if (rows.some((row) => row.consumed_at === null)) return 'expired';
    return 'consumed';
  }
}

function validBinding(binding: PublishApprovalBinding): boolean {
  return isValidPublishBinding(binding);
}
