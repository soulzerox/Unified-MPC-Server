import { defineTool, missingService, type McpToolContext, type McpToolDefinition } from './tool-types.js';
import { ok, type Result } from '@unified-mpc/domain';
import {
  prepareCodeChangeSchema,
  projectSnapshotSchema,
  workspaceActiveListSchema,
  workspaceBootstrapSchema,
  workspaceInfoSchema,
  workspaceListSchema,
  workspaceRegisterSchema,
  workspaceSelectionSchema,
  workspaceTreeSchema,
} from './schemas.js';

export function workspaceTools(context: McpToolContext): McpToolDefinition[] {
  return [
    defineTool({
      name: 'workspace_list',
      description: 'List registered project workspaces available to unified-mpc. Legacy explicitly registered drive roots may also appear as kind=machine_root.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: workspaceListSchema,
      handler: async () => context.services.workspaceInfo === undefined
        ? missingService()
        : context.services.workspaceInfo.list === undefined
          ? missingService()
          : context.services.workspaceInfo.list(context.actor),
    }),
    defineTool({
      name: 'workspace_active_list',
      description: 'Return the current ordered Active Project set. The first workspace is the Primary Project used for implicit project context.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: workspaceActiveListSchema,
      handler: async () => context.services.workspaceSelection === undefined
        ? missingService()
        : context.services.workspaceSelection.list(),
    }),
    defineTool({
      name: 'workspace_activate',
      description: 'Add one already-registered project to this runtime active set without widening access to arbitrary filesystem paths.',
      permission: 'WRITE',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: workspaceSelectionSchema,
      handler: async (input) => context.services.workspaceSelection === undefined
        ? missingService()
        : context.services.workspaceSelection.activate(input.workspaceId),
    }),
    defineTool({
      name: 'workspace_deactivate',
      description: 'Remove one registered project from this runtime active set. At least one Active Project always remains.',
      permission: 'WRITE',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: workspaceSelectionSchema,
      handler: async (input) => context.services.workspaceSelection === undefined
        ? missingService()
        : context.services.workspaceSelection.deactivate(input.workspaceId),
    }),
    defineTool({
      name: 'workspace_set_primary',
      description: 'Make one registered project the Primary Project; it is activated automatically and placed first in the active set.',
      permission: 'WRITE',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: workspaceSelectionSchema,
      handler: async (input) => context.services.workspaceSelection === undefined
        ? missingService()
        : context.services.workspaceSelection.setPrimary(input.workspaceId),
    }),
    defineTool({
      name: 'workspace_register',
      description: 'Register an existing project directory by absolute path. parentWorkspaceId is optional and retained only for legacy machine-root-relative registration. Idempotent for the same path.',
      permission: 'WRITE',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: workspaceRegisterSchema,
      handler: async (input) => {
        if (context.services.workspaceInfo === undefined || context.services.workspaceInfo.register === undefined) return missingService();
        const registered = await context.services.workspaceInfo.register(context.actor, {
          ...(input.parentWorkspaceId === undefined ? {} : { parentWorkspaceId: input.parentWorkspaceId }),
          path: input.path,
          ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
        });
        if (registered.ok && context.services.workspaceIndex !== undefined) {
          const workspaceId = readWorkspaceId(registered.value);
          if (workspaceId !== undefined) {
            const refreshed = await refreshWorkspaceIndex(context, workspaceId);
            if (!refreshed.ok) return refreshed;
          }
        }
        return registered;
      },
    }),
    defineTool({
      name: 'workspace_info',
      description: 'Return the configured workspace summary.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: workspaceInfoSchema,
      handler: async (input) => context.services.workspaceInfo === undefined
        ? missingService()
        : context.services.workspaceInfo.info(context.actor, input.workspaceId),
    }),
    defineTool({
      name: 'workspace_bootstrap',
      description: 'Load and fingerprint the workspace engineering harness, then eagerly connect and pin mandatory child MCP servers before code mutation.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: workspaceBootstrapSchema,
      handler: async (input, signal) => context.bootstrapWorkspaceHarness === undefined
        ? missingService()
        : context.bootstrapWorkspaceHarness(input.workspaceId, signal),
    }),
    defineTool({
      name: 'prepare_code_change',
      description: 'Run mandatory Thai-RAG pre-edit diagnostics for one development-artifact path and authorize that path for the current harness session. Set runGodkillerSafetyCheck=true to add the trusted optional Godkiller edit_safe analysis for high-risk changes.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: prepareCodeChangeSchema,
      handler: async (input, signal) => context.prepareCodeChange === undefined
        ? missingService()
        : context.prepareCodeChange(input.workspaceId, input.filePath, input.proposedSymbol, input.runGodkillerSafetyCheck === true, signal),
    }),
    defineTool({
      name: 'workspace_tree',
      description: 'List a bounded workspace tree. Absolute path does not require workspaceId.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: workspaceTreeSchema,
      handler: async (input, signal, _authorization, budget) => context.services.workspaceQuery === undefined
        ? missingService()
        : context.services.workspaceQuery.tree(context.actor, input.workspaceId, {
          ...(input.path === undefined ? {} : { path: input.path }),
          ...(input.maxDepth === undefined ? {} : { maxDepth: input.maxDepth }),
          ...(input.maxEntries === undefined ? {} : { maxEntries: input.maxEntries }),
        }, signal, budget),
    }),
    defineTool({
      name: 'project_snapshot',
      description: 'Return a bounded project snapshot without source contents.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: projectSnapshotSchema,
      handler: async (input) => context.services.projectSnapshot === undefined
        ? missingService()
        : context.services.projectSnapshot.snapshot(context.actor, input.workspaceId),
    }),
  ];
}

async function refreshWorkspaceIndex(context: McpToolContext, workspaceId: string): Promise<Result<void>> {
  const index = context.services.workspaceIndex;
  if (index === undefined) return ok(undefined);
  const before = await index.status(workspaceId);
  if (!before.ok) return before;
  const wasWatching = before.value.watcher !== null;
  const stopped = await index.stopWatch(workspaceId);
  if (!stopped.ok) return stopped;
  const rebuilt = await index.indexWorkspace(workspaceId, { rebuild: true });
  if (!rebuilt.ok) {
    await index.forgetWorkspace(workspaceId).catch(() => undefined);
    return rebuilt;
  }
  if (wasWatching) {
    const restarted = await index.startWatch(workspaceId);
    if (!restarted.ok) {
      await index.forgetWorkspace(workspaceId).catch(() => undefined);
      return restarted;
    }
  }
  return ok(undefined);
}

function readWorkspaceId(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('id' in value)) return undefined;
  const id = (value as { id?: unknown }).id;
  return typeof id === 'string' && id.trim().length > 0 ? id : undefined;
}
