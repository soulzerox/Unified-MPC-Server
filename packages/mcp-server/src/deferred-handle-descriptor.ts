/**
 * The handle a deferred call returned, in the vocabulary the workspace journal's
 * `deferred_handles` ledger stores.
 *
 * The journal row says a call started and returned; only the authority that owns
 * the handle can say whether the work ended, and it needs the id to ask. This is
 * the small piece of derivation shared by the recorder and the MCP Tasks
 * projection, kept out of both so a provider cannot be answerable in one place
 * and invisible in the other.
 */

/** Providers a handle can be recorded for today. The ledger's closed set is wider. */
export type RecordedDeferredHandleProvider = 'process' | 'task';

export interface RecordedDeferredHandle {
  readonly workspaceId: string;
  readonly provider: RecordedDeferredHandleProvider;
  readonly handleId: string;
}

export interface DeferredHandleRecord {
  readonly workspaceId: string;
  readonly callId: string;
  readonly provider: RecordedDeferredHandleProvider;
  readonly handleId: string;
}

/**
 * Records a handle next to the call that returned it.
 *
 * Best-effort by contract, like the journal append it accompanies: a ledger write
 * must never fail the tool call. A missing row keeps its call pinned, which is
 * the same fail-closed direction the journal already takes.
 */
export type DeferredHandleRecorder = (record: DeferredHandleRecord) => void;

/** Tools whose response carries a managed process id at the top level. */
export const DIRECT_PROCESS_TOOLS: ReadonlySet<string> = new Set([
  'process_start',
  'project_dev',
  'project_test',
  'project_lint',
  'project_typecheck',
  'project_build',
]);

/** Tools whose response wraps the managed process under `process`. */
export const WRAPPED_PROCESS_TOOLS: ReadonlySet<string> = new Set([
  'benchmark_run',
  'run_affected_tests',
]);

export function isDirectProcessTool(toolName: string): boolean {
  return DIRECT_PROCESS_TOOLS.has(toolName);
}

export function isWrappedProcessTool(toolName: string): boolean {
  return WRAPPED_PROCESS_TOOLS.has(toolName);
}

/** Tools whose response carries a durable shell task id at the top level. */
export const DURABLE_TASK_TOOLS: ReadonlySet<string> = new Set([
  'task_create',
]);

export function isDurableTaskTool(toolName: string): boolean {
  return DURABLE_TASK_TOOLS.has(toolName);
}

/**
 * Derive the recorded handle for a tool response, or `undefined` when this call
 * hands back nothing an authority in this runtime can answer for.
 *
 * `shell`/`wsl_exec` are deliberately absent: their own process can exit while a
 * backgrounded child keeps working, so no handle they return speaks for the work.
 *
 * `task_create` records its `task_id` under provider `task`, whose closure route
 * asks the shell backend that wrote the durable task, so the id it hands back can
 * be answered for. A tool with no route is never recorded: recording a handle
 * nothing can ask about would keep its call pinned forever, which is the exact
 * failure recording a handle is meant to prevent.
 */
export function recordableDeferredHandle(
  toolName: string,
  input: unknown,
  response: { readonly structuredContent?: unknown; readonly isError?: boolean },
): RecordedDeferredHandle | undefined {
  if (response.isError === true) return undefined;
  const structured = asRecord(response.structuredContent);
  if (structured === undefined) return undefined;
  const workspaceId = boundedString(asRecord(input)?.workspaceId, 128);
  if (workspaceId === undefined) return undefined;

  if (isDurableTaskTool(toolName)) {
    const taskId = boundedString(structured.task_id, 256);
    return taskId === undefined ? undefined : { workspaceId, provider: 'task', handleId: taskId };
  }

  if (isDirectProcessTool(toolName)) {
    const processId = boundedString(structured.processId, 256);
    return processId === undefined ? undefined : { workspaceId, provider: 'process', handleId: processId };
  }

  if (isWrappedProcessTool(toolName)) {
    const processId = boundedString(asRecord(structured.process)?.processId, 256);
    return processId === undefined ? undefined : { workspaceId, provider: 'process', handleId: processId };
  }

  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function boundedString(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined;
}
