import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { ok } from '@unified-mpc/domain';
import { permissionProfiles, type PermissionProfile } from '@unified-mpc/permissions';
import { DEFAULT_DESTRUCTIVE_AUTO_APPROVAL_POLICY, type DestructiveAutoApprovalPolicy } from '@unified-mpc/shared';
import { ToolRegistry, type McpApplicationServices, type WorkspaceScope } from './tool-registry.js';

const actor = { clientId: 'host-approval', clientName: 'host-approval-test' };
const activeScope = async (): Promise<WorkspaceScope | null> => ({ workspaceId: 'workspace-a', rootPath: path.resolve(tmpdir(), 'unified-mpc-approval-fixture') });
const balancedProfile = (): PermissionProfile => permissionProfiles.balanced;

describe('mandatory independent host approval', () => {
  it.each([
    ['write_file overwrite', 'write_file', { workspaceId: 'workspace-a', path: 'existing.txt', content: 'next', overwriteExisting: true, userConfirmed: true }],
    ['codex_run', 'codex_run', { workspaceId: 'workspace-a', instruction: 'edit the project', userConfirmed: true }],
    ['agent_swarm_run start', 'agent_swarm_run', { operation: 'start', workspaceId: 'workspace-a', idempotencyKey: '22222222-2222-4222-8222-222222222222', accessMode: 'read_only', tasks: [{ id: 'inspect', prompt: 'Inspect only.' }], userConfirmed: true }],
    ['mcp_call', 'mcp_call', { server: 'child', tool: 'write', arguments: { path: 'x' }, userConfirmed: true }],
  ] as const)('denies %s when no trusted host approval provider exists', async (_label, tool, input) => {
    const calls: string[] = [];
    const registry = new ToolRegistry(servicesWithCalls(calls), actor, {
      activeWorkspaceScopeProvider: activeScope,
      profileProvider: balancedProfile,
      codexToolsEnabled: true,
    });

    const response = await registry.invoke(tool, input);

    expect(response).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'PERMISSION_DENIED', message: expect.stringContaining('Host exact-action approval') } },
    });
    expect(calls).toEqual([]);
  });

  it.each([
    ['shell inline Node editor', 'shell', { workspaceId: 'workspace-a', operation: 'run', executable: 'node.exe', arguments: ['-e', "const fs=require('fs'); const p='src/a.ts'; fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('a', 'b'))"] }],
    ['process_start inline PowerShell editor', 'process_start', { workspaceId: 'workspace-a', executable: 'powershell.exe', args: ['-NoProfile', '-Command', "Set-Content -LiteralPath 'src/a.ts' -Value 'next'"] }],
  ] as const)('rejects misrouted text editor %s before native approval is requested', async (_label, tool, input) => {
    const calls: string[] = [];
    const approvals: string[] = [];
    const registry = new ToolRegistry(servicesWithCalls(calls), actor, {
      activeWorkspaceScopeProvider: activeScope,
      profileProvider: balancedProfile,
      hostMutationApprovalProvider: async (): Promise<boolean> => { approvals.push(tool); return true; },
    });

    const response = await registry.invoke(tool, input);

    expect(response).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'PERMISSION_DENIED', message: expect.stringContaining('Use edit_file') } },
    });
    expect(approvals).toEqual([]);
    expect(calls).toEqual([]);
  });

  it.each([
    ['process_start', 'process_start', { workspaceId: 'workspace-a', executable: 'node.exe', args: ['script.js'] }],
    ['shell real run', 'shell', { workspaceId: 'workspace-a', operation: 'run', executable: 'node.exe', arguments: ['script.js'] }],
  ] as const)('allows ordinary %s without a native host approval provider', async (_label, tool, input) => {
    const calls: string[] = [];
    const registry = new ToolRegistry(servicesWithCalls(calls), actor, { activeWorkspaceScopeProvider: activeScope, profileProvider: balancedProfile });
    const response = await registry.invoke(tool, input);
    expect(response.isError).not.toBe(true);
    expect(calls).toEqual([tool]);
  });

  it('uses curated Thai-RAG recall and remember without native host approval or caller-managed fingerprints', async () => {
    const nativeCalls: Array<{ tool: string; arguments: Readonly<Record<string, unknown>> }> = [];
    const approvals: string[] = [];
    const services = servicesWithCalls([]);
    services.thaiRag = {
      health: async (): Promise<ReturnType<typeof ok>> => ok({ providerId: 'thai-rag', state: 'ready', embeddingIndexGeneration: 1 }),
      call: async (tool, args): Promise<ReturnType<typeof ok>> => {
        nativeCalls.push({ tool, arguments: args });
        return ok({ result: tool === 'recall' ? 'matched memory' : 'stored memory' });
      },
    };
    const registry = new ToolRegistry(services, actor, {
      activeWorkspaceScopeProvider: activeScope,
      profileProvider: (): PermissionProfile => permissionProfiles.safe,
      hostMutationApprovalProvider: async (request): Promise<boolean> => { approvals.push(request.toolName); return false; },
    });

    const recalled = await registry.invoke('rag_recall', { workspaceId: 'workspace-a', query: 'architecture decision', category: 'decision', limit: 5 });
    const remembered = await registry.invoke('rag_remember', { workspaceId: 'workspace-a', content: 'Prefer native curated RAG operations.', category: 'decision' });

    expect(recalled.isError).not.toBe(true);
    expect(remembered.isError).not.toBe(true);
    expect(approvals).toEqual([]);
    expect(nativeCalls).toEqual([
      { tool: 'recall', arguments: { query: '[decision] architecture decision', category: 'workspace:workspace-a', limit: 5 } },
      { tool: 'remember', arguments: { content: '[decision] Prefer native curated RAG operations.', category: 'workspace:workspace-a' } },
    ]);
  });

  it('scopes native Thai-RAG forget to the active workspace category', async () => {
    const nativeCalls: Array<{ tool: string; arguments: Readonly<Record<string, unknown>> }> = [];
    const services = servicesWithCalls([]);
    services.thaiRag = {
      health: async (): Promise<ReturnType<typeof ok>> => ok({ providerId: 'thai-rag', state: 'ready', embeddingIndexGeneration: 1 }),
      call: async (tool, args): Promise<ReturnType<typeof ok>> => {
        nativeCalls.push({ tool, arguments: args });
        return ok({ result: 'deleted' });
      },
    };
    const registry = new ToolRegistry(services, actor, {
      activeWorkspaceScopeProvider: activeScope,
      profileProvider: balancedProfile,
      hostMutationApprovalProvider: async (): Promise<boolean> => true,
    });

    const result = await registry.invoke('rag_forget', { workspaceId: 'workspace-a', memoryId: 'memory-1', userConfirmed: true });

    expect(result.isError).not.toBe(true);
    expect(nativeCalls).toEqual([{
      tool: 'forget',
      arguments: { memory_id: 'memory-1', category: 'workspace:workspace-a' },
    }]);
  });

  it('allows an exact parent-policy read-only child MCP call without native host approval', async () => {
    const calls: string[] = [];
    const descriptorFingerprint = 'a'.repeat(64);
    const catalogFingerprint = 'b'.repeat(64);
    const services = servicesWithCalls(calls);
    services.extensions = {
      ...services.extensions,
      async runtimePolicySnapshot() {
        return ok({ ready: true, policies: [{
          priority: 'P1', id: 'child:readonly', resourceId: 'child', resolvedResourceId: 'child', resourceType: 'server',
          mandatory: false, enforcement: 'AUTO_ROUTE', directive: 'Use safe child reads.', source: 'configured', available: true,
          readOnlyTools: ['search'],
        }] });
      },
      async describeMcpServer() {
        return ok({
          server: 'child', enabled: true, connected: true,
          provenance: { source: 'test', trustTier: 'external', namespace: 'mcp:child', descriptorFingerprint, catalogFingerprint, drift: { detected: false, reasons: [] } },
          tools: [{ name: 'search', qualifiedName: 'mcp:child/search', description: 'Search' }],
        });
      },
    } as McpApplicationServices['extensions'];
    const registry = new ToolRegistry(services, actor, { activeWorkspaceScopeProvider: activeScope, profileProvider: balancedProfile });

    const response = await registry.invoke('mcp_call', {
      server: 'child', tool: 'search', arguments: { query: 'needle' }, descriptorFingerprint, catalogFingerprint,
    });

    expect(response.isError).not.toBe(true);
    expect(calls).toEqual(['mcp_call']);
  });

  it('does not let an auto-discovered policy authorize a read-only child MCP downgrade', async () => {
    const calls: string[] = [];
    const descriptorFingerprint = 'a'.repeat(64);
    const catalogFingerprint = 'b'.repeat(64);
    const services = servicesWithCalls(calls);
    services.extensions = {
      ...services.extensions,
      async runtimePolicySnapshot() {
        return ok({ ready: true, policies: [{
          priority: 'P1', id: 'auto:server:child', resourceId: 'child', resolvedResourceId: 'child', resourceType: 'server',
          mandatory: false, enforcement: 'AUTO_ROUTE', directive: 'Discovered child.', source: 'discovered', available: true,
          readOnlyTools: ['search'],
        }] });
      },
      async describeMcpServer() {
        return ok({
          server: 'child', enabled: true, connected: true,
          provenance: { source: 'test', trustTier: 'external', namespace: 'mcp:child', descriptorFingerprint, catalogFingerprint, drift: { detected: false, reasons: [] } },
          tools: [{ name: 'search', qualifiedName: 'mcp:child/search', description: 'Search' }],
        });
      },
    } as McpApplicationServices['extensions'];
    const registry = new ToolRegistry(services, actor, { activeWorkspaceScopeProvider: activeScope, profileProvider: balancedProfile });

    const response = await registry.invoke('mcp_call', {
      server: 'child', tool: 'search', arguments: {}, descriptorFingerprint, catalogFingerprint, userConfirmed: true,
    });

    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_DENIED', message: expect.stringContaining('Host exact-action approval') } } });
    expect(calls).toEqual([]);
  });

  it('keeps a parent-policy child read fail-closed when the supplied live contract is stale', async () => {
    const calls: string[] = [];
    const services = servicesWithCalls(calls);
    services.extensions = {
      ...services.extensions,
      async runtimePolicySnapshot() {
        return ok({ ready: true, policies: [{
          priority: 'P1', id: 'child:readonly', resourceId: 'child', resolvedResourceId: 'child', resourceType: 'server',
          mandatory: false, enforcement: 'AUTO_ROUTE', directive: 'Use safe child reads.', source: 'configured', available: true,
          readOnlyTools: ['search'],
        }] });
      },
      async describeMcpServer() {
        return ok({
          server: 'child', enabled: true, connected: true,
          provenance: { source: 'test', trustTier: 'external', namespace: 'mcp:child', descriptorFingerprint: 'c'.repeat(64), catalogFingerprint: 'd'.repeat(64), drift: { detected: false, reasons: [] } },
          tools: [{ name: 'search', qualifiedName: 'mcp:child/search', description: 'Search' }],
        });
      },
    } as McpApplicationServices['extensions'];
    const registry = new ToolRegistry(services, actor, { activeWorkspaceScopeProvider: activeScope, profileProvider: balancedProfile });

    const response = await registry.invoke('mcp_call', {
      server: 'child', tool: 'search', arguments: {}, descriptorFingerprint: 'a'.repeat(64), catalogFingerprint: 'b'.repeat(64), userConfirmed: true,
    });

    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_DENIED', message: expect.stringContaining('Host exact-action approval') } } });
    expect(calls).toEqual([]);
  });

  it('offers one trusted-session approval scope for Playwright instead of prompting every opaque action', async () => {
    const requests: import('./tool-registry.js').HostMutationApprovalRequest[] = [];
    const descriptorFingerprint = 'a'.repeat(64);
    const catalogFingerprint = 'b'.repeat(64);
    const registry = new ToolRegistry(servicesWithCalls([]), { ...actor, sessionId: 'session-a' }, {
      sessionId: 'session-a',
      activeWorkspaceScopeProvider: activeScope,
      profileProvider: balancedProfile,
      hostMutationApprovalProvider: async (request): Promise<boolean> => { requests.push(request); return false; },
    });

    await registry.invoke('mcp_call', {
      server: 'playwright',
      tool: 'browser_click',
      arguments: { element: 'Save', ref: 'e17' },
      descriptorFingerprint,
      catalogFingerprint,
      userConfirmed: true,
      goalLease: { goalId: 'goal-1', leaseToken: 'private-token', leaseGeneration: 7 },
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.approvalScope).toMatchObject({
      kind: 'automation_session',
      id: expect.any(String),
      label: expect.stringContaining('Playwright'),
    });
    expect(requests[0]?.approvalScope).not.toHaveProperty('ttlMs');
    expect(requests[0]?.approvalScope).not.toHaveProperty('maxUses');
  });

  it('keeps the same Playwright approval scope when only the durable lease generation changes inside one trusted session', async () => {
    const requests: import('./tool-registry.js').HostMutationApprovalRequest[] = [];
    const registry = new ToolRegistry(servicesWithCalls([]), { ...actor, sessionId: 'session-a' }, {
      sessionId: 'session-a',
      activeWorkspaceScopeProvider: activeScope,
      profileProvider: balancedProfile,
      hostMutationApprovalProvider: async (request): Promise<boolean> => { requests.push(request); return false; },
    });
    const base = {
      server: 'playwright', tool: 'browser_type', arguments: { element: 'Name', text: 'Ada' },
      descriptorFingerprint: 'a'.repeat(64), catalogFingerprint: 'b'.repeat(64), userConfirmed: true,
    };

    await registry.invoke('mcp_call', { ...base, goalLease: { goalId: 'goal-1', leaseToken: 'token-a', leaseGeneration: 7 } });
    await registry.invoke('mcp_call', { ...base, goalLease: { goalId: 'goal-1', leaseToken: 'token-b', leaseGeneration: 8 } });

    expect(requests).toHaveLength(2);
    expect(requests[0]?.approvalScope?.id).toBe(requests[1]?.approvalScope?.id);
  });

  it('changes the Playwright approval scope when the trusted host session changes', async () => {
    const requests: import('./tool-registry.js').HostMutationApprovalRequest[] = [];
    const base = {
      server: 'playwright', tool: 'browser_click', arguments: { element: 'Save', ref: 'e17' },
      descriptorFingerprint: 'a'.repeat(64), catalogFingerprint: 'b'.repeat(64), userConfirmed: true,
    };
    for (const sessionId of ['session-a', 'session-b']) {
      const registry = new ToolRegistry(servicesWithCalls([]), { ...actor, sessionId }, {
        sessionId,
        activeWorkspaceScopeProvider: activeScope,
        profileProvider: balancedProfile,
        hostMutationApprovalProvider: async (request): Promise<boolean> => { requests.push(request); return false; },
      });
      await registry.invoke('mcp_call', base);
    }

    expect(requests).toHaveLength(2);
    expect(requests[0]?.approvalScope?.id).not.toBe(requests[1]?.approvalScope?.id);
  });

  it('never grants automation-session scope to destructive child MCP actions or unrelated child servers', async () => {
    const requests: import('./tool-registry.js').HostMutationApprovalRequest[] = [];
    const registry = new ToolRegistry(servicesWithCalls([]), actor, {
      activeWorkspaceScopeProvider: activeScope,
      profileProvider: balancedProfile,
      hostMutationApprovalProvider: async (request): Promise<boolean> => { requests.push(request); return false; },
    });
    const contract = { descriptorFingerprint: 'a'.repeat(64), catalogFingerprint: 'b'.repeat(64), userConfirmed: true };

    await registry.invoke('mcp_call', { server: 'playwright', tool: 'browser_delete', arguments: {}, ...contract });
    await registry.invoke('mcp_call', { server: 'filesystem', tool: 'write_file', arguments: { path: 'a.txt' }, ...contract });

    expect(requests).toHaveLength(2);
    expect(requests[0]?.approvalScope).toBeUndefined();
    expect(requests[1]?.approvalScope).toBeUndefined();
  });

  it.each([
    ['scheduler run', 'scheduler', { action: 'run', task_name: 'UnifiedMpcTask', userConfirmed: true }],
    ['scheduler delete', 'scheduler', { action: 'delete', task_name: 'UnifiedMpcTask', userConfirmed: true }],
    ['hook removal', 'hook_remove', { name: 'audit', userConfirmed: true }],
    ['worktree removal', 'git_worktree_remove', { workspaceId: 'workspace-a', worktreePath: '.worktrees/agent-1', dryRun: false, userConfirmed: true }],
    ['self-heal apply', 'self_heal_apply', { workspaceId: 'workspace-a', planId: 'reviewed-plan', dryRun: false, userConfirmed: true }],
  ] as const)('denies destructive administrative operation %s without native host approval', async (_label, tool, input) => {
    const calls: string[] = [];
    const registry = new ToolRegistry(servicesWithCalls(calls), actor, {
      activeWorkspaceScopeProvider: activeScope,
      profileProvider: balancedProfile,
    });

    const response = await registry.invoke(tool, input);

    expect(response).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'PERMISSION_DENIED', message: expect.stringContaining('Host exact-action approval') } },
    });
    expect(calls).toEqual([]);
  });

  it('allows exact recoverable auto-approved delete_file without a host prompt only inside the active workspace', async () => {
    const calls: string[] = [];
    const policy: DestructiveAutoApprovalPolicy = {
      ...DEFAULT_DESTRUCTIVE_AUTO_APPROVAL_POLICY,
      approvals: { ...DEFAULT_DESTRUCTIVE_AUTO_APPROVAL_POLICY.approvals, delete_file: true },
    };
    const registry = new ToolRegistry(servicesWithCalls(calls), actor, {
      activeWorkspaceScopeProvider: activeScope,
      destructivePolicyProvider: (): DestructiveAutoApprovalPolicy => policy,
    });

    const response = await registry.invoke('delete_file', { workspaceId: 'workspace-a', path: 'tmp.txt' });

    expect(response.isError).not.toBe(true);
    expect(calls).toEqual(['delete_file']);
  });
});

