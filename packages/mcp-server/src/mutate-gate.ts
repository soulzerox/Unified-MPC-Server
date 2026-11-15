import { normalizeHarnessPath, type OpaqueMutationReason } from './harness-runtime.js';

/**
 * The `mutate` phase of the workflow gate (#142, step 5).
 *
 * `ToolRegistry.validateHarnessMutation` is the only seam every MCP code
 * mutation passes through, so it is where the phase belongs. Today that seam
 * auto-bootstraps the harness and auto-prepares each path: the mutation is
 * allowed because the host did the preparation on the caller's behalf. That is
 * convenient and it is not a gate — the evidence is manufactured by the same
 * call it authorizes, so it can never be missing.
 *
 * This module owns the decision for the opt-in mode where the evidence has to
 * exist first. It is pure: the registry supplies what the ledger and the
 * harness hold, and gets back a decision it must act on. Nothing here reads a
 * file, a clock or a workspace.
 *
 * `auto_prepare` is the default and means "allowed": the caller is not opting
 * into the phase, and the registry keeps its current behaviour. A workspace
 * opts in from `.unified-mpc/project-profile.json`:
 *
 * ```json
 * { "workflowGate": { "mutate": "require_preparation" } }
 * ```
 *
 * Everything that is not exactly `require_preparation` — a missing profile, an
 * unreadable one, invalid JSON, an unknown value — resolves to the default, so a
 * broken profile cannot silently tighten the gate either. Opting in is an act,
 * not an accident.
 */
export type MutateMode = 'auto_prepare' | 'require_preparation';

export const DEFAULT_MUTATE_MODE: MutateMode = 'auto_prepare';

/**
 * What the opt-in phase does with a mutation whose subject is opaque, i.e. one
 * that names no path a preparation could bind to. `allow` keeps the mutation —
 * the phase admits it and records that it did; `refuse` makes the phase honest
 * about its own reach and refuses what it cannot gate.
 *
 * The default is `allow` for the same reason `mutate` defaults to
 * `auto_prepare`: a workspace that has not chosen the strict posture keeps
 * working. The policy is a setting *of* the phase, so it only takes effect in
 * `require_preparation` mode — `mutateOpaque: 'refuse'` in a workspace that
 * never turned the phase on is a setting nobody consulted, not a second gate.
 */
export type OpaqueMutatePolicy = 'allow' | 'refuse';

export const DEFAULT_OPAQUE_MUTATE_POLICY: OpaqueMutatePolicy = 'allow';

/** Only the exact opt-in value is accepted; everything else is the default. */
export function parseMutateMode(value: unknown): MutateMode {
  return value === 'require_preparation' ? 'require_preparation' : DEFAULT_MUTATE_MODE;
}

export function parseOpaqueMutatePolicy(value: unknown): OpaqueMutatePolicy {
  return value === 'refuse' ? 'refuse' : DEFAULT_OPAQUE_MUTATE_POLICY;
}

export interface WorkspaceWorkflowGate {
  readonly mutate: MutateMode;
  readonly mutateOpaque: OpaqueMutatePolicy;
}

/**
 * Both settings come from one profile read, so the two can never be resolved
 * from two different versions of the file.
 */
export function workspaceWorkflowGate(profile: unknown): WorkspaceWorkflowGate {
  if (!isRecord(profile)) return { mutate: DEFAULT_MUTATE_MODE, mutateOpaque: DEFAULT_OPAQUE_MUTATE_POLICY };
  const gate = profile.workflowGate;
  if (!isRecord(gate)) return { mutate: DEFAULT_MUTATE_MODE, mutateOpaque: DEFAULT_OPAQUE_MUTATE_POLICY };
  return { mutate: parseMutateMode(gate.mutate), mutateOpaque: parseOpaqueMutatePolicy(gate.mutateOpaque) };
}

export type MutateHarnessState = 'active' | 'inactive' | 'stale';

export type MutateBlockerCode = 'harness_inactive' | 'harness_stale' | 'preparation_missing';

export interface MutateBlocker {
  readonly code: MutateBlockerCode;
  /** Present for `preparation_missing`: the path that has no preparation. */
  readonly path?: string;
}

export interface MutateGateRequest {
  readonly mode: MutateMode;
  readonly harness: MutateHarnessState;
  /** Development artifact paths the mutation names, in caller order. */
  readonly paths: readonly string[];
  /** The subset of `paths` the ledger currently holds a preparation for. */
  readonly preparedPaths: readonly string[];
}

export type MutateGateDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly blockers: readonly MutateBlocker[] };

/**
 * `require_preparation` allows a mutation only when the harness is active,
 * current, and every path it names already has a preparation. Staleness is its
 * own blocker because the fix is different: an inactive harness needs
 * `workspace_bootstrap`, a stale one needs bootstrap again, and a missing
 * preparation needs `prepare_code_change` for that path.
 *
 * A mutation that names no development artifact path has nothing to bind a
 * preparation to, so it is allowed. That is the honest limit of this decision,
 * which decides paths and nothing else: an opaque mutation — a command, a
 * scheduled task, a recording — reaches the same seam since step 5b-2, but never
 * arrives here as a path: the registry asks `evaluateOpaqueMutateGate` for the
 * subjects it cannot see. Since step 5b-1 the restore tools do arrive here — the
 * caller resolves their subject through `mutation-subject.ts` before asking this
 * decision.
 */
