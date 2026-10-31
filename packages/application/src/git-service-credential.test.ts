import { afterEach, describe, expect, it } from 'vitest';
import type { PublishAuditInput, PublishAuditSink } from '@unified-mpc/audit';
import {
  appError,
  fingerprintPublishCredentialHosts,
  type PublishApprovalAuthorityPort,
  type PublishApprovalBinding,
  type PublishApprovalLookupPort,
  type PublishApprovalRecord,
  type PublishCredentialLease,
  type PublishCredentialMaterial,
  type PublishCredentialPort,
  type Result,
} from '@unified-mpc/domain';
import type { GitAdapter } from '@unified-mpc/git';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Workspace, WorkspaceRepository } from '@unified-mpc/workspace';
import { GitService } from './git-service.js';

const NOW = 1_780_000_000_000;
const HEAD = 'a'.repeat(40);
const HOST = 'github.com';
const FINGERPRINT = fingerprintPublishCredentialHosts([HOST]) ?? '';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createWorkspace(): Promise<Workspace> {
  const rawRoot = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-git-credential-'));
  temporaryRoots.push(rawRoot);
  const root = await realpath(rawRoot);
  return {
    id: 'workspace-1',
    displayName: 'Fixture',
    rootPath: root,
    realRootPath: root,
    createdAt: new Date(0).toISOString(),
  };
}

function repository(workspace: Workspace): WorkspaceRepository {
  return {
    async list(): Promise<Workspace[]> { return [workspace]; },
    async get(id: string): Promise<Workspace | null> { return id === workspace.id ? workspace : null; },
    async insert(): Promise<void> {},
    async delete(): Promise<void> {},
  };
}

function lease(overrides: Partial<PublishCredentialLease> = {}): PublishCredentialLease {
  return {
    leaseId: 'lease-1',
    workspaceId: 'workspace-1',
    remote: 'origin',
    hosts: [HOST],
    username: 'git',
    createdAt: NOW,
    expiresAt: NOW + 60_000,
    ...overrides,
  };
}

function material(overrides: Partial<PublishCredentialLease> = {}): PublishCredentialMaterial {
  return { lease: lease(overrides), secret: 'secret-token' };
}

class FakeCredentialPort implements PublishCredentialPort {
  public readonly live = new Map<string, PublishCredentialMaterial>();
  public readonly revoked: Array<{ leaseId: string; now: number }> = [];
  public findLiveCalls = 0;
  public failRevoke = false;
  public throwRevoke = false;

  public async grant(): Promise<Result<void>> {
    return { ok: true, value: undefined };
  }

  public async open(leaseId: string, now: number): Promise<Result<PublishCredentialMaterial | null>> {
    const found = this.live.get(leaseId);
    return { ok: true, value: found !== undefined && found.lease.expiresAt > now ? found : null };
  }

  public async findLive(workspaceId: string, remote: string, now: number): Promise<Result<PublishCredentialLease | null>> {
    this.findLiveCalls += 1;
    const matches = [...this.live.values()]
      .filter((entry) => entry.lease.workspaceId === workspaceId
        && entry.lease.remote === remote
        && entry.lease.expiresAt > now)
      .sort((left, right) => right.lease.createdAt - left.lease.createdAt);
    return { ok: true, value: matches[0]?.lease ?? null };
  }

  public async revoke(leaseId: string, now: number): Promise<Result<void>> {
    this.revoked.push({ leaseId, now });
    if (this.throwRevoke) throw new Error('revoke crashed');
    if (this.failRevoke) {
      return { ok: false, error: appError('INTERNAL_ERROR', 'The ledger is unavailable') };
    }
    this.live.delete(leaseId);
    return { ok: true, value: undefined };
  }
}

class RecordingAudit implements PublishAuditSink {
  public readonly events: PublishAuditInput[] = [];
  public fail = false;

  public async recordPublish(input: PublishAuditInput): Promise<void> {
    if (this.fail) throw new Error('audit unavailable');
    this.events.push(input);
  }
}

class FakeApprovalLedger implements PublishApprovalLookupPort, PublishApprovalAuthorityPort {
  public readonly records = new Map<string, PublishApprovalRecord>();
  public readonly consumed: Array<{ approvalId: string; binding: PublishApprovalBinding; now: number }> = [];

  public async inspect(): Promise<'missing'> {
    return 'missing';
  }

  public async read(approvalId: string): Promise<PublishApprovalRecord | null> {
    return this.records.get(approvalId) ?? null;
  }

