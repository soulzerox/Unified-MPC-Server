import { McpServer, type CallToolResult, type RegisteredTool } from '@modelcontextprotocol/server';
import type { DiagnosticLogger, FileActor } from '@unified-mpc/application';
import type { PermissionProfile } from '@unified-mpc/permissions';
import { APP_NAME, APP_VERSION, DEFAULT_PONYTAIL_MODE, parsePonytailMode, type DestructiveAutoApprovalPolicy, type PonytailMode, type ToolAvailabilitySnapshot } from '@unified-mpc/shared';
import { readTraceContext, type ActivitySink, type ActivityTracker } from './activity-tracker.js';
import { withProgressHeartbeat, type ProgressNotifyContext } from './progress-heartbeat.js';
import { IncrementalVerifier } from './incremental-verifier.js';
import { RunBudgetGuard, type RunBudgetContext } from './run-budget.js';
import { registerTasksProtocol } from './tasks-protocol.js';
import { MODERN_TASKS_EXTENSION_ID } from './modern-tasks-protocol.js';
import { registerModernTasksProtocol } from './modern-tasks-wire.js';
import { ToolRegistry, type ActiveProjectScope, type AuthorizationMode, type HostMutationApprovalRequest, type McpApplicationServices, type WorkspaceScope } from './tool-registry.js';
import type { SetOfMarksObservationStore } from './set-of-marks-service.js';
import { BUNDLED_PONYTAIL_SKILL_ID, PonytailActivationLedger } from './ponytail-runtime.js';
import { HarnessActivationLedger } from './harness-runtime.js';
import { actorForRequestScope, type McpRequestScope } from './request-scope.js';
import { sharedProcessResourceAdmissionController, type ResourceAdmissionController } from '@unified-mpc/workspace';

export const MCP_OUTCOME_DRIVEN_INSTRUCTIONS = [
  'Continue using unified-mpc tools until the requested outcome is complete.',
  'Do not stop, hand off, or ask the user to say "continue" merely because elapsed time has passed.',
  'Stop only when the outcome is complete, a user decision or new authority is required, or an external blocker prevents safe progress.',
  'Before the first mutation of any multi-step change that includes verification, build, package, push, release preparation, or is likely to outlive the current turn, call run_goal with scheduledContinuation=auto and follow the bundled unified-mpc-scheduled-continuation skill; if such work is already in progress without an active durable goal, enroll it before the next mutation.',
  'At the start of every user task, call task_bootstrap. It resolves policy_snapshot and loads ask-matt in one server-side read; then follow that skill and prefer canonical native capabilities, using optional policy-listed child MCP servers only when relevant and available without waiting for the user to name them. Native memory is selective: recall when prior context matters and remember only durable decisions, constraints, preferences, or explicit user-requested memory; never persist ordinary turns automatically.',
  'Use canonical first-party rag_* and workspace_memory_record tools for native workspace-scoped memory and code retrieval. Do not route native Thai-RAG through generic mcp_call, substitute optional child MCPs for native tools, or create automatic per-turn memory writes.',
  'For coding work in a registered workspace, call workspace_bootstrap before the first code mutation; it loads the workspace harness and verifies required native capabilities, failing closed when they are unavailable. Optional child MCP connections do not replace canonical native tools. Before mutating each development-artifact path, call prepare_code_change for that path so required native pre-edit diagnostics run before the write. For high-risk refactors, migrations, security-sensitive changes, or unclear blast radius, set runGodkillerSafetyCheck=true on prepare_code_change to add the curated optional Godkiller edit_safe analysis.',
  'For Git code changes, never push commits directly to the repository default branch, including main or master. Work on a feature or issue branch, push that branch, open or update a pull request, inspect the final PR diff and CI, perform a code review, resolve review findings, and only then merge. A request to commit + push means push the working branch and continue through the PR/review workflow; it never authorizes skipping the pull request or review gate. Route Git integration through the guarded Git tool; direct Git and common shell/interpreter Git-push forms through process_start or shell are denied, while arbitrary generic executables remain an agent-routing concern rather than an OS-level guarantee. Follow this workflow even when GitHub branch protection or rulesets are absent.',
  'Use durable background tasks for naturally long-running commands, then keep checking them and continue the work while the current run remains active.',
].join(' ');

