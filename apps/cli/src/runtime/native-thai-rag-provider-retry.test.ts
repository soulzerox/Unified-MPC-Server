import { mkdtemp, readFile, rm } from 'node:fs/promises';
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

/** The provider's structured answer when its in-memory job registry dropped a job. */
function lostProviderJob(tool: string): unknown {
  return {
    content: [{ type: 'text', text: tool }],
    structuredContent: {
      result: tool,
      data: {
        status: 'unavailable',
        errors: [{
          code: 'workspace_not_found',
          message: 'index job is unknown',
          details: { reason: 'provider_restart_or_retention_expiry' },
        }],
      },
    },
  };
}

async function fixture(onStatus: (poll: number, providerJobId?: string) => Promise<unknown>, options: { indexStatusTimeoutCap?: number; mode?: 'admission' | 'explicit'; indexJobStuckTimeoutMs?: number; onCodeIndex?: (call: number) => unknown; mirroredProviderJobId?: string; onCancel?: () => unknown } = {}): Promise<{ driver: NativeThaiRagProviderDriver; jobId: string; indexStartsAtStart: number; dataRoot: string; counts: () => { connects: number; indexStarts: number; statusPolls: number } }> {
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
        callTool: async (name, args): Promise<unknown> => {
          if (name === 'health' || name === 'version') return response(name, handshake());
          if (name === 'code_index') {
            indexStarts += 1;
            const custom = options.onCodeIndex?.(indexStarts);
            if (custom !== undefined) return custom;
            return response(name, { status: 'running', job_id: 'idx_provider_same', workspace_id: workspaceId });
          }
          if (name === 'index_status') {
            return onStatus(++statusPolls, typeof args?.job_id === 'string' ? args.job_id : undefined);
          }
          if (name === 'cancel_index' && options.onCancel !== undefined) {
            return options.onCancel();
          }
          return response(name, { status: 'ok' });
        },
        close: async () => undefined,
      };
    },
  };
  const driver = new NativeThaiRagProviderDriver({
    dataRoot, launchConfig: { command: '/mock/python' },
    workspacesProvider: async (): Promise<Array<{ id: string; realRootPath: string }>> => [{ id: workspaceId, realRootPath: workspaceRoot }],
    clientFactory, indexJobPollMs: 10,
    ...(options.indexStatusTimeoutCap === undefined ? {} : { indexStatusTimeoutCap: options.indexStatusTimeoutCap }),
    ...(options.indexJobStuckTimeoutMs === undefined ? {} : { indexJobStuckTimeoutMs: options.indexJobStuckTimeoutMs }),
  });
  expect((await driver.start({
    providerRoot: path.join(dataRoot, 'thai-rag'), ownerId: 'owner',
    providerVersion: '4.61.0', embeddingIndexGeneration: 1,
  })).ok).toBe(true);
  // First guarded edit starts one native admission index. Do not call code_index
  // again: that would start a second, unrelated public background job.
  if (options.mode === 'explicit') {
    // An explicit `rag_code_index` background job uses the public monitor
    // instead of the admission monitor.
    const started = await driver.call('code_index', {
      workspace_path: workspaceRoot, workspace_id: workspaceId, background: true, force: true,
    });
    if (!started.ok) throw new Error(`explicit code_index start failed: ${started.error.code}: ${started.error.message}`);
  } else {
    await driver.call('pre_edit_context', { workspace_id: workspaceId, file_path: 'src/probe.ts' });
  }
  // No replacement index may start once the job exists: the same provider job
  // must be read through its transient failures.
  const indexStartsAtStart = indexStarts;
  const persisted = JSON.parse(await readFile(path.join(dataRoot, 'thai-rag', 'index-jobs.json'), 'utf8')) as {
    jobs: Array<{ jobId: string; workspaceId: string; providerJobId?: string }>;
  };
  const mirroredProviderJobId = options.mirroredProviderJobId ?? 'idx_provider_same';
  const indexJob = persisted.jobs.find((job) => job.workspaceId === workspaceId
    && job.providerJobId === mirroredProviderJobId);
  if (indexJob === undefined) throw new Error('Missing native admission job');
  return { driver, jobId: indexJob.jobId, indexStartsAtStart, dataRoot, counts: (): { connects: number; indexStarts: number; statusPolls: number } => ({ connects, indexStarts, statusPolls }) };
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
      // Demand-first admission (#202 T8): one bounded trial probe (max_files 3)
      // plus one background delta. A transient status timeout must not start a
      // replacement index.
      expect(counts()).toEqual({ connects: 2, indexStarts: 2, statusPolls: 2 });
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
      // Trial probe + background delta, and no replacement index after the
      // provider-reported failure.
      expect(counts().indexStarts).toBe(2);
    } finally { await driver.stop(); }
  });

  it('marks the index job failed and clears the admission gate when index_status stays unreachable past the deadline (issue #407)', async () => {
    const { driver, jobId } = await fixture(async () => {
      throw new Error('Timed out calling thai-rag-native/index_status');
    }, { indexStatusTimeoutCap: 3 });
    try {
      const terminal = await terminalJob(driver, jobId);
      const payload = (terminal as { ok: true; value: { status: string; error?: string } }).value;
      // issue #407: a hung provider call fails the job at its deadline; the
      // admission gate is released instead of holding reads hostage.
      expect(payload.status).toBe('failed');
      expect(payload.error ?? '').toContain('index-status-unreachable');
    } finally { await driver.stop(); }
  });

  it('marks the mirrored job failed when the provider no longer knows it at cancel time (issue #445)', async () => {
    const { driver } = await fixture(async () => response('index_status', {
      status: 'done', job_id: 'idx_provider_same', workspace_id: workspaceId,
      result: { status: 'complete', indexed: 3 },
    }), { onCancel: () => lostProviderJob('cancel_index') });
    try {
      // A mirrored running row whose provider entry vanished: nothing can
      // cancel it, and the old code returned the raw CONFLICT leaving the row
      // `running` forever (health kept advertising a job that no longer
      // existed and stopped refreshing while it did).
      const store = (driver as unknown as { jobs: {
        create(workspaceId: string, force: boolean, ownerId: string, reason: string): Promise<{ jobId: string }>;
        bindProviderJob(jobId: string, providerJobId: string, ownerId: string): Promise<unknown>;
      } }).jobs;
      const job = await store.create(workspaceId, false, 'owner', 'explicit_request');
      await store.bindProviderJob(job.jobId, 'idx_provider_same', 'owner');
      const cancelled = await driver.call('cancel_index', { workspace_id: workspaceId, job_id: job.jobId });
      expect(cancelled.ok).toBe(true);
      const payload = (cancelled as { ok: true; value: { status: string; error?: string } }).value;
      expect(payload.status).toBe('failed');
      expect(payload.error ?? '').toContain('provider-job-lost');
      const status = await driver.call('index_status', { workspace_id: workspaceId, job_id: job.jobId });
      expect(status).toMatchObject({ ok: true, value: { status: 'failed' } });
    } finally { await driver.stop(); }
  });

  it('keeps a healthy explicit background index running while the provider reports queued (issue #441)', async () => {
    const { driver, jobId, indexStartsAtStart, counts } = await fixture(async (poll) => {
      if (poll <= 2) return response('index_status', { status: 'queued', job_id: 'idx_provider_same', workspace_id: workspaceId });
      return response('index_status', {
        status: 'done', job_id: 'idx_provider_same', workspace_id: workspaceId,
        result: { status: 'complete', indexed: 924 },
      });
    }, { mode: 'explicit' });
    try {
      const terminal = await terminalJob(driver, jobId);
      const payload = (terminal as { ok: true; value: { status: string; result?: { indexed?: number } } }).value;
      // The python provider answers `queued` until its runner picks the job up.
      // That is in-progress, not an unknown status to fail on.
      expect(payload.status).toBe('completed');
      expect(payload.result?.indexed).toBe(924);
      expect(counts().indexStarts).toBe(indexStartsAtStart);
    } finally { await driver.stop(); }
  });

  it('keeps the admission index running while the provider reports queued (issue #441)', async () => {
    const { driver, jobId, counts } = await fixture(async (poll) => {
      if (poll <= 2) return response('index_status', { status: 'queued', job_id: 'idx_provider_same', workspace_id: workspaceId });
      return response('index_status', {
        status: 'done', job_id: 'idx_provider_same', workspace_id: workspaceId,
        result: { status: 'complete', indexed: 3 },
      });
    });
    try {
      const terminal = await terminalJob(driver, jobId);
      const payload = (terminal as { ok: true; value: { status: string } }).value;
      expect(payload.status).toBe('completed');
      expect(counts().indexStarts).toBe(2);
    } finally { await driver.stop(); }
  });

  it('still fails an index job whose provider reports an unrecognized status (issue #441)', async () => {
    // A genuinely unknown status is still terminal: only the documented
    // in-progress statuses keep the job alive.
    await expect(fixture(async () => response('index_status', {
      status: 'quantum-entangled', job_id: 'idx_provider_same', workspace_id: workspaceId,
    }), { mode: 'explicit' })).rejects.toThrow(/unknown index status/);
  });

  it('refreshes the durable stuck-job clock while the provider is still embedding (issue #445)', async () => {
    const { driver, jobId, dataRoot } = await fixture(async (poll) => {
      // A semantic build reports the same counters for a long stretch while it
      // embeds. Successful polls are the only liveness evidence available.
      if (poll <= 12) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return response('index_status', {
          status: 'running', job_id: 'idx_provider_same', workspace_id: workspaceId,
          indexed_files: 0, skipped_files: 0, total_files: 10,
        });
      }
      return response('index_status', {
        status: 'done', job_id: 'idx_provider_same', workspace_id: workspaceId,
        result: { status: 'complete', indexed: 10 },
      });
    }, { mode: 'explicit', indexJobStuckTimeoutMs: 600_000 });
    try {
      const terminal = await terminalJob(driver, jobId);
      const payload = (terminal as { ok: true; value: { status: string } }).value;
      expect(payload.status).toBe('completed');
      const persisted = JSON.parse(await readFile(path.join(dataRoot, 'thai-rag', 'index-jobs.json'), 'utf8')) as {
        jobs: Array<{ jobId: string; progressAt?: string; startedAt?: string; indexedFiles?: number }>;
      };
      const row = persisted.jobs.find((job) => job.jobId === jobId);
      // The counters never moved, so only the heartbeat can have advanced the
      // clock the stuck-job reaper reads.
      expect(row?.indexedFiles).toBe(0);
      expect(Date.parse(row?.progressAt ?? '')).toBeGreaterThan(Date.parse(row?.startedAt ?? ''));
    } finally { await driver.stop(); }
  });

  it('retries an index start the provider rejected for a contended SQLite write', async () => {
    const busy = response('code_index', {
      status: 'unavailable',
      errors: [{
        code: 'storage_unavailable',
        message: 'database is locked',
        details: { retryable: true, reason: 'sqlite_busy' },
      }],
    });
    const { driver, jobId, counts } = await fixture(async () => response('index_status', {
      status: 'done', job_id: 'idx_provider_same', workspace_id: workspaceId,
      result: { status: 'complete', indexed: 1 },
    }), { mode: 'explicit', onCodeIndex: (call) => (call === 1 ? busy : undefined) });
    try {
      const terminal = await terminalJob(driver, jobId);
      expect((terminal as { ok: true; value: { status: string } }).value.status).toBe('completed');
      // The rejected start was re-asked rather than failed. The exact count
      // also includes any concurrent admission probe, so only the lower bound
      // is meaningful here.
      expect(counts().indexStarts).toBeGreaterThanOrEqual(2);
    } finally { await driver.stop(); }
  });

  it('retries a busy admission trial instead of abandoning the workspace generation', async () => {
    const busy = response('code_index', {
      status: 'unavailable',
      errors: [{
        code: 'storage_unavailable',
        message: 'database is locked',
        details: { retryable: true, reason: 'sqlite_busy' },
      }],
    });
    const { driver, jobId, counts } = await fixture(async () => response('index_status', {
      status: 'done', job_id: 'idx_provider_same', workspace_id: workspaceId,
      result: { status: 'complete', indexed: 1 },
    }), { onCodeIndex: (call) => (call === 1 ? busy : undefined) });
    try {
      const terminal = await terminalJob(driver, jobId);
      expect((terminal as { ok: true; value: { status: string } }).value.status).toBe('completed');
      expect(counts().indexStarts).toBeGreaterThanOrEqual(2);
    } finally { await driver.stop(); }
  });

  it('keeps a transient read timeout from failing an explicit background index (issue #439)', async () => {
    const { driver, jobId, indexStartsAtStart, counts } = await fixture(async (poll) => {
      if (poll === 1) throw new Error('Timed out calling thai-rag-native/index_status');
      return response('index_status', {
        status: 'done', job_id: 'idx_provider_same', workspace_id: workspaceId,
        result: { status: 'complete', indexed: 924 },
      });
    }, { mode: 'explicit' });
    try {
      const terminal = await terminalJob(driver, jobId);
      const payload = (terminal as { ok: true; value: { status: string; result?: { indexed?: number } } }).value;
      // The explicit rag_code_index monitor answers a starved poll the same way
      // the admission monitor does instead of failing the whole build.
      expect(payload.status).toBe('completed');
      expect(payload.result?.indexed).toBe(924);
      // The same provider job is read through its transient failure: no
      // replacement index is started.
      expect(counts().indexStarts).toBe(indexStartsAtStart);
    } finally { await driver.stop(); }
  });

  it('still tolerates transient status errors below the deadline without failing the job (issue #407)', async () => {
    const { driver, jobId, counts } = await fixture(async (poll) => {
      if (poll <= 2) throw new Error('Timed out calling thai-rag-native/index_status');
      return response('index_status', {
        status: 'done', job_id: 'idx_provider_same', workspace_id: workspaceId,
        result: { status: 'complete', indexed: 5 },
      });
    }, { indexStatusTimeoutCap: 6 });
    try {
      const terminal = await terminalJob(driver, jobId);
      const payload = (terminal as { ok: true; value: { status: string } }).value;
      expect(payload.status).toBe('completed');
      expect(counts().indexStarts).toBe(2);
    } finally { await driver.stop(); }
  });

  it('releases the admission gate when the worker dies mid-run and lets a later read re-admit without a restart (issue #407)', async () => {
    const worker = { broken: true };
    const { driver, jobId } = await fixture(async () => {
      if (worker.broken) throw new Error('Connection closed: index worker session terminated');
      return response('index_status', {
        status: 'done', job_id: 'idx_provider_same', workspace_id: workspaceId,
        result: { status: 'complete', indexed: 7 },
      });
    });
    try {
      const first = await terminalJob(driver, jobId);
      const firstPayload = (first as { ok: true; value: { status: string; error?: string } }).value;
      // Acceptance "killing the index worker mid-run releases the gate" — a
      // hard worker death is not a call timeout: the monitor must fail the
      // job instead of treating it as retryable.
      expect(firstPayload.status).toBe('failed');
      // The gate must not survive the failure: the next guarded read
      // re-admits with a fresh job and succeeds without restarting the
      // driver runtime.
      worker.broken = false;
      const reAdmit = await driver.call('pre_edit_context', { workspace_id: workspaceId, file_path: 'src/probe.ts' });
      expect(reAdmit.ok).toBe(true);
    } finally { await driver.stop(); }
  });
});

