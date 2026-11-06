import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createPreMigrationBackupSync } from './backup-service.js';
import {
  readSqlitePhysicalMetrics,
  type SqlitePhysicalMetrics,
  type SqlitePhysicalMetricsOptions,
} from './sqlite-physical-metrics.js';

import { AUDIT_MIGRATION_SQL } from './migrations/audit-migration.js';
import { AUDIT_SCOPE_MIGRATION_SQL } from './migrations/audit-scope-migration.js';
import { CHECKPOINT_MIGRATION_SQL } from './migrations/checkpoint-migration.js';
import { GOAL_CONTINUATION_MIGRATION_SQL } from './migrations/goal-continuation-migration.js';
import { GOAL_CANCELLATION_MIGRATION_SQL } from './migrations/goal-cancellation-migration.js';
import { GOAL_TRACKED_TASKS_MIGRATION_SQL } from './migrations/goal-tracked-tasks-migration.js';
import { GOAL_LEASE_REPAIR_MIGRATION_SQL } from './migrations/goal-lease-repair-migration.js';
import { GOAL_LIVE_CONTINUATION_LEASE_QUARANTINE_MIGRATION_SQL } from './migrations/goal-live-continuation-lease-quarantine-migration.js';
import { SCHEDULED_CONTINUATION_MIGRATION_SQL } from './migrations/scheduled-continuation-migration.js';
import { SCHEDULED_CONTINUATION_SESSION_FENCE_MIGRATION_SQL } from './migrations/scheduled-continuation-session-fence-migration.js';
import { SCHEDULED_CONTINUATION_RESCHEDULE_MIGRATION_SQL } from './migrations/scheduled-continuation-reschedule-migration.js';
import { WORKSPACE_ARCHIVE_MIGRATION_SQL } from './migrations/workspace-archive-migration.js';
import { WORKSPACE_LIFECYCLE_MIGRATION_SQL } from './migrations/workspace-lifecycle-migration.js';
import { RETIRE_AUTO_MACHINE_ROOTS_MIGRATION_SQL } from './migrations/retire-auto-machine-roots-migration.js';
import { AGENT_SWARM_MIGRATION_SQL } from './migrations/agent-swarm-migration.js';
import { RECURRING_SCHEDULED_CONTINUATION_MIGRATION_SQL } from './migrations/recurring-scheduled-continuation-migration.js';
import { GOAL_PONYTAIL_MODE_MIGRATION_SQL } from './migrations/goal-ponytail-mode-migration.js';
import { TURN_PERSISTENCE_MIGRATION_SQL } from './migrations/turn_persistence_migration.js';
import { RETIRE_TURN_PERSISTENCE_MIGRATION_SQL } from './migrations/retire_turn_persistence_migration.js';
import { GOAL_EXECUTION_MIGRATION_SQL } from './migrations/goal-execution-migration.js';
import { GOAL_RUNTIME_EVENT_MIGRATION_SQL } from './migrations/goal-runtime-event-migration.js';
import { GOAL_RUNTIME_SNAPSHOT_MIGRATION_SQL } from './migrations/goal-runtime-snapshot-migration.js';
import { MANAGED_RESOURCE_BINDING_MIGRATION_SQL } from './migrations/managed-resource-binding-migration.js';
import { GOAL_RUNTIME_WORKSPACE_OBSERVATION_MIGRATION_SQL } from './migrations/goal-runtime-workspace-observation-migration.js';
import { GOAL_WORKSPACE_METADATA_MIGRATION_SQL } from './migrations/goal-workspace-metadata-migration.js';
import { GOAL_WORKSPACE_WRITER_LEASE_MIGRATION_SQL } from './migrations/goal-workspace-writer-lease-migration.js';
import { WORKSPACE_ADMISSION_MIGRATION_SQL } from './migrations/workspace-admission-migration.js';
import { WORKSPACE_BASE_REF_MIGRATION_SQL } from './migrations/workspace-base-ref-migration.js';
import { WORKSPACE_BASE_REBASE_MIGRATION_SQL } from './migrations/workspace-base-rebase-migration.js';
import { GOAL_RUNTIME_INTEGRATION_OBSERVATION_MIGRATION_SQL } from './migrations/goal-runtime-integration-observation-migration.js';
import { MERGE_VERIFICATION_RECEIPT_MIGRATION_SQL } from './migrations/merge-verification-receipt-migration.js';
import { MERGE_VERIFICATION_ATTEMPT_MIGRATION_SQL } from './migrations/merge-verification-attempt-migration.js';
import { MERGE_VERIFICATION_ATTEMPT_BASE_BRANCH_MIGRATION_SQL } from './migrations/merge-verification-attempt-base-branch-migration.js';
import { MERGE_VERIFICATION_ATTEMPT_QUEUE_MIGRATION_SQL } from './migrations/merge-verification-attempt-queue-migration.js';
import { MERGE_RECONCILIATION_MIGRATION_SQL } from './migrations/merge-reconciliation-migration.js';
import { GOAL_WORKSPACE_TRANSFER_INTENT_MIGRATION_SQL } from './migrations/goal-workspace-transfer-intent-migration.js';
import { GOAL_WORKSPACE_RETENTION_CUSTODY_MIGRATION_SQL } from './migrations/goal-workspace-retention-custody-migration.js';
import { GOAL_WORKSPACE_RETENTION_EVIDENCE_MIGRATION_SQL } from './migrations/goal-workspace-retention-evidence-migration.js';
import { WORKSPACE_AUTHORITY_EPOCH_MIGRATION_SQL } from './migrations/workspace-authority-epoch-migration.js';
import { GOAL_RELOCATION_APPROVAL_MIGRATION_SQL } from './migrations/goal-relocation-approval-migration.js';
import { WORKSPACE_ADMISSION_AUTHORITY_MIGRATION_SQL } from './migrations/workspace-admission-authority-migration.js';
import { HEAVY_JOB_QUEUE_MIGRATION_SQL } from './migrations/heavy-job-queue-migration.js';
import { PUBLISH_APPROVAL_MIGRATION_SQL } from './migrations/publish-approval-migration.js';
import { PUBLISH_CREDENTIAL_MIGRATION_SQL } from './migrations/publish-credential-migration.js';
import { PUBLISH_APPROVAL_FINGERPRINT_MIGRATION_SQL } from './migrations/publish-approval-fingerprint-migration.js';

