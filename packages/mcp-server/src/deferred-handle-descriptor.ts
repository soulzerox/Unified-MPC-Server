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
export type RecordedDeferredHandleProvider = 'process' | 'task' | 'verification' | 'codex' | 'swarm';

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

/**
 * Why a read of an `agent_swarm_run` sub-action ends its own deferral.
 *
 * The journal treats the whole tool as deferred, by name, because a `start` returns
 * while the swarm runs. A `status`/`result`/`cancel`/`list` call starts nothing, so
 * its work really did end inside the call: no handle may be recorded for it (it names
 * a swarm this call did not start, and no listing can speak for a swarm), and leaving
 * its row open would pin the goal `present` forever with nothing able to ask.
 */
export const SWARM_READ_SETTLED_CLOSURE_CODE = 'swarm_read_settled';

/**
 * Why a `git_worktree_spawn` preview ends its own deferral.
 *
 * The tool defaults to a preview: it reports the worktree it would create and creates
 * nothing. Its journal row is a durable reference, so a preview's row left open pins
 * the goal `present` over a worktree that was never made, and the lifecycle authorities
 * that answer the removal question have nothing to answer about. A call that really
 * spawned (`dryRun: false`) keeps its pin instead: a failure after creating the
 * directory is indistinguishable from a refusal, so reading an error as "nothing was
 * created" would release a pin over a worktree that exists.
 */
export const WORKTREE_PREVIEW_SETTLED_CLOSURE_CODE = 'worktree_preview_settled';

/**
 * Tools whose own response can close the journal row they opened.
 *
 * Every name here hands back work that outlives the call, and every such tool also has a
 * settlement rule below, so its newest open row can end itself: retention therefore may
 * not collapse it (`DURABLE_REFERENCE_OPERATION_KINDS` in `@unified-mpc/storage`), or a
 * newer self-settling row would evict the older row that still stands for live work.
 * The storage set cannot be derived from these rules — the journal sits one layer down —
 * so the two lists are pinned to each other by
 * `apps/cli/src/runtime/deferred-journal-closure.test.ts`.
 */
export const SETTLEMENT_TOOL_NAMES: ReadonlySet<string> = new Set([
  'agent_swarm_run', 'merge_verification_run', 'git_worktree_spawn',
]);

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
 *
 * An `agent_swarm_run` read sub-action settles too, for a different reason: it starts
 * nothing, so its work ended inside the call — including when the read failed, since
 * a read that failed still started nothing. Its `start` sibling does not: it hands
 * back a swarm id whose authority answers later.
 */
