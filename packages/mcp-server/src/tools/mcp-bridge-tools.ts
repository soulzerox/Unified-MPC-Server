import { z } from 'zod';
import { defineTool, missingService, type McpToolContext, type McpToolDefinition } from './tool-types.js';
import { mcpCallSchema, mcpDescribeSchema, mcpListSchema, policySnapshotSchema } from './schemas.js';

const installTargetSchema = z.enum(['antigravity', 'cursor', 'claude', 'codex', 'cline', 'opencode', 'all']);
const mcpInstallSchema = z.object({
  name: z.string().min(1),
  transport: z.enum(['stdio', 'sse', 'http']),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().min(1).optional(),
  source: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
  targets: z.array(installTargetSchema).min(1).default(['all']),
  scope: z.enum(['global', 'workspace']).optional(),
  workspaceRoot: z.string().min(1).optional(),
}).strict();

const readOnlyInspection = {
  permission: 'READ' as const,
  annotations: { readOnlyHint: true, destructiveHint: false },
};

const opaqueChildMutation = {
  permission: 'DANGEROUS' as const,
  annotations: { readOnlyHint: false, destructiveHint: true },
};

export function mcpBridgeTools(context: McpToolContext): McpToolDefinition[] {
  return [
    defineTool({
      name: 'task_bootstrap',
      description: 'Resolve the live runtime policy and load the mandatory session-start routing skill (normally ask-matt) in one read-only call. Use this as the first unified-mpc action for each user task.',
      ...readOnlyInspection,
      inputSchema: policySnapshotSchema,
      handler: async (_input, signal) => context.bootstrapTaskContext === undefined
        ? missingService()
        : context.bootstrapTaskContext(signal),
    }),
    defineTool({
      name: 'policy_snapshot',
      description: 'Return the live semantic runtime policy after reconciling configured policies with currently discovered child MCP servers and local skills. Use this at the start of each user task to route relevant capabilities without flattening child tools.',
      ...readOnlyInspection,
      inputSchema: policySnapshotSchema,
      handler: async () => context.services.extensions === undefined
        ? missingService()
        : context.services.extensions.runtimePolicySnapshot(),
    }),
    defineTool({
      name: 'mcp_list',
      description: 'List local MCP servers discovered from Cursor, Claude Desktop, and unified-mpc settings. This inspection is read-only and does not flatten child tools into the unified-mpc catalog.',
      ...readOnlyInspection,
      inputSchema: mcpListSchema,
      handler: async () => context.services.extensions === undefined
        ? missingService()
        : context.services.extensions.listMcpServers(),
    }),
    defineTool({
      name: 'mcp_describe',
      description: 'Connect to one local MCP server (if needed) and return its tool names, descriptions, and input schemas. This operation only inspects the child tool catalog.',
      ...readOnlyInspection,
      inputSchema: mcpDescribeSchema,
      handler: async (input, signal) => context.services.extensions === undefined
        ? missingService()
        : context.services.extensions.describeMcpServer({ server: input.server }, signal),
    }),
    defineTool({
      name: 'mcp_install',
      description: 'Register an MCP server for supported IDE targets. stdio accepts either an explicit command or a validated HTTPS Git repository source; SSE/HTTP accept a remote endpoint URL. Repository installs never run package install scripts.',
      permission: 'WRITE',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      inputSchema: mcpInstallSchema,
      handler: async (input) => context.services.installer === undefined
        ? missingService()
        : context.services.installer.installServer({
          name: input.name,
          transport: input.transport,
          targets: input.targets,
          ...(input.command === undefined ? {} : { command: input.command }),
          ...(input.args === undefined ? {} : { args: input.args }),
          ...(input.env === undefined ? {} : { env: input.env }),
          ...(input.url === undefined ? {} : { url: input.url }),
          ...(input.source === undefined ? {} : { source: input.source }),
          ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
          ...(input.scope === undefined ? {} : { scope: input.scope }),
          ...(input.workspaceRoot === undefined ? {} : { workspaceRoot: input.workspaceRoot }),
        }),
    }),
    defineTool({
      name: 'mcp_call',
      description: 'Call a tool on a discovered local MCP server. Standard mode fails closed as an opaque mutation unless the parent runtime policy explicitly lists this exact child tool in readOnlyTools and the supplied descriptor/catalog fingerprints match the live drift-free MCP contract; only that verified case is classified as a read without mutation approval. All other child calls preserve explicit chat plus host exact-action approval. Trusted Full Bypass skips unified-mpc application approval; the child server still enforces its own policy.',
      ...opaqueChildMutation,
      inputSchema: mcpCallSchema,
      handler: async (input, signal) => context.services.extensions === undefined
        ? missingService()
        : context.services.extensions.callMcpTool({
          server: input.server,
          tool: input.tool,
          ...(input.arguments === undefined ? {} : { arguments: input.arguments }),
          ...(input.descriptorFingerprint === undefined ? {} : { descriptorFingerprint: input.descriptorFingerprint }),
          ...(input.catalogFingerprint === undefined ? {} : { catalogFingerprint: input.catalogFingerprint }),
        }, signal),
    }),
  ];
}
