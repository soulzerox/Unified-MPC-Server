import { defineTool, missingService, type McpToolContext, type McpToolDefinition } from './tool-types.js';
import { gitDiffSchema, gitLogSchema, gitPublishPreflightSchema, gitRunSchema, gitStatusSchema } from './schemas.js';

export function gitTools(context: McpToolContext): McpToolDefinition[] {
  return [
    defineTool({
      name: 'git_status',
      description: 'Inspect parsed read-only Git status. For writes (init, add, commit, remote, push, rm, clean, reset) use the git tool.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: gitStatusSchema,
      handler: async (input, signal) => context.services.git === undefined
        ? missingService()
        : context.services.git.status(context.actor, input.workspaceId, signal),
    }),
    defineTool({
      name: 'git_diff',
      description: 'Return a bounded read-only Git diff. For writes use the git tool.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: gitDiffSchema,
      handler: async (input, signal) => context.services.git === undefined
        ? missingService()
        : context.services.git.diff(context.actor, input.workspaceId, {
          ...(input.path === undefined ? {} : { path: input.path }),
          ...(input.staged === undefined ? {} : { staged: input.staged }),
          ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
        }, signal),
    }),
    defineTool({
      name: 'git_log',
      description: 'Return bounded structured Git history. For writes use the git tool.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: gitLogSchema,
      handler: async (input, signal) => context.services.git === undefined
        ? missingService()
        : context.services.git.log(context.actor, input.workspaceId, {
          ...(input.maxCommits === undefined ? {} : { maxCommits: input.maxCommits }),
          ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
        }, signal),
    }),
    defineTool({
      name: 'git',
      description: 'Run a Git subcommand with a separate args array. With Full Bypass OFF, Full Access runs ordinary read and non-destructive Git mutations without confirmation while destructive/data-loss forms, scope overrides, aliases, unsafe pathspecs, unknown commands, and destructive remote/history rewrites remain guarded or denied. Trusted Full Bypass skips unified-mpc approval, command-policy, and Active Project scope checks, including explicitly absolute outside paths, without bypassing Git or OS errors. Do not wrap Git in PowerShell/cmd. A Git push denied by runtime transport or credential configuration carries details.reason (push-environment-override, push-config-override, push-protocol-override, push-credential-helper, push-signing-program, push-hook-location-unresolved, push-pre-push-hook) with the blocking config key or a key pattern when a subsection could hold a URL or credential, never the value, so a policy-level allow can be told apart from an authentication or transport block.',
      permission: 'EXECUTE',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: gitRunSchema,
      handler: async (input, signal, authorization) => context.services.git === undefined
        ? missingService()
        : context.services.git.run(context.actor, {
          args: input.args,
          ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
          ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
          ...(input.timeoutSeconds === undefined ? {} : { timeoutMs: Math.floor(input.timeoutSeconds * 1000) }),
          ...(input.userConfirmed === undefined ? {} : { userConfirmed: input.userConfirmed }),
        }, signal, authorization),
    }),
    defineTool({
      name: 'git_publish_preflight',
      description: 'Report whether a Git publish would be blocked by runtime transport or credential configuration, without pushing and without changing anything. Returns the resolved head commit, sanitized push targets (scheme and host only), default branches, whether the branch is protected, and runtime.ready plus runtime.reason (a push safety code such as push-credential-helper) when configuration would block a push. Policy is decided before this runs, so reaching this tool means the caller may ask; approval is always reported as missing until the host-mediated publish path exists.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: gitPublishPreflightSchema,
      handler: async (input, signal) => context.services.git === undefined
        ? missingService()
        : context.services.git.publishPreflight(context.actor, {
          ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
          ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
          remote: input.remote,
          branch: input.branch,
        }, signal),
    }),
  ];
}