export function buildMcpInstructions(ponytailMode: PonytailMode = DEFAULT_PONYTAIL_MODE): string {
  if (ponytailMode === 'off') return MCP_OUTCOME_DRIVEN_INSTRUCTIONS;
  return `${MCP_OUTCOME_DRIVEN_INSTRUCTIONS} For coding tasks, the global unified-mpc Ponytail policy is ${ponytailMode.toUpperCase()}. Load the exact bundled skill ${BUNDLED_PONYTAIL_SKILL_ID} before the first code mutation and follow it at the selected intensity. Workspace or durable-goal overrides are resolved at execution time and may change the effective mode. Do not substitute workspace/user copies. If the user explicitly asks to stop Ponytail or return to normal mode, call ponytail_session with suppressed=true for the active workspace/goal; use suppressed=false to resume without changing persisted settings. Ponytail is subordinate to unified-mpc security, approvals, durable goals, recovery, compatibility, observability, required tests, release verification, project rules, and explicit user instructions.`;
}

export interface McpServerOptions {
  readonly services: McpApplicationServices;
  readonly actor: FileActor;
  readonly requestScope?: McpRequestScope;
  readonly diagnostic?: DiagnosticLogger;
  readonly activity?: ActivitySink;
  readonly activityTracker?: ActivityTracker;
  readonly profileProvider?: () => PermissionProfile;
  readonly authorizationModeProvider?: () => AuthorizationMode;
  readonly allowAiDeleteProvider?: () => boolean;
  readonly destructivePolicyProvider?: () => DestructiveAutoApprovalPolicy;
  readonly activeWorkspaceScopeProvider?: () => WorkspaceScope | null | Promise<WorkspaceScope | null>;
  /** Host-owned active project set. The first scope is the primary/default workspace. */
  readonly activeWorkspaceScopesProvider?: () => readonly WorkspaceScope[] | Promise<readonly WorkspaceScope[]>;
  readonly hostMutationApprovalProvider?: (request: HostMutationApprovalRequest) => boolean | Promise<boolean>;
  /** @deprecated Request-selected workspace lookup is not an authorization boundary. */
  readonly workspaceScopeResolver?: (workspaceId: string) => WorkspaceScope | null | Promise<WorkspaceScope | null>;
  /** @deprecated Compatibility alias for activeWorkspaceScopeProvider. */
  readonly activeProjectProvider?: () => ActiveProjectScope | null;
  /** Exposes quota-consuming Codex delegation tools. Disabled unless explicitly enabled. */
  readonly codexToolsEnabled?: boolean;
  /** Current persisted global Ponytail mode. Workspace/goal overrides are resolved by ToolRegistry at execution time. */
  readonly ponytailModeProvider?: () => PonytailMode;
  /** Shared activation/review state for transport factories that recreate MCP servers per request. */
  readonly ponytailActivationLedger?: PonytailActivationLedger;
  /** Shared workspace-harness bootstrap/pre-edit state for transport factories that recreate MCP servers per request. */
  readonly harnessActivationLedger?: HarnessActivationLedger;
  /** Current persisted per-tool availability snapshot. */
  readonly toolAvailabilitySnapshotProvider?: () => ToolAvailabilitySnapshot;
  /** Subscribes to persisted per-tool availability changes for live SDK handle toggling. */
  readonly toolAvailabilitySubscribe?: (listener: (snapshot: ToolAvailabilitySnapshot) => void) => () => void;
  /** Shared across per-request server factories so repeated diff fingerprints can hit cache. */
  readonly incrementalVerifier?: IncrementalVerifier;
  /** Shared by transport-scoped server factories so visual observations survive the next MCP request. */
  readonly setOfMarksStore?: SetOfMarksObservationStore;
  /** Global UTF-8 text-result ceiling before data crosses the MCP client boundary. */
  readonly maxToolResultBytes?: number;
  /** Tighter UTF-8 result ceiling for proxied child MCP calls. */
  readonly maxMcpCallResultBytes?: number;
  /** Process-owned admission controller shared across MCP server/transport instances. */
  readonly resourceAdmissionController?: ResourceAdmissionController;
  /** Weighted admission cost for one proxied child MCP call. */
  readonly mcpCallAdmissionCost?: number;
  /** Compatibility result guard; it must not apply elapsed-time behavior. */
  readonly runBudgetGuard?: RunBudgetGuard;
  /**
   * Opt in only for MCP 2025-11-25 legacy clients. The core `tasks`
   * capability was removed from the modern protocol in favor of the
   * io.modelcontextprotocol/tasks extension, so modern clients must never
   * see this legacy surface advertised.
   */
  readonly legacyTasksProtocol?: boolean;
}

