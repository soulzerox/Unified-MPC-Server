import { describe, expect, it } from 'vitest';
import { appError, err, ok } from '@unified-mpc/domain';
import { ToolRegistry, type McpApplicationServices, type WorkspaceScope } from './tool-registry.js';
import { HarnessActivationLedger } from './harness-runtime.js';

const actor = { clientId: 'client-harness', clientName: 'Harness test', sessionId: 'session-harness' };
const activeWorkspaceScopeProvider = async (): Promise<WorkspaceScope> => ({ workspaceId: 'workspace-1', rootPath: '/tmp/workspace-1' });

function createHarnessServices(): { services: McpApplicationServices; writes: string[]; childCalls: string[]; nativeRagCalls: string[]; nativeRagArguments: Array<{ tool: string; args: Readonly<Record<string, unknown>> }>; bootstrapEvents: string[]; setAgentsMd(content: string): void } {
  const writes: string[] = [];
  const childCalls: string[] = [];
  const nativeRagCalls: string[] = [];
  const nativeRagArguments: Array<{ tool: string; args: Readonly<Record<string, unknown>> }> = [];
  const bootstrapEvents: string[] = [];
  let agentsMd = '# Rules\nUse mandatory child MCP preflight.\n';
  const services = {
    file: {
      async readFile(_actor: unknown, _workspaceId: string, request: { path: string }) {
        if (request.path === 'AGENTS.md') return ok({ path: request.path, content: agentsMd, startLine: 1, endLine: 2 });
        return err(appError('FILE_NOT_FOUND', `missing ${request.path}`));
      },
      async writeFile(_actor: unknown, _workspaceId: string, request: { path: string }) {
        writes.push(request.path);
        return ok({ path: request.path, replacedExisting: false });
      },
    },
    thaiRag: {
      async health() {
        return ok({
          providerId: 'thai-rag' as const,
          state: 'ready',
          embeddingIndexGeneration: 1,
          components: {
            workerReachable: true,
            sqliteAvailable: true,
            ftsAvailable: true,
            vectorStoreAvailable: true,
            embedderAvailable: true,
            lexicalRetrievalAvailable: true,
            semanticRetrievalAvailable: true,
            activeJobs: [],
          },
        });
      },
      async call(tool: string, args: Readonly<Record<string, unknown>>) {
        nativeRagCalls.push(tool);
        nativeRagArguments.push({ tool, args });
        return ok({ content: [{ type: 'text', text: 'ok' }] });
      },
    },
    extensions: {
      async runtimePolicySnapshot() {
        bootstrapEvents.push('policy_snapshot');
        return ok({ ready: true, policies: [{
          priority: 'P1', id: 'session-start:ask-matt', resourceId: 'ask-matt', resolvedResourceId: 'agents-skills/ask-matt',
          resourceType: 'skill', mandatory: true, enforcement: 'EVERY_SESSION', directive: 'Load ask-matt.', source: 'configured', available: true,
        }] });
      },
      async readSkill(input: { skillId: string }) {
        bootstrapEvents.push(`skill_load:${input.skillId}`);
        return ok({ id: input.skillId, name: 'ask-matt', description: 'Router', source: 'agents-skills', path: '/skills/ask-matt/SKILL.md', content: '# Ask Matt\nUse diagnosing-bugs for hard bugs.' });
      },
      async bootstrapMandatoryMcpServers() {
        bootstrapEvents.push('mandatory_mcp');
        return ok({
          ready: true,
          servers: [
            { name: 'memory', required: true, connected: true, pinned: true, descriptorFingerprint: 'a'.repeat(64), catalogFingerprint: '1'.repeat(64), tools: ['search_nodes', 'create_entities', 'add_observations'], requiredTools: ['search_nodes', 'create_entities', 'add_observations'] },
          ],
        });
      },
      async describeMcpServer(input: { server: string }) {
        if (input.server !== 'godkiller') return err(appError('NOT_FOUND', `missing ${input.server}`));
        return ok({
          server: 'godkiller',
          enabled: true,
          connected: true,
          provenance: {
            source: 'antigravity-fallback',
            trustTier: 'external',
            namespace: 'mcp:godkiller',
            descriptorFingerprint: 'c'.repeat(64),
            catalogFingerprint: '3'.repeat(64),
            drift: { detected: false, reasons: [] },
          },
          tools: [{ name: 'gk_task', description: 'Safety analysis', inputSchema: { type: 'object' }, qualifiedName: 'mcp:godkiller/gk_task' }],
        });
      },
      async callMcpTool(input: { server: string; tool: string }) {
        childCalls.push(`${input.server}/${input.tool}`);
        if (input.server === 'memory' && input.tool === 'search_nodes') return ok({ structuredContent: { entities: [], relations: [] } });
        return ok({ content: [{ type: 'text', text: 'ok' }] });
      },
    },
  } as unknown as McpApplicationServices;
  return { services, writes, childCalls, nativeRagCalls, nativeRagArguments, bootstrapEvents, setAgentsMd(content: string): void { agentsMd = content; } };
}

