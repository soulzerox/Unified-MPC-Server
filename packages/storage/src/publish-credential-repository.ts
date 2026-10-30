import {
  appError,
  err,
  isPublishCredentialLeaseId,
  isValidPublishCredentialLease,
  isPublishCredentialSecret,
  isPublishCredentialTimestamp,
  ok,
  type AppError,
  type PublishCredentialLease,
  type PublishCredentialMaterial,
  type PublishCredentialPort,
  type Result,
} from '@unified-mpc/domain';
import type { SqliteDatabase } from './database.js';
import type { SecretStore } from './secret-store.js';

/** SecretStore key prefix; the lease id is charset-safe on its own. */
const SECRET_KEY_PREFIX = 'publish-';

interface CredentialRow {
  lease_id: string;
  workspace_id: string;
  remote: string;
  hosts: string;
  username: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
}

const SELECT_CREDENTIAL = `
  SELECT lease_id, workspace_id, remote, hosts, username, created_at, expires_at, revoked_at
  FROM publish_credential_leases WHERE lease_id = ?
`;

const SELECT_LIVE_CREDENTIAL = `
  SELECT lease_id, workspace_id, remote, hosts, username, created_at, expires_at, revoked_at
  FROM publish_credential_leases
  WHERE lease_id = ? AND revoked_at IS NULL AND expires_at > ?
`;

export interface PublishCredentialRepositoryOptions {
  readonly database: SqliteDatabase;
  readonly secretStore: SecretStore;
}

/** Metadata-only read used by the status command; never carries the secret. */
export interface PublishCredentialInspection {
  readonly lease: PublishCredentialLease;
  readonly revokedAt: number | null;
}

/**
 * Host-owned credential leases backed by the publish ledger and the existing
 * `SecretStore` (#297). The ledger row and the secret are two stores, so grant
 * writes the secret first and deletes it again if the row write fails: a
 * failure never leaves a secret without a row that can revoke or sweep it.
 * Every answer fails closed, and no method returns a secret for an unknown,
 * revoked or expired lease.
 */
export class SqlitePublishCredentialRepository implements PublishCredentialPort {
  public constructor(private readonly options: PublishCredentialRepositoryOptions) {}

