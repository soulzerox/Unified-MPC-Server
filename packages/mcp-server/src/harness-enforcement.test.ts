import { describe, expect, it } from 'vitest';
import { appError, err, ok } from '@unified-mpc/domain';
import { ToolRegistry, type McpApplicationServices } from './tool-registry.js';
import { HarnessActivationLedger } from './harness-runtime.js';

const actor = { clientId: 'client-harness', clientName: 'Harness test', sessionId: 'session-harness' };

function createHarnessServices(): { services: McpApplicationServices; writes: string[]; childCalls: string[]; bootstrapEvents: string[]; setAgentsMd(content: string): void } {
  const writes: string[] = [];
  const childCalls: string[] = [];
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
            { name: 'thai-rag-mcp', required: true, connected: true, pinned: true, descriptorFingerprint: 'b'.repeat(64), catalogFingerprint: '2'.repeat(64), tools: ['pre_edit_context'], requiredTools: ['pre_edit_context'] },
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
  return { services, writes, childCalls, bootstrapEvents, setAgentsMd(content: string): void { agentsMd = content; } };
}

describe('workspace engineering harness enforcement', () => {
  it('blocks code mutation until workspace bootstrap and pre-edit checks succeed', async () => {
    const { services, writes, childCalls, bootstrapEvents } = createHarnessServices();
    const registry = new ToolRegistry(services, actor, { harnessActivationLedger: new HarnessActivationLedger() });

    await expect(registry.invoke('write_file', {
      workspaceId: 'workspace-1', path: 'src/app.ts', content: 'export const x = 1;\n',
    })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'CONFLICT', message: expect.stringContaining('workspace_bootstrap') } } });
    expect(writes).toEqual([]);

    const bootstrap = await registry.invoke('workspace_bootstrap', { workspaceId: 'workspace-1' });
    expect(bootstrap).toMatchObject({
      structuredContent: {
        ready: true,
        agentsMdLoaded: true,
        harnessFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        sessionStartSkill: { id: 'agents-skills/ask-matt', name: 'ask-matt', content: expect.stringContaining('# Ask Matt') },
        mandatoryMcp: { ready: true },
      },
    });
    expect(bootstrapEvents).toEqual(['policy_snapshot', 'skill_load:agents-skills/ask-matt', 'mandatory_mcp']);

    await expect(registry.invoke('write_file', {
      workspaceId: 'workspace-1', path: 'src/app.ts', content: 'export const x = 2;\n',
    })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'CONFLICT', message: expect.stringContaining('prepare_code_change') } } });

    const prepared = await registry.invoke('prepare_code_change', {
      workspaceId: 'workspace-1', filePath: 'src/app.ts', proposedSymbol: 'x',
    });
    expect(prepared).toMatchObject({ structuredContent: { ready: true, filePath: 'src/app.ts' } });
    expect(childCalls).toEqual(['thai-rag-mcp/pre_edit_context']);

    const allowed = await registry.invoke('write_file', {
      workspaceId: 'workspace-1', path: 'src/app.ts', content: 'export const x = 3;\n',
    });
    expect(allowed.isError).not.toBe(true);
    expect(writes).toEqual(['src/app.ts']);

    await expect(registry.invoke('write_file', {
      workspaceId: 'workspace-1', path: 'src/app.ts', content: 'export const x = 4;\n',
    })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'CONFLICT', message: expect.stringContaining('prepare_code_change') } } });
  });

  it('runs the optional Godkiller safety check only when explicitly requested', async () => {
    const { services, childCalls } = createHarnessServices();
    const registry = new ToolRegistry(services, actor, { harnessActivationLedger: new HarnessActivationLedger() });

    expect((await registry.invoke('workspace_bootstrap', { workspaceId: 'workspace-1' })).isError).not.toBe(true);
    const prepared = await registry.invoke('prepare_code_change', {
      workspaceId: 'workspace-1', filePath: 'src/risky.ts', proposedSymbol: 'migrateState', runGodkillerSafetyCheck: true,
    });

    expect(prepared).toMatchObject({
      structuredContent: {
        ready: true,
        filePath: 'src/risky.ts',
        checks: ['thai-rag-mcp/pre_edit_context', 'godkiller/gk_task'],
      },
    });
    expect(childCalls).toEqual(['thai-rag-mcp/pre_edit_context', 'godkiller/gk_task']);
  });

  it('refuses a workspace-scoped Godkiller shadow when optional safety analysis is requested', async () => {
    const { services, childCalls } = createHarnessServices();
    const originalDescribe = services.extensions!.describeMcpServer.bind(services.extensions);
    services.extensions = {
      ...services.extensions,
      async describeMcpServer(input: { server: string }, signal?: AbortSignal) {
        const result = await originalDescribe(input, signal);
        if (!result.ok || input.server !== 'godkiller') return result;
        return ok({ ...result.value, provenance: { ...result.value.provenance, source: 'workspace-cursor' } });
      },
    } as typeof services.extensions;
    const registry = new ToolRegistry(services, actor, { harnessActivationLedger: new HarnessActivationLedger() });

    expect((await registry.invoke('workspace_bootstrap', { workspaceId: 'workspace-1' })).isError).not.toBe(true);
    await expect(registry.invoke('prepare_code_change', {
      workspaceId: 'workspace-1', filePath: 'src/risky.ts', runGodkillerSafetyCheck: true,
    })).resolves.toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'PERMISSION_DENIED', message: expect.stringContaining('workspace-scoped Godkiller') } },
    });
    expect(childCalls).toEqual(['thai-rag-mcp/pre_edit_context']);
  });

  it('fails closed when the workspace AGENTS.md harness cannot be loaded', async () => {
    const { services } = createHarnessServices();
    services.file = {
      ...services.file,
      async readFile(_actor: unknown, _workspaceId: string, request: { path: string }) {
        return err(appError('FILE_NOT_FOUND', `missing ${request.path}`));
      },
    } as typeof services.file;
    const registry = new ToolRegistry(services, actor, { harnessActivationLedger: new HarnessActivationLedger() });

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
          servers: result.value.servers.map((server) => server.name === 'thai-rag-mcp' ? { ...server, tools: [] } : server),
        });
      },
    } as typeof services.extensions;
    const registry = new ToolRegistry(services, actor, { harnessActivationLedger: new HarnessActivationLedger() });

    await expect(registry.invoke('workspace_bootstrap', { workspaceId: 'workspace-1' })).resolves.toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'CONFLICT', message: expect.stringContaining('pre_edit_context') } },
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
    const registry = new ToolRegistry(services, actor, { harnessActivationLedger: new HarnessActivationLedger() });
    await expect(registry.invoke('workspace_bootstrap', { workspaceId: 'workspace-1' })).resolves.toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'CONFLICT', message: expect.stringContaining('custom-capability') } },
    });
  });

  it('exposes curated native working-memory tools after bootstrap', async () => {
    const { services, childCalls } = createHarnessServices();
    const registry = new ToolRegistry(services, actor, { harnessActivationLedger: new HarnessActivationLedger() });

    expect((await registry.invoke('workspace_bootstrap', { workspaceId: 'workspace-1' })).isError).not.toBe(true);
    const searched = await registry.invoke('working_memory_search', { workspaceId: 'workspace-1', query: 'current task' });
    expect(searched.isError).not.toBe(true);
    const recorded = await registry.invoke('working_memory_record', {
      workspaceId: 'workspace-1',
      name: 'goal:workspace-1',
      observations: ['Implemented harness bootstrap'],
    });
    expect(recorded.isError).not.toBe(true);
    expect(childCalls).toEqual([
      'memory/search_nodes',
      'memory/search_nodes',
      'memory/create_entities',
    ]);
  });

  it('invalidates the bootstrap when AGENTS.md changes and requires a fresh bootstrap', async () => {
    const { services, setAgentsMd } = createHarnessServices();
    const registry = new ToolRegistry(services, actor, { harnessActivationLedger: new HarnessActivationLedger() });

    expect((await registry.invoke('workspace_bootstrap', { workspaceId: 'workspace-1' })).isError).not.toBe(true);
    expect((await registry.invoke('prepare_code_change', { workspaceId: 'workspace-1', filePath: 'src/app.ts' })).isError).not.toBe(true);
    setAgentsMd('# Rules\nChanged policy.\n');

    await expect(registry.invoke('write_file', {
      workspaceId: 'workspace-1', path: 'src/app.ts', content: 'export const changed = true;\n',
    })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'CONFLICT', message: expect.stringContaining('changed') } } });
  });
});