describe('native provider lost index job recovery (issue #449)', () => {
  it('restarts an explicit background job the provider no longer knows', async () => {
    const { driver, jobId, counts } = await fixture(async (_poll, providerJobId) => {
      if (providerJobId === 'idx_explicit_start') return lostProviderJob('index_status');
      return response('index_status', {
        status: 'done', job_id: providerJobId ?? 'idx_provider_same', workspace_id: workspaceId,
        result: { status: 'complete', indexed: 7 },
      });
    }, {
      mode: 'explicit',
      // 1-2: admission trial + delta, 3: the explicit start, 4: its restart.
      onCodeIndex: (call) => {
        if (call <= 2) return undefined;
        return response('code_index', {
          status: 'running',
          job_id: call === 3 ? 'idx_explicit_start' : 'idx_explicit_restart',
          workspace_id: workspaceId,
        });
      },
      mirroredProviderJobId: 'idx_explicit_start',
    });
    try {
      const terminal = await terminalJob(driver, jobId);
      // The provider's own contract for a dropped registry entry is "re-run
      // code_index": the mirrored row follows the replacement instead of
      // reporting a dead workspace.
      expect(terminal).toMatchObject({ ok: true, value: {
        status: 'completed', providerJobId: 'idx_explicit_restart',
      } });
      expect(counts().indexStarts).toBe(4);
    } finally { await driver.stop(); }
  });

  it('restarts the admission job the provider no longer knows and keeps the gate', async () => {
    const { driver, jobId, counts } = await fixture(async (_poll, providerJobId) => (providerJobId === 'idx_provider_same'
      ? lostProviderJob('index_status')
      : response('index_status', {
        status: 'done', job_id: 'idx_provider_restart', workspace_id: workspaceId,
        result: { status: 'complete', indexed: 3 },
      })), {
      onCodeIndex: (call) => {
        // 1 = bounded trial probe, 2 = background delta, 3 = the restart.
        if (call <= 2) return undefined;
        return response('code_index', { status: 'running', job_id: 'idx_provider_restart', workspace_id: workspaceId });
      },
      // The guarded read waits for admission, so the mirrored row has already
      // followed the restart by the time the fixture reads the store.
      mirroredProviderJobId: 'idx_provider_restart',
    });
    try {
      const terminal = await terminalJob(driver, jobId);
      expect(terminal).toMatchObject({ ok: true, value: {
        status: 'completed', providerJobId: 'idx_provider_restart',
      } });
      expect(counts().indexStarts).toBe(3);
    } finally { await driver.stop(); }
  });

  it('stops restarting once the provider keeps dropping the job', async () => {
    const { driver, jobId, counts } = await fixture(async () => lostProviderJob('index_status'));
    try {
      const terminal = await terminalJob(driver, jobId);
      const payload = (terminal as { ok: true; value: { status: string; error?: string } }).value;
      expect(payload.status).toBe('failed');
      expect(payload.error ?? '').toContain('index job is unknown');
      // Trial + delta plus the bounded restarts, never an endless loop.
      expect(counts().indexStarts).toBe(5);
    } finally { await driver.stop(); }
  });
});
