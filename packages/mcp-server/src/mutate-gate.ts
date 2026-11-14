import { normalizeHarnessPath } from './harness-runtime.js';

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

/** Only the exact opt-in value is accepted; everything else is the default. */
export function parseMutateMode(value: unknown): MutateMode {
  return value === 'require_preparation' ? 'require_preparation' : DEFAULT_MUTATE_MODE;
}

export function workspaceMutateMode(profile: unknown): MutateMode {
  if (!isRecord(profile)) return DEFAULT_MUTATE_MODE;
  const gate = profile.workflowGate;
  if (!isRecord(gate)) return DEFAULT_MUTATE_MODE;
  return parseMutateMode(gate.mutate);
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
 * preparation to, so it is allowed. That is the honest limit of this phase and
 * not a claim about opaque mutations: `shell`, `git` and `restore_deleted_file`
 * never reach it, because `codeMutationPaths` returns nothing for them.
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
