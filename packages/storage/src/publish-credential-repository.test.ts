import { describe, expect, it } from 'vitest';
import type { PublishCredentialLease } from '@unified-mpc/domain';
import { SqliteDatabase } from './database.js';
import { SqlitePublishCredentialRepository } from './publish-credential-repository.js';
import type { SecretStore } from './secret-store.js';

const NOW = 1_780_000_000_000;
const SECRET = 'super-secret-token-value';

class FakeSecretStore implements SecretStore {
  public readonly values = new Map<string, string>();
  public failSet = false;
  public failDelete = false;

  public async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  public async set(key: string, value: string): Promise<void> {
    if (this.failSet) throw new Error('Secret Service unavailable');
    this.values.set(key, value);
  }

  public async delete(key: string): Promise<void> {
    if (this.failDelete) throw new Error('Secret Service unavailable');
    this.values.delete(key);
  }
}

function lease(overrides: Partial<PublishCredentialLease> = {}): PublishCredentialLease {
  return {
    leaseId: 'lease-1',
    workspaceId: 'workspace-1',
    remote: 'origin',
    hosts: ['github.com'],
    username: 'git',
    createdAt: NOW,
    expiresAt: NOW + 15 * 60_000,
    ...overrides,
  };
}

function setup(): {
  database: SqliteDatabase;
  store: FakeSecretStore;
  repository: SqlitePublishCredentialRepository;
} {
  const database = new SqliteDatabase(':memory:');
  const store = new FakeSecretStore();
  return {
    database,
    store,
    repository: new SqlitePublishCredentialRepository({ database, secretStore: store }),
  };
}

function ledgerRows(database: SqliteDatabase): readonly unknown[] {
  return database.connection.prepare('SELECT * FROM publish_credential_leases').all();
}

