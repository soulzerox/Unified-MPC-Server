import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { McpClientFactory, McpClientSession, McpServerLaunchConfig } from '@unified-mpc/extensions';
import {
  THAI_RAG_CONFORMANCE_FIXTURE,
  THAI_RAG_CONTRACT_FINGERPRINT,
} from '@unified-mpc/thai-rag';
import { NativeThaiRagProviderDriver } from './native-thai-rag-provider.js';

const roots: string[] = [];
const workspaceId = '11111111-1111-4111-8111-111111111111';
const recoveredWorkspaceId = '22222222-2222-4222-8222-222222222222';
const productionToolNames = ['remember', 'recall', 'record_event', 'forget', 'pre_edit_context', 'code_search', 'code_context', 'code_blast_radius', 'code_index', 'index_status', 'health', 'version'] as const;

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'native-thai-rag-driver-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('NativeThaiRagProviderDriver', () => {
  it('probes every production operation with canonical scope and structured errors', async () => {
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
          if (tool === 'health' || tool === 'version') return success(tool, defaultHandshake());
          if (tool === 'code_index') return success('indexed');
          if (tool === 'index_status') return success('status');
          if (args.workspace_id !== workspaceId) return structuredFailure('workspace_scope_required');
          if (tool === 'code_search' || tool === 'code_context' || tool === 'code_blast_radius' || tool === 'pre_edit_context') return success(tool);
          return success(tool);
        },
      }),
    });
    expect((await driver.start({ providerRoot: path.join(dataRoot, 'thai-rag'), ownerId: 'owner', providerVersion: '4.61.0', embeddingIndexGeneration: 1 })).ok).toBe(true);

    const probes: Array<[typeof productionToolNames[number], Readonly<Record<string, unknown>>]> = [
      ['remember', { workspace_id: workspaceId, content: 'probe' }],
      ['recall', { workspace_id: workspaceId, query: 'probe' }],
      ['record_event', { workspace_id: workspaceId, event_type: 'probe', content: 'probe' }],
      ['forget', { workspace_id: workspaceId, memory_id: 'probe' }],
      ['pre_edit_context', { workspace_id: workspaceId, file_path: 'src/probe.ts' }],
      ['code_search', { workspace_id: workspaceId, query: 'probe' }],
      ['code_context', { workspace_id: workspaceId, file_path: 'src/probe.ts', line_number: 1 }],
      ['code_blast_radius', { workspace_id: workspaceId, symbol_name: 'probe' }],
      ['code_index', { workspace_id: workspaceId, workspace_path: workspaceRoot }],
      ['index_status', { workspace_id: workspaceId, job_id: 'probe' }],
      ['health', {}],
      ['version', {}],
    ];
    for (const [tool, args] of probes) await driver.call(tool, args);
    await expect(driver.call('record_event', { event: 'missing-scope' })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(calls.map(({ tool }) => tool)).toEqual(expect.arrayContaining(['remember', 'recall', 'record_event', 'forget', 'pre_edit_context', 'code_search', 'code_context', 'code_blast_radius', 'code_index']));
    expect(calls.filter(({ tool }) => THAI_RAG_CONFORMANCE_FIXTURE.operations[tool as keyof typeof THAI_RAG_CONFORMANCE_FIXTURE.operations].scope === 'workspace_id').every(({ args }) => args.workspace_id === workspaceId)).toBe(true);
    await expect(driver.call('index_status', { workspace_id: workspaceId, job_id: 'missing' })).resolves.toMatchObject({ ok: false, error: { code: 'FILE_NOT_FOUND' } });
    await driver.stop();
  });

  it('rejects fixture fingerprint drift before probing operations', async () => {
    const dataRoot = await tempRoot();
    const workspaceRoot = await tempRoot();
    const driver = new NativeThaiRagProviderDriver({
      dataRoot,
      launchConfig: { command: '/python' },
      workspacesProvider: async (): Promise<readonly { id: string; realRootPath: string }[]> => [{ id: workspaceId, realRootPath: workspaceRoot }],
      clientFactory: clientFactory({ handshake: { ...defaultHandshake(), contract_fingerprint: 'fixture-drift' } }),
    });
    await expect(driver.start({ providerRoot: path.join(dataRoot, 'thai-rag'), ownerId: 'owner', providerVersion: '4.61.0', embeddingIndexGeneration: 1 })).resolves.toMatchObject({ ok: false, error: { details: { reason: 'fingerprint-mismatch' } } });
    await driver.stop();
  });

  it('matches production-shaped fixture scopes and error declarations', () => {
    expect(THAI_RAG_CONFORMANCE_FIXTURE.workspaceScope).toEqual({ field: 'workspace_id', canonical: true });
    expect(Object.keys(THAI_RAG_CONFORMANCE_FIXTURE.operations)).toEqual([...productionToolNames]);
    for (const operation of productionToolNames) expect(THAI_RAG_CONFORMANCE_FIXTURE.operations[operation].errors.length).toBeGreaterThan(0);
    expect(THAI_RAG_CONFORMANCE_FIXTURE.operations.health.scope).toBe('provider');
    expect(THAI_RAG_CONFORMANCE_FIXTURE.operations.version.scope).toBe('provider');
  });

  it('tests semantic scope and structured error behavior against production-shaped responses', async () => {
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
          if (tool === 'code_index') return success('indexed');
          if (tool === 'recall' && args.workspace_id === workspaceId) return { structuredContent: { data: { status: 'ok', workspace_id: workspaceId, data: { items: [] } } } };
          return { structuredContent: { data: { status: 'unavailable', workspace_id: args.workspace_id, errors: [{ code: 'workspace_scope_required', message: 'canonical workspace_id is required', details: {} }] } } };
        },
      }),
    });
    expect((await driver.start({ providerRoot: path.join(dataRoot, 'thai-rag'), ownerId: 'owner', providerVersion: '4.61.0', embeddingIndexGeneration: 1 })).ok).toBe(true);
    await expect(driver.call('recall', { workspace_id: workspaceId, query: 'scope' })).resolves.toMatchObject({ ok: true, value: { structuredContent: { data: { status: 'ok', workspace_id: workspaceId } } } });
    expect(calls.at(-1)?.args.workspace_id).toBe(workspaceId);
    await expect(driver.call('recall', { workspace_id: 'other-workspace', query: 'scope' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT', details: { reason: 'workspace_scope_required' } },
    });
    await driver.stop();
  });

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

  it('does not interrupt another owner job during provider startup', async () => {
    const dataRoot = await tempRoot();
    const workspaceRoot = await tempRoot();
    const filePath = path.join(dataRoot, 'thai-rag', 'index-jobs.json');
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify({ schemaVersion: 2, jobs: [{
      jobId: 'idx_umcp_owner_a',
      workspaceId,
      ownerId: 'owner-a',
      status: 'running',
      force: true,
      startedAt: '2026-09-17T01:00:00.000Z',
    }] }));
    const driver = new NativeThaiRagProviderDriver({
      dataRoot,
      launchConfig: { command: '/python' },
      workspacesProvider: async (): Promise<readonly { id: string; realRootPath: string }[]> => [{ id: workspaceId, realRootPath: workspaceRoot }],
      clientFactory: clientFactory(),
    });

    expect((await driver.start({ providerRoot: path.join(dataRoot, 'thai-rag'), ownerId: 'owner-b', providerVersion: '4.61.0', embeddingIndexGeneration: 1 })).ok).toBe(true);
    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as { jobs: Array<Record<string, unknown>> };
    expect(persisted.jobs).toEqual([expect.objectContaining({
      jobId: 'idx_umcp_owner_a',
      ownerId: 'owner-a',
      status: 'running',
    })]);
    await driver.stop();
  });

  it('does not block startup on workspace reindexing', async () => {
    const dataRoot = await tempRoot();
    const workspaceRoot = await tempRoot();
    let markIndexStarted: (() => void) | undefined;
    const indexStarted = new Promise<void>((resolve) => { markIndexStarted = resolve; });
    let releaseIndex: (() => void) | undefined;
    const indexBlocked = new Promise<void>((resolve) => { releaseIndex = resolve; });
    const driver = new NativeThaiRagProviderDriver({
      dataRoot,
      launchConfig: { command: '/python' },
      workspacesProvider: async (): Promise<readonly { id: string; realRootPath: string }[]> => [{ id: workspaceId, realRootPath: workspaceRoot }],
      clientFactory: clientFactory({
        async onCall(tool): Promise<unknown> {
          if (tool === 'code_index') {
            markIndexStarted?.();
            await indexBlocked;
          }
          return success('ok');
        },
      }),
    });

    const started = await driver.start({ providerRoot: path.join(dataRoot, 'thai-rag'), ownerId: 'owner', providerVersion: '4.61.0', embeddingIndexGeneration: 1 });

    expect(started.ok).toBe(true);
    await indexStarted;
    releaseIndex?.();
    await driver.stop();
  });

  it('waits for background reindex before completing stop', async () => {
    const dataRoot = await tempRoot();
    const workspaceRoot = await tempRoot();
    let markIndexStarted: (() => void) | undefined;
    const indexStarted = new Promise<void>((resolve) => { markIndexStarted = resolve; });
    let releaseIndex: (() => void) | undefined;
    const indexBlocked = new Promise<void>((resolve) => { releaseIndex = resolve; });
    let indexActive = false;
    const driver = new NativeThaiRagProviderDriver({
      dataRoot,
      launchConfig: { command: '/python' },
      workspacesProvider: async (): Promise<readonly { id: string; realRootPath: string }[]> => [{ id: workspaceId, realRootPath: workspaceRoot }],
      clientFactory: clientFactory({
        async onCall(tool): Promise<unknown> {
          if (tool === 'code_index') {
            indexActive = true;
            markIndexStarted?.();
            await indexBlocked;
            indexActive = false;
          }
          return success('ok');
        },
      }),
    });

    expect((await driver.start({ providerRoot: path.join(dataRoot, 'thai-rag'), ownerId: 'owner', providerVersion: '4.61.0', embeddingIndexGeneration: 1 })).ok).toBe(true);
    await indexStarted;
    let stopCompleted = false;
    const stopping = driver.stop().then((result) => {
      stopCompleted = true;
      return result;
    });
    await Promise.resolve();
    expect(stopCompleted).toBe(false);
    expect(indexActive).toBe(true);
    releaseIndex?.();
    expect((await stopping).ok).toBe(true);
    expect(indexActive).toBe(false);
  });

  it('drains queued calls before closing the worker on stop', async () => {
    const dataRoot = await tempRoot();
    const workspaceRoot = await tempRoot();
    let markIndexStarted: (() => void) | undefined;
    const indexStarted = new Promise<void>((resolve) => { markIndexStarted = resolve; });
    let releaseIndex: (() => void) | undefined;
    const indexBlocked = new Promise<void>((resolve) => { releaseIndex = resolve; });
    let closed = false;
    const calls: string[] = [];
    const driver = new NativeThaiRagProviderDriver({
      dataRoot,
      launchConfig: { command: '/python' },
      workspacesProvider: async (): Promise<readonly { id: string; realRootPath: string }[]> => [{ id: workspaceId, realRootPath: workspaceRoot }],
      clientFactory: clientFactory({
        onClose(): void { closed = true; },
        async onCall(tool): Promise<unknown> {
          calls.push(tool);
          if (tool === 'code_index') {
            markIndexStarted?.();
            await indexBlocked;
          }
          if (closed) throw new Error('worker called after close');
          return success('ok');
        },
      }),
    });

    expect((await driver.start({ providerRoot: path.join(dataRoot, 'thai-rag'), ownerId: 'owner', providerVersion: '4.61.0', embeddingIndexGeneration: 1 })).ok).toBe(true);
    await indexStarted;
    const call = driver.call('recall', { workspace_id: workspaceId, query: 'queued during stop' });
    const stopping = driver.stop();
    await Promise.resolve();
    expect(closed).toBe(false);
    releaseIndex?.();
    expect((await call).ok).toBe(true);
    expect((await stopping).ok).toBe(true);
    expect(calls).toContain('recall');
    expect(closed).toBe(true);
  });

  it('fails closed when restarting same driver after stop', async () => {
    const dataRoot = await tempRoot();
    const workspaceRoot = await tempRoot();
    const driver = new NativeThaiRagProviderDriver({
      dataRoot,
      launchConfig: { command: '/python' },
      workspacesProvider: async (): Promise<readonly { id: string; realRootPath: string }[]> => [{ id: workspaceId, realRootPath: workspaceRoot }],
      clientFactory: clientFactory(),
    });
    const options = { providerRoot: path.join(dataRoot, 'thai-rag'), ownerId: 'owner', providerVersion: '4.61.0', embeddingIndexGeneration: 1 };

    expect((await driver.start(options)).ok).toBe(true);
    expect((await driver.stop()).ok).toBe(true);
    const restarted = await driver.start(options);

    expect(restarted.ok).toBe(false);
    if (!restarted.ok) expect(restarted.error.message).toContain('cannot restart after stop');
  });

  it('serializes concurrent start and stop without opening work after shutdown', async () => {
    const dataRoot = await tempRoot();
    const workspaceRoot = await tempRoot();
    let releaseWorkspaces: (() => void) | undefined;
    const workspacesBlocked = new Promise<void>((resolve) => { releaseWorkspaces = resolve; });
    const driver = new NativeThaiRagProviderDriver({
      dataRoot,
      launchConfig: { command: '/python' },
      workspacesProvider: async (): Promise<readonly { id: string; realRootPath: string }[]> => {
        await workspacesBlocked;
        return [{ id: workspaceId, realRootPath: workspaceRoot }];
      },
      clientFactory: clientFactory(),
    });
    const starting = driver.start({ providerRoot: path.join(dataRoot, 'thai-rag'), ownerId: 'owner', providerVersion: '4.61.0', embeddingIndexGeneration: 1 });
    const stopping = driver.stop();

    releaseWorkspaces?.();
    expect((await starting).ok).toBe(false);
    expect((await stopping).ok).toBe(true);
  });

  it('skips stale alias sync when stop claims shutdown during refresh', async () => {
    const dataRoot = await tempRoot();
    const workspaceRoot = await tempRoot();
    let workspaceReads = 0;
    let releaseRefresh: (() => void) | undefined;
    const refreshBlocked = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    const driver = new NativeThaiRagProviderDriver({
      dataRoot,
      launchConfig: { command: '/python' },
      workspacesProvider: async (): Promise<readonly { id: string; realRootPath: string }[]> => {
        workspaceReads += 1;
        if (workspaceReads > 1) await refreshBlocked;
        return [{ id: workspaceId, realRootPath: workspaceRoot }];
      },
      clientFactory: clientFactory(),
    });
    const options = { providerRoot: path.join(dataRoot, 'thai-rag'), ownerId: 'owner', providerVersion: '4.61.0', embeddingIndexGeneration: 1 };

    expect((await driver.start(options)).ok).toBe(true);
    const refreshing = driver.call('recall', { query: 'refresh before stop' });
    await expect.poll(() => workspaceReads).toBe(2);
    const stopping = driver.stop();
    releaseRefresh?.();

    await refreshing;
    expect((await stopping).ok).toBe(true);
    await expect(realpath(path.join(dataRoot, 'thai-rag', 'sources', workspaceId))).resolves.toBe(await realpath(workspaceRoot));
  });

  it('restores previous alias when stop invalidates an in-flight reindex', async () => {
    const dataRoot = await tempRoot();
    const firstRoot = await tempRoot();
    const relinkedRoot = await tempRoot();
    let current = [{ id: workspaceId, realRootPath: firstRoot }];
    let markIndexStarted: (() => void) | undefined;
    const indexStarted = new Promise<void>((resolve) => { markIndexStarted = resolve; });
    let markRelinkIndexStarted: (() => void) | undefined;
    const relinkIndexStarted = new Promise<void>((resolve) => { markRelinkIndexStarted = resolve; });
    let indexCalls = 0;
    let releaseIndex: (() => void) | undefined;
    const indexBlocked = new Promise<void>((resolve) => { releaseIndex = resolve; });
    const driver = new NativeThaiRagProviderDriver({
      dataRoot,
      launchConfig: { command: '/python' },
      workspacesProvider: async (): Promise<readonly { id: string; realRootPath: string }[]> => current,
      clientFactory: clientFactory({
        async onCall(tool): Promise<unknown> {
          if (tool === 'code_index') {
            indexCalls += 1;
            if (indexCalls === 1) markIndexStarted?.();
            else markRelinkIndexStarted?.();
            await indexBlocked;
          }
          return success('indexed');
        },
      }),
    });
    const options = { providerRoot: path.join(dataRoot, 'thai-rag'), ownerId: 'owner', providerVersion: '4.61.0', embeddingIndexGeneration: 1 };

    expect((await driver.start(options)).ok).toBe(true);
    await indexStarted;
    releaseIndex?.();
    current = [{ id: workspaceId, realRootPath: relinkedRoot }];
    const refreshing = driver.call('recall', { query: 'relink before stop' });
    await relinkIndexStarted;
    const stopping = driver.stop();
    releaseIndex?.();

    await refreshing;
    expect((await stopping).ok).toBe(true);
    await expect(realpath(path.join(dataRoot, 'thai-rag', 'sources', workspaceId))).resolves.toBe(await realpath(firstRoot));
  });

  it('reports stop failure when stale alias restoration is unsafe', async () => {
    const dataRoot = await tempRoot();
    const workspaceRoot = await tempRoot();
    let markIndexStarted: (() => void) | undefined;
    const indexStarted = new Promise<void>((resolve) => { markIndexStarted = resolve; });
    let releaseIndex: (() => void) | undefined;
    const indexBlocked = new Promise<void>((resolve) => { releaseIndex = resolve; });
    const driver = new NativeThaiRagProviderDriver({
      dataRoot,
      launchConfig: { command: '/python' },
      workspacesProvider: async (): Promise<readonly { id: string; realRootPath: string }[]> => [{ id: workspaceId, realRootPath: workspaceRoot }],
      clientFactory: clientFactory({
        async onCall(tool): Promise<unknown> {
          if (tool === 'code_index') {
            markIndexStarted?.();
            await indexBlocked;
          }
          return success('indexed');
        },
      }),
    });
    const options = { providerRoot: path.join(dataRoot, 'thai-rag'), ownerId: 'owner', providerVersion: '4.61.0', embeddingIndexGeneration: 1 };

    expect((await driver.start(options)).ok).toBe(true);
    await indexStarted;
    const alias = path.join(dataRoot, 'thai-rag', 'sources', workspaceId);
    await rm(alias, { recursive: true, force: true });
    await mkdir(alias);
    const stopping = driver.stop();
    releaseIndex?.();

    const stopped = await stopping;
    expect(stopped.ok).toBe(false);
    expect((await lstat(alias)).isSymbolicLink()).toBe(false);
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
    const status = await driver.call('index_status', { job_id: scheduled.value.job_id, workspace_id: workspaceId });

    expect(status.ok && isRecord(status.value) && status.value.status).toBe('completed');
    expect(maxInFlight).toBe(1);
    const indexCall = calls.find((call) => call.tool === 'code_index');
    expect(indexCall?.args).toMatchObject({
      workspace_path: workspaceRoot,
       workspace_id: workspaceId,
       background: false,

    });
    await driver.stop();
  });

  it('rejects arbitrary and foreign index status IDs without calling worker', async () => {
    const dataRoot = await tempRoot();
    const workspaceRoot = await tempRoot();
    const calls: string[] = [];
    const driver = new NativeThaiRagProviderDriver({
      dataRoot,
      launchConfig: { command: '/python' },
      workspacesProvider: async (): Promise<readonly { id: string; realRootPath: string }[]> => [
        { id: workspaceId, realRootPath: workspaceRoot },
        { id: recoveredWorkspaceId, realRootPath: await tempRoot() },
      ],
      clientFactory: clientFactory({
        async onCall(tool): Promise<unknown> {
          calls.push(tool);
          return success('unexpected-worker-call');
        },
      }),
    });

    expect((await driver.start({ providerRoot: path.join(dataRoot, 'thai-rag'), ownerId: 'owner-a', providerVersion: '4.61.0', embeddingIndexGeneration: 1 })).ok).toBe(true);
    await expect(driver.call('index_status', { job_id: 'arbitrary-id', workspace_id: workspaceId })).resolves.toMatchObject({ ok: false, error: { code: 'FILE_NOT_FOUND' } });
    await expect(driver.call('index_status', { job_id: 'idx_umcp_missing', workspace_id: workspaceId })).resolves.toMatchObject({ ok: false, error: { code: 'FILE_NOT_FOUND' } });
    await expect(driver.call('index_status', { job_id: 'idx_umcp_missing', workspace_id: recoveredWorkspaceId })).resolves.toMatchObject({ ok: false, error: { code: 'FILE_NOT_FOUND' } });
    expect(calls).not.toContain('index_status');
    await driver.stop();
  });

  it('preserves noncanonical legacy index jobs as unavailable', async () => {
    const dataRoot = await tempRoot();
    const workspaceRoot = await tempRoot();
    const filePath = path.join(dataRoot, 'thai-rag', 'index-jobs.json');
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify({ schemaVersion: 1, jobs: [{
      jobId: 'idx_umcp_legacy_noncanonical',
      workspaceId: 'legacy-workspace-name',
      status: 'completed',
      force: false,
      startedAt: '2026-09-17T01:00:00.000Z',
      result: { indexed: 3 },
    }] }));
    const driver = new NativeThaiRagProviderDriver({
      dataRoot,
      launchConfig: { command: '/python' },
      workspacesProvider: async (): Promise<readonly { id: string; realRootPath: string }[]> => [{ id: workspaceId, realRootPath: workspaceRoot }],
      clientFactory: clientFactory(),
    });

    expect((await driver.start({ providerRoot: path.join(dataRoot, 'thai-rag'), ownerId: 'owner-a', providerVersion: '4.61.0', embeddingIndexGeneration: 1 })).ok).toBe(true);
    await expect(driver.call('index_status', { job_id: 'idx_umcp_legacy_noncanonical', workspace_id: workspaceId })).resolves.toMatchObject({ ok: false, error: { code: 'FILE_NOT_FOUND' } });
    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as { jobs: Array<Record<string, unknown>> };
    expect(persisted.jobs).toEqual([expect.objectContaining({
      jobId: 'idx_umcp_legacy_noncanonical',
      workspaceId: 'legacy-workspace-name',
      status: 'legacy-unavailable',
    })]);
    await driver.stop();
  });

  it('rejects missing index status workspace scope', async () => {
    const dataRoot = await tempRoot();
    const workspaceRoot = await tempRoot();
    const calls: string[] = [];
    const driver = new NativeThaiRagProviderDriver({
      dataRoot,
      launchConfig: { command: '/python' },
      workspacesProvider: async (): Promise<readonly { id: string; realRootPath: string }[]> => [{ id: workspaceId, realRootPath: workspaceRoot }],
      clientFactory: clientFactory({
        async onCall(tool): Promise<unknown> {
          calls.push(tool);
          return success('indexed');
        },
      }),
    });

    expect((await driver.start({ providerRoot: path.join(dataRoot, 'thai-rag'), ownerId: 'owner-a', providerVersion: '4.61.0', embeddingIndexGeneration: 1 })).ok).toBe(true);
    await expect(driver.call('index_status', { job_id: 'idx_umcp_any' })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(calls).not.toContain('index_status');
    await driver.stop();
  });

  it('rejects a real job queried through a different workspace', async () => {
    const dataRoot = await tempRoot();
    const workspaceRoot = await tempRoot();
    const otherWorkspaceRoot = await tempRoot();
    const calls: string[] = [];
    const driver = new NativeThaiRagProviderDriver({
      dataRoot,
      launchConfig: { command: '/python' },
      workspacesProvider: async (): Promise<readonly { id: string; realRootPath: string }[]> => [
        { id: workspaceId, realRootPath: workspaceRoot },
        { id: recoveredWorkspaceId, realRootPath: otherWorkspaceRoot },
      ],
      clientFactory: clientFactory({
        async onCall(tool): Promise<unknown> {
          calls.push(tool);
          return success('indexed');
        },
      }),
    });

    expect((await driver.start({ providerRoot: path.join(dataRoot, 'thai-rag'), ownerId: 'owner-a', providerVersion: '4.61.0', embeddingIndexGeneration: 1 })).ok).toBe(true);
    const scheduled = await driver.call('code_index', { workspace_path: workspaceRoot, background: true });
    if (!scheduled.ok || !isRecord(scheduled.value) || typeof scheduled.value.job_id !== 'string') return;
    await new Promise((resolve) => setTimeout(resolve, 10));

    await expect(driver.call('index_status', { job_id: scheduled.value.job_id, workspace_id: recoveredWorkspaceId })).resolves.toMatchObject({ ok: false, error: { code: 'FILE_NOT_FOUND' } });
    expect(calls).not.toContain('index_status');
    await driver.stop();
  });

  it('does not expose index status to a foreign provider owner', async () => {
    const dataRoot = await tempRoot();
    const workspaceRoot = await tempRoot();
    const createDriver = (): NativeThaiRagProviderDriver => new NativeThaiRagProviderDriver({
      dataRoot,
      launchConfig: { command: '/python' },
      workspacesProvider: async (): Promise<readonly { id: string; realRootPath: string }[]> => [{ id: workspaceId, realRootPath: workspaceRoot }],
      clientFactory: clientFactory({
        async onCall(tool): Promise<unknown> { return success(tool === 'code_index' ? 'indexed' : 'ok'); },
      }),
    });

    const first = createDriver();
    expect((await first.start({ providerRoot: path.join(dataRoot, 'thai-rag'), ownerId: 'owner-a', providerVersion: '4.61.0', embeddingIndexGeneration: 1 })).ok).toBe(true);
    const scheduled = await first.call('code_index', { workspace_path: workspaceRoot, background: true });
    if (!scheduled.ok || !isRecord(scheduled.value) || typeof scheduled.value.job_id !== 'string') return;
    await new Promise((resolve) => setTimeout(resolve, 10));
    await first.stop();

    const second = createDriver();
    expect((await second.start({ providerRoot: path.join(dataRoot, 'thai-rag'), ownerId: 'owner-b', providerVersion: '4.61.0', embeddingIndexGeneration: 1 })).ok).toBe(true);
    await expect(second.call('index_status', { job_id: scheduled.value.job_id, workspace_id: workspaceId })).resolves.toMatchObject({ ok: false, error: { code: 'FILE_NOT_FOUND' } });
    await second.stop();
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
    expect((await driver.call('code_index', { workspace_path: workspaceRoot })).ok).toBe(true);
    const preEdit = await driver.call('pre_edit_context', { workspace_id: workspaceId, file_path: 'src/example.py' });

    expect(preEdit).toMatchObject({ ok: true, value: { structuredContent: { result: 'context-found' } } });
    expect(await realpath(path.join(sourcesRoot, workspaceId))).toBe(await realpath(workspaceRoot));
    await driver.stop();
  });

  it.each([
    ['contract version', { contract_version: '2.0' }],
    ['fingerprint', { contract_fingerprint: 'wrong' }],
    ['generation', {
      embedding_index_generation: 2,
      generation: {
        contract: THAI_RAG_CONTRACT_FINGERPRINT,
        embedding: 'nomic-embed-text-v2-moe',
        index: '2',
        storage: 'sqlite',
      },
    }],
  ])('fails closed on handshake %s mismatch', async (_name, change) => {
    const dataRoot = await tempRoot();
    const workspaceRoot = await tempRoot();
    const driver = new NativeThaiRagProviderDriver({
      dataRoot,
      launchConfig: { command: '/python' },
      workspacesProvider: async (): Promise<readonly { id: string; realRootPath: string }[]> => [{ id: workspaceId, realRootPath: workspaceRoot }],
      clientFactory: clientFactory({ handshake: { ...defaultHandshake(), ...change } }),
    });

    const started = await driver.start({ providerRoot: path.join(dataRoot, 'thai-rag'), ownerId: 'owner', providerVersion: '4.61.0', embeddingIndexGeneration: 1 });

    expect(started.ok).toBe(false);
    await driver.stop();
  });

  it.each([
    ['missing contract version', { contract_version: undefined }],
    ['malformed compatibility range', { compatibility_range: { min: '1.0' } }],
  ])('fails closed on %s before provider activation', async (_name, change) => {
    const dataRoot = await tempRoot();
    const workspaceRoot = await tempRoot();
    const driver = new NativeThaiRagProviderDriver({
      dataRoot,
      launchConfig: { command: '/python' },
      workspacesProvider: async (): Promise<readonly { id: string; realRootPath: string }[]> => [{ id: workspaceId, realRootPath: workspaceRoot }],
      clientFactory: clientFactory({ handshake: { ...defaultHandshake(), ...change } }),
    });

    const started = await driver.start({ providerRoot: path.join(dataRoot, 'thai-rag'), ownerId: 'owner', providerVersion: '4.61.0', embeddingIndexGeneration: 1 });

    expect(started.ok).toBe(false);
    if (!started.ok) expect(started.error.details?.reason).toBe('malformed-handshake');
    await driver.stop();
  });

  it('accepts supported tagged model metadata for contract 1.0', async () => {
    const dataRoot = await tempRoot();
    const workspaceRoot = await tempRoot();
    const tagged = {
      ...defaultHandshake(),
      embedding: { ...defaultHandshake().embedding as Record<string, unknown>, profile: 'nomic-embed-text-v2-moe:latest', model: 'nomic-embed-text-v2-moe:latest' },
      generation: { ...defaultHandshake().generation as Record<string, unknown>, embedding: 'nomic-embed-text-v2-moe:latest' },
    };
    const driver = new NativeThaiRagProviderDriver({
      dataRoot,
      launchConfig: { command: '/python' },
      workspacesProvider: async (): Promise<readonly { id: string; realRootPath: string }[]> => [{ id: workspaceId, realRootPath: workspaceRoot }],
      clientFactory: clientFactory({ handshake: tagged }),
    });
    expect((await driver.start({ providerRoot: path.join(dataRoot, 'thai-rag'), ownerId: 'owner', providerVersion: '4.61.0', embeddingIndexGeneration: 1 })).ok).toBe(true);
    await driver.stop();
  });

  it('starts and reports health for a PR25-shaped handshake without preprocessing version', async () => {
    const dataRoot = await tempRoot();
    const workspaceRoot = await tempRoot();
    const driver = new NativeThaiRagProviderDriver({
      dataRoot,
      launchConfig: { command: '/python' },
      workspacesProvider: async (): Promise<readonly { id: string; realRootPath: string }[]> => [{ id: workspaceId, realRootPath: workspaceRoot }],
      clientFactory: clientFactory({ handshake: pr25Handshake() }),
    });

    await expect(driver.start({ providerRoot: path.join(dataRoot, 'thai-rag'), ownerId: 'owner', providerVersion: '4.61.0', embeddingIndexGeneration: 1 })).resolves.toMatchObject({
      ok: true,
      value: { contractVersion: '1.0', indexJobContractVersion: '1.0' },
    });
    await expect(driver.health()).resolves.toMatchObject({
      ok: true,
      value: { contractVersion: '1.0', indexJobContractVersion: '1.0', embedding: { profile: 'nomic-embed-text-v2-moe' } },
    });
    await driver.stop();
  });

  it('rejects unsupported embedding dimension for contract 1.0', async () => {
    const dataRoot = await tempRoot();
    const workspaceRoot = await tempRoot();
    const unsupported = { ...defaultHandshake(), embedding: { ...defaultHandshake().embedding as Record<string, unknown>, dimension: 1024 } };
    const driver = new NativeThaiRagProviderDriver({
      dataRoot,
      launchConfig: { command: '/python' },
      workspacesProvider: async (): Promise<readonly { id: string; realRootPath: string }[]> => [{ id: workspaceId, realRootPath: workspaceRoot }],
      clientFactory: clientFactory({ handshake: unsupported }),
    });
    await expect(driver.start({ providerRoot: path.join(dataRoot, 'thai-rag'), ownerId: 'owner', providerVersion: '4.61.0', embeddingIndexGeneration: 1 })).resolves.toMatchObject({ ok: false, error: { details: { reason: 'embedding-metadata-invalid' } } });
    await driver.stop();
  });

  it('accepts production-shaped Thai-RAG provider handshake bridge', async () => {
    const dataRoot = await tempRoot();
    const workspaceRoot = await tempRoot();
    const production = {
      ...defaultHandshake(),
      contract_version: '0.9',
      compatibility_range: { min: '0.9', max: '1.x' },
      legacy_adapter: 'thai-rag-provider-1.0-production-bridge',
      state: 'degraded',
      embedding: { profile: 'nomic-embed-text-v2-moe:latest', model: 'nomic-embed-text-v2-moe:latest', dimension: 768 },
      generation: { contract: THAI_RAG_CONTRACT_FINGERPRINT, embedding: 'nomic-embed-text-v2-moe:latest', index: 'unknown', storage: 'sqlite' },
      components: {
        worker_reachable: true,
        sqlite_available: true,
        fts_available: true,
        vector_store_available: false,
        embedder_available: false,
        lexical_retrieval_available: true,
        semantic_retrieval_available: false,
        active_jobs: [],
      },
    };
    const driver = new NativeThaiRagProviderDriver({
      dataRoot,
      launchConfig: { command: '/python' },
      workspacesProvider: async (): Promise<readonly { id: string; realRootPath: string }[]> => [{ id: workspaceId, realRootPath: workspaceRoot }],
      clientFactory: clientFactory({ handshake: production }),
    });

    const started = await driver.start({ providerRoot: path.join(dataRoot, 'thai-rag'), ownerId: 'owner', providerVersion: '4.61.0', embeddingIndexGeneration: 1 });

    expect(started.ok).toBe(true);
    await driver.stop();
  });

  it('exposes handshake diagnostics through health refresh', async () => {
    const dataRoot = await tempRoot();
    const workspaceRoot = await tempRoot();
    const driver = new NativeThaiRagProviderDriver({
      dataRoot,
      launchConfig: { command: '/python' },
      workspacesProvider: async (): Promise<readonly { id: string; realRootPath: string }[]> => [{ id: workspaceId, realRootPath: workspaceRoot }],
      clientFactory: clientFactory({ handshake: { ...defaultHandshake(), state: 'degraded', degraded_reasons: ['semantic-retrieval-unavailable'] } }),
    });
    expect((await driver.start({ providerRoot: path.join(dataRoot, 'thai-rag'), ownerId: 'owner', providerVersion: '4.61.0', embeddingIndexGeneration: 1 })).ok).toBe(true);
    await expect(driver.health()).resolves.toMatchObject({ ok: true, value: {
      contractVersion: '1.0',
      indexJobContractVersion: '1.0',
      compatibilityRange: { min: '1.0', max: '1.x' },
      contractFingerprint: THAI_RAG_CONTRACT_FINGERPRINT,
      generation: { contract: THAI_RAG_CONTRACT_FINGERPRINT, index: '1' },
      degradation: ['semantic-retrieval-unavailable'],
    } });
    await driver.stop();
  });

  it('accepts provider schema drift when the versioned handshake is valid', async () => {
    const dataRoot = await tempRoot();
    const workspaceRoot = await tempRoot();
    const driver = new NativeThaiRagProviderDriver({
      dataRoot,
      launchConfig: { command: '/python' },
      workspacesProvider: async (): Promise<readonly { id: string; realRootPath: string }[]> => [{ id: workspaceId, realRootPath: workspaceRoot }],
      clientFactory: clientFactory({ schemaDrift: 'recall' }),
    });
    const started = await driver.start({ providerRoot: path.join(dataRoot, 'thai-rag'), ownerId: 'owner', providerVersion: '4.61.0', embeddingIndexGeneration: 1 });
    expect(started.ok).toBe(true);
    await driver.stop();
  });

  it('accepts provider scope schema drift when the versioned handshake is valid', async () => {
    const dataRoot = await tempRoot();
    const workspaceRoot = await tempRoot();
    const driver = new NativeThaiRagProviderDriver({
      dataRoot,
      launchConfig: { command: '/python' },
      workspacesProvider: async (): Promise<readonly { id: string; realRootPath: string }[]> => [{ id: workspaceId, realRootPath: workspaceRoot }],
      clientFactory: clientFactory({ scopeDrift: 'recall' }),
    });
    const started = await driver.start({ providerRoot: path.join(dataRoot, 'thai-rag'), ownerId: 'owner', providerVersion: '4.61.0', embeddingIndexGeneration: 1 });
    expect(started.ok).toBe(true);
    await driver.stop();
  });

  it('uses handshake metadata instead of raw code_index schema compatibility', async () => {
    const dataRoot = await tempRoot();
    const workspaceRoot = await tempRoot();
    const driver = new NativeThaiRagProviderDriver({
      dataRoot,
      launchConfig: { command: '/python' },
      workspacesProvider: async (): Promise<readonly { id: string; realRootPath: string }[]> => [{ id: workspaceId, realRootPath: workspaceRoot }],
      clientFactory: clientFactory(),
    });

    const started = await driver.start({ providerRoot: path.join(dataRoot, 'thai-rag'), ownerId: 'owner', providerVersion: '4.61.0', embeddingIndexGeneration: 1 });

    expect(started.ok).toBe(true);
    await driver.stop();
  });

  it('starts when a valid handshake accompanies an old provider-shaped tool schema', async () => {
    const dataRoot = await tempRoot();
    const workspaceRoot = await tempRoot();
    const driver = new NativeThaiRagProviderDriver({
      dataRoot,
      launchConfig: { command: '/python' },
      workspacesProvider: async (): Promise<readonly { id: string; realRootPath: string }[]> => [{ id: workspaceId, realRootPath: workspaceRoot }],
      clientFactory: clientFactory({ oldProviderSchema: true }),
    });

    const started = await driver.start({ providerRoot: path.join(dataRoot, 'thai-rag'), ownerId: 'owner', providerVersion: '4.61.0', embeddingIndexGeneration: 1 });

    expect(started.ok).toBe(true);
    await driver.stop();
  });

  it('does not couple startup to legacy forget.category', async () => {
    const dataRoot = await tempRoot();
    const workspaceRoot = await tempRoot();
    const driver = new NativeThaiRagProviderDriver({
      dataRoot,
      launchConfig: { command: '/python' },
      workspacesProvider: async (): Promise<readonly { id: string; realRootPath: string }[]> => [{ id: workspaceId, realRootPath: workspaceRoot }],
      clientFactory: clientFactory(),
    });

    const started = await driver.start({ providerRoot: path.join(dataRoot, 'thai-rag'), ownerId: 'owner', providerVersion: '4.61.0', embeddingIndexGeneration: 1 });

    expect(started.ok).toBe(true);
    await driver.stop();
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
    const result = await driver.call('pre_edit_context', { workspace_id: recoveredWorkspaceId, file_path: 'src/index.ts' });

    expect(result.ok).toBe(true);
    expect(calls.some((call) => call.tool === 'code_index' && call.args.workspace_id === recoveredWorkspaceId && call.args.force === true)).toBe(true);
    expect(calls.at(-1)?.args).toMatchObject({ workspace_id: recoveredWorkspaceId, file_path: `${recoveredWorkspaceId}/src/index.ts` });
    await expect(access(path.join(dataRoot, 'thai-rag', 'sources', workspaceId))).rejects.toThrow();
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
    await expect.poll(() => calls.some((call) => call.tool === 'code_index' && call.args.workspace_id === workspaceId && call.args.force === true)).toBe(true);
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

    const result = await driver.call('pre_edit_context', { workspace_id: workspaceId, file_path: 'src/index.ts' });

    expect(result.ok).toBe(false);
    await expect(realpath(path.join(dataRoot, 'thai-rag', 'sources', workspaceId))).resolves.toBe(await realpath(firstRoot));
    await driver.stop();
  });
});

