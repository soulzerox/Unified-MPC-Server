import { describe, expect, it } from 'vitest';
import { AuditService, type ActivityAuditEvent, type ActivityTargetDetail, type AuditEvent, type AuditEventQuery, type AuditEventRepository, type AuditEventSummaryProjection } from './audit-service.js';

class MemoryAuditRepository implements AuditEventRepository {
  public readonly events: AuditEvent[] = [];

  public async insert(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }

  public async list(limit = 100): Promise<AuditEvent[]> {
    return [...this.events].reverse().slice(0, limit);
  }

  public async listByActionPrefix(prefix: string, limit = 100): Promise<AuditEvent[]> {
    return this.listScoped({ actionPrefix: prefix }, limit);
  }

  public async listScoped(query: AuditEventQuery, limit = 100): Promise<AuditEvent[]> {
    return this.events.filter((event) => {
      if (query.actionPrefix !== undefined && !event.action.startsWith(query.actionPrefix)) return false;
      if (query.workspaceId !== undefined && (event.workspaceId ?? null) !== query.workspaceId) return false;
      if (query.sessionId !== undefined && (event.sessionId ?? null) !== query.sessionId) return false;
      return true;
    }).reverse().slice(0, limit);
  }

  public async listSummaries(limit = 100): Promise<AuditEventSummaryProjection[]> {
    return this.events.slice().reverse().slice(0, limit).map((event) => ({
      id: event.id,
      timestamp: event.timestamp,
      action: event.action,
      resultCode: event.resultCode,
    }));
  }

  public async listActivityScoped(): Promise<ActivityAuditEvent[]> {
    return [];
  }

  public async resolveActivityTargetDetail(): Promise<ActivityTargetDetail | null> {
    return null;
  }
}