describe('SqlitePublishCredentialRepository', () => {
  it('grants, opens and revokes one lease round-trip', async () => {
    const { store, repository } = setup();
    await expect(repository.grant(lease(), SECRET)).resolves.toEqual({ ok: true, value: undefined });
    expect(store.values.get('publish-lease-1')).toBe(SECRET);

    const opened = await repository.open('lease-1', NOW);
    expect(opened).toEqual({ ok: true, value: { lease: lease(), secret: SECRET } });

    await expect(repository.revoke('lease-1', NOW + 1)).resolves.toEqual({ ok: true, value: undefined });
    expect(store.values.has('publish-lease-1')).toBe(false);
    await expect(repository.open('lease-1', NOW + 2)).resolves.toEqual({ ok: true, value: null });
  });

  it('refuses an expired lease and never returns its secret', async () => {
    const { repository } = setup();
    await expect(repository.grant(lease(), SECRET)).resolves.toMatchObject({ ok: true });
    await expect(repository.open('lease-1', NOW + 15 * 60_000)).resolves.toEqual({ ok: true, value: null });
  });

  it('answers null for unknown and revoked leases', async () => {
    const { repository } = setup();
    await expect(repository.open('missing', NOW)).resolves.toEqual({ ok: true, value: null });
    await expect(repository.grant(lease(), SECRET)).resolves.toMatchObject({ ok: true });
    await expect(repository.revoke('lease-1', NOW + 1)).resolves.toMatchObject({ ok: true });
    await expect(repository.revoke('lease-1', NOW + 2)).resolves.toMatchObject({ ok: true });
    await expect(repository.open('lease-1', NOW + 3)).resolves.toEqual({ ok: true, value: null });
  });

  it('sweeps expired leases, deleting both the secret and the row', async () => {
    const { database, store, repository } = setup();
    await expect(repository.grant(lease(), SECRET)).resolves.toMatchObject({ ok: true });
    await expect(repository.grant(lease({
      leaseId: 'lease-live',
      expiresAt: NOW + 60 * 60_000,
    }), 'live-secret')).resolves.toMatchObject({ ok: true });

    await expect(repository.sweepExpired(NOW + 15 * 60_000)).resolves.toBe(1);
    expect(store.values.has('publish-lease-1')).toBe(false);
    expect(store.values.has('publish-lease-live')).toBe(true);
    expect(database.connection.prepare('SELECT lease_id FROM publish_credential_leases ORDER BY lease_id').all())
      .toEqual([{ lease_id: 'lease-live' }]);
    await expect(repository.open('lease-live', NOW + 1)).resolves.toMatchObject({ ok: true, value: { secret: 'live-secret' } });
  });

  it('keeps a row whose secret cannot be deleted so the next sweep retries', async () => {
    const { database, store, repository } = setup();
    await expect(repository.grant(lease(), SECRET)).resolves.toMatchObject({ ok: true });
    store.failDelete = true;
    await expect(repository.sweepExpired(NOW + 15 * 60_000)).resolves.toBe(0);
    expect(database.connection.prepare('SELECT lease_id FROM publish_credential_leases').get())
      .toEqual({ lease_id: 'lease-1' });
  });

  it('removes the ledger row when the secret write fails, so nothing is left behind', async () => {
    const { database, store, repository } = setup();
    store.failSet = true;
    const result = await repository.grant(lease(), SECRET);
    expect(result).toMatchObject({ ok: false });
    expect(ledgerRows(database)).toEqual([]);
    expect(store.values.size).toBe(0);
    await expect(repository.open('lease-1', NOW)).resolves.toEqual({ ok: true, value: null });
  });

  it('never leaves a secret without a ledger row when the row write fails', async () => {
    const { database, store, repository } = setup();
    database.connection.exec(`
      CREATE TRIGGER reject_publish_credential BEFORE INSERT ON publish_credential_leases
      BEGIN SELECT RAISE(ABORT, 'rejected'); END;
    `);
    const result = await repository.grant(lease(), SECRET);
    expect(result.ok).toBe(false);
    expect(store.values.size).toBe(0);
    expect(ledgerRows(database)).toEqual([]);
  });

  it('deletes the secret before it tombstones the row, so a failed ledger write still kills the token', async () => {
    const { database, store, repository } = setup();
    await expect(repository.grant(lease(), SECRET)).resolves.toMatchObject({ ok: true });
    database.connection.exec(`
      CREATE TRIGGER reject_publish_credential_revoke BEFORE UPDATE ON publish_credential_leases
      BEGIN SELECT RAISE(ABORT, 'rejected'); END;
    `);
    const result = await repository.revoke('lease-1', NOW + 1);
    expect(result.ok ? undefined : result.error.details?.reason).toBe('publish-credential-store-unavailable');
    // The CLI infers "the entry was deleted" from this reason, so the delete
    // has to run first: a failed tombstone must not leave the token alive.
    expect(store.values.has('publish-lease-1')).toBe(false);
    expect(database.connection.prepare('SELECT revoked_at FROM publish_credential_leases WHERE lease_id = ?').get('lease-1'))
      .toEqual({ revoked_at: null });
  });

  it('refuses a duplicate lease id without clobbering the stored secret', async () => {
    const { store, repository } = setup();
    await expect(repository.grant(lease(), SECRET)).resolves.toMatchObject({ ok: true });
    await expect(repository.grant(lease(), 'replacement-secret')).resolves.toMatchObject({ ok: false });
    expect(store.values.get('publish-lease-1')).toBe(SECRET);
  });

  it('never writes the plaintext secret into the ledger table', async () => {
    const { database, repository } = setup();
    await expect(repository.grant(lease(), SECRET)).resolves.toMatchObject({ ok: true });
    expect(JSON.stringify(ledgerRows(database))).not.toContain(SECRET);
  });

  it('refuses an invalid lease before touching the SecretStore', async () => {
    const { store, repository } = setup();
    const result = await repository.grant(lease({ remote: 'https://github.com/org/repo.git' }), SECRET);
    expect(result.ok).toBe(false);
    expect(store.values.size).toBe(0);
  });

  it('fails closed when the Secret Service is unavailable', async () => {
    const { store, repository } = setup();
    store.failSet = true;
    const result = await repository.grant(lease(), SECRET);
    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.error.details?.reason).toBe('publish-credential-unavailable');
  });

  it('inspects metadata without returning the secret', async () => {
    const { repository } = setup();
    await expect(repository.grant(lease(), SECRET)).resolves.toMatchObject({ ok: true });
    await expect(repository.inspect('lease-1')).resolves.toEqual({
      ok: true,
      value: { lease: lease(), revokedAt: null },
    });
  });

  it('finds the newest live lease for one workspace and remote', async () => {
    const { repository } = setup();
    await repository.grant(lease(), SECRET);
    await repository.grant(lease({ leaseId: 'lease-2', createdAt: NOW + 1_000 }), SECRET);
    await repository.grant(lease({ leaseId: 'lease-3', remote: 'upstream' }), SECRET);
    await expect(repository.findLive('workspace-1', 'origin', NOW + 2_000)).resolves.toEqual({
      ok: true,
      value: lease({ leaseId: 'lease-2', createdAt: NOW + 1_000 }),
    });
    await expect(repository.findLive('workspace-1', 'origin', NOW + 15 * 60_000)).resolves.toEqual({
      ok: true,
      value: null,
    });
    await expect(repository.findLive('workspace-1', 'upstream', NOW)).resolves.toEqual({
      ok: true,
      value: lease({ leaseId: 'lease-3', remote: 'upstream' }),
    });
  });

  it('does not report a revoked lease as live', async () => {
    const { repository } = setup();
    await repository.grant(lease(), SECRET);
    await repository.revoke('lease-1', NOW + 1);
    await expect(repository.findLive('workspace-1', 'origin', NOW + 2)).resolves.toEqual({ ok: true, value: null });
  });

  it('refuses a malformed live-lease lookup without touching the ledger', async () => {
    const { repository } = setup();
    for (const [workspaceId, remote, now] of [
      ['', 'origin', NOW],
      ['workspace-1', '../origin', NOW],
      ['workspace-1', 'origin', -1],
    ] as const) {
      const result = await repository.findLive(workspaceId, remote, now);
      expect(result.ok).toBe(false);
    }
  });
});