  public async record(record: PublishApprovalRecord): Promise<boolean> {
    this.records.set(record.approvalId, record);
    return true;
  }

  public async consume(approvalId: string, binding: PublishApprovalBinding, now: number): Promise<boolean> {
    this.consumed.push({ approvalId, binding, now });
    return this.records.has(approvalId);
  }
}

function preflight(head = HEAD): Record<string, unknown> {
  return {
    ok: true,
    value: {
      remote: 'origin',
      branch: 'goal/publish',
      head,
      defaultBranches: ['main'],
      protectedBranch: false,
      targets: [`https://${HOST}`],
      runtime: { ready: true },
      approval: 'missing',
    },
  };
}

function adapter(overrides: Partial<Record<string, unknown>> = {}): {
  adapter: GitAdapter;
  calls: { preflight: unknown[]; publish: unknown[]; fingerprint: number };
} {
  const calls = { preflight: [] as unknown[], publish: [] as unknown[], fingerprint: 0 };
  const fake = {
    async publishPreflight(_cwd: string, _remote: string, _branch: string, options: unknown): Promise<unknown> {
      calls.preflight.push(options);
      return preflight();
    },
    async publishTargetFingerprint(): Promise<unknown> {
      calls.fingerprint += 1;
      return { ok: true, value: FINGERPRINT };
    },
    async publish(_cwd: string, _request: unknown, options: unknown): Promise<unknown> {
      calls.publish.push(options);
      return { ok: true, value: { remote: 'origin', branch: 'goal/publish', sha: HEAD, targets: [`https://${HOST}`] } };
    },
    ...overrides,
  } as unknown as GitAdapter;
  return { adapter: fake, calls };
}

const actor = { clientId: 'test', clientName: 'test' };
const bindingRequest = { workspaceId: 'workspace-1', remote: 'origin', branch: 'goal/publish', expectedSha: HEAD };