function servicesWithCalls(calls: string[]): McpApplicationServices {
  return {
    file: {
      async writeFile(): Promise<ReturnType<typeof ok>> { calls.push('write_file'); return ok({ path: 'existing.txt' }); },
      async deleteFile(): Promise<ReturnType<typeof ok>> { calls.push('delete_file'); return ok({ path: 'tmp.txt', recoveryId: 'recovery-1', recoverable: true }); },
    } as McpApplicationServices['file'],
    process: {
      async start(): Promise<ReturnType<typeof ok>> { calls.push('process_start'); return ok({ processId: 'process-1' }); },
    } as McpApplicationServices['process'],
    codex: {
      async run(): Promise<ReturnType<typeof ok>> { calls.push('codex_run'); return ok({ codexTaskId: 'codex-1' }); },
    } as McpApplicationServices['codex'],
    agentSwarm: {
      async start(): Promise<ReturnType<typeof ok>> { calls.push('agent_swarm_run'); return ok({ swarmId: '11111111-1111-4111-8111-111111111111', state: 'running', tasks: [] }); },
      async status(): Promise<ReturnType<typeof ok>> { return ok({ swarmId: '11111111-1111-4111-8111-111111111111', state: 'running', tasks: [] }); },
      async result(): Promise<ReturnType<typeof ok>> { return ok({ swarmId: '11111111-1111-4111-8111-111111111111', taskId: 'inspect', state: 'completed', text: '', eof: true, outputTruncated: false }); },
      async cancel(): Promise<ReturnType<typeof ok>> { calls.push('agent_swarm_run'); return ok({ swarmId: '11111111-1111-4111-8111-111111111111', state: 'cancelled', tasks: [] }); },
      async list(): Promise<ReturnType<typeof ok>> { return ok({ items: [] }); },
    } as McpApplicationServices['agentSwarm'],
    capabilities: {
      async execute(tool): Promise<ReturnType<typeof ok>> { calls.push(tool); return ok({ task_id: 'task-1', state: 'running' }); },
    },
    extensions: {
      async callMcpTool(): Promise<ReturnType<typeof ok>> { calls.push('mcp_call'); return ok({ ok: true }); },
    } as McpApplicationServices['extensions'],
  };
}
