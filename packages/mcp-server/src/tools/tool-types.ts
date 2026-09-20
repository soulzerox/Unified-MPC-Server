import { err, ok, type InvocationAuthorization, type Result, type ResultBudget } from '@unified-mpc/domain';
import type { CapabilityService, EventLogBackendOptions } from '@unified-mpc/capabilities';
import type { ExtensionsService, InstallerService } from '@unified-mpc/extensions';
import type { ResourceAdmissionController } from '@unified-mpc/workspace';
import type {
  AgentSwarmService,
  ApplyPatchRequest,
  CheckpointService,
  CodexService,
  DeleteFileRequest,
  EditFileRequest,
  FileActor,
  FileService,
  GitService,
  GoalRequestCancellationPort,
  GoalContinuationService,
  GoalMutationFenceService,
  MoveFileRequest,
  ProcessService,
  ProjectService,
  ReadFileRequest,
  ReadFilesRequest,
  SearchService,
  ScheduledContinuationService,
  WorkspaceIndexService,
  WorkspaceQueryService,
  WriteFileRequest,
} from '@unified-mpc/application';
import { z } from 'zod';
import type { ContextEconomyRuntime } from '../context-economy.js';

export interface WorkspaceInfoPort {
  info(actor: FileActor, workspaceId: string): Promise<Result<unknown>>;
  list?(actor: FileActor): Promise<Result<unknown>>;
  register?(actor: FileActor, request: {
    readonly parentWorkspaceId?: string;
    readonly path: string;
    readonly displayName?: string;
  }): Promise<Result<unknown>>;
}

export interface WorkspaceSelectionPort {
  list(): Promise<Result<unknown>>;
  activate(workspaceId: string): Promise<Result<unknown>>;
  deactivate(workspaceId: string): Promise<Result<unknown>>;
  setPrimary(workspaceId: string): Promise<Result<unknown>>;
}

export interface PreferredGoalPort {
  get(workspaceId: string): Promise<{
    readonly goalId: string;
    readonly goalKey: string;
    readonly objective: string;
    readonly currentPhase: string;
    readonly updatedAt: string;
  } | null>;
}

export interface ProjectSnapshotPort {
  snapshot(actor: FileActor, workspaceId: string): Promise<Result<unknown>>;
}

export interface McpRuntimeTiming {
  readonly mcpPollWaitSeconds: number;
}

export interface ThaiRagProviderPort {
  health(signal?: AbortSignal): Promise<Result<{
    readonly providerId: 'thai-rag';
    readonly state: string;
    readonly contractVersion?: string;
    readonly capabilities?: readonly string[];
    readonly workspaceScopeModel?: string;
    readonly embedding?: { readonly profile: string; readonly model: string; readonly dimension: number; readonly preprocessingVersion?: string };
    readonly compatibilityRange?: { readonly min: string; readonly max: string };
    readonly contractFingerprint?: string;
    readonly generation?: { readonly contract: string; readonly embedding: string; readonly index: string; readonly storage: string };
    readonly embeddingIndexGeneration: number;
    readonly degradation?: readonly string[];
    readonly components?: {
      readonly workerReachable: boolean;
      readonly sqliteAvailable: boolean;
      readonly ftsAvailable: boolean;
      readonly vectorStoreAvailable: boolean;
      readonly embedderAvailable: boolean;
      readonly lexicalRetrievalAvailable: boolean;
      readonly semanticRetrievalAvailable: boolean;
      readonly activeJobs: readonly unknown[];
    };
  }>>;
  call(tool: string, args: Readonly<Record<string, unknown>>, signal?: AbortSignal, budget?: ResultBudget): Promise<Result<unknown>>;
}