describe('GitService publish credentials', () => {
  it('reports publish-credential-required when no lease backs a helper-blocked preflight', async () => {
    const workspace = await createWorkspace();
    const fake = adapter({
      async publishPreflight(): Promise<unknown> {
        return {
          ...preflight(),
          value: { ...(preflight().value as object), runtime: { ready: false, reason: 'push-credential-helper', key: 'credential.helper' } },
        };
      },
    });
    const service = new GitService(repository(workspace), undefined, fake.adapter, {
      publishApprovals: new FakeApprovalLedger(),
      publishCredentials: new FakeCredentialPort(),
      now: (): number => NOW,
    });

    await expect(service.publishPreflight(actor, {
      workspaceId: workspace.id, remote: 'origin', branch: 'goal/publish',
    })).resolves.toMatchObject({
      ok: true,
      value: { runtime: { ready: false, reason: 'publish-credential-required', key: 'credential.helper' } },
    });
  });

  it('runs the diagnostic preflight with the live lease and keeps a ready runtime', async () => {
    const workspace = await createWorkspace();
    const credentials = new FakeCredentialPort();
    credentials.live.set('lease-1', material());
    const fake = adapter();
    const service = new GitService(repository(workspace), undefined, fake.adapter, {
      publishApprovals: new FakeApprovalLedger(),
      publishCredentials: credentials,
      now: (): number => NOW,
    });

    await expect(service.publishPreflight(actor, {
      workspaceId: workspace.id, remote: 'origin', branch: 'goal/publish',
    })).resolves.toMatchObject({ ok: true, value: { runtime: { ready: true } } });
    expect(fake.calls.preflight).toEqual([{
      credential: { approvalId: 'diagnostic', material: material() },
    }]);
  });

  it('binds a receipt to the lease id, host fingerprint and the shorter expiry', async () => {
    const workspace = await createWorkspace();
    const credentials = new FakeCredentialPort();
    credentials.live.set('lease-1', material({ expiresAt: NOW + 45_000 }));
    const ledger = new FakeApprovalLedger();
    const fake = adapter();
    const service = new GitService(repository(workspace), undefined, fake.adapter, {
      publishApprovals: ledger,
      publishApprovalAuthority: ledger,
      publishCredentials: credentials,
      now: (): number => NOW,
    });

    const result = await service.approvePublish(actor, { ...bindingRequest, userConfirmed: true });

    expect(result).toMatchObject({
      ok: true,
      value: {
        leaseId: 'lease-1',
        pushUrlFingerprint: FINGERPRINT,
        approvedAt: NOW,
        expiresAt: NOW + 45_000,
      },
    });
    expect(fake.calls.fingerprint).toBe(1);
  });

  it('refuses an approval when the resolved target no longer matches the lease', async () => {
    const workspace = await createWorkspace();
    const credentials = new FakeCredentialPort();
    credentials.live.set('lease-1', material({ hosts: ['gitlab.com'] }));
    const ledger = new FakeApprovalLedger();
    const fake = adapter();
    const service = new GitService(repository(workspace), undefined, fake.adapter, {
      publishApprovals: ledger,
      publishApprovalAuthority: ledger,
      publishCredentials: credentials,
      now: (): number => NOW,
    });

    await expect(service.approvePublish(actor, { ...bindingRequest, userConfirmed: true }))
      .resolves.toMatchObject({
        ok: false,
        error: { code: 'PERMISSION_DENIED', details: { reason: 'publish-target-changed' } },
      });
    expect(ledger.records.size).toBe(0);
  });

  it('publishes through the bound lease and revokes it after a successful push', async () => {
    const workspace = await createWorkspace();
    const credentials = new FakeCredentialPort();
    credentials.live.set('lease-1', material());
    const ledger = new FakeApprovalLedger();
    ledger.records.set('approval-1', {
      ...bindingRequest,
      approvalId: 'approval-1',
      approvedBy: 'host',
      approvedAt: NOW,
      expiresAt: NOW + 60_000,
      leaseId: 'lease-1',
      pushUrlFingerprint: FINGERPRINT,
    });
    const fake = adapter();
    const audit = new RecordingAudit();
    const service = new GitService(repository(workspace), undefined, fake.adapter, {
      publishApprovals: ledger,
      publishApprovalAuthority: ledger,
      publishCredentials: credentials,
      publishAudit: audit,
      now: (): number => NOW,
    });

    await expect(service.publish(actor, { ...bindingRequest, approvalId: 'approval-1' }))
      .resolves.toMatchObject({ ok: true, value: { approvalId: 'approval-1' } });
    expect(fake.calls.publish).toEqual([{
      credential: { approvalId: 'approval-1', material: material() },
    }]);
    expect(ledger.consumed).toHaveLength(1);
    expect(credentials.revoked).toEqual([{ leaseId: 'lease-1', now: NOW }]);
    expect(audit.events).toEqual([{
      actorId: 'test',
      actorName: 'test',
      workspaceId: 'workspace-1',
      action: 'publish_credential_use',
      remote: 'origin',
      leaseId: 'lease-1',
      approvalId: 'approval-1',
      branch: 'goal/publish',
      expectedSha: HEAD,
      hosts: ['github.com'],
      username: 'git',
      pushUrlFingerprint: FINGERPRINT,
      resultCode: 'SUCCESS',
      durationMs: 0,
    }]);
    expect(JSON.stringify(audit.events)).not.toContain('secret-token');
  });

  it('flags a failed lease release without changing the publish result', async () => {
    const workspace = await createWorkspace();
    const credentials = new FakeCredentialPort();
    credentials.live.set('lease-1', material());
    credentials.failRevoke = true;
    const ledger = new FakeApprovalLedger();
    ledger.records.set('approval-1', {
      ...bindingRequest,
      approvalId: 'approval-1',
      approvedBy: 'host',
      approvedAt: NOW,
      expiresAt: NOW + 60_000,
      leaseId: 'lease-1',
      pushUrlFingerprint: FINGERPRINT,
    });
    const fake = adapter();
    const audit = new RecordingAudit();
    const service = new GitService(repository(workspace), undefined, fake.adapter, {
      publishApprovals: ledger,
      publishApprovalAuthority: ledger,
      publishCredentials: credentials,
      publishAudit: audit,
      now: (): number => NOW,
    });

    // `revoke` reports failure as an error result, not a throw: the push still
    // succeeds and the row records that the lease outlived the spend.
    await expect(service.publish(actor, { ...bindingRequest, approvalId: 'approval-1' }))
      .resolves.toMatchObject({ ok: true, value: { approvalId: 'approval-1' } });
    expect(credentials.revoked).toEqual([{ leaseId: 'lease-1', now: NOW }]);
    expect(audit.events).toMatchObject([{
      action: 'publish_credential_use',
      resultCode: 'SUCCESS',
      leaseRevokeFailed: true,
    }]);
  });

  it('flags a lease release that throws instead of returning a result', async () => {
    const workspace = await createWorkspace();
    const credentials = new FakeCredentialPort();
    credentials.live.set('lease-1', material());
    credentials.throwRevoke = true;
    const ledger = new FakeApprovalLedger();
    ledger.records.set('approval-1', {
      ...bindingRequest,
      approvalId: 'approval-1',
      approvedBy: 'host',
      approvedAt: NOW,
      expiresAt: NOW + 60_000,
      leaseId: 'lease-1',
      pushUrlFingerprint: FINGERPRINT,
    });
    const fake = adapter();
    const audit = new RecordingAudit();
    const service = new GitService(repository(workspace), undefined, fake.adapter, {
      publishApprovals: ledger,
      publishApprovalAuthority: ledger,
      publishCredentials: credentials,
      publishAudit: audit,
      now: (): number => NOW,
    });

    // A throwing release is the other failure shape: the row must still say the
    // lease outlived the spend, and the completed push must still stand.
    await expect(service.publish(actor, { ...bindingRequest, approvalId: 'approval-1' }))
      .resolves.toMatchObject({ ok: true, value: { approvalId: 'approval-1' } });
    expect(audit.events).toMatchObject([{
      action: 'publish_credential_use',
      resultCode: 'SUCCESS',
      leaseRevokeFailed: true,
    }]);
  });

  it('revokes the lease after a failed push and keeps the failure', async () => {
    const workspace = await createWorkspace();
    const credentials = new FakeCredentialPort();
    credentials.live.set('lease-1', material());
    const ledger = new FakeApprovalLedger();
    ledger.records.set('approval-1', {
      ...bindingRequest,
      approvalId: 'approval-1',
      approvedBy: 'host',
      approvedAt: NOW,
      expiresAt: NOW + 60_000,
      leaseId: 'lease-1',
      pushUrlFingerprint: FINGERPRINT,
    });
    const fake = adapter({
      async publish(): Promise<unknown> {
        return { ok: false, error: { code: 'CONFLICT', message: 'push failed', retryable: true, details: { reason: 'publish-push-failed' } } };
      },
    });
    const audit = new RecordingAudit();
    const service = new GitService(repository(workspace), undefined, fake.adapter, {
      publishApprovals: ledger,
      publishApprovalAuthority: ledger,
      publishCredentials: credentials,
      publishAudit: audit,
      now: (): number => NOW,
    });

    await expect(service.publish(actor, { ...bindingRequest, approvalId: 'approval-1' }))
      .resolves.toMatchObject({ ok: false, error: { details: { reason: 'publish-push-failed' } } });
    expect(credentials.revoked).toEqual([{ leaseId: 'lease-1', now: NOW }]);
    expect(audit.events).toMatchObject([{
      action: 'publish_credential_use',
      leaseId: 'lease-1',
      resultCode: 'CONFLICT',
      reason: 'publish-push-failed',
    }]);
  });

  it('keeps the publish result when the audit write fails', async () => {
    const workspace = await createWorkspace();
    const credentials = new FakeCredentialPort();
    credentials.live.set('lease-1', material());
    const ledger = new FakeApprovalLedger();
    ledger.records.set('approval-1', {
      ...bindingRequest,
      approvalId: 'approval-1',
      approvedBy: 'host',
      approvedAt: NOW,
      expiresAt: NOW + 60_000,
      leaseId: 'lease-1',
      pushUrlFingerprint: FINGERPRINT,
    });
    const audit = new RecordingAudit();
    audit.fail = true;
    const fake = adapter();
    const service = new GitService(repository(workspace), undefined, fake.adapter, {
      publishApprovals: ledger,
      publishApprovalAuthority: ledger,
      publishCredentials: credentials,
      publishAudit: audit,
      now: (): number => NOW,
    });

    await expect(service.publish(actor, { ...bindingRequest, approvalId: 'approval-1' }))
      .resolves.toMatchObject({ ok: true, value: { approvalId: 'approval-1' } });
    expect(credentials.revoked).toEqual([{ leaseId: 'lease-1', now: NOW }]);
  });

  it('fails closed before the preflight when the bound lease is gone or mismatched', async () => {
    const workspace = await createWorkspace();
    const credentials = new FakeCredentialPort();
    credentials.live.set('lease-2', material({ leaseId: 'lease-2' }));
    const ledger = new FakeApprovalLedger();
    ledger.records.set('approval-1', {
      ...bindingRequest,
      approvalId: 'approval-1',
      approvedBy: 'host',
      approvedAt: NOW,
      expiresAt: NOW + 60_000,
      leaseId: 'lease-1',
      pushUrlFingerprint: FINGERPRINT,
    });
    const fake = adapter();
    const service = new GitService(repository(workspace), undefined, fake.adapter, {
      publishApprovals: ledger,
      publishApprovalAuthority: ledger,
      publishCredentials: credentials,
      now: (): number => NOW,
    });

    await expect(service.publish(actor, { ...bindingRequest, approvalId: 'approval-1' }))
      .resolves.toMatchObject({
        ok: false,
        error: { code: 'PERMISSION_DENIED', details: { reason: 'publish-credential-unavailable' } },
      });
    expect(fake.calls.preflight).toHaveLength(0);
    expect(fake.calls.publish).toHaveLength(0);
    expect(ledger.consumed).toHaveLength(0);
  });

  it('fails closed when the receipt was already consumed', async () => {
    const workspace = await createWorkspace();
    const credentials = new FakeCredentialPort();
    credentials.live.set('lease-1', material());
    const ledger = new FakeApprovalLedger();
    ledger.records.set('approval-1', {
      ...bindingRequest,
      approvalId: 'approval-1',
      approvedBy: 'host',
      approvedAt: NOW,
      expiresAt: NOW + 60_000,
      leaseId: 'lease-1',
      pushUrlFingerprint: FINGERPRINT,
      consumedAt: NOW + 1,
    } as PublishApprovalRecord);
    const fake = adapter();
    const service = new GitService(repository(workspace), undefined, fake.adapter, {
      publishApprovals: ledger,
      publishApprovalAuthority: ledger,
      publishCredentials: credentials,
      now: (): number => NOW,
    });

    await expect(service.publish(actor, { ...bindingRequest, approvalId: 'approval-1' }))
      .resolves.toMatchObject({
        ok: false,
        error: { code: 'PERMISSION_DENIED', details: { reason: 'publish-credential-unavailable' } },
      });
    expect(fake.calls.preflight).toHaveLength(0);
    expect(fake.calls.publish).toHaveLength(0);
  });

  it('refuses a target rewritten after approval without spending the receipt', async () => {
    const workspace = await createWorkspace();
    const credentials = new FakeCredentialPort();
    credentials.live.set('lease-1', material());
    const ledger = new FakeApprovalLedger();
    ledger.records.set('approval-1', {
      ...bindingRequest,
      approvalId: 'approval-1',
      approvedBy: 'host',
      approvedAt: NOW,
      expiresAt: NOW + 60_000,
      leaseId: 'lease-1',
      pushUrlFingerprint: fingerprintPublishCredentialHosts(['gitlab.com']) ?? '',
    });
    const fake = adapter();
    const service = new GitService(repository(workspace), undefined, fake.adapter, {
      publishApprovals: ledger,
      publishApprovalAuthority: ledger,
      publishCredentials: credentials,
      now: (): number => NOW,
    });

    await expect(service.publish(actor, { ...bindingRequest, approvalId: 'approval-1' }))
      .resolves.toMatchObject({
        ok: false,
        error: { code: 'PERMISSION_DENIED', details: { reason: 'publish-target-changed' } },
      });
    expect(ledger.consumed).toHaveLength(0);
    expect(fake.calls.publish).toHaveLength(0);
    expect(credentials.revoked).toHaveLength(0);
  });

  it('keeps a credential-free receipt on the S1 path', async () => {
    const workspace = await createWorkspace();
    const credentials = new FakeCredentialPort();
    credentials.live.set('lease-1', material());
    const ledger = new FakeApprovalLedger();
    ledger.records.set('approval-1', {
      ...bindingRequest,
      approvalId: 'approval-1',
      approvedBy: 'host',
      approvedAt: NOW,
      expiresAt: NOW + 60_000,
    });
    const fake = adapter();
    const audit = new RecordingAudit();
    const service = new GitService(repository(workspace), undefined, fake.adapter, {
      publishApprovals: ledger,
      publishApprovalAuthority: ledger,
      publishCredentials: credentials,
      publishAudit: audit,
      now: (): number => NOW,
    });

    await expect(service.publish(actor, { ...bindingRequest, approvalId: 'approval-1' }))
      .resolves.toMatchObject({ ok: true, value: { approvalId: 'approval-1' } });
    expect(fake.calls.publish).toEqual([{ signal: undefined }]);
    expect(credentials.revoked).toHaveLength(0);
    expect(audit.events).toEqual([]);
  });
});