export function evaluateMutateGate(request: MutateGateRequest): MutateGateDecision {
  if (request.mode === 'auto_prepare') return { allowed: true };

  const blockers: MutateBlocker[] = [];
  if (request.harness === 'inactive') blockers.push({ code: 'harness_inactive' });
  else if (request.harness === 'stale') blockers.push({ code: 'harness_stale' });

  const prepared = new Set(request.preparedPaths.map(normalizeHarnessPath));
  const seen = new Set<string>();
  for (const path of request.paths) {
    const normalized = normalizeHarnessPath(path);
    if (prepared.has(normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    blockers.push({ code: 'preparation_missing', path });
  }

  return blockers.length === 0 ? { allowed: true } : { allowed: false, blockers };
}

/**
 * One sentence the caller can act on. The registry returns it verbatim under
 * CONFLICT, so it names the tool that fixes the blocker rather than the
 * internal code.
 */
export function describeMutateBlockers(blockers: readonly MutateBlocker[]): string {
  const missing = blockers
    .filter((blocker) => blocker.code === 'preparation_missing')
    .map((blocker) => blocker.path)
    .filter((path): path is string => path !== undefined);

  if (blockers.some((blocker) => blocker.code === 'harness_inactive')) {
    return 'Run workspace_bootstrap before mutating this workspace: the mutate phase requires an active engineering harness';
  }
  if (blockers.some((blocker) => blocker.code === 'harness_stale')) {
    return 'The workspace harness changed; run workspace_bootstrap and prepare_code_change again before mutating this workspace';
  }
  const shown = missing.slice(0, 5).join(', ');
  const suffix = missing.length > 5 ? ` and ${String(missing.length - 5)} more` : '';
  return `Run prepare_code_change for ${shown}${suffix} against the current workspace state before mutating; this workspace requires prepared evidence rather than automatic preparation`;
}

export interface OpaqueMutateRequest {
  readonly policy: OpaqueMutatePolicy;
  readonly reason: OpaqueMutationReason;
}

export type OpaqueMutateDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: 'opaque_mutation'; readonly reason: OpaqueMutationReason };

/**
 * The residue of step 5b-1: a mutation that names no path, not even through a
 * store. There is nothing here for a preparation to bind to, so the only honest
 * decisions are "admit it and say so" and "refuse it". There is deliberately no
 * third option that reads paths out of a command: `bash -c`, globs and
 * `node -e` would all satisfy any parser and none of them would mean what the
 * gate claims, so a classifier here would be a coverage claim, not coverage.
 */
export function evaluateOpaqueMutateGate(request: OpaqueMutateRequest): OpaqueMutateDecision {
  return request.policy === 'refuse'
    ? { allowed: false, code: 'opaque_mutation', reason: request.reason }
    : { allowed: true };
}

/**
 * One sentence for the refusal. It says what the tool did, why that leaves
 * nothing to prepare, and the ways out, because the strict posture is surprising
 * by construction: it refuses every mutation the phase cannot turn into a path,
 * not just an edit whose preparation is missing.
 *
 * Relaxing the setting is the one way out that always exists, so the shape
 * message names it first. The second is per reason, because the faults are
 * different. A mutation refused for its shape was refused because the phase
 * cannot name its artifact, and a path-bearing form is a real way out only where
 * such a form exists: a task, a recording, a push, a merge or a stop has none, so
 * the sentence offers the form as a condition to meet rather than a tool to
 * switch to. An unresolvable stored subject is a lookup that could not answer for
 * an id the caller supplied, so switching tools would abandon the restore rather
 * than fix it: there the way out is to name a subject this workspace can resolve,
 * and the setting is named after it.
 */
export function describeOpaqueMutateRefusal(toolName: string, reason: OpaqueMutationReason): string {
  const subject = reason === 'shape'
    ? `${toolName} does not name a file the phase can turn into a preparation`
    : `${toolName} names a stored subject this workspace cannot resolve, so it names no file a preparation could bind to`;
  const wayOut = reason === 'shape'
    ? 'set workflowGate.mutateOpaque back to allow, or, if the change has a form whose request names the file it writes, express it that way and prepare_code_change that file'
    : 'name a subject this workspace can resolve, or set workflowGate.mutateOpaque back to allow';
  return `${subject}. This workspace refuses mutations it cannot gate (workflowGate.mutateOpaque is refuse); ${wayOut}`;
}

/**
 * The audit note for an admitted opaque mutation. It is written to the call's
 * durable record only in the opt-in mode, where "the phase saw this and let it
 * through without evidence" is a decision worth keeping.
 */
export function describeOpaqueMutateAdmission(toolName: string, reason: OpaqueMutationReason): string {
  return `mutate: admitted ${toolName} with an opaque ${reason} subject and no prepared path (workflowGate.mutateOpaque is allow)`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