describe('AuditService', () => {
  it('redacts metadata before handing it to persistence', async () => {
    const repository = new MemoryAuditRepository();
    await new AuditService(repository).record({
      actorId: 'client-1',
      actorName: 'test',
      workspaceId: 'workspace-1',
      action: 'process_start',
      resultCode: 'SUCCESS',
      durationMs: 12,
      metadata: { Authorization: 'Bearer token-123', API_KEY: 'secret-123', safe: 'value' },
    });

    expect(repository.events).toHaveLength(1);
    expect(repository.events[0]?.metadata).toEqual({ Authorization: '[REDACTED]', API_KEY: '[REDACTED]', safe: 'value' });
    expect(JSON.stringify(repository.events[0])).not.toContain('token-123');
    expect(JSON.stringify(repository.events[0])).not.toContain('secret-123');
  });

  it('stores Codex instruction metadata without the instruction text', async () => {
    const repository = new MemoryAuditRepository();
    await new AuditService(repository).recordCodexRun({
      actorId: 'client-1',
      actorName: 'test',
      workspaceId: 'workspace-1',
      codexTaskId: 'codex-1',
      instruction: 'do not persist this prompt',
      resultCode: 'STARTED',
      durationMs: 1,
    });

    expect(repository.events[0]?.metadata).toMatchObject({ codexTaskId: 'codex-1', instructionLength: 26 });
    expect(JSON.stringify(repository.events[0])).not.toContain('do not persist this prompt');
  });

  it('records MCP tool activity with phase metadata', async () => {
    const repository = new MemoryAuditRepository();
    await new AuditService(repository).recordMcpTool({
      actorId: 'client-1',
      actorName: 'test',
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      toolName: 'read_file',
      callId: 'call-1',
      phase: 'completed',
      targetSummary: 'src\\app.ts',
      targetDetail: { detailRef: null, itemCount: 1, preview: ['src\\app.ts'], legacyIncomplete: false },
      resultCode: 'FILE_NOT_FOUND',
      resultMessage: 'File or directory was not found',
      durationMs: 8,
    });

    expect(repository.events[0]).toMatchObject({
      action: 'mcp_tool:read_file',
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      targetSummary: 'src\\app.ts',
      resultCode: 'FILE_NOT_FOUND',
      metadata: { toolName: 'read_file', callId: 'call-1', phase: 'completed', errorMessage: 'File or directory was not found' },
    });
  });

  it('retains sanitized completed-result diagnostics for lazy log expansion', async () => {
    const repository = new MemoryAuditRepository();
    const workspaceId = '372e9384-9628-43be-b766-661cdb591383';
    const goalId = 'e27da685-745f-484c-86c8-235eb8cb42e5';
    await new AuditService(repository).recordMcpTool({
      actorId: 'client-1', actorName: 'test', workspaceId, sessionId: 'session-full',
      toolName: 'run_goal', callId: 'call-full', phase: 'completed',
      targetSummary: `goalKey=activity-log-full-detail-no-truncation workspace=${workspaceId}`,
      targetDetail: { detailRef: 'call-full:completed', itemCount: 4, preview: [], legacyIncomplete: false },
      activityTargetDetail: { kind: 'details', items: [`goalId=${goalId}`, `workspaceId=${workspaceId}`, 'status=active', 'password=must-never-leak'] },
      resultCode: 'SUCCESS', durationMs: 8,
    });

    expect(repository.events[0]?.metadata).toMatchObject({
      toolName: 'run_goal', callId: 'call-full', phase: 'completed',
      activityTargetDetail: {
        kind: 'details', items: [`goalId=${goalId}`, `workspaceId=${workspaceId}`, 'status=active', 'password=[REDACTED]'],
      },
    });
    expect(JSON.stringify(repository.events[0])).not.toContain('must-never-leak');
  });

  it('records a credential-bound publish use without the secret', async () => {
    const repository = new MemoryAuditRepository();
    await new AuditService(repository).recordPublish({
      actorId: 'client-1', actorName: 'goal-worker',
      workspaceId: 'workspace-1', action: 'publish_credential_use',
      remote: 'origin', leaseId: 'lease-1', approvalId: 'approval-1',
      branch: 'goal/publish', expectedSha: 'a'.repeat(40),
      hosts: ['github.com'], username: 'git',
      pushUrlFingerprint: `sha256:${'b'.repeat(64)}`,
      resultCode: 'SUCCESS', durationMs: 42,
    });

    expect(repository.events[0]).toMatchObject({
      action: 'publish_credential_use',
      workspaceId: 'workspace-1',
      targetSummary: 'workspace=workspace-1 remote=origin lease=lease-1 approval=approval-1',
      resultCode: 'SUCCESS',
      durationMs: 42,
      metadata: {
        remote: 'origin', leaseId: 'lease-1', approvalId: 'approval-1',
        branch: 'goal/publish', expectedSha: 'a'.repeat(40),
        hosts: ['github.com'], username: 'git',
        pushUrlFingerprint: `sha256:${'b'.repeat(64)}`,
      },
    });
    const serialized = JSON.stringify(repository.events[0]);
    expect(serialized).not.toContain('ghs_');
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('password');
  });

  it('records a revoke reason and a sweep count without a secret field', async () => {
    const repository = new MemoryAuditRepository();
    const service = new AuditService(repository);
    await service.recordPublish({
      actorId: 'publish-credential-cli', actorName: 'unified-mpc publish-credential',
      action: 'publish_credential_revoke', workspaceId: 'workspace-1',
      leaseId: 'lease-1', resultCode: 'SUCCESS', reason: 'operator-revoked',
    });
    await service.recordPublish({
      actorId: 'publish-credential-sweep', actorName: 'publish credential expiry sweep',
      action: 'publish_credential_sweep', resultCode: 'SUCCESS', reclaimed: 2,
    });

    expect(repository.events[0]?.metadata).toMatchObject({ leaseId: 'lease-1', reason: 'operator-revoked' });
    expect(repository.events[1]).toMatchObject({
      action: 'publish_credential_sweep',
      resultCode: 'SUCCESS',
      metadata: { reclaimed: 2 },
    });
    expect(JSON.stringify(repository.events)).not.toContain('secret');
  });
});
