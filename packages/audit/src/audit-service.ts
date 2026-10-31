import { randomUUID } from 'node:crypto';
import { codexInstructionSummary, decodeActivityTargetReference, redactActivityTargetDetail, Redactor } from './redactor.js';
import type {
  AuditEvent,
  AuditEventInput,
  AuditEventRepository,
  CodexRunAuditInput,
  McpToolAuditInput,
  PublishAuditInput,
} from './audit-types.js';

export class AuditService {
  public constructor(
    private readonly repository: AuditEventRepository,
    private readonly redactor: Redactor = new Redactor(),
  ) {}

  public async record(input: AuditEventInput): Promise<void> {
    const event: AuditEvent = {
      id: randomUUID(),
      timestamp: input.timestamp ?? new Date().toISOString(),
      actorId: input.actorId,
      actorName: input.actorName,
      ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      action: input.action,
      ...(input.targetSummary === undefined ? {} : { targetSummary: this.redactor.redactText(input.targetSummary) }),
      ...(input.permissionDecision === undefined ? {} : { permissionDecision: input.permissionDecision }),
      resultCode: input.resultCode,
      durationMs: input.durationMs,
      metadata: this.redactor.redactRecord(input.metadata ?? {}),
    };
    await this.repository.insert(event);
  }

  public recordCodexRun(input: CodexRunAuditInput): Promise<void> {
    return this.record({
      ...(input.timestamp === undefined ? {} : { timestamp: input.timestamp }),
      actorId: input.actorId,
      actorName: input.actorName,
      ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
      action: 'codex_run',
      resultCode: input.resultCode,
      durationMs: input.durationMs,
      metadata: { ...codexInstructionSummary(input.codexTaskId, input.instruction) },
    });
  }

  /**
   * Record one publish credential lifecycle event. `metadata` is deliberately
   * built from a closed list of non-secret fields; a caller cannot pass a
   * secret through this method, and the redactor still runs over the result.
   */
  public recordPublish(input: PublishAuditInput): Promise<void> {
    const targetSummary = publishTargetSummary(input);
    return this.record({
      ...(input.timestamp === undefined ? {} : { timestamp: input.timestamp }),
      actorId: input.actorId,
      actorName: input.actorName,
      ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
      action: input.action,
      ...(targetSummary === undefined ? {} : { targetSummary }),
      resultCode: input.resultCode,
      durationMs: input.durationMs ?? 0,
      metadata: {
        ...(input.remote === undefined ? {} : { remote: input.remote }),
        ...(input.leaseId === undefined ? {} : { leaseId: input.leaseId }),
        ...(input.approvalId === undefined ? {} : { approvalId: input.approvalId }),
        ...(input.branch === undefined ? {} : { branch: input.branch }),
        ...(input.expectedSha === undefined ? {} : { expectedSha: input.expectedSha }),
        ...(input.hosts === undefined ? {} : { hosts: input.hosts }),
        ...(input.username === undefined ? {} : { username: input.username }),
        ...(input.pushUrlFingerprint === undefined ? {} : { pushUrlFingerprint: input.pushUrlFingerprint }),
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        ...(input.reclaimed === undefined ? {} : { reclaimed: input.reclaimed }),
      },
    });
  }

  public recordMcpTool(input: McpToolAuditInput): Promise<void> {
    return this.record({
      ...(input.timestamp === undefined ? {} : { timestamp: input.timestamp }),
      actorId: input.actorId,
      actorName: input.actorName,
      ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      action: `mcp_tool:${input.toolName}`,
      ...(input.targetSummary === undefined ? {} : { targetSummary: input.targetSummary }),
      resultCode: input.resultCode,
      durationMs: input.durationMs,
      metadata: {
        toolName: input.toolName,
        callId: input.callId,
        phase: input.phase,
        targetDetail: decodeActivityTargetReference(input.targetDetail, input.targetSummary),
        ...(input.activityTargetDetail === undefined
          ? {}
          : { activityTargetDetail: redactActivityTargetDetail(input.activityTargetDetail, this.redactor) }),
        ...(input.resultMessage === undefined ? {} : { errorMessage: input.resultMessage }),
        ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
        ...(input.traceParent === undefined ? {} : { traceParent: input.traceParent }),
        ...(input.authorizationMode === undefined ? {} : { authorizationMode: input.authorizationMode }),
      },
    });
  }
}

function publishTargetSummary(input: PublishAuditInput): string | undefined {
  const parts = [
    input.workspaceId === undefined ? undefined : `workspace=${input.workspaceId}`,
    input.remote === undefined ? undefined : `remote=${input.remote}`,
    input.leaseId === undefined ? undefined : `lease=${input.leaseId}`,
    input.approvalId === undefined ? undefined : `approval=${input.approvalId}`,
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? undefined : parts.join(' ').slice(0, 512);
}

export type {
  AuditEvent,
  AuditEventInput,
  AuditEventQuery,
  AuditEventRepository,
  CodexRunAuditInput,
  McpToolAuditInput,
  PublishAuditAction,
  PublishAuditInput,
  PublishAuditSink,
} from './audit-types.js';