describe('workspace engineering harness enforcement', () => {
  it('self-bootstraps and runs mandatory pre-edit checks when the host cannot call lifecycle tools explicitly', async () => {
    const { services, writes, childCalls, nativeRagCalls, nativeRagArguments, bootstrapEvents } = createHarnessServices();
    const registry = new ToolRegistry(services, actor, { harnessActivationLedger: new HarnessActivationLedger(), activeWorkspaceScopeProvider });

    const first = await registry.invoke('write_file', {
      workspaceId: 'workspace-1', path: 'src/app.ts', content: 'export const x = 1;\n',
    });
    expect(first.isError).not.toBe(true);
    expect(bootstrapEvents).toEqual(['policy_snapshot', 'skill_load:agents-skills/ask-matt', 'mandatory_mcp']);
    expect(childCalls).toEqual([]);
    expect(nativeRagCalls).toEqual(['pre_edit_context']);
    expect(nativeRagArguments[0]).toEqual({
      tool: 'pre_edit_context',
      args: { file_path: 'src/app.ts', workspace_id: 'workspace-1', workspace: 'workspace-1' },
    });
    expect(writes).toEqual(['src/app.ts']);

    const second = await registry.invoke('write_file', {
      workspaceId: 'workspace-1', path: 'src/app.ts', content: 'export const x = 2;\n',
    });
    expect(second.isError).not.toBe(true);
    expect(childCalls).toEqual([]);
    expect(nativeRagCalls).toEqual(['pre_edit_context', 'pre_edit_context']);
    expect(writes).toEqual(['src/app.ts', 'src/app.ts']);
  });

  it('preserves bootstrap and single-use prepared-path state across request-scoped registry recreation', async () => {
    const { services, writes, nativeRagCalls, nativeRagArguments } = createHarnessServices();
    const ledger = new HarnessActivationLedger();
    const options = { harnessActivationLedger: ledger, sessionId: 'shared-transport-session', activeWorkspaceScopeProvider };

    const bootstrapRegistry = new ToolRegistry(services, actor, options);
    expect((await bootstrapRegistry.invoke('workspace_bootstrap', { workspaceId: 'workspace-1' })).isError).not.toBe(true);

    const prepareRegistry = new ToolRegistry(services, actor, options);
    expect((await prepareRegistry.invoke('prepare_code_change', {
      workspaceId: 'workspace-1', filePath: 'src/shared.ts', proposedSymbol: 'shared',
    })).isError).not.toBe(true);
    expect(nativeRagCalls).toEqual(['pre_edit_context']);
    expect(nativeRagArguments).toEqual([{
      tool: 'pre_edit_context',
      args: { file_path: 'src/shared.ts', proposed_symbol: 'shared', workspace_id: 'workspace-1', workspace: 'workspace-1' },
    }]);

    const mutationRegistry = new ToolRegistry(services, actor, options);
    expect((await mutationRegistry.invoke('write_file', {
      workspaceId: 'workspace-1', path: 'src/shared.ts', content: 'export const shared = 1;\n',
    })).isError).not.toBe(true);
    expect(nativeRagCalls).toEqual(['pre_edit_context']);
    expect(writes).toEqual(['src/shared.ts']);

    const secondMutationRegistry = new ToolRegistry(services, actor, options);
    expect((await secondMutationRegistry.invoke('write_file', {
      workspaceId: 'workspace-1', path: 'src/shared.ts', content: 'export const shared = 2;\n',
    })).isError).not.toBe(true);
    expect(nativeRagCalls).toEqual(['pre_edit_context', 'pre_edit_context']);
    expect(writes).toEqual(['src/shared.ts', 'src/shared.ts']);
  });

  it('returns the preferred workspace goal as a non-leasing continuation hint during bootstrap', async () => {
    const { services } = createHarnessServices();
    (services as { preferredGoal?: McpApplicationServices['preferredGoal'] }).preferredGoal = {
      get: async (workspaceId: string): Promise<{ goalId: string; goalKey: string; objective: string; currentPhase: string; updatedAt: string } | null> => workspaceId === 'workspace-1' ? {
        goalId: 'goal-a',
        goalKey: 'project-goals',
        objective: 'Expose open goals in the Projects view.',
        currentPhase: 'frontend',
        updatedAt: '2026-09-16T01:00:00.000Z',
      } : null,
    };
    const registry = new ToolRegistry(services, actor, { harnessActivationLedger: new HarnessActivationLedger(), activeWorkspaceScopeProvider });

    await expect(registry.invoke('workspace_bootstrap', { workspaceId: 'workspace-1' })).resolves.toMatchObject({
      structuredContent: {
        ready: true,
        preferredGoal: {
          goalId: 'goal-a',
          goalKey: 'project-goals',
          currentPhase: 'frontend',
        },
      },
    });
  });

  it('runs the optional Godkiller safety check only when explicitly requested', async () => {
    const { services, childCalls } = createHarnessServices();
    const registry = new ToolRegistry(services, actor, { harnessActivationLedger: new HarnessActivationLedger(), activeWorkspaceScopeProvider });

    expect((await registry.invoke('workspace_bootstrap', { workspaceId: 'workspace-1' })).isError).not.toBe(true);
    const prepared = await registry.invoke('prepare_code_change', {
      workspaceId: 'workspace-1', filePath: 'src/risky.ts', proposedSymbol: 'migrateState', runGodkillerSafetyCheck: true,
    });

    expect(prepared).toMatchObject({
      structuredContent: {
        ready: true,
        filePath: 'src/risky.ts',
        checks: ['thai-rag/pre_edit_context', 'godkiller/gk_task'],
      },
    });
    expect(childCalls).toEqual(['godkiller/gk_task']);
  });

  it('refuses a workspace-scoped Godkiller shadow when optional safety analysis is requested', async () => {
    const { services, childCalls, nativeRagCalls } = createHarnessServices();
    const originalDescribe = services.extensions!.describeMcpServer.bind(services.extensions);
    services.extensions = {
      ...services.extensions,
      async describeMcpServer(input: { server: string }, signal?: AbortSignal) {
        const result = await originalDescribe(input, signal);
        if (!result.ok || input.server !== 'godkiller') return result;
        return ok({ ...result.value, provenance: { ...result.value.provenance, source: 'workspace-cursor' } });
      },
    } as typeof services.extensions;
    const registry = new ToolRegistry(services, actor, { harnessActivationLedger: new HarnessActivationLedger(), activeWorkspaceScopeProvider });

    expect((await registry.invoke('workspace_bootstrap', { workspaceId: 'workspace-1' })).isError).not.toBe(true);
    await expect(registry.invoke('prepare_code_change', {
      workspaceId: 'workspace-1', filePath: 'src/risky.ts', runGodkillerSafetyCheck: true,
    })).resolves.toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'PERMISSION_DENIED', message: expect.stringContaining('workspace-scoped Godkiller') } },
    });
    expect(childCalls).toEqual([]);
    expect(nativeRagCalls).toEqual(['pre_edit_context']);
  });

  it('fails closed when the workspace AGENTS.md harness cannot be loaded', async () => {
    const { services } = createHarnessServices();
    services.file = {
      ...services.file,
      async readFile(_actor: unknown, _workspaceId: string, request: { path: string }) {
        return err(appError('FILE_NOT_FOUND', `missing ${request.path}`));
      },
    } as typeof services.file;
    const registry = new ToolRegistry(services, actor, { harnessActivationLedger: new HarnessActivationLedger(), activeWorkspaceScopeProvider });

    await expect(registry.invoke('workspace_bootstrap', { workspaceId: 'workspace-1' })).resolves.toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'CONFLICT', message: expect.stringContaining('AGENTS.md') } },
    });
  });

  it('fails workspace bootstrap when a mandatory child lacks a required harness capability', async () => {
    const { services } = createHarnessServices();
    const originalBootstrap = services.extensions!.bootstrapMandatoryMcpServers.bind(services.extensions);
    services.extensions = {
      ...services.extensions,
      async bootstrapMandatoryMcpServers(signal?: AbortSignal) {
        const result = await originalBootstrap(signal);
        if (!result.ok) return result;
        return ok({
          ...result.value,
          servers: result.value.servers.map((server) => server.name === 'memory' ? { ...server, tools: [] } : server),
        });
      },
    } as typeof services.extensions;
    const registry = new ToolRegistry(services, actor, { harnessActivationLedger: new HarnessActivationLedger(), activeWorkspaceScopeProvider });

    await expect(registry.invoke('workspace_bootstrap', { workspaceId: 'workspace-1' })).resolves.toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'CONFLICT', message: expect.stringContaining('search_nodes') } },
    });
  });

  it('enforces required child capabilities declared by runtime policy instead of a hardcoded server-name map', async () => {
    const { services } = createHarnessServices();
    services.extensions = {
      ...services.extensions,
      async bootstrapMandatoryMcpServers() {
        return ok({
          ready: true,
          servers: [{
            name: 'custom-policy-server',
            required: true,
            connected: true,
            pinned: true,
            descriptorFingerprint: 'd'.repeat(64),
            catalogFingerprint: '4'.repeat(64),
            requiredTools: ['custom-capability'],
            tools: [],
          }],
        });
      },
    } as typeof services.extensions;
    const registry = new ToolRegistry(services, actor, { harnessActivationLedger: new HarnessActivationLedger(), activeWorkspaceScopeProvider });
    await expect(registry.invoke('workspace_bootstrap', { workspaceId: 'workspace-1' })).resolves.toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'CONFLICT', message: expect.stringContaining('custom-capability') } },
    });
  });

  it('exposes curated native working-memory tools after bootstrap', async () => {
    const { services, nativeRagCalls } = createHarnessServices();
    const registry = new ToolRegistry(services, actor, {
      harnessActivationLedger: new HarnessActivationLedger(),
      activeWorkspaceScopeProvider: async (): Promise<{ readonly workspaceId: string; readonly rootPath: string }> => ({ workspaceId: 'workspace-1', rootPath: '/tmp/workspace-1' }),
    });

    expect((await registry.invoke('workspace_bootstrap', { workspaceId: 'workspace-1' })).isError).not.toBe(true);
    const searched = await registry.invoke('working_memory_search', { workspaceId: 'workspace-1', query: 'current task' });
    expect(searched.isError).not.toBe(true);
    const recorded = await registry.invoke('working_memory_record', {
      workspaceId: 'workspace-1',
      name: 'goal:workspace-1',
      observations: ['Implemented harness bootstrap'],
    });
    expect(recorded.isError).not.toBe(true);
    expect(nativeRagCalls).toEqual(['recall', 'remember']);
  });

  it('re-bootstraps and re-runs pre-edit checks when AGENTS.md changes', async () => {
    const { services, setAgentsMd, writes, childCalls, nativeRagCalls, bootstrapEvents } = createHarnessServices();
    const registry = new ToolRegistry(services, actor, { harnessActivationLedger: new HarnessActivationLedger(), activeWorkspaceScopeProvider });

    expect((await registry.invoke('write_file', {
      workspaceId: 'workspace-1', path: 'src/app.ts', content: 'export const before = true;\n',
    })).isError).not.toBe(true);
    setAgentsMd('# Rules\nChanged policy.\n');

    const changed = await registry.invoke('write_file', {
      workspaceId: 'workspace-1', path: 'src/app.ts', content: 'export const changed = true;\n',
    });
    expect(changed.isError).not.toBe(true);
    expect(writes).toEqual(['src/app.ts', 'src/app.ts']);
    expect(childCalls).toEqual([]);
    expect(nativeRagCalls).toEqual(['pre_edit_context', 'pre_edit_context']);
    expect(bootstrapEvents.filter((entry) => entry === 'mandatory_mcp')).toHaveLength(2);
  });
});
