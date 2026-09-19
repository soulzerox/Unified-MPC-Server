import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { type ResultBudget } from '@unified-mpc/domain';
import { DEFAULT_EXTENSIONS_SETTINGS } from './types.js';
import { LocalExtensionsService } from './extensions-service.js';
import { bundledSkillRootCandidates } from './create-local-extensions.js';
import { attachChildStderrDrain, McpSessionManager, type McpClientFactory, type McpClientSession } from './mcp-session-manager.js';

function settingsWithMockServer(): typeof DEFAULT_EXTENSIONS_SETTINGS {
  return {
    ...DEFAULT_EXTENSIONS_SETTINGS,
    extraMcpServers: {
      mock: { command: 'node', args: ['mock-server.js'] },
    },
  };
}

async function currentMockContract(service: LocalExtensionsService): Promise<{ readonly descriptorFingerprint: string; readonly catalogFingerprint: string }> {
  const described = await service.describeMcpServer({ server: 'mock' });
  if (!described.ok) throw new Error('MCP description failed');
  return {
    descriptorFingerprint: described.value.provenance.descriptorFingerprint,
    catalogFingerprint: described.value.provenance.catalogFingerprint,
  };
}

describe('LocalExtensionsService MCP bridge', () => {
  it('discovers parent-owned skills and child MCP servers from the canonical unified-mpc data store', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-parent-store-'));
    try {
      const dataDir = path.join(root, 'data');
      const skillDir = path.join(dataDir, 'extensions', 'skills', 'parent-skill');
      const registryDir = path.join(dataDir, 'extensions', 'mcp');
      await mkdir(skillDir, { recursive: true });
      await mkdir(registryDir, { recursive: true });
      await writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: parent-skill\ndescription: parent managed\n---\n# Parent Skill\n', 'utf8');
      await writeFile(path.join(registryDir, 'registry.json'), JSON.stringify({
        mcpServers: { 'parent-child': { command: 'node', args: ['server.js'] } },
      }), 'utf8');

      const service = new LocalExtensionsService({
        settings: DEFAULT_EXTENSIONS_SETTINGS,
        homeDir: path.join(root, 'home'),
        dataDir,
      } as never);

      await expect(service.listSkills({ query: 'parent-skill' })).resolves.toMatchObject({
        ok: true,
        value: { skills: [expect.objectContaining({ name: 'parent-skill', source: 'unified-mpc-skills', trustTier: 'user' })] },
      });
      await expect(service.listMcpServers()).resolves.toMatchObject({
        ok: true,
        value: { servers: [expect.objectContaining({ name: 'parent-child', source: 'unified-mpc-registry', enabled: true })] },
      });
      await service.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('discovers the source-tree bundled skill fallback for development runs', () => {
    const candidates = bundledSkillRootCandidates(
      undefined,
      '/usr/bin/node',
      'file:///repo/packages/extensions/src/create-local-extensions.ts',
    );
    expect(candidates).toContain('/repo/.agents/skills');
  });

  it('prefers bundled provenance when a bundled root aliases the active workspace skill root', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-bundled-alias-'));
    try {
      const workspace = path.join(root, 'workspace');
      const skillDir = path.join(workspace, '.agents', 'skills', 'ponytail');
      await mkdir(skillDir, { recursive: true });
      await writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: ponytail\ndescription: test ponytail\n---\n', 'utf8');
      const service = new LocalExtensionsService({
        settings: DEFAULT_EXTENSIONS_SETTINGS,
        homeDir: path.join(root, 'home'),
        workspaceRootProvider: async (): Promise<string> => workspace,
        bundledSkillRoots: [path.join(workspace, '.agents', 'skills')],
      } as never);

      const listed = await service.listSkills({ query: 'ponytail' });
      expect(listed).toMatchObject({
        ok: true,
        value: {
          skills: [expect.objectContaining({
            id: 'bundled:agent-skills/ponytail',
            trustTier: 'bundled',
          })],
        },
      });
      await service.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('includes a packaged bundled-skill root without hiding global or workspace skills', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-bundled-skills-'));
    try {
      const home = path.join(root, 'home');
      const workspace = path.join(root, 'workspace');
      const bundled = path.join(root, 'agent-skills');
      for (const [skillRoot, name] of [
        [path.join(home, '.agents', 'skills', 'global-skill'), 'global-skill'],
        [path.join(workspace, '.agents', 'skills', 'workspace-skill'), 'workspace-skill'],
        [path.join(bundled, 'ponytail'), 'ponytail'],
        [path.join(bundled, 'ponytail-review'), 'ponytail-review'],
        [path.join(bundled, 'ponytail-audit'), 'ponytail-audit'],
        [path.join(bundled, 'ponytail-debt'), 'ponytail-debt'],
        [path.join(bundled, 'ponytail-gain'), 'ponytail-gain'],
        [path.join(bundled, 'ponytail-help'), 'ponytail-help'],
      ] as const) {
        await mkdir(skillRoot, { recursive: true });
        await writeFile(path.join(skillRoot, 'SKILL.md'), `---\nname: ${name}\ndescription: Use when testing ${name}\n---\n# ${name}\n`, 'utf8');
      }
      const service = new LocalExtensionsService({
        settings: DEFAULT_EXTENSIONS_SETTINGS,
        homeDir: home,
        workspaceRootProvider: async () => workspace,
        bundledSkillRoots: [bundled],
      } as never);

      const listed = await service.listSkills({});
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      expect(listed.value.skills.map((skill) => skill.name).sort()).toEqual([
        'global-skill',
        'ponytail',
        'ponytail-audit',
        'ponytail-debt',
        'ponytail-gain',
        'ponytail-help',
        'ponytail-review',
        'workspace-skill',
      ]);
      for (const skillName of ['ponytail', 'ponytail-review', 'ponytail-audit', 'ponytail-debt', 'ponytail-gain', 'ponytail-help'] as const) {
        const skill = listed.value.skills.find((entry) => entry.name === skillName);
        expect(skill).toMatchObject({
          id: `bundled:agent-skills/${skillName}`,
          source: 'bundled:agent-skills',
          trustTier: 'bundled',
        });
        await expect(service.readSkill({ skillId: `bundled:agent-skills/${skillName}` }))
          .resolves.toMatchObject({ ok: true, value: { id: `bundled:agent-skills/${skillName}`, name: skillName, trustTier: 'bundled' } });
      }
      await service.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('lists, describes, and calls child MCP tools through the session manager', async () => {
    const calls: string[] = [];
    const session: McpClientSession = {
      listTools: async () => [{ name: 'ping', description: 'Ping tool', inputSchema: { type: 'object' } }],
      listResources: async () => [{ uri: 'file:///docs/readme.md', name: 'README', description: 'Project docs', mimeType: 'text/markdown' }],
      callTool: async (name, args) => {
        calls.push(`${name}:${JSON.stringify(args)}`);
        return { content: [{ type: 'text', text: 'pong' }] };
      },
      close: async () => undefined,
    };
    const factory: McpClientFactory = {
      connect: async () => session,
    };
    const service = new LocalExtensionsService({
      settings: settingsWithMockServer(),
      homeDir: process.cwd(),
      appDataDir: process.cwd(),
      clientFactory: factory,
    });

    const listed = await service.listMcpServers();
    expect(listed).toMatchObject({ ok: true, value: { servers: [expect.objectContaining({ name: 'mock', enabled: true })] } });

    const described = await service.describeMcpServer({ server: 'mock' });
    expect(described).toMatchObject({
      ok: true,
      value: {
        server: 'mock',
        tools: [{ name: 'ping', description: 'Ping tool' }],
      },
    });

    const resources = await service.listMcpResources({ server: 'mock' });
    expect(resources).toMatchObject({
      ok: true,
      value: { server: 'mock', connected: true, resources: [{ uri: 'file:///docs/readme.md', name: 'README', mimeType: 'text/markdown' }] },
    });

    const called = await service.callMcpTool({
      server: 'mock', tool: 'ping', arguments: { n: 1 },
      ...(await currentMockContract(service)),
    });
    expect(called.ok).toBe(true);
    expect(calls).toEqual(['ping:{"n":1}']);

    await service.close();
  });

  it('fingerprints external MCP contracts and surfaces live tool-catalog drift', async (): Promise<void> => {
    let catalog = [{
      name: 'ping',
      description: 'Ping tool',
      inputSchema: { type: 'object', additionalProperties: false },
      outputSchema: { type: 'object', required: ['answer'], properties: { answer: { type: 'number' } }, additionalProperties: false },
    }];
    const session: McpClientSession = {
      listTools: async () => catalog,
      listResources: async () => [],
      callTool: async () => ({ structuredContent: { answer: 1 }, content: [] }),
      close: async () => undefined,
    };
    const service = new LocalExtensionsService({
      settings: settingsWithMockServer(),
      homeDir: process.cwd(),
      appDataDir: process.cwd(),
      clientFactory: { connect: async (): Promise<McpClientSession> => session },
    });

    const first = await service.describeMcpServer({ server: 'mock' });
    expect(first).toMatchObject({
      ok: true,
      value: {
        provenance: {
          trustTier: 'external',
          namespace: 'mcp:mock',
          descriptorFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
          catalogFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
          drift: { detected: false, reasons: [] },
        },
        tools: [expect.objectContaining({ qualifiedName: 'mcp:mock/ping', outputSchema: expect.any(Object) })],
      },
    });
    if (!first.ok) return;
    const initialFingerprint = first.value.provenance.catalogFingerprint;

    catalog = [{
      name: 'ping',
      description: 'Ping tool',
      inputSchema: { type: 'object', additionalProperties: false },
      outputSchema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } }, additionalProperties: false },
    }];
    const changed = await service.describeMcpServer({ server: 'mock' });
    expect(changed).toMatchObject({
      ok: true,
      value: {
        provenance: {
          drift: { detected: true, reasons: ['tool_catalog'], previousCatalogFingerprint: initialFingerprint },
        },
      },
    });
    if (changed.ok) expect(changed.value.provenance.catalogFingerprint).not.toBe(initialFingerprint);
    await service.close();
  });

  it('rejects child structured output that violates a declared external output schema', async (): Promise<void> => {
    const session: McpClientSession = {
      listTools: async () => [{
        name: 'ping',
        description: 'Ping tool',
        outputSchema: { type: 'object', required: ['answer'], properties: { answer: { type: 'number' } }, additionalProperties: false },
      }],
      listResources: async () => [],
      callTool: async () => ({ structuredContent: { answer: 'spoofed' }, content: [] }),
      close: async () => undefined,
    };
    const service = new LocalExtensionsService({
      settings: settingsWithMockServer(),
      homeDir: process.cwd(),
      appDataDir: process.cwd(),
      clientFactory: { connect: async (): Promise<McpClientSession> => session },
    });

    await expect(service.callMcpTool({ server: 'mock', tool: 'ping', ...await currentMockContract(service) })).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT', message: expect.stringContaining('output schema mismatch') },
    });
    await service.close();
  });

  it('accepts legacy JSON-embedded text output like sequentialthinking without structuredContent', async (): Promise<void> => {
    const session: McpClientSession = {
      listTools: async () => [{
        name: 'sequentialthinking',
        description: 'Sequential thinking tool',
        outputSchema: {
          type: 'object',
          required: ['thoughtNumber', 'totalThoughts', 'nextThoughtNeeded', 'branches', 'thoughtHistoryLength'],
          properties: {
            thoughtNumber: { type: 'number' },
            totalThoughts: { type: 'number' },
            nextThoughtNeeded: { type: 'boolean' },
            branches: { type: 'array' },
            thoughtHistoryLength: { type: 'number' },
          },
          additionalProperties: false,
        },
      }],
      listResources: async () => [],
      callTool: async () => ({ content: [{ type: 'text', text: '{"thoughtNumber":1,"totalThoughts":2,"nextThoughtNeeded":true,"branches":[],"thoughtHistoryLength":1}' }] }),
      close: async () => undefined,
    };
    const service = new LocalExtensionsService({
      settings: settingsWithMockServer(),
      homeDir: process.cwd(),
      appDataDir: process.cwd(),
      clientFactory: { connect: async (): Promise<McpClientSession> => session },
    });

    await expect(service.callMcpTool({ server: 'mock', tool: 'sequentialthinking', ...await currentMockContract(service) })).resolves.toMatchObject({
      ok: true,
    });
    await service.close();
  });

  it('accepts legacy text-only child output when a single required string result can be reconstructed safely', async (): Promise<void> => {
    const session: McpClientSession = {
      listTools: async () => [{
        name: 'ping',
        description: 'Ping tool',
        outputSchema: { type: 'object', required: ['result'], properties: { result: { type: 'string' } }, additionalProperties: false },
      }],
      listResources: async () => [],
      callTool: async () => ({ content: [{ type: 'text', text: 'legacy-result' }] }),
      close: async () => undefined,
    };
    const service = new LocalExtensionsService({
      settings: settingsWithMockServer(),
      homeDir: process.cwd(),
      appDataDir: process.cwd(),
      clientFactory: { connect: async (): Promise<McpClientSession> => session },
    });

    await expect(service.callMcpTool({ server: 'mock', tool: 'ping', ...await currentMockContract(service) })).resolves.toMatchObject({
      ok: true,
      value: { content: [{ type: 'text', text: 'legacy-result' }] },
    });
    await service.close();
  });

  it('rejects child arguments that violate a declared external input schema before dispatch', async (): Promise<void> => {
    let calls = 0;
    const service = new LocalExtensionsService({
      settings: settingsWithMockServer(),
      homeDir: process.cwd(),
      appDataDir: process.cwd(),
      clientFactory: { connect: async (): Promise<McpClientSession> => ({
        listTools: async () => [{
          name: 'ping', description: 'Ping tool',
          inputSchema: { type: 'object', required: ['answer'], properties: { answer: { type: 'number' } }, additionalProperties: false },
        }],
        listResources: async () => [],
        callTool: async (): Promise<{ readonly content: readonly [] }> => { calls += 1; return { content: [] }; },
        close: async () => undefined,
      }) },
    });

    await expect(service.callMcpTool({ server: 'mock', tool: 'ping', arguments: {}, ...await currentMockContract(service) }))
      .resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: expect.stringContaining('input schema mismatch') } });
    expect(calls).toBe(0);
    await service.close();
  });

  it('rejects a call carrying a stale external MCP contract fingerprint before child dispatch', async (): Promise<void> => {
    let calls = 0;
    const session: McpClientSession = {
      listTools: async () => [{ name: 'ping', description: 'Ping tool' }],
      listResources: async () => [],
      callTool: async () => { calls += 1; return { content: [] }; },
      close: async () => undefined,
    };
    const service = new LocalExtensionsService({
      settings: settingsWithMockServer(),
      homeDir: process.cwd(),
      appDataDir: process.cwd(),
      clientFactory: { connect: async (): Promise<McpClientSession> => session },
    });

    const described = await service.describeMcpServer({ server: 'mock' });
    if (!described.ok) throw new Error('MCP description failed');
    await expect(service.callMcpTool({
      server: 'mock',
      tool: 'ping',
      descriptorFingerprint: described.value.provenance.descriptorFingerprint,
      catalogFingerprint: '0'.repeat(64),
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'CONFLICT', message: expect.stringContaining('contract fingerprint') },
    });
    expect(calls).toBe(0);
    await service.close();
  });

  it('fails closed when an external MCP call has no contract fingerprints', async (): Promise<void> => {
    let calls = 0;
    const service = new LocalExtensionsService({
      settings: settingsWithMockServer(),
      homeDir: process.cwd(),
      appDataDir: process.cwd(),
      clientFactory: { connect: async (): Promise<McpClientSession> => ({
        listTools: async () => [{ name: 'ping', description: 'Ping tool' }],
        listResources: async () => [],
        callTool: async (): Promise<{ readonly content: readonly [] }> => { calls += 1; return { content: [] }; },
        close: async () => undefined,
      }) },
    });

    await expect(service.callMcpTool({ server: 'mock', tool: 'ping' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
    expect(calls).toBe(0);
    await service.close();
  });

  it('rejects oversized external MCP arguments before child dispatch', async (): Promise<void> => {
    let calls = 0;
    const service = new LocalExtensionsService({
      settings: settingsWithMockServer(),
      homeDir: process.cwd(),
      appDataDir: process.cwd(),
      clientFactory: { connect: async (): Promise<McpClientSession> => ({
        listTools: async () => [{ name: 'ping', description: 'Ping tool' }],
        listResources: async () => [],
        callTool: async (): Promise<{ readonly content: readonly [] }> => { calls += 1; return { content: [] }; },
        close: async () => undefined,
      }) },
    });

    await expect(service.callMcpTool({ server: 'mock', tool: 'ping', arguments: { payload: 'x'.repeat(1024 * 1024 + 1) }, ...await currentMockContract(service) }))
      .resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: expect.stringContaining('arguments exceed') } });
    expect(calls).toBe(0);
    await service.close();
  });

  it('rejects oversized external MCP results after child dispatch', async (): Promise<void> => {
    const service = new LocalExtensionsService({
      settings: settingsWithMockServer(),
      homeDir: process.cwd(),
      appDataDir: process.cwd(),
      clientFactory: { connect: async (): Promise<McpClientSession> => ({
        listTools: async () => [{ name: 'ping', description: 'Ping tool' }],
        listResources: async () => [],
        callTool: async (): Promise<{ readonly content: readonly { readonly type: string; readonly text: string }[] }> => ({ content: [{ type: 'text', text: 'x'.repeat(8 * 1024 * 1024 + 1) }] }),
        close: async () => undefined,
      }) },
    });

    await expect(service.callMcpTool({ server: 'mock', tool: 'ping', ...await currentMockContract(service) }, undefined, {
      maxItems: 100,
      maxTextBytes: 128,
      maxStructuredBytes: 128,
      maxBinaryBytes: 128,
      maxBase64Bytes: 128,
    })).resolves.toMatchObject({ ok: false, error: { code: 'CONFLICT', message: 'Child MCP transport cannot enforce bounded results for mock/ping' } });
    await service.close();
  });

  it('applies live MCP settings and reconnects when launch configuration changes without recreating the service', async () => {
    let liveSettings = DEFAULT_EXTENSIONS_SETTINGS;
    let connects = 0;
    let closes = 0;
    const observedArgs: string[][] = [];
    const factory: McpClientFactory = {
      connect: async (config): Promise<McpClientSession> => {
        connects += 1;
        observedArgs.push([...(config.args ?? [])]);
        return {
          listTools: async (): Promise<readonly { name: string; description: string }[]> => [{ name: 'ping', description: 'Ping tool' }],
          listResources: async (): Promise<readonly []> => [],
          callTool: async (): Promise<unknown> => ({ content: [{ type: 'text', text: 'pong' }] }),
          close: async (): Promise<void> => { closes += 1; },
        };
      },
    };
    const service = new LocalExtensionsService({
      settings: liveSettings,
      settingsProvider: (): typeof DEFAULT_EXTENSIONS_SETTINGS => liveSettings,
      homeDir: process.cwd(),
      appDataDir: process.cwd(),
      clientFactory: factory,
    });

    await expect(service.describeMcpServer({ server: 'mock' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    });
    liveSettings = settingsWithMockServer();
    await expect(service.describeMcpServer({ server: 'mock' })).resolves.toMatchObject({
      ok: true,
      value: { connected: true, tools: [expect.objectContaining({ name: 'ping' })] },
    });
    expect(connects).toBe(1);

    liveSettings = {
      ...settingsWithMockServer(),
      extraMcpServers: { mock: { command: 'node', args: ['mock-server-v2.js'] } },
    };
    await expect(service.describeMcpServer({ server: 'mock' })).resolves.toMatchObject({ ok: true, value: { connected: true } });
    expect(connects).toBe(2);
    expect(closes).toBe(1);
    expect(observedArgs).toEqual([['mock-server.js'], ['mock-server-v2.js']]);
    await service.close();
  });

  it('drops a connected child MCP session when live discovery no longer contains the server', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-child-reconcile-remove-'));
    try {
      let liveSettings = settingsWithMockServer();
      let closes = 0;
      const service = new LocalExtensionsService({
        settings: liveSettings,
        settingsProvider: (): typeof DEFAULT_EXTENSIONS_SETTINGS => liveSettings,
        homeDir: path.join(root, 'home'),
        appDataDir: path.join(root, 'appdata'),
        clientFactory: {
          connect: async (): Promise<McpClientSession> => ({
            listTools: async () => [{ name: 'ping', description: 'Ping tool' }],
            listResources: async () => [],
            callTool: async () => ({ content: [] }),
            close: async (): Promise<void> => { closes += 1; },
          }),
        },
      });

      await expect(service.describeMcpServer({ server: 'mock' })).resolves.toMatchObject({ ok: true });
      liveSettings = DEFAULT_EXTENSIONS_SETTINGS;
      await expect(service.listMcpServers()).resolves.toMatchObject({ ok: true, value: { servers: [] } });
      expect(closes).toBe(1);
      await service.close();
      expect(closes).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not connect a child MCP server when the request is already cancelled', async () => {
    let connects = 0;
    const factory: McpClientFactory = {
      connect: async () => {
        connects += 1;
        throw new Error('must not connect');
      },
    };
    const service = new LocalExtensionsService({
      settings: settingsWithMockServer(),
      homeDir: process.cwd(),
      appDataDir: process.cwd(),
      clientFactory: factory,
    });
    const controller = new AbortController();
    controller.abort();

    await expect(service.callMcpTool({ server: 'mock', tool: 'ping' }, controller.signal))
      .resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
    await expect(service.describeMcpServer({ server: 'mock' }, controller.signal))
      .resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
    expect(connects).toBe(0);

    await service.close();
  });

  it('does not execute a queued child MCP call after cancellation', async () => {
    let active = false;
    let release!: () => void;
    const calls: string[] = [];
    const session: McpClientSession = {
      listTools: async () => [{ name: 'ping', description: 'Ping tool' }],
      listResources: async () => [],
      callTool: async (name, _args, signal): Promise<unknown> => {
        calls.push(name);
        if (!active) {
          active = true;
          await new Promise<void>((resolve) => { release = resolve; });
        }
        if (signal?.aborted) throw new Error('child call cancelled');
        return { content: [] };
      },
      close: async () => undefined,
    };
    const service = new LocalExtensionsService({
      settings: settingsWithMockServer(),
      homeDir: process.cwd(),
      appDataDir: process.cwd(),
      clientFactory: { connect: async (): Promise<McpClientSession> => session },
    });
    const contract = await currentMockContract(service);
    const started = new Promise<void>((resolve) => {
      const wait = (): void => {
        if (active) resolve();
        else setImmediate(wait);
      };
      wait();
    });
    const first = service.callMcpTool({ server: 'mock', tool: 'ping', ...contract });
    await started;
    const controller = new AbortController();
    const second = service.callMcpTool({ server: 'mock', tool: 'ping', ...contract }, controller.signal);
    controller.abort();
    release();

    await expect(first).resolves.toMatchObject({ ok: true });
    await expect(second).resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
    expect(calls).toEqual(['ping']);
    await service.close();
  });

  it('aborts an in-flight child MCP call and closes its managed session', async () => {
    let observedSignal: AbortSignal | undefined;
    let releaseStarted!: () => void;
    const started = new Promise<void>((resolve) => { releaseStarted = resolve; });
    let closes = 0;
    const session: McpClientSession = {
      listTools: async () => [{ name: 'ping', description: 'Ping tool' }],
      listResources: async () => [],
      callTool: async (_name, _args, signal) => {
        observedSignal = signal;
        releaseStarted();
        await new Promise<void>((resolve) => {
          if (signal?.aborted === true) {
            resolve();
            return;
          }
          signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        throw new Error('child call cancelled');
      },
      close: async () => { closes += 1; },
    };
    const factory: McpClientFactory = { connect: async () => session };
    const service = new LocalExtensionsService({
      settings: settingsWithMockServer(),
      homeDir: process.cwd(),
      appDataDir: process.cwd(),
      clientFactory: factory,
    });
    const controller = new AbortController();

    const pending = service.callMcpTool({ server: 'mock', tool: 'ping', ...await currentMockContract(service) }, controller.signal);
    await started;
    controller.abort();

    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
    expect(observedSignal?.aborted).toBe(true);
    expect(closes).toBe(1);
    await service.close();
  });

  it('drains high-volume child stderr and removes its error listener during cleanup', async () => {
    const stderr = new PassThrough();
    const initialErrorListeners = stderr.listenerCount('error');
    const dispose = attachChildStderrDrain(stderr);
    expect(stderr.readableFlowing).toBe(true);
    for (let index = 0; index < 64; index += 1) stderr.write(Buffer.alloc(64 * 1024, index % 255));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(stderr.readableLength).toBe(0);
    expect(stderr.listenerCount('error')).toBe(initialErrorListeners + 1);
    dispose();
    dispose();
    expect(stderr.listenerCount('error')).toBe(initialErrorListeners);
    stderr.destroy();
  });

  it('fails closed when bounded child results lack bounded transport support', async () => {
    const session: McpClientSession = {
      listTools: async () => [{ name: 'ping', description: 'Ping tool' }],
      listResources: async () => [],
      callTool: async () => ({ content: [{ type: 'text', text: 'pong' }] }),
      close: async () => undefined,
    };
    const manager = new McpSessionManager({ clientFactory: { connect: async (): Promise<McpClientSession> => session } });
    const budget: ResultBudget = { maxItems: 1, maxTextBytes: 10, maxStructuredBytes: 10, maxBinaryBytes: 10, maxBase64Bytes: 10 };

    await expect(manager.call('mock', { command: 'node' }, 'ping', {}, undefined, {}, budget)).resolves.toMatchObject({
      ok: false,
      error: { code: 'CONFLICT' },
    });
    await manager.close();
  });

  it('passes bounded budgets to child transport and rejects oversized bounded results', async () => {
    let observedBudget: ResultBudget | undefined;
    const session: McpClientSession = {
      listTools: async () => [{ name: 'ping', description: 'Ping tool' }],
      listResources: async () => [],
      callTool: async () => ({ content: [{ type: 'text', text: 'unbounded fallback' }] }),
      callToolBounded: async (_name, _args, callBudget) => {
        observedBudget = callBudget;
        return { content: [{ type: 'text', text: 'x'.repeat(64) }] };
      },
      close: async () => undefined,
    };
    const manager = new McpSessionManager({ clientFactory: { connect: async (): Promise<McpClientSession> => session } });
    const budget: ResultBudget = { maxItems: 2, maxTextBytes: 128, maxStructuredBytes: 32, maxBinaryBytes: 128, maxBase64Bytes: 128 };

    await expect(manager.call('mock', { command: 'node' }, 'ping', {}, undefined, {}, budget)).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    });
    expect(observedBudget).toEqual({ ...budget, maxStructuredBytes: 32 });
    await manager.close();
  });

  it('shares one child connection across concurrent calls', async () => {
    let connects = 0;
    const session: McpClientSession = {
      listTools: async () => [{ name: 'ping', description: 'Ping tool' }],
      listResources: async () => [],
      callTool: async () => ({ content: [{ type: 'text', text: 'pong' }] }),
      close: async () => undefined,
    };
    const manager = new McpSessionManager({
      clientFactory: { connect: async (): Promise<McpClientSession> => { connects += 1; await Promise.resolve(); return session; } },
      callTimeoutMs: 500,
    });

    const results = await Promise.all(Array.from({ length: 8 }, () => manager.call('mock', { command: 'node' }, 'ping', {})));
    expect(results.every((result) => result.ok)).toBe(true);
    expect(connects).toBe(1);
    await manager.close();
  });

  it('closes a child connection that finishes after the session manager is closed', async () => {
    let resolveConnect!: (session: McpClientSession) => void;
    let connectStarted!: () => void;
    const started = new Promise<void>((resolve) => { connectStarted = resolve; });
    let closes = 0;
    const session: McpClientSession = {
      listTools: async () => [{ name: 'ping', description: 'Ping tool' }],
      listResources: async () => [],
      callTool: async () => ({ content: [{ type: 'text', text: 'pong' }] }),
      close: async () => { closes += 1; },
    };
    const manager = new McpSessionManager({
      clientFactory: {
        connect: async (): Promise<McpClientSession> => {
          connectStarted();
          return new Promise<McpClientSession>((resolve) => { resolveConnect = resolve; });
        },
      },
      callTimeoutMs: 500,
    });

    const pending = manager.describe('mock', { command: 'node' });
    await started;
    await manager.close();
    resolveConnect(session);

    await expect(pending).resolves.toMatchObject({ ok: false });
    await expect.poll(() => closes).toBe(1);
    expect(manager.isConnected('mock')).toBe(false);
  });

  it('times out queued calls and cleans the failed managed session', async () => {
    let closes = 0;
    const session: McpClientSession = {
      listTools: async () => [{ name: 'hang', description: 'Hang tool' }],
      listResources: async () => [],
      callTool: async () => new Promise<never>(() => undefined),
      close: async () => { closes += 1; },
    };
    const manager = new McpSessionManager({ clientFactory: { connect: async (): Promise<McpClientSession> => session }, callTimeoutMs: 25 });

    const [first, second] = await Promise.all([
      manager.call('mock', { command: 'node' }, 'hang', {}),
      manager.call('mock', { command: 'node' }, 'hang', {}),
    ]);
    expect(first).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    expect(second).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    expect(manager.isConnected('mock')).toBe(false);
    expect(closes).toBe(1);
    await manager.close();
  });

  it('does not let a stale failed call close its replacement child session', async () => {
    let rejectOld!: (error: Error) => void;
    let newConnects = 0;
    const oldSession: McpClientSession = {
      listTools: async () => [{ name: 'ping', description: 'Ping tool' }],
      listResources: async () => [],
      callTool: async () => new Promise<never>((_resolve, reject) => { rejectOld = reject; }),
      close: async () => undefined,
    };
    const newSession: McpClientSession = {
      listTools: async () => [{ name: 'ping', description: 'Ping tool' }],
      listResources: async () => [],
      callTool: async () => ({ content: [{ type: 'text', text: 'new' }] }),
      close: async () => undefined,
    };
    const manager = new McpSessionManager({
      clientFactory: {
        connect: async (config): Promise<McpClientSession> => {
          if (config.args?.[0] === 'new') { newConnects += 1; return newSession; }
          return oldSession;
        },
      },
      callTimeoutMs: 500,
    });

    const oldCall = manager.call('mock', { command: 'node', args: ['old'] }, 'ping', {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    const replacement = await manager.call('mock', { command: 'node', args: ['new'] }, 'ping', {});
    expect(replacement.ok).toBe(true);
    rejectOld(new Error('old child exited'));
    await expect(oldCall).resolves.toMatchObject({ ok: false });
    expect(manager.isConnected('mock')).toBe(true);
    await expect(manager.call('mock', { command: 'node', args: ['new'] }, 'ping', {})).resolves.toMatchObject({ ok: true });
    expect(newConnects).toBe(1);
    await manager.close();
  });

  it('drops a child session after describe fails so the next describe reconnects', async () => {
    let connects = 0;
    let firstList = true;
    const factory: McpClientFactory = {
      connect: async (): Promise<McpClientSession> => {
        connects += 1;
        return {
          listTools: async (): Promise<readonly { name: string; description: string }[]> => {
            if (connects === 1 && !firstList) throw new Error('child exited');
            firstList = false;
            return [{ name: 'health_check', description: 'Health' }];
          },
          listResources: async () => [],
          callTool: async () => ({ content: [] }),
          close: async () => undefined,
        };
      },
    };
    const service = new LocalExtensionsService({
      settings: settingsWithMockServer(),
      homeDir: process.cwd(),
      appDataDir: process.cwd(),
      clientFactory: factory,
    });

    await expect(service.describeMcpServer({ server: 'mock' })).resolves.toMatchObject({ ok: false });
    await expect(service.describeMcpServer({ server: 'mock' })).resolves.toMatchObject({
      ok: true,
      value: { connected: true, tools: [expect.objectContaining({ name: 'health_check' })] },
    });
    expect(connects).toBe(2);
    await service.close();
  });

  it('keeps pinned child MCP sessions alive past the normal idle timeout', async () => {
    vi.useFakeTimers();
    let closes = 0;
    const manager = new McpSessionManager({
      clientFactory: {
        connect: async (): Promise<McpClientSession> => ({
          listTools: async () => [{ name: 'ping', description: 'Ping tool' }],
          listResources: async () => [],
          callTool: async () => ({ content: [] }),
          close: async (): Promise<void> => { closes += 1; },
        }),
      },
      idleTimeoutMs: 25,
    });

    manager.pin('mock');
    await expect(manager.describe('mock', { command: 'node' })).resolves.toMatchObject({ ok: true });
    await vi.advanceTimersByTimeAsync(100);
    expect(manager.isConnected('mock')).toBe(true);
    expect(closes).toBe(0);

    manager.unpin('mock');
    await vi.advanceTimersByTimeAsync(50);
    expect(manager.isConnected('mock')).toBe(false);
    expect(closes).toBe(1);
    await manager.close();
    vi.useRealTimers();
  });

  it('unpins child MCP servers that are no longer mandatory after live settings change', async () => {
    let liveSettings = { ...settingsWithMockServer(), mandatoryMcpServers: ['mock'] };
    const service = new LocalExtensionsService({
      settings: liveSettings,
      settingsProvider: (): typeof liveSettings => liveSettings,
      homeDir: process.cwd(),
      appDataDir: process.cwd(),
      clientFactory: {
        connect: async (): Promise<McpClientSession> => ({
          listTools: async () => [{ name: 'ping', description: 'Ping tool' }],
          listResources: async () => [],
          callTool: async () => ({ content: [] }),
          close: async () => undefined,
        }),
      },
    });

    expect((await service.bootstrapMandatoryMcpServers()).ok).toBe(true);
    await expect(service.listMcpServers()).resolves.toMatchObject({
      ok: true,
      value: { servers: [expect.objectContaining({ name: 'mock', pinned: true, required: true })] },
    });

    liveSettings = { ...liveSettings, mandatoryMcpServers: [] };
    await expect(service.bootstrapMandatoryMcpServers()).resolves.toMatchObject({ ok: true, value: { ready: true, servers: [] } });
    await expect(service.listMcpServers()).resolves.toMatchObject({
      ok: true,
      value: { servers: [expect.objectContaining({ name: 'mock', pinned: false, required: false })] },
    });
    await service.close();
  });

  it('refuses to promote a workspace-scoped child MCP into the mandatory native harness', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-mandatory-trust-'));
    try {
      const workspace = path.join(root, 'workspace');
      await mkdir(path.join(workspace, '.cursor'), { recursive: true });
      await writeFile(path.join(workspace, '.cursor', 'mcp.json'), JSON.stringify({
        mcpServers: { mock: { command: 'node', args: ['workspace-controlled.js'] } },
      }), 'utf8');
      let connects = 0;
      const service = new LocalExtensionsService({
        settings: { ...DEFAULT_EXTENSIONS_SETTINGS, mandatoryMcpServers: ['mock'] },
        homeDir: path.join(root, 'home'),
        appDataDir: path.join(root, 'config'),
        workspaceRootProvider: async (): Promise<string> => workspace,
        clientFactory: {
          connect: async (): Promise<McpClientSession> => {
            connects += 1;
            throw new Error('workspace-scoped mandatory MCP must not launch');
          },
        },
      });

      await expect(service.bootstrapMandatoryMcpServers()).resolves.toMatchObject({
        ok: true,
        value: { ready: false, servers: [{ name: 'mock', connected: false, pinned: false, error: expect.stringContaining('workspace-scoped') }] },
      });
      await expect(service.listMcpServers()).resolves.toMatchObject({
        ok: true,
        value: { servers: [expect.objectContaining({
          name: 'mock', required: true, connected: false, state: 'degraded',
          lastError: expect.stringContaining('workspace-scoped'), lastCheckedAt: expect.any(String),
        })] },
      });
      expect(connects).toBe(0);
      await service.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resolves mandatory child MCP names case-insensitively to the discovered canonical server', async () => {
    const service = new LocalExtensionsService({
      settings: { ...settingsWithMockServer(), mandatoryMcpServers: ['MoCk'] },
      homeDir: process.cwd(),
      appDataDir: process.cwd(),
      clientFactory: {
        connect: async (): Promise<McpClientSession> => ({
          listTools: async () => [{ name: 'ping', description: 'Ping tool' }],
          listResources: async () => [],
          callTool: async () => ({ content: [] }),
          close: async () => undefined,
        }),
      },
    });
    await expect(service.bootstrapMandatoryMcpServers()).resolves.toMatchObject({
      ok: true,
      value: { ready: true, servers: [{ name: 'mock', connected: true, pinned: true }] },
    });
    await service.close();
  });

  it('warms and pins mandatory child MCP servers automatically before status is observed', async () => {
    let connects = 0;
    const service = new LocalExtensionsService({
      settings: {
        ...settingsWithMockServer(),
        mandatoryMcpServers: ['mock'],
      },
      homeDir: process.cwd(),
      appDataDir: process.cwd(),
      clientFactory: {
        connect: async (): Promise<McpClientSession> => {
          connects += 1;
          return {
            listTools: async () => [{ name: 'ping', description: 'Ping tool' }],
            listResources: async () => [],
            callTool: async () => ({ content: [] }),
            close: async () => undefined,
          };
        },
      },
    });

    await expect(service.listMcpServers()).resolves.toMatchObject({
      ok: true,
      value: { servers: [expect.objectContaining({ name: 'mock', connected: true, pinned: true, required: true })] },
    });
    expect(connects).toBe(1);
    await service.close();
  });

  it('bootstraps configured mandatory child MCP servers and pins successful connections', async () => {
    let connects = 0;
    const service = new LocalExtensionsService({
      settings: {
        ...settingsWithMockServer(),
        mandatoryMcpServers: ['mock'],
      },
      homeDir: process.cwd(),
      appDataDir: process.cwd(),
      clientFactory: {
        connect: async (): Promise<McpClientSession> => {
          connects += 1;
          return {
            listTools: async () => [{ name: 'ping', description: 'Ping tool' }],
            listResources: async () => [],
            callTool: async () => ({ content: [] }),
            close: async () => undefined,
          };
        },
      },
    });

    const bootstrapped = await service.bootstrapMandatoryMcpServers();
    expect(bootstrapped).toMatchObject({
      ok: true,
      value: {
        ready: true,
        servers: [{ name: 'mock', required: true, connected: true, pinned: true }],
      },
    });
    expect(connects).toBe(1);
    await expect(service.listMcpServers()).resolves.toMatchObject({
      ok: true,
      value: { servers: [expect.objectContaining({ name: 'mock', connected: true, pinned: true, required: true })] },
    });
    await service.close();
  });

  it('reconciles auto-route policy entries when child MCP servers are installed or removed', async () => {
    let liveSettings = {
      ...DEFAULT_EXTENSIONS_SETTINGS,
      mandatoryMcpServers: [],
      extraMcpServers: { mock: { command: 'node', args: ['mock-server.js'] } },
      policies: [],
    };
    const service = new LocalExtensionsService({
      settings: liveSettings as never,
      settingsProvider: (): never => liveSettings as never,
      homeDir: process.cwd(),
      appDataDir: process.cwd(),
    });

    await expect(service.runtimePolicySnapshot()).resolves.toMatchObject({
      ok: true,
      value: {
        policies: [expect.objectContaining({
          id: 'auto:server:mock',
          resourceId: 'mock',
          resourceType: 'server',
          enforcement: 'AUTO_ROUTE',
          source: 'discovered',
          available: true,
        })],
      },
    });

    liveSettings = { ...liveSettings, extraMcpServers: {} };
    const afterRemoval = await service.runtimePolicySnapshot();
    expect(afterRemoval.ok).toBe(true);
    if (afterRemoval.ok) expect(afterRemoval.value.policies.some((policy) => policy.id === 'auto:server:mock')).toBe(false);
    await service.close();
  });
});
