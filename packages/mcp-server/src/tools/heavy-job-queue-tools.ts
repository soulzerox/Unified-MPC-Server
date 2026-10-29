import { appError, err, ok } from '@unified-mpc/domain';
import type { HeavyJobLiveEntry, ResourceAdmissionSnapshot } from '@unified-mpc/workspace';
import { defineTool, missingService, type McpToolContext, type McpToolDefinition } from './tool-types.js';
import { heavyJobQueueStatusSchema } from './schemas.js';

const DEFAULT_LIMIT = 20;

function elapsedMs(since: string | undefined, nowMs: number): number | undefined {
  if (since === undefined) return undefined;
  const parsed = Date.parse(since);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.max(0, nowMs - parsed);
}

function projectEntry(entry: HeavyJobLiveEntry, nowMs: number): Record<string, unknown> {
  const waitedMs = entry.state === 'queued' ? elapsedMs(entry.requestedAt, nowMs) : undefined;
  const runningMs = entry.state === 'running' ? elapsedMs(entry.startedAt, nowMs) : undefined;
  return {
    operationId: entry.operationId,
    workspaceId: entry.workspaceId,
    jobKind: entry.jobKind,
    resourceClass: entry.resourceClass,
    cost: entry.cost,
    blocking: entry.blocking,
    state: entry.state,
    position: entry.position,
    attempt: entry.attempt,
    requestedAt: entry.requestedAt,
    heartbeatAt: entry.heartbeatAt,
    ...(entry.startedAt === undefined ? {} : { startedAt: entry.startedAt }),
    ...(entry.ownerId === undefined ? {} : { ownerId: entry.ownerId }),
    ...(waitedMs === undefined ? {} : { waitedMs }),
    ...(runningMs === undefined ? {} : { runningMs }),
  };
}

/**
 * Bounded admission projection for diagnosis: why a queued job is not running.
 * Workspace/session cost maps are intentionally omitted so the response cannot
 * leak other callers' identities; the class map is bounded by resource class.
 */
function projectAdmission(snapshot: ResourceAdmissionSnapshot): Record<string, unknown> {
  return {
    activeCost: snapshot.activeCost,
    activeOperations: snapshot.activeOperations,
    activeHeavyOperations: snapshot.activeHeavyOperations,
    maxHeavyOperations: snapshot.maxHeavyOperations,
    effectiveGlobalCost: snapshot.effectiveGlobalCost,
    pressureState: snapshot.pressureState,
    rejected: snapshot.rejected,
    activeCostByClass: snapshot.activeCostByClass,
    ...(snapshot.pressure === undefined ? {} : { pressure: snapshot.pressure }),
  };
}

export function heavyJobQueueTools(context: McpToolContext): McpToolDefinition[] {
  return [
    defineTool({
      name: 'heavy_job_queue_status',
      description: 'Read the durable heavy-job queue without running or admitting work. Reports store-wide queueDepth, the current admission snapshot (active/effective cost, pressure state, memory sample) and bounded queued/running entries with position, attempt, heartbeat and wait/run durations, so a starved, stalled or orphaned job can be diagnosed before it is retried. live, queued and running honour an optional workspaceId filter when several projects share the queue.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: heavyJobQueueStatusSchema,
      handler: async (input) => {
        const store = context.services.heavyJobQueue;
        if (store === undefined) return missingService();
        try {
          const live = store.listLive();
          const filtered = input.workspaceId === undefined
            ? live
            : live.filter((entry) => entry.workspaceId === input.workspaceId);
          const limit = input.limit ?? DEFAULT_LIMIT;
          const nowMs = Date.now();
          const entries = filtered.slice(0, limit).map((entry) => projectEntry(entry, nowMs));
          const admission = context.resourceAdmissionController?.snapshot();
          return ok({
            queueDepth: store.depth(),
            live: filtered.length,
            queued: filtered.filter((entry) => entry.state === 'queued').length,
            running: filtered.filter((entry) => entry.state === 'running').length,
            truncated: filtered.length > entries.length,
            ...(admission === undefined ? {} : { admission: projectAdmission(admission) }),
            entries,
          });
        } catch {
          return err(appError('INTERNAL_ERROR', 'Heavy job queue state could not be read', true));
        }
      },
    }),
  ];
}