export interface McpApplicationServices {
  /** Host platform selected by the composition root; tests may inject a deterministic profile. */
  readonly platform?: NodeJS.Platform;
  readonly runtimeStatePath?: string;
  readonly runtimeTiming?: () => McpRuntimeTiming;
  /** Test-only deterministic override for Windows Sandbox discovery; production runtimes leave this undefined. */
  readonly sandboxRuntimeOptions?: { readonly platform?: NodeJS.Platform; readonly sandboxExecutable?: string };
  /** Test-only deterministic override for native event-log queries; production runtimes leave this undefined. */
  readonly eventLogRuntimeOptions?: EventLogBackendOptions;
  readonly localProviders?: () => { readonly pdfProvider?: string; readonly lspCommands?: Readonly<Record<string, string>> };
  readonly capabilities?: CapabilityService;
  readonly extensions?: ExtensionsService;
  /** Parent-owned native Thai-RAG provider. Repository-local child MCP configuration cannot replace this port. */
  readonly thaiRag?: ThaiRagProviderPort;
  readonly installer?: Pick<InstallerService, 'installSkill' | 'installServer'>;
  readonly workspaceInfo?: WorkspaceInfoPort;
  readonly workspaceSelection?: WorkspaceSelectionPort;
  readonly preferredGoal?: PreferredGoalPort;
  readonly workspaceQuery?: Pick<WorkspaceQueryService, 'tree'>;
  readonly projectSnapshot?: ProjectSnapshotPort;
  readonly project?: Pick<ProjectService, 'detect'>;
  readonly file?: Pick<FileService, 'readFile' | 'readFiles' | 'writeFile' | 'applyPatch' | 'editFile' | 'moveFile' | 'copyFile' | 'deleteFile' | 'listRecoveryItems' | 'restoreDeletedFile' | 'prepareExternalFileMutation'>;
  readonly checkpoint?: Pick<CheckpointService, 'list' | 'restore'>;
  readonly goals?: Pick<GoalContinuationService, 'runGoal' | 'getGoal' | 'checkpointGoal' | 'finishGoal' | 'cancelGoal' | 'reconcileGoals' | 'listGoals'>;
  /** Runtime-shared cancellation registry for in-flight fenced MCP requests. */
  readonly goalRequestCancellation?: GoalRequestCancellationPort;
  readonly scheduledContinuations?: Pick<ScheduledContinuationService, 'prepareScheduledContinuation' | 'recordScheduledContinuationReceipt' | 'cancelScheduledContinuation' | 'claimScheduledContinuation' | 'getScheduledContinuation' | 'expediteScheduledContinuation'>;
  readonly goalMutationFence?: Pick<GoalMutationFenceService, 'inspectWorkspaceFence' | 'begin' | 'heartbeat' | 'end' | 'observe'>;
  readonly search?: Pick<SearchService, 'searchFiles' | 'searchText'>;
  readonly workspaceIndex?: Pick<WorkspaceIndexService, 'indexWorkspace' | 'status' | 'startWatch' | 'stopWatch' | 'forgetWorkspace'>;
  readonly git?: Pick<GitService, 'status' | 'diff' | 'log' | 'run'>;
  readonly process?: Pick<ProcessService, 'start' | 'list' | 'status' | 'logs' | 'stop' | 'previewProjectCommand' | 'startProjectCommand'>;
  readonly codex?: Pick<CodexService, 'status' | 'run' | 'list' | 'taskStatus' | 'taskLogs' | 'stop'>;
  readonly agentSwarm?: Pick<AgentSwarmService, 'start' | 'status' | 'result' | 'cancel' | 'list'>;
}

export interface McpToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

export interface McpToolAnnotationInput {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

export interface McpToolExecution {
  readonly taskSupport: 'required' | 'optional' | 'forbidden';
}

export type McpPermissionLevel = 'READ' | 'WRITE' | 'EXECUTE' | 'DANGEROUS';

export interface McpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly permission: McpPermissionLevel;
  readonly annotations: McpToolAnnotations;
  readonly inputSchema: z.ZodType;
  readonly outputSchema: z.ZodType;
  readonly execution: McpToolExecution;
  parse(input: unknown): Result<unknown>;
  execute(input: unknown, signal: AbortSignal, authorization?: InvocationAuthorization, budget?: ResultBudget): Promise<Result<unknown>>;
}

