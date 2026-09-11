import { z } from 'zod';
import { defineTool, missingService, type McpToolContext, type McpToolDefinition } from './tool-types.js';
import { workspaceIdSchema } from './schemas.js';

const taskId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const prompt = z.string().min(1).refine((value) => Buffer.byteLength(value, 'utf8') <= 32 * 1024, 'Prompt is too large');
const swarmId = z.string().uuid();
const cursor = z.string().max(128);
const startTask = z.object({
  id: taskId,
  prompt,
  dependsOn: z.array(taskId).max(3).optional(),
}).strict();

const startSchema = z.object({
  operation: z.literal('start'),
  workspaceId: workspaceIdSchema,
  idempotencyKey: z.string().uuid(),
  accessMode: z.literal('read_only'),
  tasks: z.array(startTask).min(1).max(4),
  maxConcurrency: z.number().int().min(1).max(4).optional(),
}).strict().superRefine((value, ctx) => {
  const ids = new Set<string>();
  for (const [index, task] of value.tasks.entries()) {
    if (ids.has(task.id)) ctx.addIssue({ code: 'custom', path: ['tasks', index, 'id'], message: 'Task IDs must be unique' });
    ids.add(task.id);
    if (task.dependsOn?.includes(task.id)) ctx.addIssue({ code: 'custom', path: ['tasks', index, 'dependsOn'], message: 'A task cannot depend on itself' });
    if (new Set(task.dependsOn ?? []).size !== (task.dependsOn?.length ?? 0)) ctx.addIssue({ code: 'custom', path: ['tasks', index, 'dependsOn'], message: 'Dependency IDs must be unique' });
  }
  for (const [index, task] of value.tasks.entries()) {
    for (const dependency of task.dependsOn ?? []) {
      if (!ids.has(dependency)) ctx.addIssue({ code: 'custom', path: ['tasks', index, 'dependsOn'], message: `Unknown dependency: ${dependency}` });
    }
  }
  if (value.maxConcurrency !== undefined && value.maxConcurrency > value.tasks.length) {
    ctx.addIssue({ code: 'custom', path: ['maxConcurrency'], message: 'maxConcurrency cannot exceed task count' });
  }
});

const statusSchema = z.object({ operation: z.literal('status'), workspaceId: workspaceIdSchema, swarmId }).strict();
const resultSchema = z.object({
  operation: z.literal('result'),
  workspaceId: workspaceIdSchema,
  swarmId,
  taskId,
  cursor: cursor.optional(),
  maxBytes: z.number().int().min(1).max(16_384).default(8_192),
}).strict();
const cancelSchema = z.object({ operation: z.literal('cancel'), workspaceId: workspaceIdSchema, swarmId }).strict();
const listSchema = z.object({
  operation: z.literal('list'),
  workspaceId: workspaceIdSchema,
  cursor: cursor.optional(),
  limit: z.number().int().min(1).max(50).default(20),
}).strict();

export const agentSwarmSchema = z.discriminatedUnion('operation', [startSchema, statusSchema, resultSchema, cancelSchema, listSchema]);
export const AGENT_SWARM_TOOL_NAMES = ['agent_swarm_run'] as const;

export function agentSwarmTools(context: McpToolContext): McpToolDefinition[] {
  return [defineTool({
    name: 'agent_swarm_run',
    description: 'Run or inspect a bounded 1-4 task Codex-backed agent swarm in enforced read-only mode. The tool is available only when Codex tools are explicitly enabled. start/cancel require trusted host approval; status/result/list are owner-scoped reads. Prompts are never persisted in plaintext and unverifiable post-restart tasks report termination_unverified.',
    permission: 'EXECUTE',
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: agentSwarmSchema,
    handler: async (input, signal, authorization) => {
      const service = context.services.agentSwarm;
      if (service === undefined) return missingService();
      switch (input.operation) {
        case 'start':
          return service.start(context.actor, {
            workspaceId: input.workspaceId,
            idempotencyKey: input.idempotencyKey,
            accessMode: input.accessMode,
            tasks: input.tasks.map((task) => ({
              id: task.id,
              prompt: task.prompt,
              ...(task.dependsOn === undefined ? {} : { dependsOn: task.dependsOn }),
            })),
            ...(input.maxConcurrency === undefined ? {} : { maxConcurrency: input.maxConcurrency }),
          }, signal, authorization);
        case 'status':
          return service.status(context.actor, input.workspaceId, input.swarmId);
        case 'result':
          return service.result(context.actor, input.workspaceId, input.swarmId, input.taskId, input.cursor, input.maxBytes);
        case 'cancel':
          return service.cancel(context.actor, input.workspaceId, input.swarmId, authorization);
        case 'list':
          return service.list(context.actor, input.workspaceId, input.cursor, input.limit);
      }
    },
  })];
}