  public async grant(lease: PublishCredentialLease, secret: string): Promise<Result<void>> {
    if (!isValidPublishCredentialLease(lease)) {
      return err(invalidLease('The publish credential lease is invalid'));
    }
    if (!isPublishCredentialSecret(secret)) {
      return err(invalidLease('The publish credential secret is invalid'));
    }
    const conn = this.options.database.connection;
    try {
      const existing = conn.prepare('SELECT lease_id FROM publish_credential_leases WHERE lease_id = ?')
        .get(lease.leaseId);
      if (existing !== undefined) return err(leaseConflict());
    } catch {
      return err(ledgerUnavailable());
    }

    try {
      await this.options.secretStore.set(secretKey(lease.leaseId), secret);
    } catch {
      return err(secretServiceUnavailable());
    }

    try {
      conn.prepare(`
        INSERT INTO publish_credential_leases (
          lease_id, workspace_id, remote, hosts, username, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        lease.leaseId,
        lease.workspaceId,
        lease.remote,
        JSON.stringify(lease.hosts),
        lease.username,
        lease.createdAt,
        lease.expiresAt,
      );
      return ok(undefined);
    } catch {
      await this.deleteSecret(lease.leaseId);
      return err(ledgerUnavailable());
    }
  }

  /** Returns material only for a live lease; expired rows and revoked rows answer null. */
  public async open(leaseId: string, now: number): Promise<Result<PublishCredentialMaterial | null>> {
    if (!isPublishCredentialLeaseId(leaseId) || !isPublishCredentialTimestamp(now)) {
      return err(invalidLease('The publish credential lease id is invalid'));
    }
    let row: CredentialRow | undefined;
    try {
      row = this.options.database.connection.prepare(SELECT_LIVE_CREDENTIAL).get(leaseId, now) as CredentialRow | undefined;
    } catch {
      return err(ledgerUnavailable());
    }
    if (row === undefined) return ok(null);

    let secret: string | null;
    try {
      secret = await this.options.secretStore.get(secretKey(leaseId));
    } catch {
      return err(secretServiceUnavailable());
    }
    if (secret === null || secret.length === 0) return ok(null);

    const lease = rowToLease(row);
    if (!isValidPublishCredentialLease(lease) || lease.expiresAt <= now) return ok(null);
    return ok({ lease, secret });
  }

  /** Deletes the secret first, then tombstones the row. Safe to call twice. */
  public async revoke(leaseId: string, now: number): Promise<Result<void>> {
    if (!isPublishCredentialLeaseId(leaseId) || !isPublishCredentialTimestamp(now)) {
      return err(invalidLease('The publish credential lease id is invalid'));
    }
    try {
      await this.options.secretStore.delete(secretKey(leaseId));
    } catch {
      return err(secretServiceUnavailable());
    }
    try {
      this.options.database.connection.prepare(`
        UPDATE publish_credential_leases SET revoked_at = COALESCE(revoked_at, ?) WHERE lease_id = ?
      `).run(now, leaseId);
    } catch {
      return err(ledgerUnavailable());
    }
    return ok(undefined);
  }

  /**
   * Deletes the secret and prunes the row for every lease whose expiry has
   * passed. A row whose secret cannot be deleted is kept so the next sweep can
   * retry instead of leaving an unreachable secret behind.
   */
  public async sweepExpired(now: number): Promise<number> {
    if (!isPublishCredentialTimestamp(now)) return 0;
    let rows: Array<Pick<CredentialRow, 'lease_id'>>;
    try {
      rows = this.options.database.connection.prepare(
        'SELECT lease_id FROM publish_credential_leases WHERE expires_at <= ?',
      ).all(now) as Array<Pick<CredentialRow, 'lease_id'>>;
    } catch {
      return 0;
    }
    let swept = 0;
    for (const row of rows) {
      try {
        await this.options.secretStore.delete(secretKey(row.lease_id));
      } catch {
        continue;
      }
      try {
        this.options.database.connection.prepare(
          'DELETE FROM publish_credential_leases WHERE lease_id = ? AND expires_at <= ?',
        ).run(row.lease_id, now);
        swept += 1;
      } catch {
        continue;
      }
    }
    return swept;
  }

  /** Metadata-only lifecycle read for `status`; never opens or returns the secret. */
  public async inspect(leaseId: string): Promise<Result<PublishCredentialInspection | null>> {
    if (!isPublishCredentialLeaseId(leaseId)) {
      return err(invalidLease('The publish credential lease id is invalid'));
    }
    let row: CredentialRow | undefined;
    try {
      row = this.options.database.connection.prepare(SELECT_CREDENTIAL).get(leaseId) as CredentialRow | undefined;
    } catch {
      return err(ledgerUnavailable());
    }
    if (row === undefined) return ok(null);
    const lease = rowToLease(row);
    return ok(isValidPublishCredentialLease(lease) ? { lease, revokedAt: row.revoked_at } : null);
  }

  private async deleteSecret(leaseId: string): Promise<void> {
    try {
      await this.options.secretStore.delete(secretKey(leaseId));
    } catch {
      // The row write failed and the secret must not outlive the attempt. A
      // failed delete is swept later from the ledger row; never mask the
      // original failure with a second error.
    }
  }
}

function secretKey(leaseId: string): string {
  return `${SECRET_KEY_PREFIX}${leaseId}`;
}

function rowToLease(row: CredentialRow): PublishCredentialLease {
  return {
    leaseId: row.lease_id,
    workspaceId: row.workspace_id,
    remote: row.remote,
    hosts: parseHosts(row.hosts),
    username: row.username,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

function parseHosts(value: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((host): host is string => typeof host === 'string') ? parsed : [];
  } catch {
    return [];
  }
}

function invalidLease(message: string): AppError {
  return appError('INVALID_INPUT', message, false, { reason: 'publish-credential-invalid' });
}

function leaseConflict(): AppError {
  return appError('CONFLICT', 'A publish credential lease with this id already exists', false, {
    reason: 'publish-credential-conflict',
  });
}

function secretServiceUnavailable(): AppError {
  return appError('SECRET_ACCESS_DENIED', 'Linux Secret Service is unavailable', true, {
    reason: 'publish-credential-unavailable',
  });
}

function ledgerUnavailable(): AppError {
  return appError('INTERNAL_ERROR', 'The publish credential ledger is unavailable', true, {
    reason: 'publish-credential-store-unavailable',
  });
}