export function recordableDeferredSettlement(
  toolName: string,
  input: unknown,
  response: { readonly structuredContent?: unknown; readonly isError?: boolean },
): RecordedDeferredSettlement | undefined {
  const workspaceId = boundedString(asRecord(input)?.workspaceId, 128);
  if (workspaceId === undefined) return undefined;
  // A read starts nothing, so even a failed read is finished: leaving it open
  // would pin the goal on a call that could never have produced work, and no
  // probe could ever answer it.
  if (toolName === 'agent_swarm_run' && isAgentSwarmRead(input)) {
    return { workspaceId, closureCode: SWARM_READ_SETTLED_CLOSURE_CODE };
  }
  // A preview creates nothing, so its work ended inside the call whether it answered
  // or errored. Decided from the input alone for the same reason a read is: the
  // response cannot say whether a directory was created on the way to failing. A
  // present `dry_run` counts as a preview because the tool's schema is `.strict()` and
  // lists only `dryRun`, so such a call is refused before its handler and created
  // nothing. That is not the runtime's own reading — `gitWorktreeSpawn` takes
  // `dryRun !== false && dry_run !== false` — so the two agree only while the schema
  // keeps refusing the alias, which
  // `deferred-handle-descriptor.test.ts` pins against the real catalog entry.
  if (toolName === 'git_worktree_spawn' && isWorktreeSpawnPreview(input)) {
    return { workspaceId, closureCode: WORKTREE_PREVIEW_SETTLED_CLOSURE_CODE };
  }
  if (response.isError === true) return undefined;
  if (isMergeVerificationTool(toolName)) {
    const structured = asRecord(response.structuredContent);
    if (structured?.status !== 'completed') return undefined;
    return { workspaceId, closureCode: VERIFICATION_SETTLED_CLOSURE_CODE };
  }
  return undefined;
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
 * Tools whose response carries the id of a local Codex task at the top level.
 *
 * `codex_run` returns `{ codexTaskId, processId }`, and only the `CodexService` that
 * launched it knows the task: a codex process lives in that service's own process
 * manager, so the CLI's process listing can never see it. The id is what its
 * liveness probe answers for, so it is the handle.
 */
export const CODEX_TASK_TOOLS: ReadonlySet<string> = new Set([
  'codex_run',
]);

export function isCodexTaskTool(toolName: string): boolean {
  return CODEX_TASK_TOOLS.has(toolName);
}

/**
 * Tools that hand back the id of a Codex-backed agent swarm this host owns.
 *
 * `agent_swarm_run` carries read sub-actions too (`status`/`result`/`cancel`/`list`),
 * so only its `start` operation is a handle: the response shapes are snapshots of a
 * *different* swarm the caller merely asked about. `delegate`/`parallel_delegate` are
 * always a start and answer `{ delegateId, swarm }`. All of them are answered by the
 * `AgentSwarmService` that started the swarm, and its own goal-liveness probe is the
 * one reading of that swarm's state no listing could reproduce.
 */
export const AGENT_SWARM_TOOLS: ReadonlySet<string> = new Set([
  'agent_swarm_run',
  'delegate',
  'parallel_delegate',
]);

export function isAgentSwarmTool(toolName: string): boolean {
  return AGENT_SWARM_TOOLS.has(toolName);
}

/** The only `agent_swarm_run` operation that starts work. */
const AGENT_SWARM_START_OPERATION = 'start';

/**
 * The `agent_swarm_run` sub-actions that start nothing.
 *
 * Enumerated rather than "anything but `start`", so a sub-action added later is
 * neither treated as a read (which would settle a call that may have started work)
 * nor as a start (which would record a snapshot as a handle) until someone decides
 * which it is. Both mistakes are the fail-open direction, so the unknown answer is
 * "this call deferred nothing".
 */
const AGENT_SWARM_READ_OPERATIONS: ReadonlySet<string> = new Set([
  'status', 'result', 'cancel', 'list',
]);

function agentSwarmOperation(input: unknown): string | undefined {
  const operation = asRecord(input)?.operation;
  return typeof operation === 'string' ? operation : undefined;
}

/** True only for a known read sub-action: an unknown operation is not one. */
function isAgentSwarmRead(input: unknown): boolean {
  const operation = agentSwarmOperation(input);
  return operation !== undefined && AGENT_SWARM_READ_OPERATIONS.has(operation);
}

/**
 * True when the call created no worktree, so its durable-reference row must close.
 *
 * The tool's input schema is `.strict()` and lists only `dryRun`, so a call that
 * carries the `dry_run` alias is refused before its handler runs and created nothing,
 * whatever the alias says. The only reachable real spawn is therefore `dryRun === false`
 * with no alias present, and it keeps its pin: a failure after `git worktree add` is
 * indistinguishable from a refusal, so reading an error as "nothing was created" would
 * release a pin over work that exists.
 */
function isWorktreeSpawnPreview(input: unknown): boolean {
  const value = asRecord(input);
  if (value === undefined) return false;
  if (value.dry_run !== undefined) return true;
  return value.dryRun !== false;
}

/** True only for the `start` sub-action. */
function isAgentSwarmStart(input: unknown): boolean {
  return agentSwarmOperation(input) === AGENT_SWARM_START_OPERATION;
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
 * `codex_run` records its `codexTaskId` under provider `codex`, whose closure route
 * asks the codex service that launched it: the id is invisible to the CLI process
 * listing, so no other provider could answer for it.
 * `agent_swarm_run`'s `start`, `delegate` and `parallel_delegate` record their swarm
 * id under provider `swarm`, whose closure route asks the swarm service that started
 * it. A read sub-action records nothing: it names a swarm this call did not start, so
 * a handle there would let one call's pin be released by another call's work.
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

  if (isCodexTaskTool(toolName)) {
    const codexTaskId = boundedString(structured.codexTaskId, 256);
    return codexTaskId === undefined ? undefined : { workspaceId, provider: 'codex', handleId: codexTaskId };
  }

  if (isAgentSwarmTool(toolName)) {
    // A `status`/`result`/`cancel`/`list` sub-action answers with a snapshot of a
    // swarm this call did not start, so its id is not this call's handle. An
    // operation nobody classified records nothing either: a snapshot is never
    // evidence of work this call started.
    if (toolName === 'agent_swarm_run' && !isAgentSwarmStart(input)) {
      return undefined;
    }
    // `agent_swarm_run` answers the snapshot itself; the delegate tools wrap it.
    const swarmId = boundedString(structured.swarmId, 256)
      ?? boundedString(structured.delegateId, 256)
      ?? boundedString(asRecord(structured.swarm)?.swarmId, 256);
    return swarmId === undefined ? undefined : { workspaceId, provider: 'swarm', handleId: swarmId };
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
