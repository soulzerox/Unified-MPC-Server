import { ok } from '@unified-mpc/domain';
import type { SkillSummary } from '@unified-mpc/extensions';
import { z } from 'zod';
import { defineTool, missingService, type McpToolContext, type McpToolDefinition } from './tool-types.js';
import { skillsListSchema, skillsReadSchema } from './schemas.js';

const ponytailSessionSchema = z.object({
  workspaceId: z.string().min(1).max(128),
  goalId: z.string().min(1).max(128).optional(),
  suppressed: z.boolean(),
}).strict();

const skillInstallSchema = z.object({
  name: z.string().min(1),
  source: z.string().min(1),
}).strict();

const readOnlyInspection = {
  permission: 'READ' as const,
  annotations: { readOnlyHint: true, destructiveHint: false },
};

export function skillTools(context: McpToolContext): McpToolDefinition[] {
  return [
    defineTool({
      name: 'skills_list',
      description: 'List skills from the current Unified runtime authority. When a canonical data directory is configured, the verified staged generation or direct canonical managed store is authoritative and client/global/workspace roots are not merged as runtime peers. Standalone callers without canonical data-directory ownership retain legacy multi-source discovery. Filter with query or source. Returns one summary row per skill by default (id, name, source, trust tier and a 200-character description preview); filesystem paths are omitted because the unprojected catalog costs ~112 KB on a ~136-skill host, a third of it description text and a quarter of it three path variants per skill. Pass detail=full when you need paths or complete descriptions.',
      ...readOnlyInspection,
      inputSchema: skillsListSchema,
      handler: async (input) => {
        const extensions = context.services.extensions;
        if (extensions === undefined) return missingService();
        const listed = await extensions.listSkills({
          ...(input.query === undefined ? {} : { query: input.query }),
          ...(input.source === undefined ? {} : { source: input.source }),
        });
        if (!listed.ok || input.detail === 'full') return listed;
        return ok(summarizeSkillList(listed.value));
      },
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
      description: 'Install a validated local or HTTPS Git SKILL.md source into the canonical Unified MCP skill store. This does not write Cursor, Cline, Claude, Codex, Antigravity, or OpenCode skill catalogs. Remote repositories are materialized without running install scripts and are rejected when unsafe symlinks are present.',
      permission: 'WRITE',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      inputSchema: skillInstallSchema,
      handler: async (input) => context.services.installer === undefined
        ? missingService()
        : context.services.installer.installSkill({
          name: input.name,
          source: input.source,
          targets: ['unified-mpc'],
          scope: 'global',
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

/**
 * A skill row is cheap until it is multiplied by the catalog: on this host 136
 * skills made a default `skills_list` 112 KB, of which the description text was
 * 53% and three path variants per skill another 26%. The paths are runtime
 * bookkeeping, not routing information, so a listing keeps identity plus a
 * description preview and reports every clip.
 */
const SKILL_LIST_OMITTED_FIELDS = ['rootPath', 'skillPath', 'canonicalSkillPath'] as const;
const SKILL_LIST_DESCRIPTION_PREVIEW_CHARS = 200;

function summarizeSkillList(result: { readonly skills: readonly SkillSummary[] }): Record<string, unknown> {
  return {
    total: result.skills.length,
    detail: 'summary',
    omittedFields: SKILL_LIST_OMITTED_FIELDS,
    hint: 'description is a preview of the text skill_match ranks; pass detail=full for complete descriptions and filesystem paths',
    skills: result.skills.map((skill) => {
      const truncated = skill.description.length > SKILL_LIST_DESCRIPTION_PREVIEW_CHARS;
      return {
        id: skill.id,
        name: skill.name,
        source: skill.source,
        trustTier: skill.trustTier,
        description: truncated ? `${skill.description.slice(0, SKILL_LIST_DESCRIPTION_PREVIEW_CHARS)}…` : skill.description,
        descriptionTruncated: truncated,
      };
    }),
  };
}
