import { defineTool, missingService, type McpToolContext, type McpToolDefinition } from './tool-types.js';
import { gitDiffSchema, gitLogSchema, gitPublishPreflightSchema, gitPublishSchema, gitRunSchema, gitStatusSchema, publishApproveSchema } from './schemas.js';

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
      description: 'Run a Git subcommand with a separate args array. With Full Bypass OFF, Full Access runs ordinary read and non-destructive Git mutations without confirmation while destructive/data-loss forms, scope overrides, aliases, unsafe pathspecs, unknown commands, and destructive remote/history rewrites remain guarded or denied. Trusted Full Bypass skips unified-mpc approval, command-policy, and Active Project scope checks, including explicitly absolute outside paths, without bypassing Git or OS errors. Do not wrap Git in PowerShell/cmd. A Git push denied by runtime transport or credential configuration carries details.reason (push-environment-override, push-config-override, push-protocol-override, push-credential-helper, push-signing-program, push-hook-location-unresolved, push-pre-push-hook) plus details.key, or details.keys for environment overrides, naming the blocking config key or a key pattern when a subsection could hold a URL or credential, never the value; only PERMISSION_DENIED push denials carry these codes, so a policy-level allow can be told apart from an authentication or transport block. push-credential-helper is reported when a resolved push target could use a helper (HTTP(S)) or when a target cannot be resolved or is not a supported transport, so an unknown remote stays guarded; SSH, git:// and local targets never consult a helper.',
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
      description: 'Report whether a Git publish would be blocked by runtime transport or credential configuration, without pushing and without changing anything. Returns the resolved head commit, sanitized push targets (scheme and host only), default branches, whether the branch is protected, and runtime.ready plus runtime.reason (a push safety code such as push-credential-helper) when configuration would block a push. The push safety guard runs before any remote contact, so a blocked runtime reports no default branches (defaultBranches is empty and protectedBranch is false) instead of running ls-remote and a possible credential helper. Policy is decided before this runs, so reaching this tool means the caller may ask. approval is the host approval ledger state for this exact workspace, remote, branch and head (missing, pending, expired, or consumed); pending is a diagnostic, not permission, and this tool cannot publish anything.',
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
    defineTool({
      name: 'publish_approve',
      description: 'Mint one single-use publish approval for an exact workspace, remote, branch and commit. This is the human approval gate: call it only after the user explicitly approves that exact binding in chat, and pass userConfirmed: true as their answer. It never pushes. It refuses without userConfirmed, when the checked-out head is not the expected commit, when the branch is a repository default branch, or when runtime transport/credential configuration would block a publish. The receipt expires (default 15 minutes) and can be spent once by git_publish.',
      permission: 'EXECUTE',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      inputSchema: publishApproveSchema,
      handler: async (input, signal) => context.services.git === undefined
        ? missingService()
        : context.services.git.approvePublish(context.actor, {
          ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
          ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
          remote: input.remote,
          branch: input.branch,
          expectedSha: input.expectedSha,
          ...(input.ttlSeconds === undefined ? {} : { ttlSeconds: input.ttlSeconds }),
          ...(input.userConfirmed === undefined ? {} : { userConfirmed: input.userConfirmed }),
        }, signal),
    }),
    defineTool({
      name: 'git_publish',
      description: 'Spend one single-use publish approval and push exactly its approved commit to exactly its approved branch. The host builds the Git invocation and verifies the remote ref afterwards; the caller supplies only workspaceId or cwd, remote, branch, expectedSha and approvalId, never argv. Force, tags, deletes, --all, --mirror and default branches are not expressible. A missing, expired, already consumed or differently-bound approval fails with reason publish-approval-required and no Git child runs. HTTP(S) targets that could run a credential helper stay denied with the push safety reason; SSH, git:// and local targets are supported. The result reports the verified remote sha and sanitized transport targets, never credentials or raw stderr.',
      permission: 'EXECUTE',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      inputSchema: gitPublishSchema,
      handler: async (input, signal) => context.services.git === undefined
        ? missingService()
        : context.services.git.publish(context.actor, {
          ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
          ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
          remote: input.remote,
          branch: input.branch,
          expectedSha: input.expectedSha,
          approvalId: input.approvalId,
        }, signal),
    }),
  ];
}
