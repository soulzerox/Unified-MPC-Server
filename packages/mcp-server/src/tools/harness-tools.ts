import { defineTool, missingService, type McpToolContext, type McpToolDefinition } from './tool-types.js';
import type { ResultBudget } from '@unified-mpc/domain';
import { workingMemoryRecordSchema, workingMemorySearchSchema } from './schemas.js';

export function harnessTools(context: McpToolContext): McpToolDefinition[] {
  return [
    defineTool({
      name: 'working_memory_search',
      description: 'Search the pinned mandatory working-memory MCP through a stable native unified-mpc surface.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: workingMemorySearchSchema,
      handler: async (input, signal, _authorization, budget: ResultBudget | undefined) => context.workingMemorySearch === undefined
        ? missingService()
        : context.workingMemorySearch(input.workspaceId, input.query, signal, budget),
    }),
    defineTool({
      name: 'working_memory_record',
      description: 'Create or append a working-memory entity through a stable native unified-mpc surface.',
      permission: 'WRITE',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: workingMemoryRecordSchema,
      handler: async (input, signal, _authorization, budget: ResultBudget | undefined) => context.workingMemoryRecord === undefined
        ? missingService()
        : context.workingMemoryRecord(input.workspaceId, input.name, input.entityType, input.observations, signal, budget),
    }),
  ];
}