export interface McpToolContext {
  readonly actor: FileActor;
  readonly services: McpApplicationServices;
  readonly contextEconomy: ContextEconomyRuntime;
  /** Process-owned controller shared across transports and expensive runtime subsystems. */
  readonly resourceAdmissionController?: ResourceAdmissionController;
  /** Stable caller/session owner used for admission accounting. */
  readonly resourceAdmissionSessionId?: string;
  /** Weighted cost of one live LSP server process. */
  readonly lspProcessAdmissionCost?: number;
  /** Dynamic registry exposure predicate used by discovery/ranking helpers. */
  readonly isToolExposed?: (name: string) => boolean;
  /** Live canonical tool definitions used by discovery so meta-catalogs cannot drift from the registry. */
  readonly discoveryTools?: () => readonly McpToolDefinition[];
  /** Session-scoped Ponytail suppression owned by the current ToolRegistry/transport ledger. */
  readonly setPonytailSessionSuppressed?: (workspaceId: string, goalId: string | undefined, suppressed: boolean) => Promise<boolean>;
  /** Resolve live policy, load the mandatory session-start routing skill, and register the correlated turn when supplied. */
  readonly bootstrapTaskContext?: (signal: AbortSignal) => Promise<Result<unknown>>;
  /** Bootstrap the effective workspace engineering harness and verify required native capabilities; optional child MCP connections cannot replace them. */
  readonly bootstrapWorkspaceHarness?: (workspaceId: string, signal: AbortSignal) => Promise<Result<unknown>>;
  /** Run required canonical native pre-edit diagnostics, optionally add Godkiller safety analysis, and authorize one development-artifact path; unavailable required capabilities fail closed. */
  readonly prepareCodeChange?: (workspaceId: string, filePath: string, proposedSymbol: string | undefined, runGodkillerSafetyCheck: boolean, signal: AbortSignal) => Promise<Result<unknown>>;
  /** Search the canonical parent-owned native working-memory capability through its curated read surface. */
  readonly workingMemorySearch?: (workspaceId: string, query: string, signal: AbortSignal, budget?: ResultBudget) => Promise<Result<unknown>>;
  /** Create or append a work-log entity through the canonical parent-owned native working-memory capability. */
  readonly workingMemoryRecord?: (workspaceId: string, name: string, entityType: string, observations: readonly string[], signal: AbortSignal, budget?: ResultBudget) => Promise<Result<unknown>>;
  /** Search parent-owned native Thai-RAG within one canonical workspace. */
  readonly ragRecall?: (workspaceId: string, query: string, category: string | undefined, limit: number | undefined, signal: AbortSignal, budget?: ResultBudget) => Promise<Result<unknown>>;
  /** Persist one bounded long-term memory through the parent-owned native Thai-RAG capability. */
  readonly ragRemember?: (workspaceId: string, content: string, category: string | undefined, signal: AbortSignal, budget?: ResultBudget) => Promise<Result<unknown>>;
  /** Invoke one parent-owned native Thai-RAG operation after canonical workspace validation. */
  readonly nativeRagCall?: (workspaceId: string, tool: string, args: Readonly<Record<string, unknown>>, signal: AbortSignal, budget?: ResultBudget) => Promise<Result<unknown>>;
}

export interface ToolConfig<T extends z.ZodType> {
  readonly name: string;
  readonly description: string;
  readonly permission: McpPermissionLevel;
  readonly annotations: McpToolAnnotationInput;
  readonly inputSchema: T;
  readonly outputSchema?: z.ZodType;
  readonly execution?: Partial<McpToolExecution>;
  handler(input: z.infer<T>, signal: AbortSignal, authorization?: InvocationAuthorization, budget?: ResultBudget): Promise<Result<unknown>>;
}

const defaultStructuredOutputSchema = z.object({}).catchall(z.unknown());

export function defineTool<T extends z.ZodType>(config: ToolConfig<T>): McpToolDefinition {
  return {
    name: config.name,
    description: config.description,
    permission: config.permission,
    annotations: {
      readOnlyHint: config.annotations.readOnlyHint,
      destructiveHint: config.annotations.destructiveHint,
      idempotentHint: config.annotations.idempotentHint ?? config.permission === 'READ',
      openWorldHint: config.annotations.openWorldHint ?? false,
    },
    inputSchema: config.inputSchema,
    outputSchema: config.outputSchema ?? defaultStructuredOutputSchema,
    execution: { taskSupport: config.execution?.taskSupport ?? 'forbidden' },
    parse(input: unknown): Result<unknown> {
      const parsed = config.inputSchema.safeParse(input);
      return parsed.success ? ok(parsed.data) : err({ code: 'INVALID_INPUT', message: 'Tool input is invalid', recoverable: false });
    },
    execute(input: unknown, signal: AbortSignal, authorization?: InvocationAuthorization, budget?: ResultBudget): Promise<Result<unknown>> {
      return config.handler(input as z.infer<T>, signal, authorization, budget);
    },
  };
}

export function missingService<T>(): Result<T> {
  return err({ code: 'INTERNAL_ERROR', message: 'MCP application service is unavailable', recoverable: true });
}

export type { ApplyPatchRequest, DeleteFileRequest, EditFileRequest, MoveFileRequest, ReadFileRequest, ReadFilesRequest, WriteFileRequest };