export type SqliteCompactionResult =
  | {
    readonly status: 'compacted';
    readonly beforeBytes: number;
    readonly afterBytes: number;
    readonly reclaimedBytes: number;
    readonly beforeFreelistBytes: number;
    readonly afterFreelistBytes: number;
    /** A reader blocked the final WAL truncate; reclamation may be partial. */
    readonly checkpointBusy: boolean;
    readonly checkpointTruncated: boolean;
    readonly walBytesAfter: number;
  }
  | {
    readonly status: 'skipped';
    readonly reason: 'reader-pressure';
    readonly detail: string;
  };

/**
 * SQLITE_BUSY / SQLITE_LOCKED, including the message-only shape some
 * `node:sqlite` builds and wrapped errors expose.
 */
function isSqliteBusyError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const errcode = (error as { errcode?: unknown }).errcode;
  if (errcode === 5 || errcode === 6) return true;
  const message = error.message.toLowerCase();
  return message.includes('database is locked')
    || message.includes('database table is locked')
    || message.includes('database schema is locked')
    || message.includes('sqlite_busy')
    || message.includes('sqlite_locked');
}

export interface SqliteDatabaseOptions {
  readonly backupDirectory?: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
}

export interface Migration {
  readonly id: string;
  readonly sql: string;
  /**
   * Compact the database after the migration commits. A table-rebuild migration
   * frees the old table's pages into the freelist, and a freshly created database
   * would otherwise open with dead pages that the physical-space metrics report as
   * reclaimable. `VACUUM` cannot run inside the migration transaction, so it runs
   * once, right after the commit.
   */
  readonly reclaimFreePages?: boolean;
}

