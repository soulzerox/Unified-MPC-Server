import { describe, expect, it } from 'vitest';
import { heavyJobQueueTools } from './heavy-job-queue-tools.js';
import type { HeavyJobLiveEntry, ResourceAdmissionController } from '@unified-mpc/workspace';
import type { McpToolContext, McpToolDefinition } from './tool-types.js';

function context(
  services: McpToolContext['services'],
  controller?: ResourceAdmissionController,
): McpToolContext {
  return {
    actor: { clientId: 'test', clientName: 'test' },
    contextEconomy: {} as McpToolContext['contextEconomy'],
    services,
    ...(controller === undefined ? {} : { resourceAdmissionController: controller }),
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

function queueTool(
  services: McpToolContext['services'],
  controller?: ResourceAdmissionController,
): McpToolDefinition {
  const tool = heavyJobQueueTools(context(services, controller)).find((candidate) => candidate.name === 'heavy_job_queue_status');
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

  it('adds bounded admission state and wait/run durations without leaking other owners', async () => {
    const now = Date.now();
    const live: HeavyJobLiveEntry[] = [
      entry({ requestedAt: new Date(now - 90_000).toISOString() }),
      entry({
        operationId: 'job-running',
        state: 'running',
        position: 0,
        requestedAt: new Date(now - 120_000).toISOString(),
        startedAt: new Date(now - 30_000).toISOString(),
      }),
    ];
    const controller = {
      snapshot: () => ({
        activeCost: 3,
        activeOperations: 1,
        activeCostByClass: {
          dependency_bootstrap: 0,
          context_scan: 0,
          child_mcp_call: 0,
          lsp_process: 0,
          rag_indexing: 3,
          goal_process: 0,
          delegated_agent: 0,
          verification_heavy: 0,
        },
        activeCostByWorkspace: { 'workspace-secret': 3 },
        activeCostBySession: { 'session-secret': 3 },
        activeHeavyOperations: 1,
        maxHeavyOperations: 1,
        rejected: 2,
        pressureState: 'elevated',
        effectiveGlobalCost: 6,
        pressure: {
          state: 'elevated',
          totalMemoryBytes: 1_000,
          availableMemoryBytes: 150,
          availableRatio: 0.15,
          processRssBytes: 50,
          sampledAtMs: now,
        },
      }),
    } as unknown as ResourceAdmissionController;
    const tool = queueTool({
      heavyJobQueue: { listLive: () => live, depth: () => 2 },
    } as unknown as McpToolContext['services'], controller);

    const result = await tool.execute({}, new AbortController().signal);

    expect(result).toMatchObject({
      ok: true,
      value: {
        admission: {
          activeCost: 3,
          activeOperations: 1,
          activeHeavyOperations: 1,
          maxHeavyOperations: 1,
          effectiveGlobalCost: 6,
          pressureState: 'elevated',
          rejected: 2,
          pressure: { availableMemoryBytes: 150, processRssBytes: 50 },
        },
        entries: [
          expect.objectContaining({ state: 'queued' }),
          expect.objectContaining({ state: 'running' }),
        ],
      },
    });
    const value = (result as {
      ok: true;
      value: {
        admission: Record<string, unknown>;
        entries: Array<{ waitedMs?: number; runningMs?: number }>;
      };
    }).value;
    expect(value.entries[0]?.waitedMs).toBeGreaterThanOrEqual(89_000);
    expect(value.entries[1]?.runningMs).toBeGreaterThanOrEqual(29_000);
    expect(value.admission).not.toHaveProperty('activeCostByWorkspace');
    expect(value.admission).not.toHaveProperty('activeCostBySession');
    expect(JSON.stringify(result)).not.toMatch(/workspace-secret|session-secret/);
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

  it('annotates queued entries from the runtime-local fair-order provider', async () => {
    const live: HeavyJobLiveEntry[] = [
      entry({ operationId: 'job-a', workspaceId: 'workspace-a' }),
      entry({ operationId: 'job-b', workspaceId: 'workspace-b', position: 2 }),
      entry({ operationId: 'job-running', state: 'running', position: 0 }),
    ];
    const tool = queueTool({
      heavyJobQueue: { listLive: () => live, depth: () => 2 },
      heavyJobFairness: {
        fairnessSnapshot: () => ({
          agingMs: 1_800_000,
          entries: [
            { operationId: 'job-b', effectiveRank: 0, aged: false },
            { operationId: 'job-a', effectiveRank: 1, aged: true },
            // A running row is never in the fair order; if a provider says so
            // anyway, the tool must not present it as queued work.
            { operationId: 'job-running', effectiveRank: 2, aged: false },
          ],
        }),
      },
    } as unknown as McpToolContext['services']);

    const result = await tool.execute({}, new AbortController().signal);

    expect(result).toMatchObject({
      ok: true,
      value: {
        fairness: { scope: 'runtime-local', agingMs: 1_800_000 },
        entries: [
          expect.objectContaining({ operationId: 'job-a', effectiveRank: 1, aged: true }),
          expect.objectContaining({ operationId: 'job-b', effectiveRank: 0, aged: false }),
          expect.objectContaining({ operationId: 'job-running' }),
        ],
      },
    });
    const value = (result as {
      ok: true;
      value: { entries: Array<Record<string, unknown>> };
    }).value;
    expect(value.entries[2]).not.toHaveProperty('effectiveRank');
    expect(value.entries[2]).not.toHaveProperty('aged');
  });

  it('omits fair-order fields when the runtime has no fairness provider', async () => {
    const tool = queueTool({
      heavyJobQueue: { listLive: () => [entry()], depth: () => 1 },
    } as unknown as McpToolContext['services']);

    const result = await tool.execute({}, new AbortController().signal);
    const value = (result as {
      ok: true;
      value: { entries: Array<Record<string, unknown>> } & Record<string, unknown>;
    }).value;

    expect(value).not.toHaveProperty('fairness');
    expect(value.entries[0]).not.toHaveProperty('effectiveRank');
    expect(value.entries[0]).not.toHaveProperty('aged');
  });

  it('keeps reporting queue state when the fairness projection fails', async () => {
    const tool = queueTool({
      heavyJobQueue: { listLive: () => [entry()], depth: () => 1 },
      heavyJobFairness: {
        fairnessSnapshot: () => {
          throw new Error('projection failed');
        },
      },
    } as unknown as McpToolContext['services']);

    const result = await tool.execute({}, new AbortController().signal);

    expect(result).toMatchObject({
      ok: true,
      value: { entries: [expect.objectContaining({ operationId: 'pre-edit:workspace-1:abc' })] },
    });
    expect((result as { ok: true; value: Record<string, unknown> }).value).not.toHaveProperty('fairness');
  });
});
