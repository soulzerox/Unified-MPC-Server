import { describe, expect, it } from 'vitest';
import { appError, err, ok } from '@unified-mpc/domain';
import { ToolRegistry } from '../tool-registry.js';
import type { ExtensionsService } from '@unified-mpc/extensions';

describe('skills and mcp bridge tools', () => {
  it('registers skill and MCP inspection as read-only while mcp_call remains opaque mutation', async () => {
    let runtimePolicyFails = false;
    const extensions: ExtensionsService = {
      listSkills: async () => ok({ skills: [{ id: 'a/b', name: 'b', description: 'd', source: 'a', rootPath: '/', skillPath: '/SKILL.md' }] }),
      readSkill: async (input) => input.skillId === 'agents-skills/ask-matt'
        ? ok({ id: input.skillId, name: 'ask-matt', description: 'router', source: 'agents-skills', path: '/ask-matt/SKILL.md', content: '# Ask Matt' })
        : ok({ id: 'a/b', name: 'b', description: 'd', source: 'a', path: '/SKILL.md', content: '# b' }),
      listMcpServers: async () => ok({ servers: [{ name: 'mock', source: 'test', enabled: true, connected: false, excluded: false, command: 'node' }] }),
      runtimePolicySnapshot: async () => runtimePolicyFails
        ? err(appError('CONFLICT', 'simulated policy failure', true))
        : ok({ ready: true, policies: [
        { priority: 'P1', id: 'session-start:ask-matt', resourceId: 'ask-matt', resolvedResourceId: 'agents-skills/ask-matt', resourceType: 'skill', mandatory: true, enforcement: 'EVERY_SESSION', directive: 'Load ask-matt', source: 'configured', available: true },
        { priority: 'P2', id: 'auto:server:mock', resourceId: 'mock', resourceType: 'server', mandatory: false, enforcement: 'AUTO_ROUTE', directive: 'Auto route', source: 'discovered', available: true },
      ] }),
      describeMcpServer: async () => ok({ server: 'mock', enabled: true, connected: true, tools: [{ name: 'ping', description: 'Ping' }] }),
      callMcpTool: async () => ok({ content: [{ type: 'text', text: 'pong' }] }),
      close: async () => undefined,
    };
    const installed: unknown[] = [];
    const registry = new ToolRegistry({
      extensions,
      installer: {
        installSkill: async (input): Promise<{ ok: true; value: { name: string; installedPaths: readonly string[]; targets: typeof input.targets } }> => { installed.push(input); return ok({ name: input.name, installedPaths: ['/tmp/SKILL.md'], targets: input.targets }); },
        installServer: async (input): Promise<{ ok: true; value: { name: string; targets: typeof input.targets; updatedConfigFiles: readonly string[] } }> => { installed.push(input); return ok({ name: input.name, targets: input.targets, updatedConfigFiles: ['/tmp/mcp.json'] }); },
      },
    }, { clientId: 'test', clientName: 'test' }, {
      hostMutationApprovalProvider: async (): Promise<boolean> => true,
    });
    const tools = registry.list();
    const names = tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(['skills_list', 'skills_read', 'skills_install', 'task_bootstrap', 'policy_snapshot', 'mcp_list', 'mcp_describe', 'mcp_install', 'mcp_call']));

    for (const name of ['skills_list', 'skills_read']) {
      const tool = tools.find((entry) => entry.name === name);
      expect(tool?.permission).toBe('READ');
      expect(tool?.annotations.readOnlyHint).toBe(true);
      expect(tool?.annotations.destructiveHint).toBe(false);
    }
    expect(tools.find((entry) => entry.name === 'skills_list')?.description).toContain('Codex plugin');
    expect(tools.find((entry) => entry.name === 'skills_list')?.description).toContain('machine-global');
    for (const name of ['mcp_list', 'mcp_describe']) {
      const tool = tools.find((entry) => entry.name === name);
      expect(tool?.permission).toBe('READ');
      expect(tool?.annotations.readOnlyHint).toBe(true);
      expect(tool?.annotations.destructiveHint).toBe(false);
    }
    const mcpCall = tools.find((entry) => entry.name === 'mcp_call');
    expect(mcpCall?.permission).toBe('DANGEROUS');
    expect(mcpCall?.annotations.readOnlyHint).toBe(false);
    expect(mcpCall?.annotations.destructiveHint).toBe(true);

    await expect(registry.invoke('skills_list', {})).resolves.toMatchObject({
      structuredContent: { skills: [expect.objectContaining({ id: 'a/b' })] },
    });
    await expect(registry.invoke('skills_install', {
      name: 'remote-skill',
      source: 'https://github.com/example/remote-skill.git',
    })).resolves.toMatchObject({ structuredContent: { name: 'remote-skill' } });
    await expect(registry.invoke('mcp_install', {
      name: 'remote-mcp',
      transport: 'stdio',
      source: 'https://github.com/example/remote-mcp.git',
    })).resolves.toMatchObject({ structuredContent: { name: 'remote-mcp' } });
    expect(installed).toEqual([
      expect.objectContaining({ name: 'remote-skill', source: 'https://github.com/example/remote-skill.git', targets: ['unified-mpc'], scope: 'global' }),
      expect.objectContaining({ name: 'remote-mcp', source: 'https://github.com/example/remote-mcp.git', transport: 'stdio', targets: ['unified-mpc'], scope: 'global' }),
    ]);
    await expect(registry.invoke('skills_install', {
      name: 'legacy-skill', source: '/tmp/legacy', targets: ['cursor'],
    })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_INPUT' } } });
    await expect(registry.invoke('mcp_install', {
      name: 'legacy-mcp', transport: 'stdio', command: 'node', targets: ['cursor'],
    })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_INPUT' } } });
    await expect(registry.invoke('task_bootstrap', {})).resolves.toMatchObject({
      structuredContent: {
        ready: true,
        policy: { ready: true, policies: [expect.objectContaining({ id: 'session-start:ask-matt' }), expect.objectContaining({ id: 'auto:server:mock' })] },
        sessionStartSkill: { id: 'agents-skills/ask-matt', name: 'ask-matt', content: '# Ask Matt' },
        turnPersistence: { state: 'untracked', mode: 'best_effort' },
      },
    });
    await expect(registry.invoke('task_bootstrap', { turnId: 'web-turn-1' })).resolves.toMatchObject({ structuredContent: { turnPersistence: { state: 'awaiting_record', turnId: 'web-turn-1', mode: 'best_effort', violations: 0 } } });
    await expect(registry.invoke('task_bootstrap', { turnId: 'web-turn-2' })).resolves.toMatchObject({ structuredContent: { turnPersistence: { state: 'awaiting_record', turnId: 'web-turn-2', mode: 'best_effort', violations: 1, replacedUnpersistedTurnId: 'web-turn-1' } } });
    const bootstrapFailureRegistry = new ToolRegistry({ extensions }, { clientId: 'bootstrap-failure', clientName: 'bootstrap-failure' }, { sessionId: 'bootstrap-failure', turnPersistenceMode: 'required' });
    runtimePolicyFails = true;
    await expect(bootstrapFailureRegistry.invoke('task_bootstrap', { turnId: 'failed-turn' })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'CONFLICT' } } });
    runtimePolicyFails = false;
    await expect(bootstrapFailureRegistry.invoke('task_bootstrap', { turnId: 'next-turn' })).resolves.toMatchObject({ structuredContent: { turnPersistence: { state: 'awaiting_record', turnId: 'next-turn', mode: 'required' } } });
    const strictRegistry = new ToolRegistry({ extensions }, { clientId: 'strict-test', clientName: 'strict-test' }, {
      sessionId: 'strict-session',
      turnPersistenceMode: 'required',
    });
    await expect(strictRegistry.invoke('task_bootstrap', {})).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_INPUT' } } });
    await expect(strictRegistry.invoke('task_bootstrap', { turnId: 'turn-1' })).resolves.toMatchObject({ structuredContent: { turnPersistence: { state: 'awaiting_record', turnId: 'turn-1', mode: 'required' } } });
    await expect(strictRegistry.invoke('task_bootstrap', { turnId: 'turn-2' })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'CONFLICT', message: expect.stringContaining('turn-1') } } });
    await expect(registry.invoke('policy_snapshot', {})).resolves.toMatchObject({
      structuredContent: { ready: true, policies: [expect.objectContaining({ id: 'session-start:ask-matt' }), expect.objectContaining({ id: 'auto:server:mock' })] },
    });
    await expect(registry.invoke('mcp_call', { server: 'mock', tool: 'ping', arguments: {}, userConfirmed: true })).resolves.toMatchObject({
      structuredContent: { content: [{ type: 'text', text: 'pong' }] },
    });
  });

  it('forwards the caller AbortSignal through mcp_describe and approved mcp_call', async () => {
    const observed: AbortSignal[] = [];
    const extensions: ExtensionsService = {
      listSkills: async () => ok({ skills: [] }),
      readSkill: async () => ok({ id: 'a/b', name: 'b', description: '', source: 'a', path: '/SKILL.md', content: '' }),
      listMcpServers: async () => ok({ servers: [] }),
      runtimePolicySnapshot: async () => ok({ ready: true, policies: [] }),
      describeMcpServer: async (_input, signal) => {
        if (signal !== undefined) observed.push(signal);
        return ok({ server: 'mock', enabled: true, connected: true, tools: [] });
      },
      callMcpTool: async (_input, signal) => {
        if (signal !== undefined) observed.push(signal);
        return ok({ content: [] });
      },
      close: async () => undefined,
    };
    const registry = new ToolRegistry({ extensions }, { clientId: 'test', clientName: 'test' }, {
      hostMutationApprovalProvider: async (): Promise<boolean> => true,
    });
    const controller = new AbortController();

    await expect(registry.invoke('mcp_describe', { server: 'mock' }, undefined, controller.signal))
      .resolves.toMatchObject({ structuredContent: { server: 'mock', connected: true } });
    await expect(registry.invoke('mcp_call', { server: 'mock', tool: 'ping', arguments: {}, userConfirmed: true }, undefined, controller.signal))
      .resolves.toMatchObject({ structuredContent: { content: [] } });

    expect(observed).toHaveLength(2);
    for (const signal of observed) expect(signal).toBeInstanceOf(AbortSignal);
  });
});
