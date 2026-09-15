import { createHash } from 'node:crypto';
import { appError, err, ok, type Result } from '@unified-mpc/domain';
import type { ExtensionsService } from '@unified-mpc/extensions';

const THAI_RAG_SERVER = 'thai-rag-mcp';
type TrustedThaiRagTool = 'recall' | 'remember' | 'remember_turn';

export interface TrustedCompletedTurnInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly projectId: string;
  readonly projectRoot: string;
  readonly userMessage: string;
  readonly assistantMessage: string;
  readonly sourceClient: string;
  readonly summary?: string;
  readonly tags?: string;
}

export interface TrustedCompletedTurnResult {
  readonly recorded: number;
  readonly childTurnIds: readonly string[];
}

interface TrustedThaiRagContract {
  readonly descriptorFingerprint: string;
  readonly catalogFingerprint: string;
  readonly inputSchema?: unknown;
}

/**
 * Narrow first-party adapter for the explicitly safe Thai-RAG surface.
 * Callers cannot choose a child server or arbitrary child tool. Every call
 * re-resolves the live contract, rejects workspace shadows/drift, and supplies
 * the current fingerprints to the external MCP session manager.
 */
export class TrustedMemoryRagAdapter {
  public constructor(private readonly extensions: ExtensionsService) {}

  public async recall(
    query: string,
    category?: string,
    limit?: number,
    signal?: AbortSignal,
  ): Promise<Result<unknown>> {
    return this.call('recall', {
      query,
      ...(category === undefined ? {} : { category }),
      ...(limit === undefined ? {} : { limit }),
    }, signal);
  }

  public async remember(content: string, category?: string, signal?: AbortSignal): Promise<Result<unknown>> {
    return this.call('remember', {
      content,
      ...(category === undefined ? {} : { category }),
    }, signal);
  }

  public async recordCompletedTurn(input: TrustedCompletedTurnInput, signal?: AbortSignal): Promise<Result<TrustedCompletedTurnResult>> {
    const contract = await this.resolveContract('remember_turn', signal);
    if (!contract.ok) return contract;
    if (!supportsTurnId(contract.value.inputSchema)) {
      return err(appError('CONFLICT', 'Trusted Thai-RAG remember_turn must support turn_id before reliable runtime persistence can run', true));
    }

    const roles = [
      { role: 'user' as const, content: input.userMessage },
      { role: 'assistant' as const, content: input.assistantMessage },
    ];
    const childTurnIds: string[] = [];
    let recorded = 0;
    for (const entry of roles) {
      const childTurnId = stableChildTurnId(input, entry.role);
      const persisted = await this.extensions.callMcpTool({
        server: THAI_RAG_SERVER,
        tool: 'remember_turn',
        arguments: {
          role: entry.role,
          content: entry.content,
          workspace: input.projectRoot,
          ...(input.summary === undefined ? {} : { summary: input.summary }),
          tags: input.tags ?? `runtime-turn,${input.sourceClient}`,
          turn_id: childTurnId,
        },
        descriptorFingerprint: contract.value.descriptorFingerprint,
        catalogFingerprint: contract.value.catalogFingerprint,
      }, signal);
      if (!persisted.ok) {
        return err(appError('CONFLICT', `Trusted Thai-RAG remember_turn failed for ${entry.role}: ${persisted.error.message}`, true));
      }
      childTurnIds.push(childTurnId);
      recorded += 1;
    }
    return ok({ recorded, childTurnIds });
  }

  private async call(tool: Exclude<TrustedThaiRagTool, 'remember_turn'>, arguments_: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<Result<unknown>> {
    const contract = await this.resolveContract(tool, signal);
    if (!contract.ok) return contract;
    const result = await this.extensions.callMcpTool({
      server: THAI_RAG_SERVER,
      tool,
      arguments: arguments_,
      descriptorFingerprint: contract.value.descriptorFingerprint,
      catalogFingerprint: contract.value.catalogFingerprint,
    }, signal);
    return result.ok
      ? result
      : err(appError('CONFLICT', `Trusted Thai-RAG ${tool} failed: ${result.error.message}`, true));
  }

  private async resolveContract(tool: TrustedThaiRagTool, signal?: AbortSignal): Promise<Result<TrustedThaiRagContract>> {
    const described = await this.extensions.describeMcpServer({ server: THAI_RAG_SERVER }, signal);
    if (!described.ok) {
      return err(appError('CONFLICT', `Trusted Thai-RAG inspection failed: ${described.error.message}`, true));
    }
    if (!described.value.connected) {
      return err(appError('CONFLICT', 'Trusted Thai-RAG mandatory dependency is offline', true));
    }
    if (described.value.provenance.source.startsWith('workspace-')) {
      return err(appError('PERMISSION_DENIED', 'Refusing to use a workspace-scoped MCP server for the trusted Thai-RAG adapter'));
    }
    if (described.value.provenance.drift.detected) {
      return err(appError('CONFLICT', 'Trusted Thai-RAG contract drift was detected; reconcile the mandatory child before retrying', true));
    }
    const capability = described.value.tools.find((entry) => entry.name === tool);
    if (capability === undefined) {
      return err(appError('CONFLICT', `Trusted Thai-RAG capability is unavailable: ${tool}`, true));
    }
    return ok({
      descriptorFingerprint: described.value.provenance.descriptorFingerprint,
      catalogFingerprint: described.value.provenance.catalogFingerprint,
      ...(capability.inputSchema === undefined ? {} : { inputSchema: capability.inputSchema }),
    });
  }
}

function supportsTurnId(inputSchema: unknown): boolean {
  if (!isRecord(inputSchema) || !isRecord(inputSchema.properties)) return false;
  return Object.prototype.hasOwnProperty.call(inputSchema.properties, 'turn_id');
}

function stableChildTurnId(input: TrustedCompletedTurnInput, role: 'user' | 'assistant'): string {
  return `turn_umcp_${createHash('sha256')
    .update(JSON.stringify(['trusted-memory-rag-v1', input.sessionId, input.projectId, input.turnId, role]))
    .digest('hex')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
