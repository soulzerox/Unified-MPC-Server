import { describe, expect, it } from 'vitest';
import { SqliteDatabase } from './database.js';
import {
  SqlitePublishApprovalRepository,
  type PublishApprovalRecord,
} from './publish-approval-repository.js';
import { SqliteWorkspaceRepository } from './workspace-repository.js';

const WORKSPACE = 'goal-publish-workspace';
const HEAD = 'a'.repeat(40);
const NEXT_HEAD = 'b'.repeat(64);
const NOW = 1_780_000_000_000;
const TTL_MS = 15 * 60_000;

function approval(overrides: Partial<PublishApprovalRecord> = {}): PublishApprovalRecord {
  return {
    approvalId: 'approval-1',
    workspaceId: WORKSPACE,
    remote: 'origin',
    branch: 'goal/publish',
    expectedSha: HEAD,
    approvedBy: 'host:desktop',
    approvedAt: NOW,
    expiresAt: NOW + TTL_MS,
    ...overrides,
  };
}

async function setup(): Promise<{ database: SqliteDatabase; repository: SqlitePublishApprovalRepository }> {
  const database = new SqliteDatabase(':memory:');
  const workspaces = new SqliteWorkspaceRepository(database);
  await workspaces.insert({
    id: WORKSPACE,
    displayName: 'Publish workspace',
    rootPath: '/srv/unified-mpc/publish',
    realRootPath: '/srv/unified-mpc/publish',
    createdAt: '2026-10-29T00:00:00.000Z',
    lifecycleKind: 'goal',
  });
  return { database, repository: new SqlitePublishApprovalRepository(database) };
}

describe('SqlitePublishApprovalRepository', () => {
  it('records a host approval and reads it back unconsumed', async () => {
    const { repository } = await setup();
    await expect(repository.record(approval())).resolves.toBe(true);
    await expect(repository.read('approval-1')).resolves.toEqual({
      ...approval(),
      consumedAt: null,
    });
  });

  it('refuses an approval for a workspace that does not exist', async () => {
    const { repository } = await setup();
    await expect(repository.record(approval({ workspaceId: 'forged-workspace' }))).resolves.toBe(false);
    await expect(repository.read('approval-1')).resolves.toBeNull();
  });

  it('is idempotent for the exact binding and refuses to widen a recorded approval', async () => {
    const { repository } = await setup();
    await expect(repository.record(approval())).resolves.toBe(true);
    await expect(repository.record(approval())).resolves.toBe(true);
    await expect(repository.record(approval({ branch: 'goal/other' }))).resolves.toBe(false);
    await expect(repository.record(approval({ expectedSha: NEXT_HEAD }))).resolves.toBe(false);
    await expect(repository.read('approval-1')).resolves.toEqual({ ...approval(), consumedAt: null });
  });

  it('consumes exactly once and never rewinds the consumption', async () => {
    const { repository } = await setup();
    await repository.record(approval());
    await expect(repository.consume(approval(), NOW + 1_000)).resolves.toBe(true);
    await expect(repository.read('approval-1')).resolves.toEqual({ ...approval(), consumedAt: NOW + 1_000 });
    await expect(repository.consume(approval(), NOW + 2_000)).resolves.toBe(false);
    await expect(repository.record(approval())).resolves.toBe(false);
    await expect(repository.read('approval-1')).resolves.toEqual({ ...approval(), consumedAt: NOW + 1_000 });
  });

  it('refuses an approval at and after its expiry boundary', async () => {
    const { repository } = await setup();
    await repository.record(approval());
    await expect(repository.consume(approval(), approval().expiresAt)).resolves.toBe(false);
    await expect(repository.consume(approval(), approval().expiresAt + 1)).resolves.toBe(false);
    await expect(repository.consume(approval({ expectedSha: 'c'.repeat(40) }), approval().expiresAt)).resolves.toBe(false);
    await expect(repository.read('approval-1')).resolves.toEqual({ ...approval(), consumedAt: null });
  });

  it('refuses a receipt bound to a different commit and keeps the stored binding spendable', async () => {
    const { repository } = await setup();
    await repository.record(approval());
    await expect(repository.consume(approval({ expectedSha: NEXT_HEAD }), NOW + 1_000)).resolves.toBe(false);
    await expect(repository.consume(approval({ remote: 'upstream' }), NOW + 1_000)).resolves.toBe(false);
    await expect(repository.read('approval-1')).resolves.toEqual({ ...approval(), consumedAt: null });
    await expect(repository.consume(approval(), NOW + 1_000)).resolves.toBe(true);
  });

  it('rejects malformed bindings without writing', async () => {
    const { repository } = await setup();
    const malformed: readonly Partial<PublishApprovalRecord>[] = [
      { approvalId: '' },
      { approvalId: 'a'.repeat(129) },
      { workspaceId: '' },
      { remote: '' },
      { remote: '../origin' },
      { remote: 'origin --upload-pack=x' },
      { remote: null as unknown as string },
      { branch: '' },
      { branch: '-force' },
      { branch: 'goal/publish branch' },
      { branch: 'goal/../main' },
      { branch: 'goal/publish.lock' },
      { expectedSha: 'a'.repeat(39) },
      { expectedSha: 'not-a-sha' },
      { approvedBy: '' },
      { approvedAt: -1 },
      { approvedAt: 1.5 },
      { expiresAt: NOW },
      { expiresAt: NOW - 1 },
    ];
    for (const overrides of malformed) {
      await expect(repository.record(approval(overrides))).resolves.toBe(false);
    }
    await expect(repository.read('approval-1')).resolves.toBeNull();
  });

  it('rejects an invalid consumption clock without spending the approval', async () => {
    const { repository } = await setup();
    await repository.record(approval());
    for (const now of [-1, 1.5, Number.NaN, Number.MAX_VALUE]) {
      await expect(repository.consume(approval(), now)).resolves.toBe(false);
    }
    await expect(repository.read('approval-1')).resolves.toEqual({ ...approval(), consumedAt: null });
  });

  it('reads no approval for an out-of-range identifier', async () => {
    const { repository } = await setup();
    await expect(repository.read('')).resolves.toBeNull();
    await expect(repository.read('a'.repeat(129))).resolves.toBeNull();
  });

  it('enforces the binding shape in SQLite even when a row is written directly', async () => {
    const { database } = await setup();
    const insertDirect = (approvalId: string, workspaceId: string, expiresAt: number): void => {
      database.connection.prepare(`
        INSERT INTO publish_approvals (
          approval_id, workspace_id, remote, branch, expected_sha, approved_by,
          approved_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(approvalId, workspaceId, 'origin', 'goal/publish', HEAD, 'host:desktop', NOW, expiresAt);
    };
    expect(() => insertDirect('direct-1', WORKSPACE, NOW)).toThrow();
    expect(() => insertDirect('direct-2', 'missing-workspace', NOW + 1_000)).toThrow();
  });
});
