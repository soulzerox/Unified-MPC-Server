import { describe, expect, it } from 'vitest';
import { ok, type Result } from '@unified-mpc/domain';
import type { ExtensionsService } from '@unified-mpc/extensions';
import { TrustedMemoryRagAdapter } from './trusted-memory-rag-adapter.js';

function extensions(overrides: Partial<ExtensionsService> = {}): ExtensionsService {
  const described = {
    server: 'thai-rag-mcp',
    enabled: true,
    connected: true,
    provenance: {
      source: 'antigravity-fallback',
      trustTier: 'external' as const,
      namespace: 'mcp:thai-rag-mcp',
      descriptorFingerprint: 'd'.repeat(64),
      catalogFingerprint: 'c'.repeat(64),
      drift: { detected: false, reasons: [] as const },
    },
    tools: [
      { name: 'recall', qualifiedName: 'mcp:thai-rag-mcp/recall', description: '', inputSchema: { type: 'object' } },
      { name: 'remember', qualifiedName: 'mcp:thai-rag-mcp/remember', description: '', inputSchema: { type: 'object' } },
      { name: 'remember_turn', qualifiedName: 'mcp:thai-rag-mcp/remember_turn', description: '', inputSchema: { type: 'object', properties: { turn_id: { type: 'string' } } } },
    ],
  };
  return {
    listSkills: async () => ok({ skills: [] }),
    readSkill: async () => ok({} as never),
    listMcpServers: async () => ok({ servers: [] }),
    runtimePolicySnapshot: async () => ok({ ready: true, policies: [] }),
    bootstrapMandatoryMcpServers: async () => ok({ ready: true, servers: [] }),
    describeMcpServer: async () => ok(described),
    listMcpResources: async () => ok({ server: 'thai-rag-mcp', enabled: true, connected: true, resources: [] }),
    callMcpTool: async (): Promise<Result<unknown>> => ok({}),
    close: async () => undefined,
    ...overrides,
  };
}

describe('TrustedMemoryRagAdapter', () => {
  it('dispatches only the fixed recall/remember tools with live fingerprints', async () => {
    const calls: Array<{ server: string; tool: string; arguments?: Readonly<Record<string, unknown>>; descriptorFingerprint?: string; catalogFingerprint?: string }> = [];
    const adapter = new TrustedMemoryRagAdapter(extensions({
      callMcpTool: async (input) => { calls.push(input); return ok({ accepted: true }); },
    }));

    expect((await adapter.recall('architecture', 'project', 4)).ok).toBe(true);
    expect((await adapter.remember('distilled decision', 'decision')).ok).toBe(true);
    expect(calls.map((call) => call.tool)).toEqual(['recall', 'remember']);
    expect(calls.every((call) => call.server === 'thai-rag-mcp')).toBe(true);
    expect(calls.every((call) => call.descriptorFingerprint === 'd'.repeat(64))).toBe(true);
    expect(calls.every((call) => call.catalogFingerprint === 'c'.repeat(64))).toBe(true);
  });

  it('fails closed on workspace-scoped or drifted Thai-RAG contracts', async () => {
    let dispatches = 0;
    const workspaceAdapter = new TrustedMemoryRagAdapter(extensions({
      describeMcpServer: async () => ok({
        server: 'thai-rag-mcp', enabled: true, connected: true,
        provenance: { source: 'workspace-settings', trustTier: 'external', namespace: 'mcp:thai-rag-mcp', descriptorFingerprint: 'd'.repeat(64), catalogFingerprint: 'c'.repeat(64), drift: { detected: false, reasons: [] } },
        tools: [{ name: 'recall', qualifiedName: 'mcp:thai-rag-mcp/recall', description: '' }],
      }),
      callMcpTool: async () => { dispatches += 1; return ok({}); },
    }));
    expect((await workspaceAdapter.recall('x')).ok).toBe(false);

    const driftAdapter = new TrustedMemoryRagAdapter(extensions({
      describeMcpServer: async () => ok({
        server: 'thai-rag-mcp', enabled: true, connected: true,
        provenance: { source: 'antigravity-fallback', trustTier: 'external', namespace: 'mcp:thai-rag-mcp', descriptorFingerprint: 'd'.repeat(64), catalogFingerprint: 'c'.repeat(64), drift: { detected: true, reasons: ['tool_catalog'] } },
        tools: [{ name: 'remember', qualifiedName: 'mcp:thai-rag-mcp/remember', description: '' }],
      }),
      callMcpTool: async () => { dispatches += 1; return ok({}); },
    }));
    expect((await driftAdapter.remember('x')).ok).toBe(false);
    expect(dispatches).toBe(0);
  });

  it('records a completed turn with deterministic child idempotency keys for both roles', async () => {
    const childTurnIds: string[] = [];
    const adapter = new TrustedMemoryRagAdapter(extensions({
      callMcpTool: async (input) => {
        if (input.tool === 'remember_turn') childTurnIds.push(String(input.arguments?.turn_id));
        return ok({});
      },
    }));
    const turn = {
      sessionId: 'session-a', turnId: 'turn-42', projectId: 'workspace-a', projectRoot: '/workspace/a',
      userMessage: 'hello', assistantMessage: 'world', sourceClient: 'cline',
    };

    expect((await adapter.recordCompletedTurn(turn)).ok).toBe(true);
    expect((await adapter.recordCompletedTurn(turn)).ok).toBe(true);
    expect(childTurnIds).toHaveLength(4);
    expect(childTurnIds[0]).toBe(childTurnIds[2]);
    expect(childTurnIds[1]).toBe(childTurnIds[3]);
    expect(childTurnIds[0]).not.toBe(childTurnIds[1]);
  });

  it('refuses reliable completed-turn persistence when child turn_id idempotency is unavailable', async () => {
    let dispatches = 0;
    const adapter = new TrustedMemoryRagAdapter(extensions({
      describeMcpServer: async () => ok({
        server: 'thai-rag-mcp', enabled: true, connected: true,
        provenance: { source: 'antigravity-fallback', trustTier: 'external', namespace: 'mcp:thai-rag-mcp', descriptorFingerprint: 'd'.repeat(64), catalogFingerprint: 'c'.repeat(64), drift: { detected: false, reasons: [] } },
        tools: [{ name: 'remember_turn', qualifiedName: 'mcp:thai-rag-mcp/remember_turn', description: '', inputSchema: { type: 'object', properties: {} } }],
      }),
      callMcpTool: async () => { dispatches += 1; return ok({}); },
    }));
    const result = await adapter.recordCompletedTurn({
      sessionId: 'session-a', turnId: 'turn-1', projectId: 'workspace-a', projectRoot: '/workspace/a',
      userMessage: 'u', assistantMessage: 'a', sourceClient: 'cline',
    });
    expect(result.ok).toBe(false);
    expect(dispatches).toBe(0);
  });
});
