import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { McpClientFactory, McpClientSession, McpServerLaunchConfig } from '@unified-mpc/extensions';
import { NativeThaiRagProviderDriver } from './native-thai-rag-provider.js';

const roots: string[] = [];
const workspaceId = '11111111-1111-4111-8111-111111111111';
const recoveredWorkspaceId = '22222222-2222-4222-8222-222222222222';
const tools = ['remember', 'recall', 'pre_edit_context', 'code_blast_radius', 'forget', 'code_index', 'index_status', 'code_search', 'code_context'];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'native-thai-rag-driver-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('NativeThaiRagProviderDriver', () => {
  it('launches without the obsolete remember_turn dependency', async () => {
    const dataRoot = await tempRoot();
    const workspaceRoot = await tempRoot();
    let connectedConfig: McpServerLaunchConfig | undefined;
    const factory = clientFactory({
      onConnect(config): void { connectedConfig = config; },
    });
    const driver = new NativeThaiRagProviderDriver({
      dataRoot,
      launchConfig: { command: '/python', args: ['/thai_rag_context_mcp.py'] },
      workspacesProvider: async (): Promise<readonly { id: string; realRootPath: string }[]> => [{ id: workspaceId, realRootPath: workspaceRoot }],
      clientFactory: factory,
    });

    const started = await driver.start({
      providerRoot: path.join(dataRoot, 'thai-rag'),
      ownerId: 'owner',
      providerVersion: '4.61.0',
      embeddingIndexGeneration: 1,
    });
    expect(started.ok).toBe(true);
    expect(connectedConfig?.cwd).toBe(path.join(dataRoot, 'thai-rag', 'sources'));
    expect(connectedConfig?.env?.THAI_RAG_CACHE_DIR).toBe(path.join(dataRoot, 'thai-rag', 'runtime'));
    await driver.stop();
  });

  it('indexes through the explicit UUID namespace when the directory basename differs', async () => {
    const dataRoot = await tempRoot();
    const workspaceRoot = await tempRoot();
    let inFlight = 0;
    let maxInFlight = 0;
    const calls: Array<{ tool: string; args: Readonly<Record<string, unknown>> }> = [];
    const driver = new NativeThaiRagProviderDriver({
      dataRoot,
      launchConfig: { command: '/python' },
      workspacesProvider: async (): Promise<readonly { id: string; realRootPath: string }[]> => [{ id: workspaceId, realRootPath: workspaceRoot }],
      clientFactory: clientFactory({
        async onCall(tool, args): Promise<unknown> {
          calls.push({ tool, args });
          if (tool === 'code_index' || tool === 'recall') {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise((resolve) => setTimeout(resolve, 20));
            inFlight -= 1;
          }
          return success(tool === 'code_index' ? 'indexed' : 'ok');
        },
      }),
    });
    expect((await driver.start({ providerRoot: path.join(dataRoot, 'thai-rag'), ownerId: 'owner', providerVersion: '4.61.0', embeddingIndexGeneration: 1 })).ok).toBe(true);

    const scheduled = await driver.call('code_index', { workspace_id: workspaceId, workspace_path: workspaceRoot, force: false, background: true });
    expect(scheduled.ok).toBe(true);
    if (!scheduled.ok || !isRecord(scheduled.value) || typeof scheduled.value.job_id !== 'string') return;
    const foreground = driver.call('recall', { query: 'after index' });
    await foreground;
    await new Promise((resolve) => setTimeout(resolve, 10));
    const status = await driver.call('index_status', { job_id: scheduled.value.job_id, workspace_id: workspaceId });

    expect(status.ok && isRecord(status.value) && status.value.status).toBe('completed');
    expect(maxInFlight).toBe(1);
    const indexCall = calls.find((call) => call.tool === 'code_index');
    expect(indexCall?.args).toMatchObject({
      workspace_path: workspaceRoot,
      workspace_id: workspaceId,
      workspace: workspaceId,
      background: false,
    });
    await driver.stop();
  });

  it('requires exact workspace scope when reading an index job status', async () => {
    const dataRoot = await tempRoot();
    const workspaceRoot = await tempRoot();
    const driver = new NativeThaiRagProviderDriver({
      dataRoot,
      launchConfig: { command: '/python' },
      workspacesProvider: async (): Promise<readonly { id: string; realRootPath: string }[]> => [
        { id: workspaceId, realRootPath: workspaceRoot },
        { id: recoveredWorkspaceId, realRootPath: await tempRoot() },
      ],
      clientFactory: clientFactory(),
    });
    expect((await driver.start({ providerRoot: path.join(dataRoot, 'thai-rag'), ownerId: 'owner', providerVersion: '4.61.0', embeddingIndexGeneration: 1 })).ok).toBe(true);

    const scheduled = await driver.call('code_index', { workspace_id: workspaceId, workspace_path: workspaceRoot, background: true });
    expect(scheduled.ok).toBe(true);
    if (!scheduled.ok || !isRecord(scheduled.value) || typeof scheduled.value.job_id !== 'string') return;

    const unscoped = await driver.call('index_status', { job_id: scheduled.value.job_id });
    expect(unscoped.ok).toBe(false);
    if (!unscoped.ok) expect(unscoped.error.code).toBe('INVALID_INPUT');
    const wrongWorkspace = await driver.call('index_status', { job_id: scheduled.value.job_id, workspace_id: recoveredWorkspaceId });
    expect(wrongWorkspace.ok).toBe(false);
    if (!wrongWorkspace.ok) expect(wrongWorkspace.error.code).toBe('PERMISSION_DENIED');
    const scoped = await driver.call('index_status', { job_id: scheduled.value.job_id, workspace_id: workspaceId });
    expect(scoped.ok).toBe(true);
    if (scoped.ok) expect(scoped.value).toMatchObject({ workspaceId });
    await driver.stop();
  });

  it('rejects unscoped worker writes instead of forwarding them', async () => {
    const dataRoot = await tempRoot();
    const workspaceRoot = await tempRoot();
    const calls: Array<{ tool: string; args: Readonly<Record<string, unknown>> }> = [];
    const driver = new NativeThaiRagProviderDriver({
      dataRoot,
      launchConfig: { command: '/python' },
      workspacesProvider: async (): Promise<readonly { id: string; realRootPath: string }[]> => [{ id: workspaceId, realRootPath: workspaceRoot }],
      clientFactory: clientFactory({
        async onCall(tool, args): Promise<unknown> {
          calls.push({ tool, args });
          return success('ok');
        },
      }),
    });
    expect((await driver.start({ providerRoot: path.join(dataRoot, 'thai-rag'), ownerId: 'owner', providerVersion: '4.61.0', embeddingIndexGeneration: 1 })).ok).toBe(true);

    const result = await driver.call('remember', { content: 'unscoped' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_INPUT');
    expect(calls.some((call) => call.tool === 'remember')).toBe(false);
    await driver.stop();
  });

  it('keeps same-basename workspaces isolated in index requests', async () => {
    const dataRoot = await tempRoot();
    const firstRoot = await tempRoot();
    const secondRoot = await tempRoot();
    const secondId = '22222222-2222-4222-8222-222222222222';
    const calls: Array<{ tool: string; args: Readonly<Record<string, unknown>> }> = [];
    const driver = new NativeThaiRagProviderDriver({
      dataRoot,
      launchConfig: { command: '/python' },
      workspacesProvider: async (): Promise<readonly { id: string; realRootPath: string }[]> => [
        { id: workspaceId, realRootPath: firstRoot },
        { id: secondId, realRootPath: secondRoot },
      ],
      clientFactory: clientFactory({
        async onCall(tool, args): Promise<unknown> {
          if (tool === 'code_index') calls.push({ tool, args });
          return success('indexed');
        },
      }),
    });
    expect((await driver.start({ providerRoot: path.join(dataRoot, 'thai-rag'), ownerId: 'owner', providerVersion: '4.61.0', embeddingIndexGeneration: 1 })).ok).toBe(true);

    expect((await driver.call('code_index', { workspace_id: workspaceId, workspace_path: firstRoot })).ok).toBe(true);
    expect((await driver.call('code_index', { workspace_id: secondId, workspace_path: secondRoot })).ok).toBe(true);
    expect(calls.slice(-2).map((call) => call.args.workspace_id)).toEqual([workspaceId, secondId]);
    await driver.stop();
  });

  it('resolves pre-edit context through the UUID source alias', async () => {
    const dataRoot = await tempRoot();
    const workspaceRoot = await tempRoot();
    const sourceFile = path.join(workspaceRoot, 'src', 'example.py');
    await mkdir(path.dirname(sourceFile), { recursive: true });
    await writeFile(sourceFile, 'def example():\n    return 1\n', 'utf8');
    const sourcesRoot = path.join(dataRoot, 'thai-rag', 'sources');
    const realSourceFile = await realpath(sourceFile);
    const driver = new NativeThaiRagProviderDriver({
      dataRoot,
      launchConfig: { command: '/python' },
      workspacesProvider: async (): Promise<readonly { id: string; realRootPath: string }[]> => [{ id: workspaceId, realRootPath: workspaceRoot }],
      clientFactory: clientFactory({
        async onCall(tool, args): Promise<unknown> {
          if (tool === 'pre_edit_context') {
            const requested = typeof args.file_path === 'string' ? args.file_path : '';
            const resolved = await realpath(path.join(sourcesRoot, requested)).catch(() => null);
            return success(resolved === realSourceFile ? 'context-found' : 'code_context: none');
          }
          return success(tool === 'code_index' ? 'indexed' : 'ok');
        },
      }),
    });

    expect((await driver.start({ providerRoot: path.join(dataRoot, 'thai-rag'), ownerId: 'owner', providerVersion: '4.61.0', embeddingIndexGeneration: 1 })).ok).toBe(true);
    expect((await driver.call('code_index', { workspace_id: workspaceId, workspace_path: workspaceRoot })).ok).toBe(true);
    const preEdit = await driver.call('pre_edit_context', { workspace: workspaceId, file_path: 'src/example.py' });

    expect(preEdit).toMatchObject({ ok: true, value: { structuredContent: { result: 'context-found' } } });
    expect(await realpath(path.join(sourcesRoot, workspaceId))).toBe(await realpath(workspaceRoot));
    await driver.stop();
  });

  it('fails startup when the worker lacks the explicit workspace namespace contract', async () => {
    const dataRoot = await tempRoot();
    const workspaceRoot = await tempRoot();
    const driver = new NativeThaiRagProviderDriver({
      dataRoot,
      launchConfig: { command: '/python' },
      workspacesProvider: async (): Promise<readonly { id: string; realRootPath: string }[]> => [{ id: workspaceId, realRootPath: workspaceRoot }],
      clientFactory: clientFactory({ codeIndexSupportsWorkspace: false }),
    });

    const started = await driver.start({
      providerRoot: path.join(dataRoot, 'thai-rag'),
      ownerId: 'owner',
      providerVersion: '4.61.0',
      embeddingIndexGeneration: 1,
    });

    expect(started.ok).toBe(false);
    if (!started.ok) expect(started.error.message).toContain('explicit workspace namespace contract');
  });

  it('fails startup when the worker lacks the scoped forget category contract', async () => {
    const dataRoot = await tempRoot();
    const workspaceRoot = await tempRoot();
    const driver = new NativeThaiRagProviderDriver({
      dataRoot,
      launchConfig: { command: '/python' },
      workspacesProvider: async (): Promise<readonly { id: string; realRootPath: string }[]> => [{ id: workspaceId, realRootPath: workspaceRoot }],
      clientFactory: clientFactory({ forgetSupportsCategory: false }),
    });

    const started = await driver.start({ providerRoot: path.join(dataRoot, 'thai-rag'), ownerId: 'owner', providerVersion: '4.61.0', embeddingIndexGeneration: 1 });

    expect(started.ok).toBe(false);
    if (!started.ok) expect(started.error.message).toContain('forget does not support the workspace category contract');
  });

  it('rejects malformed workspace IDs before creating source aliases', async () => {
    const dataRoot = await tempRoot();
    const workspaceRoot = await tempRoot();
    const driver = new NativeThaiRagProviderDriver({
      dataRoot,
      launchConfig: { command: '/python' },
      workspacesProvider: async (): Promise<readonly { id: string; realRootPath: string }[]> => [{ id: '../outside', realRootPath: workspaceRoot }],
      clientFactory: clientFactory(),
    });

    const started = await driver.start({ providerRoot: path.join(dataRoot, 'thai-rag'), ownerId: 'owner', providerVersion: '4.61.0', embeddingIndexGeneration: 1 });

    expect(started.ok).toBe(false);
    if (!started.ok) expect(started.error.message).toContain('workspace ID is not canonical');
    await expect(access(path.join(dataRoot, 'thai-rag', 'sources'))).rejects.toThrow();
  });

  it('refreshes registered workspace roots without restarting the worker', async () => {
    const dataRoot = await tempRoot();
    const workspaceRoot = await tempRoot();
    const recoveredRoot = await tempRoot();
    let current = [{ id: workspaceId, realRootPath: workspaceRoot }];
    const calls: Array<{ tool: string; args: Readonly<Record<string, unknown>> }> = [];
    const driver = new NativeThaiRagProviderDriver({
      dataRoot,
      launchConfig: { command: '/python' },
      workspacesProvider: async (): Promise<readonly { id: string; realRootPath: string }[]> => current,
      clientFactory: clientFactory({
        async onCall(tool, args): Promise<unknown> {
          calls.push({ tool, args });
          return success('ok');
        },
      }),
    });
    expect((await driver.start({ providerRoot: path.join(dataRoot, 'thai-rag'), ownerId: 'owner', providerVersion: '4.61.0', embeddingIndexGeneration: 1 })).ok).toBe(true);

    current = [{ id: recoveredWorkspaceId, realRootPath: recoveredRoot }];
    const result = await driver.call('pre_edit_context', { workspace_id: recoveredWorkspaceId, workspace: recoveredWorkspaceId, file_path: 'src/index.ts' });

    expect(result.ok).toBe(true);
    expect(calls.some((call) => call.tool === 'code_index' && call.args.workspace === recoveredWorkspaceId && call.args.force === true)).toBe(true);
    expect(calls.at(-1)?.args).toMatchObject({ workspace: recoveredWorkspaceId, file_path: `${recoveredWorkspaceId}/src/index.ts` });
    await expect(access(path.join(dataRoot, 'thai-rag', 'sources', workspaceId))).resolves.toBeUndefined();
    await expect(realpath(path.join(dataRoot, 'thai-rag', 'sources', recoveredWorkspaceId))).resolves.toBe(await realpath(recoveredRoot));
    await driver.stop();
  });

  it('reindexes a relinked workspace after a provider restart', async () => {
    const dataRoot = await tempRoot();
    const firstRoot = await tempRoot();
    const relinkedRoot = await tempRoot();
    const calls: Array<{ tool: string; args: Readonly<Record<string, unknown>> }> = [];
    const createDriver = (root: string): NativeThaiRagProviderDriver => new NativeThaiRagProviderDriver({
      dataRoot,
      launchConfig: { command: '/python' },
      workspacesProvider: async (): Promise<readonly { id: string; realRootPath: string }[]> => [{ id: workspaceId, realRootPath: root }],
      clientFactory: clientFactory({
        async onCall(tool, args): Promise<unknown> {
          calls.push({ tool, args });
          return success('indexed');
        },
      }),
    });

    const first = createDriver(firstRoot);
    expect((await first.start({ providerRoot: path.join(dataRoot, 'thai-rag'), ownerId: 'owner', providerVersion: '4.61.0', embeddingIndexGeneration: 1 })).ok).toBe(true);
    await first.stop();

    const second = createDriver(relinkedRoot);
    expect((await second.start({ providerRoot: path.join(dataRoot, 'thai-rag'), ownerId: 'owner', providerVersion: '4.61.0', embeddingIndexGeneration: 1 })).ok).toBe(true);
    expect(calls.some((call) => call.tool === 'code_index' && call.args.workspace === workspaceId && call.args.force === true)).toBe(true);
    await second.stop();
  });

  it('restores the previous source alias when a relink reindex fails', async () => {
    const dataRoot = await tempRoot();
    const firstRoot = await tempRoot();
    const relinkedRoot = await tempRoot();
    let current = [{ id: workspaceId, realRootPath: firstRoot }];
    let failIndex = false;
    const driver = new NativeThaiRagProviderDriver({
      dataRoot,
      launchConfig: { command: '/python' },
      workspacesProvider: async (): Promise<readonly { id: string; realRootPath: string }[]> => current,
      clientFactory: clientFactory({
        async onCall(tool): Promise<unknown> {
          if (tool === 'code_index' && failIndex) return { content: [{ type: 'text', text: 'Error: index failed' }] };
          return success('ok');
        },
      }),
    });

    expect((await driver.start({ providerRoot: path.join(dataRoot, 'thai-rag'), ownerId: 'owner', providerVersion: '4.61.0', embeddingIndexGeneration: 1 })).ok).toBe(true);
    current = [{ id: workspaceId, realRootPath: relinkedRoot }];
    failIndex = true;

    const result = await driver.call('pre_edit_context', { workspace_id: workspaceId, workspace: workspaceId, file_path: 'src/index.ts' });

    expect(result.ok).toBe(false);
    await expect(realpath(path.join(dataRoot, 'thai-rag', 'sources', workspaceId))).resolves.toBe(await realpath(firstRoot));
    await driver.stop();
  });
});

