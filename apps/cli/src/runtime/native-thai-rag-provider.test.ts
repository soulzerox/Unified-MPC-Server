import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { McpClientFactory, McpClientSession, McpServerLaunchConfig } from '@unified-mpc/extensions';
import { NativeThaiRagProviderDriver } from './native-thai-rag-provider.js';

const roots: string[] = [];
const workspaceId = '11111111-1111-4111-8111-111111111111';
const tools = ['remember', 'recall', 'remember_turn', 'pre_edit_context', 'code_blast_radius', 'forget', 'code_index', 'index_status', 'code_search', 'code_context'];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'native-thai-rag-driver-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('NativeThaiRagProviderDriver', () => {
  it('launches the worker under the Unified-owned cache and canonical source root', async () => {
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

    const scheduled = await driver.call('code_index', { workspace_path: workspaceRoot, force: false, background: true });
    expect(scheduled.ok).toBe(true);
    if (!scheduled.ok || !isRecord(scheduled.value) || typeof scheduled.value.job_id !== 'string') return;
    const foreground = driver.call('recall', { query: 'after index' });
    await foreground;
    await new Promise((resolve) => setTimeout(resolve, 10));
    const status = await driver.call('index_status', { job_id: scheduled.value.job_id });

    expect(status.ok && isRecord(status.value) && status.value.status).toBe('completed');
    expect(maxInFlight).toBe(1);
    const indexCall = calls.find((call) => call.tool === 'code_index');
    expect(indexCall?.args).toMatchObject({
      workspace_path: workspaceRoot,
      workspace: workspaceId,
      background: false,
    });
    await driver.stop();
  });
});

function clientFactory(options: {
  readonly onConnect?: (config: McpServerLaunchConfig) => void;
  readonly onCall?: (tool: string, args: Readonly<Record<string, unknown>>) => Promise<unknown>;
} = {}): McpClientFactory {
  return {
    async connect(config): Promise<McpClientSession> {
      options.onConnect?.(config);
      return {
        async listTools(): Promise<Array<{ name: string; description: string; inputSchema: { type: string } }>> {
          return tools.map((name) => ({ name, description: name, inputSchema: { type: 'object' } }));
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