/**
 * Canonical highest migration applied by a freshly opened database.
 *
 * Tests that assert storage diagnostics should reference this constant rather
 * than duplicating a migration literal. Adding a newer migration without
 * advancing this value intentionally keeps those tests red.
 */
export const CURRENT_SCHEMA_MIGRATION_ID = '045_retire_turn_persistence' as const;

export const INITIAL_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY NOT NULL,
  display_name TEXT NOT NULL,
  root_path TEXT NOT NULL UNIQUE,
  real_root_path TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);
`;

export class SqliteDatabase {
  private _connection: DatabaseSync;
  private readonly existedBeforeOpen: boolean;
  private preMigrationBackupCreated = false;
  private isClosed = false;

  public constructor(private readonly filename: string, private readonly options: SqliteDatabaseOptions = {}) {
    this.ensureDirectory();
    this.existedBeforeOpen = existsSync(filename);
    this._connection = this.createConnection();
    this.initPragmas(this._connection);
    this._connection.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY NOT NULL);');
    this.applyMigration({ id: '001_initial', sql: INITIAL_MIGRATION_SQL });
    this.applyMigration({ id: '002_audit', sql: AUDIT_MIGRATION_SQL });
    this.applyMigration({ id: '003_checkpoints', sql: CHECKPOINT_MIGRATION_SQL });
    this.applyMigration({ id: '004_audit_scope', sql: AUDIT_SCOPE_MIGRATION_SQL });
    this.applyMigration({ id: '005_workspace_archive', sql: WORKSPACE_ARCHIVE_MIGRATION_SQL });
    this.applyMigration({ id: '006_goal_continuation', sql: GOAL_CONTINUATION_MIGRATION_SQL });
    this.applyMigration({ id: '007_scheduled_continuations', sql: SCHEDULED_CONTINUATION_MIGRATION_SQL });
    this.applyMigration({ id: '008_scheduled_continuation_session_fence', sql: SCHEDULED_CONTINUATION_SESSION_FENCE_MIGRATION_SQL });
    this.applyMigration({ id: '009_scheduled_continuation_same_task_reschedule', sql: SCHEDULED_CONTINUATION_RESCHEDULE_MIGRATION_SQL });
    this.applyMigration({ id: '010_goal_lease_repair', sql: GOAL_LEASE_REPAIR_MIGRATION_SQL });
    this.applyMigration({ id: '011_goal_live_continuation_lease_quarantine', sql: GOAL_LIVE_CONTINUATION_LEASE_QUARANTINE_MIGRATION_SQL });
    this.applyMigration({ id: '012_retire_auto_machine_roots', sql: RETIRE_AUTO_MACHINE_ROOTS_MIGRATION_SQL });
    this.applyMigration({ id: '013_goal_cancellation', sql: GOAL_CANCELLATION_MIGRATION_SQL });
    this.applyMigration({ id: '014_goal_tracked_tasks', sql: GOAL_TRACKED_TASKS_MIGRATION_SQL });
    this.applyMigration({ id: '015_agent_swarm', sql: AGENT_SWARM_MIGRATION_SQL });
    this.applyMigration({ id: '016_recurring_scheduled_continuation', sql: RECURRING_SCHEDULED_CONTINUATION_MIGRATION_SQL });
    this.applyMigration({ id: '017_goal_ponytail_mode', sql: GOAL_PONYTAIL_MODE_MIGRATION_SQL });
    this.applyMigration({ id: '018_turn_persistence', sql: TURN_PERSISTENCE_MIGRATION_SQL });
    this.applyMigration({ id: '018_goal_executions', sql: GOAL_EXECUTION_MIGRATION_SQL });
    this.applyMigration({ id: '019_goal_runtime_events', sql: GOAL_RUNTIME_EVENT_MIGRATION_SQL });
    this.applyMigration({ id: '020_goal_runtime_snapshots', sql: GOAL_RUNTIME_SNAPSHOT_MIGRATION_SQL });
    this.applyMigration({ id: '021_managed_resource_bindings', sql: MANAGED_RESOURCE_BINDING_MIGRATION_SQL });
    this.applyMigration({ id: '022_goal_runtime_workspace_observations', sql: GOAL_RUNTIME_WORKSPACE_OBSERVATION_MIGRATION_SQL });
    this.applyMigration({ id: '023_workspace_lifecycle', sql: WORKSPACE_LIFECYCLE_MIGRATION_SQL });
    this.applyMigration({ id: '024_goal_workspace_metadata', sql: GOAL_WORKSPACE_METADATA_MIGRATION_SQL });
    this.applyMigration({ id: '025_goal_workspace_writer_lease', sql: GOAL_WORKSPACE_WRITER_LEASE_MIGRATION_SQL });
    this.applyMigration({ id: '026_workspace_admission', sql: WORKSPACE_ADMISSION_MIGRATION_SQL });
    this.applyMigration({ id: '027_workspace_base_ref', sql: WORKSPACE_BASE_REF_MIGRATION_SQL });
    this.applyMigration({ id: '028_workspace_base_rebase', sql: WORKSPACE_BASE_REBASE_MIGRATION_SQL });
    this.applyMigration({ id: '029_goal_runtime_integration_observations', sql: GOAL_RUNTIME_INTEGRATION_OBSERVATION_MIGRATION_SQL });
    this.applyMigration({ id: '030_merge_verification_receipts', sql: MERGE_VERIFICATION_RECEIPT_MIGRATION_SQL });
    this.applyMigration({ id: '031_merge_reconciliation_records', sql: MERGE_RECONCILIATION_MIGRATION_SQL });
    this.applyMigration({ id: '032_goal_workspace_transfer_intents', sql: GOAL_WORKSPACE_TRANSFER_INTENT_MIGRATION_SQL });
    this.applyMigration({ id: '033_goal_workspace_retention_custody', sql: GOAL_WORKSPACE_RETENTION_CUSTODY_MIGRATION_SQL });
    this.applyMigration({ id: '034_goal_workspace_retention_evidence', sql: GOAL_WORKSPACE_RETENTION_EVIDENCE_MIGRATION_SQL });
    this.applyMigration({ id: '035_workspace_authority_epoch', sql: WORKSPACE_AUTHORITY_EPOCH_MIGRATION_SQL });
    this.applyMigration({ id: '036_workspace_admission_authority', sql: WORKSPACE_ADMISSION_AUTHORITY_MIGRATION_SQL });
    this.applyMigration({ id: '037_goal_relocation_approvals', sql: GOAL_RELOCATION_APPROVAL_MIGRATION_SQL });
    this.applyMigration({ id: '038_merge_verification_attempts', sql: MERGE_VERIFICATION_ATTEMPT_MIGRATION_SQL });
    this.applyMigration({ id: '039_merge_verification_attempt_base_branch', sql: MERGE_VERIFICATION_ATTEMPT_BASE_BRANCH_MIGRATION_SQL });
    this.applyMigration({ id: '040_heavy_job_queue', sql: HEAVY_JOB_QUEUE_MIGRATION_SQL });
    this.applyMigration({
      id: '041_merge_verification_attempt_queue',
      sql: MERGE_VERIFICATION_ATTEMPT_QUEUE_MIGRATION_SQL,
      reclaimFreePages: true,
    });
    this.applyMigration({ id: '042_publish_approvals', sql: PUBLISH_APPROVAL_MIGRATION_SQL });
    this.applyMigration({ id: '043_publish_credential_leases', sql: PUBLISH_CREDENTIAL_MIGRATION_SQL });
    this.applyMigration({ id: '044_publish_approval_fingerprint', sql: PUBLISH_APPROVAL_FINGERPRINT_MIGRATION_SQL });
    this.applyMigration({
      id: CURRENT_SCHEMA_MIGRATION_ID,
      sql: RETIRE_TURN_PERSISTENCE_MIGRATION_SQL,
      reclaimFreePages: true,
    });
  }

  private ensureDirectory(): void {
    if (this.filename !== ':memory:') {
      mkdirSync(path.dirname(this.filename), { recursive: true });
    }
  }

  private createConnection(): DatabaseSync {
    this.ensureDirectory();
    return new DatabaseSync(this.filename, { timeout: 5_000 });
  }

  private initPragmas(conn: DatabaseSync): void {
    conn.exec('PRAGMA journal_mode = WAL;');
    conn.exec('PRAGMA busy_timeout = 5000;');
    conn.exec('PRAGMA foreign_keys = ON;');
  }

  public get connection(): DatabaseSync {
    if (this.isClosed) throw new Error('SqliteDatabase is closed');
    return this._connection;
  }

  public applyMigration(migration: Migration): void {
    const existing = this.connection.prepare('SELECT id FROM schema_migrations WHERE id = ?').get(migration.id);
    if (this.hasMigrationId(existing, migration.id)) return;
    this.backupBeforeFirstPendingMigration();

    this.connection.exec('BEGIN;');
    try {
      this.connection.exec(migration.sql);
      this.connection.prepare('INSERT INTO schema_migrations (id) VALUES (?)').run(migration.id);
      this.connection.exec('COMMIT;');
    } catch (error) {
      this.connection.exec('ROLLBACK;');
      throw error;
    }

    if (migration.reclaimFreePages === true) this.connection.exec('VACUUM;');
  }

  private backupBeforeFirstPendingMigration(): void {
    if (this.preMigrationBackupCreated || !this.existedBeforeOpen || this.options.backupDirectory === undefined) return;
    createPreMigrationBackupSync(this.connection, this.options.backupDirectory, this.options.platform, this.options.arch);
    this.preMigrationBackupCreated = true;
  }

  public close(): void {
    if (!this.isClosed) {
      this.isClosed = true;
      try {
        this._connection.close();
      } catch {
        // Ignored if already closed
      }
    }
  }

  public physicalMetrics(options?: SqlitePhysicalMetricsOptions): SqlitePhysicalMetrics {
    return readSqlitePhysicalMetrics(this.connection, this.filename, options);
  }

  /**
   * Physically compact the database after logical GC (#210 §2-§3).
   *
   * `VACUUM` rebuilds the file but writes the result through the WAL, so the
   * main file can stay at its old size until the WAL is checkpointed.
   * `wal_checkpoint(TRUNCATE)` copies those frames back and reclaims WAL space;
   * a reader can block the truncate, and that is reported instead of claiming
   * unproven reclamation. A busy `VACUUM` is a reader-pressure skip; every
   * other error is a real failure.
   *
   * This is the physical half only: the caller must hold the existing
   * single-owner fence and have measured pressure before calling it.
   */
  public compact(): SqliteCompactionResult {
    const before = readSqlitePhysicalMetrics(this.connection, this.filename, { checkpointMode: 'none' });
    try {
      this.connection.exec('VACUUM;');
    } catch (error) {
      if (isSqliteBusyError(error)) {
        return {
          status: 'skipped',
          reason: 'reader-pressure',
          detail: error instanceof Error ? error.message : String(error),
        };
      }
      throw error;
    }

    let checkpointBusy = false;
    try {
      const row = this.connection.prepare('PRAGMA wal_checkpoint(TRUNCATE);').get() as Record<string, unknown> | undefined;
      checkpointBusy = Number(row?.busy) === 1;
    } catch (error) {
      if (!isSqliteBusyError(error)) throw error;
      checkpointBusy = true;
    }

    const after = readSqlitePhysicalMetrics(this.connection, this.filename, { checkpointMode: 'none' });
    return {
      status: 'compacted',
      beforeBytes: before.databaseBytes,
      afterBytes: after.databaseBytes,
      reclaimedBytes: Math.max(0, before.databaseBytes - after.databaseBytes),
      beforeFreelistBytes: before.freelistBytes,
      afterFreelistBytes: after.freelistBytes,
      checkpointBusy,
      checkpointTruncated: !checkpointBusy,
      walBytesAfter: after.walBytes,
    };
  }

  private hasMigrationId(value: unknown, expectedId: string): boolean {
    if (typeof value !== 'object' || value === null || !('id' in value)) return false;
    const id = value.id;
    return typeof id === 'string' && id === expectedId;
  }
}