function clientFactory(options: {
  readonly onConnect?: (config: McpServerLaunchConfig) => void;
  readonly onCall?: (tool: string, args: Readonly<Record<string, unknown>>) => Promise<unknown>;
  readonly codeIndexSupportsWorkspace?: boolean;
  readonly codeIndexSupportsWorkspaceId?: boolean;
  readonly forgetSupportsCategory?: boolean;
} = {}): McpClientFactory {
  return {
    async connect(config): Promise<McpClientSession> {
      options.onConnect?.(config);
      return {
        async listTools(): Promise<Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>> {
          return tools.map((name) => ({
            name,
            description: name,
            inputSchema: name === 'code_index' && options.codeIndexSupportsWorkspace !== false
              ? { type: 'object', properties: {
                  workspace: { type: 'string' },
                  ...(options.codeIndexSupportsWorkspaceId === false ? {} : { workspace_id: { type: 'string' } }),
                } }
              : name === 'forget' && options.forgetSupportsCategory !== false
                ? { type: 'object', properties: { category: { type: 'string' } } }
                : { type: 'object' },
          }));
        },
        async listResources(): Promise<[]> { return []; },
        async callTool(tool, args): Promise<unknown> {
          return options.onCall === undefined ? success('ok') : options.onCall(tool, args);
        },
        async close(): Promise<void> {},
      };
    },
  };
}

function success(result: string): unknown {
  return { content: [{ type: 'text', text: result }], structuredContent: { result } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
