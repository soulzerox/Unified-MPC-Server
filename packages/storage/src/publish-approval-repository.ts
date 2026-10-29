import type { PublishApprovalBinding, PublishApprovalLookupPort, PublishApprovalState } from '@unified-mpc/domain';
import type { SqliteDatabase } from './database.js';

/**
 * One host-issued publish capability (issue #297). Bound to a single workspace,
 * remote, branch and exact commit; only the trusted host approval surface may
 * construct one, and MCP callers never do.
 */
export interface PublishApprovalRecord {
  readonly approvalId: string;
  readonly workspaceId: string;
  readonly remote: string;
  readonly branch: string;
  readonly expectedSha: string;
  readonly approvedBy: string;
  readonly approvedAt: number;
  readonly expiresAt: number;
}

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
}

const SELECT_APPROVAL = `
  SELECT approval_id, workspace_id, remote, branch, expected_sha, approved_by,
    approved_at, expires_at, consumed_at
  FROM publish_approvals WHERE approval_id = ?
`;

/** Same shape the Git adapter accepts for a remote name; no URL or option form. */
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;

function bounded(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

/** ASCII control characters, space, and DEL are never part of a branch name. */
function hasControlOrSpace(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * The receipt store refuses refs that cannot be a plain branch name so a stored
 * capability never carries whitespace, a traversal segment, or an option form.
 * The publish path revalidates against the live remote before it spawns Git.
 */
function validBranch(branch: unknown): branch is string {
  return bounded(branch, 256)
    && !hasControlOrSpace(branch)
    && !branch.includes('..')
    && !branch.startsWith('-')
    && !branch.endsWith('/')
    && !branch.endsWith('.lock');
}

function validRecord(record: PublishApprovalRecord): boolean {
  return bounded(record.approvalId, 128)
    && bounded(record.workspaceId, 128)
    && typeof record.remote === 'string' && REMOTE_NAME.test(record.remote)
    && validBranch(record.branch)
    && OBJECT_ID.test(record.expectedSha)
    && bounded(record.approvedBy, 256)
    && Number.isSafeInteger(record.approvedAt) && record.approvedAt >= 0
    && Number.isSafeInteger(record.expiresAt) && record.expiresAt > record.approvedAt;
}

function sameBinding(row: ApprovalRow, record: PublishApprovalRecord): boolean {
  return row.workspace_id === record.workspaceId
    && row.remote === record.remote
    && row.branch === record.branch
    && row.expected_sha === record.expectedSha;
}

/**
 * Transaction-scoped spend of one capability. Runs on the caller's open
 * transaction so consumption and the authorized publish either both land or
 * both roll back; a spent capability never outlives the publish it authorized.
 *
 * Fails closed on an unknown, differently-bound, expired, or already consumed
 * approval. The `consumed_at IS NULL` guard is the replay barrier.
 */
export function consumePublishApproval(
  conn: SqliteDatabase['connection'],
  record: PublishApprovalRecord,
  now: number,
): boolean {
  if (!validRecord(record) || !Number.isSafeInteger(now) || now < 0) return false;
  const row = conn.prepare(SELECT_APPROVAL).get(record.approvalId) as ApprovalRow | undefined;
  if (row === undefined || !sameBinding(row, record) || row.consumed_at !== null
    || row.expires_at <= now) return false;
  const consumed = conn.prepare(`
    UPDATE publish_approvals
    SET consumed_at = ?
    WHERE approval_id = ? AND consumed_at IS NULL
  `).run(now, record.approvalId);
  return Number(consumed.changes) === 1;
}

/**
 * Durable single-use approval ledger. Recording is idempotent per exact binding
 * so a host retry cannot widen an earlier approval; consumption binds the
 * capability to one publish and nothing can rewind it afterwards.
 */
export class SqlitePublishApprovalRepository implements PublishApprovalLookupPort {
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
          approved_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(record.approvalId, record.workspaceId, record.remote, record.branch,
        record.expectedSha, record.approvedBy, record.approvedAt, record.expiresAt);
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
  public async consume(record: PublishApprovalRecord, now: number): Promise<boolean> {
    if (!Number.isSafeInteger(now) || now < 0) return false;
    const conn = this.database.connection;
    conn.exec('BEGIN IMMEDIATE;');
    try {
      const ok = consumePublishApproval(conn, record, now);
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
  return bounded(binding.workspaceId, 128)
    && typeof binding.remote === 'string' && REMOTE_NAME.test(binding.remote)
    && validBranch(binding.branch)
    && OBJECT_ID.test(binding.expectedSha);
}