function clientFactory(options: {
  readonly onConnect?: (config: McpServerLaunchConfig) => void;
  readonly onClose?: () => void;
  readonly onCall?: (tool: string, args: Readonly<Record<string, unknown>>) => Promise<unknown>;
  readonly handshake?: Record<string, unknown>;
  readonly scopeDrift?: string;
  readonly schemaDrift?: string;
  readonly oldProviderSchema?: boolean;
} = {}): McpClientFactory {
  return {
    async connect(config): Promise<McpClientSession> {
      options.onConnect?.(config);
      return {
        async listTools(): Promise<Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>> {
          return productionToolNames.map((name) => ({
            name,
            description: name,
            inputSchema: options.oldProviderSchema && name === 'code_index'
            ? { type: 'array' }
            : productionToolNames.includes(name as typeof productionToolNames[number]) && name !== 'health' && name !== 'version' && name !== options.scopeDrift && name !== options.schemaDrift
            ? name === 'record_event'
              ? { type: 'object', properties: { workspace_id: { type: 'string' }, event_type: { type: 'string' }, content: { type: 'string' } }, required: ['workspace_id', 'event_type', 'content'] }
                : { type: 'object', properties: { workspace_id: { type: 'string' } }, required: ['workspace_id'] }
              : { type: 'object' },
          }));
        },
        async listResources(): Promise<[]> { return []; },
        async callTool(tool, args): Promise<unknown> {
          if (tool === 'version') return success('version', options.handshake ?? defaultHandshake());
          if (tool === 'health') return success('health', options.handshake ?? defaultHandshake());
          return options.onCall === undefined ? success('ok') : options.onCall(tool, args);
        },
        async close(): Promise<void> { options.onClose?.(); },
      };
    },
  };
}

