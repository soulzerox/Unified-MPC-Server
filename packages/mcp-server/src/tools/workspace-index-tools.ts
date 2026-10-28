import type { WorkspaceIndexStatus } from '@unified-mpc/application';
import { ok } from '@unified-mpc/domain';
import { defineTool, missingService, type McpToolContext, type McpToolDefinition } from './tool-types.js';
import { workspaceIndexSchema, workspaceIndexStatusSchema, workspaceIndexStopSchema, workspaceIndexWatchSchema } from './schemas.js';

/**
 * A status call must stay inside the tool-result budget on a large workspace:
 * every entry carries its symbols/imports/exports, so a whole-snapshot response
 * blew past 512 KiB and the caller only saw a truncation envelope. Metadata is
 * the point of this surface; entries are opt-in and capped.
 */
const DEFAULT_STATUS_ENTRY_LIMIT = 200;

export function workspaceIndexTools(context: McpToolContext): McpToolDefinition[] {
  return [
    defineTool({
      name: 'workspace_index',
      description: 'Build or refresh the persistent workspace index using automatic context filters unless ignored paths are explicitly included.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: workspaceIndexSchema,
      handler: async (input) => context.services.workspaceIndex === undefined
        ? missingService()
        : context.services.workspaceIndex.indexWorkspace(input.workspaceId, {
          discovery: input.includeIgnored ? 'explicit' : 'automatic',
          rebuild: input.rebuild,
        }),
    }),
    defineTool({
      name: 'workspace_index_status',
      description: 'Return persistent index metadata and lossless watcher queue telemetry.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: workspaceIndexStatusSchema,
      handler: async (input) => {
        if (context.services.workspaceIndex === undefined) return missingService();
        const status = await context.services.workspaceIndex.status(input.workspaceId);
        return status.ok ? ok(boundedIndexStatus(status.value, input.entryLimit)) : status;
      },
    }),
    defineTool({
      name: 'workspace_index_watch',
      description: 'Watch all workspace paths and incrementally re-index only changed paths with configurable debounce/concurrency.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: workspaceIndexWatchSchema,
      handler: async (input) => context.services.workspaceIndex === undefined
        ? missingService()
        : context.services.workspaceIndex.startWatch(input.workspaceId, {
          ...(input.debounceMs === undefined ? {} : { debounceMs: input.debounceMs }),
          ...(input.concurrency === undefined ? {} : { concurrency: input.concurrency }),
        }),
    }),
    defineTool({
      name: 'workspace_index_stop',
      description: 'Stop a workspace watcher after draining all queued path updates.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: workspaceIndexStopSchema,
      handler: async (input) => context.services.workspaceIndex === undefined
        ? missingService()
        : context.services.workspaceIndex.stopWatch(input.workspaceId),
    }),
  ];
}

/**
 * Truncation is reported, never silent: `entryCount` is the true size and
 * `entriesTruncated` says whether entries were dropped, so a caller can tell an
 * empty index from a clipped one and page the rest through `workspace_full_scan`.
 */
function boundedIndexStatus(status: WorkspaceIndexStatus, requestedEntryLimit: number | undefined): Record<string, unknown> {
  const entryLimit = requestedEntryLimit ?? DEFAULT_STATUS_ENTRY_LIMIT;
  const snapshot = status.snapshot;
  const entryCount = snapshot === null ? 0 : snapshot.entries.length;
  return {
    indexed: status.indexed,
    generation: status.generation,
    freshness: status.freshness,
    stale: status.stale,
    watcher: status.watcher,
    entryCount,
    entryLimit,
    entriesTruncated: entryCount > entryLimit,
    snapshot: snapshot === null ? null : {
      version: snapshot.version,
      workspaceId: snapshot.workspaceId,
      rootPath: snapshot.rootPath,
      indexedAt: snapshot.indexedAt,
      entries: snapshot.entries.slice(0, entryLimit),
    },
  };
}
