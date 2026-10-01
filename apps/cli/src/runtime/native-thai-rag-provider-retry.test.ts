import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { McpClientFactory, McpClientSession } from '@unified-mpc/extensions';
import { THAI_RAG_CANCEL_CAPABILITY, THAI_RAG_CANCEL_CONTRACT_FINGERPRINT } from '@unified-mpc/thai-rag';
import { NativeThaiRagProviderDriver } from './native-thai-rag-provider.js';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const tools = ['remember', 'recall', 'record_event', 'forget', 'pre_edit_context', 'code_search',
  'code_context', 'code_blast_radius', 'code_index', 'index_status', 'health', 'version', 'cancel_index'];
const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'thai-rag-status-retry-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function handshake(): Record<string, unknown> {
  return {
    provider_id: 'thai-rag', provider_version: '0.1.0', contract_version: '1.0',
    compatibility_range: { min: '1.0', max: '1.x' },
    contract_fingerprint: THAI_RAG_CANCEL_CONTRACT_FINGERPRINT,
    index_job_contract_version: '1.1',
    capabilities: [...tools.filter((name) => name !== 'cancel_index'), THAI_RAG_CANCEL_CAPABILITY],
    workspace_scope_model: 'explicit_workspace_id',
    state: 'ready', workspace_ready: true, embedding_index_generation: 1,
    components: {
      worker_reachable: true, sqlite_available: true, fts_available: true,
      vector_store_available: true, embedder_available: true,
      lexical_retrieval_available: true, semantic_retrieval_available: true, active_jobs: [],
    },
    embedding: {
      profile: 'nomic-embed-text-v2-moe',
      model: 'nomic-embed-text-v2-moe@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      dimension: 768, preprocessing_version: '1',
    },
    generation: {
      contract: THAI_RAG_CANCEL_CONTRACT_FINGERPRINT,
      embedding: 'nomic-embed-text-v2-moe', index: '1', storage: 'sqlite',
    },
  };
}

function response(tool: string, data: Record<string, unknown>): unknown {
  return { content: [{ type: 'text', text: tool }], structuredContent: { result: tool, data } };
}

async function fixture(onStatus: (poll: number) => Promise<unknown>) {
  const dataRoot = await tempRoot();
  const workspaceRoot = await tempRoot();
  let connects = 0;
  let indexStarts = 0;
  let statusPolls = 0;
  const clientFactory: McpClientFactory = {
    async connect(): Promise<McpClientSession> {
      connects += 1;
      return {
        listTools: async () => tools.map((name) => ({
          name, description: name, inputSchema: { type: 'object' },
        })),
        listResources: async () => [],
        callTool: async (name) => {
          if (name === 'health' || name === 'version') return response(name, handshake());
          if (name === 'code_index') {
            indexStarts += 1;
            return response(name, { status: 'running', job_id: 'idx_provider_same', workspace_id: workspaceId });
          }
          if (name === 'index_status') return onStatus(++statusPolls);
          return response(name, { status: 'ok' });
        },
        close: async () => undefined,
      };
    },
  };
  const driver = new NativeThaiRagProviderDriver({
    dataRoot, launchConfig: { command: '/mock/python' },
    workspacesProvider: async () => [{ id: workspaceId, realRootPath: workspaceRoot }],
    clientFactory, indexJobPollMs: 10,
  });
  expect((await driver.start({
    providerRoot: path.join(dataRoot, 'thai-rag'), ownerId: 'owner',
    providerVersion: '4.61.0', embeddingIndexGeneration: 1,
  })).ok).toBe(true);
  const started = await driver.call('code_index', {
    workspace_path: workspaceRoot, workspace_id: workspaceId, background: true, force: false,
  });
  if (!started.ok || typeof (started.value as { job_id?: unknown }).job_id !== 'string') {
    throw new Error('Missing durable local job');
  }
  return { driver, jobId: (started.value as { job_id: string }).job_id,
    counts: () => ({ connects, indexStarts, statusPolls }) };
}

async function terminalJob(driver: NativeThaiRagProviderDriver, jobId: string): Promise<unknown> {
  for (let i = 0; i < 120; i += 1) {
    const result = await driver.call('index_status', { workspace_id: workspaceId, job_id: jobId });
    if (result.ok && typeof result.value === 'object' && result.value !== null
      && ['completed', 'failed', 'cancelled'].includes((result.value as { status: string }).status)) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Provider job never reached terminal status');
}

describe('native provider admission index status truth', () => {
  it('retains provider job and dedicated session across a transient index_status timeout', async () => {
    const { driver, jobId, counts } = await fixture(async (poll) => {
      if (poll === 1) throw new Error('Timed out calling thai-rag-native/index_status');
      return response('index_status', {
        status: 'done', job_id: 'idx_provider_same', workspace_id: workspaceId,
        result: { status: 'complete', indexed: 3 },
      });
    });
    try {
      const terminal = await terminalJob(driver, jobId);
      expect(terminal).toMatchObject({ ok: true, value: {
        status: 'completed', providerJobId: 'idx_provider_same',
        result: { status: 'complete', indexed: 3 },
      } });
      expect(counts()).toEqual({ connects: 2, indexStarts: 1, statusPolls: 2 });
    } finally { await driver.stop(); }
  });

  it('fails the Unified job when outer done hides a failed provider result', async () => {
    const { driver, jobId, counts } = await fixture(async () => response('index_status', {
      status: 'done', job_id: 'idx_provider_same', workspace_id: workspaceId,
      result: { status: 'failed', indexed: 3, errors: { 'src/broken.ts': 'Chroma compaction failed' } },
    }));
    try {
      const terminal = await terminalJob(driver, jobId);
      expect(terminal).toMatchObject({ ok: true, value: {
        status: 'failed', providerJobId: 'idx_provider_same',
      } });
      expect(counts().indexStarts).toBe(1);
    } finally { await driver.stop(); }
  });
});