function structuredFailure(code: string): unknown {
  return { structuredContent: { data: { status: 'error', errors: [{ code, message: code, details: {} }] } } };
}

function success(result: string, data?: Record<string, unknown>): unknown {
  return {
    content: [{ type: 'text', text: result }],
    structuredContent: data === undefined ? { result } : { result, data },
  };
}

function defaultHandshake(): Record<string, unknown> {
  return {
    provider_id: 'thai-rag',
    provider_version: '0.1.0',
    contract_version: '1.0',
    compatibility_range: { min: '1.0', max: '1.x' },
    contract_fingerprint: THAI_RAG_CONTRACT_FINGERPRINT,
    index_job_contract_version: '1.0',
    capabilities: [...productionToolNames],
    workspace_scope_model: 'explicit_workspace_id',
    state: 'ready',
    workspace_ready: true,
    embedding_index_generation: 1,
    components: {
      worker_reachable: true,
      sqlite_available: true,
      fts_available: true,
      vector_store_available: true,
      embedder_available: true,
      lexical_retrieval_available: true,
      semantic_retrieval_available: true,
      active_jobs: [],
    },
    embedding: {
      profile: 'nomic-embed-text-v2-moe',
      model: 'nomic-embed-text-v2-moe@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      dimension: 768,
      preprocessing_version: '1',
    },
    generation: {
      contract: THAI_RAG_CONTRACT_FINGERPRINT,
      embedding: 'nomic-embed-text-v2-moe',
      index: '1',
      storage: 'sqlite',
    },
  };
}

function pr25Handshake(): Record<string, unknown> {
  const handshake = defaultHandshake();
  const embedding = { ...(handshake.embedding as Record<string, unknown>) };
  delete embedding.preprocessing_version;
  return { ...handshake, embedding };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
