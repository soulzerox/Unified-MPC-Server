import { describe, expect, it } from 'vitest';
import { appError, err, ok } from '@unified-mpc/domain';
import { ContextEconomyRuntime } from '../context-economy.js';
import { ToolRegistry } from '../tool-registry.js';
import { skillTools } from './skill-tools.js';
import type { McpToolContext } from './tool-types.js';
import type { ExtensionsService } from '@unified-mpc/extensions';

describe('skills and mcp bridge tools', () => {
  it('registers skill and MCP inspection as read-only while mcp_call remains opaque mutation', async () => {
    const runtimePolicyFails = false;
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
    const skillsList = tools.find((entry) => entry.name === 'skills_list');
    expect(skillsList?.description).toContain('current Unified runtime authority');
    expect(skillsList?.description).toContain('not merged as runtime peers');
    expect(skillsList?.description).toContain('Standalone callers');
    for (const name of ['mcp_list', 'mcp_describe']) {
      const tool = tools.find((entry) => entry.name === name);
      expect(tool?.permission).toBe('READ');
      expect(tool?.annotations.readOnlyHint).toBe(true);
      expect(tool?.annotations.destructiveHint).toBe(false);
    }
    const mcpList = tools.find((entry) => entry.name === 'mcp_list');
    expect(mcpList?.description).toContain('current Unified runtime authority');
    expect(mcpList?.description).toContain('not merged as runtime peers');
    expect(mcpList?.description).toContain('standalone callers');

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
      },
    });
    await expect(registry.invoke('task_bootstrap', {})).resolves.toMatchObject({ structuredContent: { ready: true } });
    await expect(registry.invoke('task_bootstrap', { unexpected: true })).resolves.toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'INVALID_INPUT' } },
    });
    await expect(registry.invoke('policy_snapshot', {})).resolves.toMatchObject({
      structuredContent: { ready: true, policies: [expect.objectContaining({ id: 'session-start:ask-matt' }), expect.objectContaining({ id: 'auto:server:mock' })] },
    });
    await expect(registry.invoke('mcp_call', { server: 'mock', tool: 'ping', arguments: {}, userConfirmed: true })).resolves.toMatchObject({
      structuredContent: { content: [{ type: 'text', text: 'pong' }] },
    });
  });

  it('bounds oversized global and child-MCP results while leaving small responses unchanged', async () => {
    const diagnostics: unknown[] = [];
    const extensions: ExtensionsService = {
      listSkills: async () => ok({ skills: [] }),
      readSkill: async (input) => ok({ id: input.skillId, name: 'ask-matt', description: '', source: 'test', path: '/SKILL.md', content: '' }),
      listMcpServers: async () => ok({ servers: [{ name: 'huge', source: 'test', enabled: true, connected: true, excluded: false, command: 'x'.repeat(8_000) }] }),
      runtimePolicySnapshot: async () => ok({ ready: true, policies: [] }),
      describeMcpServer: async () => ok({ server: 'mock', enabled: true, connected: true, tools: [] }),
      callMcpTool: async (input) => input.tool === 'small'
        ? ok({ content: [{ type: 'text', text: 'pong' }] })
        : ok({ content: [{ type: 'text', text: 'x'.repeat(8_000) }], structuredContent: { payload: 'x'.repeat(8_000) } }),
      close: async () => undefined,
    };
    const registry = new ToolRegistry({ extensions }, { clientId: 'output-budget', clientName: 'output-budget' }, {
      hostMutationApprovalProvider: async (): Promise<boolean> => true,
      diagnostic: (event): void => { diagnostics.push(event); },
      maxToolResultBytes: 2_048,
      maxMcpCallResultBytes: 1_024,
    });

    await expect(registry.invoke('mcp_call', { server: 'mock', tool: 'small', arguments: {}, userConfirmed: true }))
      .resolves.toMatchObject({ structuredContent: { content: [{ type: 'text', text: 'pong' }] } });

    const child = await registry.invoke('mcp_call', { server: 'mock', tool: 'huge', arguments: {}, userConfirmed: true });
    // The budget envelope is the result, so it must also be structured content:
    // MCP rejects a successful call whose tool declares an output schema and
    // sends none.
    expect(child.structuredContent).toMatchObject({ truncated: true, toolName: 'mcp_call', maxBytes: 1_024 });
    const childEnvelope = JSON.parse(child.content[0]?.type === 'text' ? child.content[0].text : '{}') as Record<string, unknown>;
    expect(childEnvelope).toMatchObject({ truncated: true, toolName: 'mcp_call', maxBytes: 1_024 });

    const global = await registry.invoke('mcp_list', {});
    expect(global.structuredContent).toMatchObject({ truncated: true, toolName: 'mcp_list', maxBytes: 2_048 });
    const globalEnvelope = JSON.parse(global.content[0]?.type === 'text' ? global.content[0].text : '{}') as Record<string, unknown>;
    expect(globalEnvelope).toMatchObject({ truncated: true, toolName: 'mcp_list', maxBytes: 2_048 });

    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'ToolResultBudgetExceeded', message: expect.stringContaining('mcp_call') }),
      expect.objectContaining({ name: 'ToolResultBudgetExceeded', message: expect.stringContaining('mcp_list') }),
    ]));
  });

  it('uses conservative default output budgets', async () => {
    const extensions: ExtensionsService = {
      listSkills: async () => ok({ skills: [] }),
      readSkill: async (input) => ok({ id: input.skillId, name: 'ask-matt', description: '', source: 'test', path: '/SKILL.md', content: '' }),
      listMcpServers: async () => ok({ servers: [{ name: 'huge', source: 'test', enabled: true, connected: true, excluded: false, command: 'x'.repeat(600_000) }] }),
      runtimePolicySnapshot: async () => ok({ ready: true, policies: [] }),
      describeMcpServer: async () => ok({ server: 'mock', enabled: true, connected: true, tools: [] }),
      callMcpTool: async () => ok({ content: [{ type: 'text', text: 'x'.repeat(300_000) }] }),
      close: async () => undefined,
    };
    const registry = new ToolRegistry({ extensions }, { clientId: 'default-output-budget', clientName: 'default-output-budget' }, {
      hostMutationApprovalProvider: async (): Promise<boolean> => true,
    });

    const child = await registry.invoke('mcp_call', { server: 'mock', tool: 'huge', arguments: {}, userConfirmed: true });
    const childEnvelope = JSON.parse(child.content[0]?.type === 'text' ? child.content[0].text : '{}') as Record<string, unknown>;
    expect(childEnvelope).toMatchObject({ truncated: true, toolName: 'mcp_call', maxBytes: 256 * 1024 });

    const global = await registry.invoke('mcp_list', {});
    const globalEnvelope = JSON.parse(global.content[0]?.type === 'text' ? global.content[0].text : '{}') as Record<string, unknown>;
    expect(globalEnvelope).toMatchObject({ truncated: true, toolName: 'mcp_list', maxBytes: 512 * 1024 });
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

  it('lists skills as bounded summaries and keeps the full catalog behind detail=full', async () => {
    const longDescription = 'Use when the user asks for this '.repeat(30);
    const exactDescription = 'd'.repeat(200);
    const catalog = [
      { id: 'a/long', name: 'long', description: longDescription, source: 'a', trustTier: 'trusted' as const, rootPath: '/root', skillPath: '/root/a/SKILL.md', canonicalSkillPath: '/canonical/a/SKILL.md' },
      { id: 'a/short', name: 'short', description: 'Short one.', source: 'a', trustTier: 'trusted' as const, rootPath: '/root', skillPath: '/root/a/SKILL.md' },
      { id: 'a/exact', name: 'exact', description: exactDescription, source: 'a', trustTier: 'trusted' as const, rootPath: '/root', skillPath: '/root/a/SKILL.md' },
    ];
    const requests: unknown[] = [];
    const context = {
      actor: { clientId: 'test', clientName: 'test' },
      contextEconomy: new ContextEconomyRuntime(),
      services: {
        extensions: {
          async listSkills(input: unknown) {
            requests.push(input);
            return ok({ skills: catalog });
          },
        },
      },
    } as unknown as McpToolContext;
    const tool = skillTools(context).find((entry) => entry.name === 'skills_list');
    if (tool === undefined) throw new Error('skills_list is not registered');

    const summary = await tool.execute({ query: 'long', source: 'a' }, new AbortController().signal);
    expect(requests).toEqual([{ query: 'long', source: 'a' }]);
    expect(tool.parse({ query: 'long' })).toMatchObject({ ok: true, value: { query: 'long', detail: 'summary' } });
    expect(tool.parse({ detail: 'full' })).toMatchObject({ ok: true, value: { detail: 'full' } });
    expect(tool.parse({ detail: 'everything' })).toMatchObject({ ok: false });
    if (!summary.ok) throw new Error('expected a summary listing');
    expect(summary.value).toMatchObject({
      total: 3,
      returned: 3,
      truncated: false,
      detail: 'summary',
      omittedFields: ['rootPath', 'skillPath', 'canonicalSkillPath'],
    });
    const rows = (summary.value as { skills: Record<string, unknown>[] }).skills;
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(['description', 'descriptionTruncated', 'id', 'name', 'source', 'trustTier']);
    expect(rows[0]).toMatchObject({ id: 'a/long', descriptionTruncated: true });
    expect((rows[0]?.description as string)).toHaveLength(201);
    expect(rows[1]).toMatchObject({ id: 'a/short', description: 'Short one.', descriptionTruncated: false });
    // Exactly the preview length is not truncation: `>` is strict, so the text survives whole.
    expect(rows[2]).toMatchObject({ id: 'a/exact', description: exactDescription, descriptionTruncated: false });
    expect(JSON.stringify(summary.value)).not.toContain('/root/a/SKILL.md');
    expect(JSON.stringify(summary.value)).not.toContain(longDescription);
    // `detail=full` has to stay discoverable from the default envelope.
    expect((summary.value as { hint: string }).hint).toContain('detail=full');

    const full = await tool.execute({ detail: 'full' }, new AbortController().signal);
    expect(full).toEqual(ok({ skills: catalog }));

    const failed = await skillTools({
      actor: { clientId: 'test', clientName: 'test' },
      contextEconomy: new ContextEconomyRuntime(),
      services: { extensions: { async listSkills() { return err(appError('INTERNAL_ERROR', 'catalog failed')); } } },
    } as unknown as McpToolContext).find((entry) => entry.name === 'skills_list')!.execute({}, new AbortController().signal);
    expect(failed).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });

    const missing = await skillTools({
      actor: { clientId: 'test', clientName: 'test' },
      contextEconomy: new ContextEconomyRuntime(),
      services: {},
    } as unknown as McpToolContext).find((entry) => entry.name === 'skills_list')!.execute({}, new AbortController().signal);
    expect(missing).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
  });

  it('keeps a large skill catalog well inside the registry tool-result budget', async () => {
    const skills = Array.from({ length: 136 }, (_, index) => ({
      id: `unified-mpc-skills/skill-${index}`,
      name: `skill-${index}`,
      description: `Use when the user asks about capability ${index}. `.repeat(20),
      source: 'unified-mpc-skills',
      trustTier: 'trusted' as const,
      rootPath: '/home/user/.local/share/unified-mpc/skills',
      skillPath: `/home/user/.local/share/unified-mpc/skills/skill-${index}/SKILL.md`,
      canonicalSkillPath: `/home/user/.local/share/unified-mpc/canonical/skills/skill-${index}/SKILL.md`,
    }));
    const context = {
      actor: { clientId: 'test', clientName: 'test' },
      contextEconomy: new ContextEconomyRuntime(),
      services: { extensions: { async listSkills() { return ok({ skills }); } } },
    } as unknown as McpToolContext;
    const tool = skillTools(context).find((entry) => entry.name === 'skills_list');
    if (tool === undefined) throw new Error('skills_list is not registered');

    const summary = await tool.execute({}, new AbortController().signal);
    if (!summary.ok) throw new Error('expected a summary listing');
    const summaryBytes = Buffer.byteLength(JSON.stringify(summary.value));
    const unprojectedBytes = Buffer.byteLength(JSON.stringify({ skills }));
    expect(unprojectedBytes).toBeGreaterThan(140 * 1024);
    // The registry truncates around 512 KiB (`DEFAULT_MAX_TOOL_RESULT_BYTES` in
    // tool-registry.ts); a listing must not sit anywhere near that cliff, so this
    // pins an eighth of it.
    expect(summaryBytes).toBeLessThan(64 * 1024);
  });
});
