import { ok } from '@unified-mpc/domain';
import { z } from 'zod';
import { defineTool, missingService, type McpToolContext, type McpToolDefinition } from './tool-types.js';
import { skillsListSchema, skillsReadSchema } from './schemas.js';

const ponytailSessionSchema = z.object({
  workspaceId: z.string().min(1).max(128),
  goalId: z.string().min(1).max(128).optional(),
  suppressed: z.boolean(),
}).strict();

const installTargetSchema = z.enum(['antigravity', 'cursor', 'claude', 'codex', 'cline', 'opencode', 'all']);
const skillInstallSchema = z.object({
  name: z.string().min(1),
  source: z.string().min(1),
  targets: z.array(installTargetSchema).min(1).default(['all']),
  scope: z.enum(['global', 'workspace']).optional(),
  workspaceRoot: z.string().min(1).optional(),
}).strict();

const readOnlyInspection = {
  permission: 'READ' as const,
  annotations: { readOnlyHint: true, destructiveHint: false },
};

export function skillTools(context: McpToolContext): McpToolDefinition[] {
  return [
    defineTool({
      name: 'skills_list',
      description: 'List the union of bundled skills and every discovered machine-global or active-workspace skill from Cursor, Claude, Agents, Codex, the Codex plugin cache, GitHub workspace roots, and unified-mpc settings. Nested and symlinked skill collections are included. Filter with query or source.',
      ...readOnlyInspection,
      inputSchema: skillsListSchema,
      handler: async (input) => context.services.extensions === undefined
        ? missingService()
        : context.services.extensions.listSkills({
          ...(input.query === undefined ? {} : { query: input.query }),
          ...(input.source === undefined ? {} : { source: input.source }),
        }),
    }),
    defineTool({
      name: 'skills_read',
      description: 'Read a local skill SKILL.md (or a relative file inside the skill folder). Prefer the source-qualified id returned by skills_list; an unambiguous bare name or $name is also accepted. Follow the skill instructions with unified-mpc tools and mcp_call.',
      ...readOnlyInspection,
      inputSchema: skillsReadSchema,
      handler: async (input) => context.services.extensions === undefined
        ? missingService()
        : context.services.extensions.readSkill({
          skillId: input.skillId,
          ...(input.relativePath === undefined ? {} : { relativePath: input.relativePath }),
        }),
    }),
    defineTool({
      name: 'skills_install',
      description: 'Install a validated local or HTTPS Git SKILL.md source into supported IDE skill catalogs. Remote repositories are materialized without running install scripts and are rejected when unsafe symlinks are present.',
      permission: 'WRITE',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      inputSchema: skillInstallSchema,
      handler: async (input) => context.services.installer === undefined
        ? missingService()
        : context.services.installer.installSkill({
          name: input.name,
          source: input.source,
          targets: input.targets,
          ...(input.scope === undefined ? {} : { scope: input.scope }),
          ...(input.workspaceRoot === undefined ? {} : { workspaceRoot: input.workspaceRoot }),
        }),
    }),
    defineTool({
      name: 'ponytail_session',
      description: 'Temporarily suppress or resume the effective Ponytail coding policy for this MCP session and workspace/goal only. This does not change persisted global, workspace, or durable-goal settings. Use suppressed=true when the user explicitly asks to stop Ponytail or return to normal mode; use false to resume the effective policy.',
      permission: 'WRITE',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: ponytailSessionSchema,
      handler: async (input) => {
        if (context.setPonytailSessionSuppressed === undefined) return missingService();
        const applied = await context.setPonytailSessionSuppressed(input.workspaceId, input.goalId, input.suppressed);
        return ok({
          applied,
          workspaceId: input.workspaceId,
          ...(input.goalId === undefined ? {} : { goalId: input.goalId }),
          suppressed: input.suppressed,
          persistence: 'session_only',
        });
      },
    }),
  ];
}
