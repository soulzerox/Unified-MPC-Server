import { describe, expect, it } from 'vitest';
import { heavyJobQueueTools } from './heavy-job-queue-tools.js';
import type { HeavyJobLiveEntry } from '@unified-mpc/workspace';
import type { McpToolContext, McpToolDefinition } from './tool-types.js';

function context(services: McpToolContext['services']): McpToolContext {
  return {
    actor: { clientId: 'test', clientName: 'test' },
    contextEconomy: {} as McpToolContext['contextEconomy'],
    services,
  } as McpToolContext;
}

function entry(overrides: Partial<HeavyJobLiveEntry> = {}): HeavyJobLiveEntry {
  return {
    operationId: 'pre-edit:workspace-1:abc',
    workspaceId: 'workspace-1',
    jobKind: 'pre_edit_demand',
    resourceClass: 'context_scan',
    cost: 1,
    blocking: true,
    requestedAt: '2026-10-29T10:00:00.000Z',
    state: 'queued',
    position: 1,
    attempt: 1,
    heartbeatAt: '2026-10-29T10:00:00.000Z',
    ...overrides,
  };
}

function queueTool(services: McpToolContext['services']): McpToolDefinition {
  const tool = heavyJobQueueTools(context(services)).find((candidate) => candidate.name === 'heavy_job_queue_status');
  if (tool === undefined) throw new Error('missing heavy_job_queue_status');
  return tool;
}

describe('heavyJobQueueTools', () => {
  it('fails closed when the durable queue service is unavailable', async () => {
    const result = await queueTool({}).execute({}, new AbortController().signal);
    expect(result).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
  });

  it('reports store-wide depth and both live entries without a filter', async () => {
    const live: HeavyJobLiveEntry[] = [
      entry(),
      entry({
        operationId: 'pre-edit:workspace-2:def',
        workspaceId: 'workspace-2',
        resourceClass: 'rag_indexing',
        cost: 8,
        blocking: false,
        state: 'running',
        position: 0,
        startedAt: '2026-10-29T10:00:05.000Z',
        ownerId: 'runtime-owner',
      }),
    ];
    const tool = queueTool({
      heavyJobQueue: { listLive: () => live, depth: () => 1 },
    } as unknown as McpToolContext['services']);

    const result = await tool.execute({}, new AbortController().signal);

    expect(result).toMatchObject({
      ok: true,
      value: {
        queueDepth: 1,
        live: 2,
        queued: 1,
        running: 1,
        truncated: false,
        entries: [
          expect.objectContaining({ operationId: 'pre-edit:workspace-1:abc', state: 'queued' }),
          expect.objectContaining({
            operationId: 'pre-edit:workspace-2:def',
            state: 'running',
            ownerId: 'runtime-owner',
            startedAt: '2026-10-29T10:00:05.000Z',
          }),
        ],
      },
    });
  });

  it('honours a workspace filter while keeping depth store-wide', async () => {
    const live: HeavyJobLiveEntry[] = [
      entry(),
      entry({ operationId: 'pre-edit:workspace-2:def', workspaceId: 'workspace-2', state: 'running', position: 0 }),
    ];
    const tool = queueTool({
      heavyJobQueue: { listLive: () => live, depth: () => 9 },
    } as unknown as McpToolContext['services']);

    const result = await tool.execute({ workspaceId: 'workspace-2' }, new AbortController().signal);

    expect(result).toMatchObject({
      ok: true,
      value: {
        queueDepth: 9,
        live: 1,
        queued: 0,
        running: 1,
        entries: [expect.objectContaining({ operationId: 'pre-edit:workspace-2:def' })],
      },
    });
  });

  it('keeps the listing bounded and says so when entries are dropped', async () => {
    const live = Array.from({ length: 5 }, (_, index) => entry({ operationId: `job-${index}`, position: index + 1 }));
    const tool = queueTool({
      heavyJobQueue: { listLive: () => live, depth: () => 5 },
    } as unknown as McpToolContext['services']);

    const result = await tool.execute({ limit: 2 }, new AbortController().signal);

    expect(result).toMatchObject({
      ok: true,
      value: { live: 5, truncated: true, entries: [{ operationId: 'job-0' }, { operationId: 'job-1' }] },
    });
  });

  it('reports a storage failure as a bounded internal error', async () => {
    const tool = queueTool({
      heavyJobQueue: {
        listLive: () => {
          throw new Error('database is locked');
        },
        depth: () => 0,
      },
    } as unknown as McpToolContext['services']);

    const result = await tool.execute({}, new AbortController().signal);

    expect(result).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
  });
});