export function createMcpServer(options: McpServerOptions): McpServer {
  const actor = actorForRequestScope(options.actor, options.requestScope);
  const registry = new ToolRegistry(options.services, actor, {
    ...(options.diagnostic === undefined ? {} : { diagnostic: options.diagnostic }),
    ...(options.activity === undefined ? {} : { activity: options.activity }),
    ...(options.activityTracker === undefined ? {} : { activityTracker: options.activityTracker }),
    ...(options.requestScope === undefined ? {} : { sessionId: options.requestScope.sessionId }),
    ...(options.profileProvider === undefined ? {} : { profileProvider: options.profileProvider }),
    ...(options.authorizationModeProvider === undefined ? {} : { authorizationModeProvider: options.authorizationModeProvider }),
    ...(options.allowAiDeleteProvider === undefined ? {} : { allowAiDeleteProvider: options.allowAiDeleteProvider }),
    ...(options.destructivePolicyProvider === undefined ? {} : { destructivePolicyProvider: options.destructivePolicyProvider }),
    ...(options.activeWorkspaceScopeProvider === undefined ? {} : { activeWorkspaceScopeProvider: options.activeWorkspaceScopeProvider }),
    ...(options.activeWorkspaceScopesProvider === undefined ? {} : { activeWorkspaceScopesProvider: options.activeWorkspaceScopesProvider }),
    ...(options.hostMutationApprovalProvider === undefined ? {} : { hostMutationApprovalProvider: options.hostMutationApprovalProvider }),
    ...(options.workspaceScopeResolver === undefined ? {} : { workspaceScopeResolver: options.workspaceScopeResolver }),
    ...(options.activeProjectProvider === undefined ? {} : { activeProjectProvider: options.activeProjectProvider }),
    ...(options.codexToolsEnabled === undefined ? {} : { codexToolsEnabled: options.codexToolsEnabled }),
    ...(options.ponytailModeProvider === undefined ? {} : { ponytailModeProvider: options.ponytailModeProvider }),
    ...(options.ponytailActivationLedger === undefined ? {} : { ponytailActivationLedger: options.ponytailActivationLedger }),
    ...(options.harnessActivationLedger === undefined ? {} : { harnessActivationLedger: options.harnessActivationLedger }),
    ...(options.toolAvailabilitySnapshotProvider === undefined ? {} : { toolAvailabilitySnapshotProvider: options.toolAvailabilitySnapshotProvider }),
    ...(options.incrementalVerifier === undefined ? {} : { incrementalVerifier: options.incrementalVerifier }),
    ...(options.setOfMarksStore === undefined ? {} : { setOfMarksStore: options.setOfMarksStore }),
    ...(options.maxToolResultBytes === undefined ? {} : { maxToolResultBytes: options.maxToolResultBytes }),
    ...(options.maxMcpCallResultBytes === undefined ? {} : { maxMcpCallResultBytes: options.maxMcpCallResultBytes }),
    resourceAdmissionController: options.resourceAdmissionController ?? sharedProcessResourceAdmissionController(),
    ...(options.mcpCallAdmissionCost === undefined ? {} : { mcpCallAdmissionCost: options.mcpCallAdmissionCost }),
  });
  const runBudgetGuard = options.runBudgetGuard ?? new RunBudgetGuard();
  let configuredPonytailMode = DEFAULT_PONYTAIL_MODE;
  try {
    configuredPonytailMode = parsePonytailMode(options.ponytailModeProvider?.(), DEFAULT_PONYTAIL_MODE);
  } catch {
    configuredPonytailMode = DEFAULT_PONYTAIL_MODE;
  }
  // The core `tasks` capability belongs only to MCP 2025-11-25 legacy
  // negotiation. Modern MCP moved Tasks to the io.modelcontextprotocol/tasks
  // extension, so advertising the old core capability to a modern host is a
  // protocol mismatch. Keep the legacy bridge available only when the
  // transport has already identified a legacy client.
  const legacyTasksProtocol = options.legacyTasksProtocol === true;
  const server = new McpServer({ name: APP_NAME, version: APP_VERSION }, {
    capabilities: legacyTasksProtocol
      ? { tools: {}, tasks: { list: {}, cancel: {} } }
      : { tools: {}, extensions: { [MODERN_TASKS_EXTENSION_ID]: {} } },
    instructions: buildMcpInstructions(configuredPonytailMode),
    debouncedNotificationMethods: ['notifications/tools/list_changed'],
  });
  if (legacyTasksProtocol) registerTasksProtocol(server, options.services, { actor });
  else registerModernTasksProtocol(server, options.services, { actor });

  const registeredTools = new Map<string, RegisteredTool>();
  const initiallyExposed = new Set(registry.listExposedDefinitions().map((tool) => tool.name));
  for (const tool of registry.listAll()) {
    const registeredTool = server.registerTool(tool.name, {
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      annotations: tool.annotations,
    }, async (input: unknown, context): Promise<CallToolResult> => {
      const dispatchContext = context as ProgressNotifyContext & RunBudgetContext;
      runBudgetGuard.begin(dispatchContext);
      const sdkTrace = readTraceContext(context);
      const requestScope = options.requestScope;
      const traceContext = {
        ...sdkTrace,
        ...(requestScope?.sessionId === undefined ? {} : { sessionId: requestScope.sessionId }),
        ...(sdkTrace.traceId !== undefined || requestScope?.traceId === undefined ? {} : { traceId: requestScope.traceId }),
        ...(sdkTrace.traceParent !== undefined || requestScope?.traceParent === undefined ? {} : { traceParent: requestScope.traceParent }),
        ...(sdkTrace.traceState !== undefined || requestScope?.traceState === undefined ? {} : { traceState: requestScope.traceState }),
        ...(sdkTrace.baggage !== undefined || requestScope?.baggage === undefined ? {} : { baggage: requestScope.baggage }),
      };
      const result = await withProgressHeartbeat(dispatchContext, tool.name, async () => (
        registry.invoke(tool.name, input, traceContext) as unknown as Promise<CallToolResult>
      ));
      const finished = runBudgetGuard.finish(dispatchContext, result);
      return finished;
    });
    if (!initiallyExposed.has(tool.name)) registeredTool.disable();
    registeredTools.set(tool.name, registeredTool);
  }

  const syncRegisteredToolAvailability = (): void => {
    const exposed = new Set(registry.listExposedDefinitions().map((tool) => tool.name));
    for (const [name, registeredTool] of registeredTools) {
      const shouldEnable = exposed.has(name);
      if (registeredTool.enabled === shouldEnable) continue;
      if (shouldEnable) registeredTool.enable();
      else registeredTool.disable();
    }
  };

  const unsubscribeToolAvailability = options.toolAvailabilitySubscribe?.(() => {
    syncRegisteredToolAvailability();
  });
  if (unsubscribeToolAvailability !== undefined) {
    const closeServer = server.close.bind(server);
    let availabilitySubscriptionClosed = false;
    server.close = async (): Promise<void> => {
      if (!availabilitySubscriptionClosed) {
        availabilitySubscriptionClosed = true;
        unsubscribeToolAvailability();
      }
      await closeServer();
    };
  }

  return server;
}
