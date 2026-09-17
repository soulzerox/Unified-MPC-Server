import { defineTool, missingService, type McpToolContext, type McpToolDefinition } from './tool-types.js';
import {
  ragCodeBlastRadiusSchema,
  ragCodeContextSchema,
  ragCodeIndexSchema,
  ragCodeSearchSchema,
  ragForgetSchema,
  ragIndexStatusSchema,
  ragPreEditContextSchema,
  ragRecallSchema,
  ragRememberSchema,
  workspaceMemoryRecordSchema,
} from './schemas.js';

const readOnly = {
  permission: 'READ' as const,
  annotations: { readOnlyHint: true, destructiveHint: false },
};

const safeWrite = {
  permission: 'WRITE' as const,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
};

export function ragTools(context: McpToolContext): McpToolDefinition[] {
  return [
    defineTool({
      name: 'rag_recall',
      description: 'Recall persistent context from the parent-owned native Thai-RAG provider, isolated to one canonical workspace.',
      ...readOnly,
      inputSchema: ragRecallSchema,
      handler: async (input, signal) => context.ragRecall === undefined
        ? missingService()
        : context.ragRecall(input.workspaceId, input.query, input.category, input.limit, signal),
    }),
    defineTool({
      name: 'rag_remember',
      description: 'Persist one selective durable memory in the parent-owned native Thai-RAG provider, tagged to one canonical workspace. Do not use this for automatic conversation capture.',
      ...safeWrite,
      inputSchema: ragRememberSchema,
      handler: async (input, signal) => context.ragRemember === undefined
        ? missingService()
        : context.ragRemember(input.workspaceId, input.content, input.category, signal),
    }),
    defineTool({
      name: 'workspace_memory_record',
      description: 'Record a concise workspace-scoped decision, constraint, preference, or work note in native Thai-RAG. Writes are explicit and selective.',
      ...safeWrite,
      inputSchema: workspaceMemoryRecordSchema,
      handler: async (input, signal) => context.nativeRagCall === undefined
        ? missingService()
        : context.nativeRagCall(input.workspaceId, 'workspace_memory_record', {
            name: input.name,
            observations: input.observations,
            ...(input.category === undefined ? {} : { category: input.category }),
          }, signal),
    }),
    defineTool({
      name: 'rag_forget',
      description: 'Delete one obsolete native Thai-RAG memory by ID for the selected canonical workspace. This is destructive and remains approval-guarded.',
      permission: 'DANGEROUS',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: ragForgetSchema,
      handler: async (input, signal) => context.nativeRagCall === undefined
        ? missingService()
        : context.nativeRagCall(input.workspaceId, 'forget', { memory_id: input.memoryId }, signal),
    }),
    defineTool({
      name: 'rag_pre_edit_context',
      description: 'Retrieve native Thai-RAG architectural constraints and code context for a development artifact before editing it.',
      ...readOnly,
      inputSchema: ragPreEditContextSchema,
      handler: async (input, signal) => context.nativeRagCall === undefined
        ? missingService()
        : context.nativeRagCall(input.workspaceId, 'pre_edit_context', {
            file_path: input.filePath,
            ...(input.proposedSymbol === undefined ? {} : { proposed_symbol: input.proposedSymbol }),
          }, signal),
    }),
    defineTool({
      name: 'rag_code_search',
      description: 'Search indexed code through native Thai-RAG within one canonical workspace.',
      ...readOnly,
      inputSchema: ragCodeSearchSchema,
      handler: async (input, signal) => context.nativeRagCall === undefined
        ? missingService()
        : context.nativeRagCall(input.workspaceId, 'code_search', {
            query: input.query,
            ...(input.topK === undefined ? {} : { top_k: input.topK }),
            ...(input.pathFilter === undefined ? {} : { path_filter: input.pathFilter }),
          }, signal),
    }),
    defineTool({
      name: 'rag_code_context',
      description: 'Retrieve enclosing code context from native Thai-RAG for one file and line in the selected workspace.',
      ...readOnly,
      inputSchema: ragCodeContextSchema,
      handler: async (input, signal) => context.nativeRagCall === undefined
        ? missingService()
        : context.nativeRagCall(input.workspaceId, 'code_context', {
            file_path: input.filePath,
            line_number: input.lineNumber,
            ...(input.window === undefined ? {} : { window: input.window }),
          }, signal),
    }),
    defineTool({
      name: 'rag_code_blast_radius',
      description: 'Analyze native Thai-RAG code graph callers and impacted files for one symbol within the selected workspace.',
      ...readOnly,
      inputSchema: ragCodeBlastRadiusSchema,
      handler: async (input, signal) => context.nativeRagCall === undefined
        ? missingService()
        : context.nativeRagCall(input.workspaceId, 'code_blast_radius', {
            symbol_name: input.symbolName,
            ...(input.maxDepth === undefined ? {} : { max_depth: input.maxDepth }),
          }, signal),
    }),
    defineTool({
      name: 'rag_code_index',
      description: 'Refresh the parent-owned native Thai-RAG code index for one canonical workspace. Background indexing returns a durable provider job ID.',
      ...safeWrite,
      inputSchema: ragCodeIndexSchema,
      handler: async (input, signal) => context.nativeRagCall === undefined
        ? missingService()
        : context.nativeRagCall(input.workspaceId, 'code_index', {
            force: input.force === true,
            background: input.background === true,
          }, signal),
    }),
    defineTool({
      name: 'rag_index_status',
      description: 'Read one native Thai-RAG background indexing job status for the selected canonical workspace.',
      ...readOnly,
      inputSchema: ragIndexStatusSchema,
      handler: async (input, signal) => context.nativeRagCall === undefined
        ? missingService()
        : context.nativeRagCall(input.workspaceId, 'index_status', { job_id: input.jobId }, signal),
    }),
  ];
}
