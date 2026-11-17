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
export type RecordedDeferredHandleProvider = 'process' | 'task' | 'verification';

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

/**
 * Why this call's own response ended its deferral.
 *
 * A `merge_verification_run` that reached a verdict ran its gate inside the call,
 * so nothing is left to ask and the journal row must close with that call. The
 * code is the journal's vocabulary for "the work ended", not a provider verdict.
 */
export const VERIFICATION_SETTLED_CLOSURE_CODE = 'verification_settled';

export interface RecordedDeferredSettlement {
  readonly workspaceId: string;
  readonly closureCode: string;
}

export interface DeferredSettlementRecord {
  readonly workspaceId: string;
  readonly callId: string;
  readonly closureCode: string;
}

/** Closes the journal row of a call its own response proved finished. */
export type DeferredSettlementRecorder = (record: DeferredSettlementRecord) => void;

/**
 * Derive the closure a response proves about its own call, or `undefined` when the
 * call stayed deferred.
 *
 * Only a verdict settles itself: a `queued` attempt hands back an id and waits for
 * the status port, and a failed call may have been cancelled mid-run, so its work
 * can still be live — the pin stays rather than reading "errored" as "finished".
 */
export function recordableDeferredSettlement(
  toolName: string,
  input: unknown,
  response: { readonly structuredContent?: unknown; readonly isError?: boolean },
): RecordedDeferredSettlement | undefined {
  if (!isMergeVerificationTool(toolName)) return undefined;
  if (response.isError === true) return undefined;
  const structured = asRecord(response.structuredContent);
  if (structured?.status !== 'completed') return undefined;
  const workspaceId = boundedString(asRecord(input)?.workspaceId, 128);
  return workspaceId === undefined ? undefined : { workspaceId, closureCode: VERIFICATION_SETTLED_CLOSURE_CODE };
}

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
 * Tools whose response can carry the id of a durably queued verification attempt.
 *
 * A completed run returns a receipt and no attempt id, so it records no handle: the
 * gate already ran, and `recordableDeferredSettlement` closes its own journal row.
 */
export const MERGE_VERIFICATION_TOOLS: ReadonlySet<string> = new Set([
  'merge_verification_run',
]);

export function isMergeVerificationTool(toolName: string): boolean {
  return MERGE_VERIFICATION_TOOLS.has(toolName);
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
 * be answered for. `merge_verification_run` records its `attemptId` under provider
 * `verification`, and only while the attempt is `queued`: a run that already holds
 * a receipt records no handle, and its own response closes its journal row instead
 * (`recordableDeferredSettlement`), so that call is never pinned in the first place.
 * A tool with no route is never recorded: recording a handle nothing can ask about
 * would keep its call pinned forever, which is the exact failure recording a handle
 * is meant to prevent.
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

  if (isMergeVerificationTool(toolName)) {
    if (structured.status !== 'queued') return undefined;
    const attemptId = boundedString(structured.attemptId, 256);
    return attemptId === undefined ? undefined : { workspaceId, provider: 'verification', handleId: attemptId };
  }

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
