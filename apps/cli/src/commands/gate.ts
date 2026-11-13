import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { appError, err, ok, type Result } from '@unified-mpc/domain';
import type { GoalCompletionWorktreeBlocker } from '@unified-mpc/application';
import type { WorkspaceLifecycleCleanupEvaluation } from '@unified-mpc/workspace';

/**
 * The `close` phase of the workflow gate engine (#142).
 *
 * Three existing decisions already answer whether a goal may be closed; this
 * module composes them into one verdict and one durable receipt. It re-derives
 * no policy:
 *
 * - `WorkspaceService.evaluateGoalWorkspaceCleanup` owns workspace disposition
 *   (`blocked` | `retention_pending` | `retention_candidate`).
 * - the `git_worktree_remove` dry run owns worktree safety per path
 *   (`clean` | `blocked` | `unavailable`).
 * - `goalCompletionWorktreeBlockers` owns goal-completion blockers
 *   (`dirty` | `unmerged_changes` | `probe_failed`).
 *
 * The caller supplies those answers; this module only decides. That is why it
 * needs no runtime, no database and no tool registry, and why the wiring lives
 * next to the other CLI API methods instead of inside a command.
 */

/** Worktree safety as the `git_worktree_remove` dry run reports it. */
export interface CloseGateRemovalPreview {
  readonly worktreePath: string;
  readonly status: 'clean' | 'blocked' | 'unavailable';
  /** Machine-readable blocker names, non-empty only when `status` is not `clean`. */
  readonly blockers: readonly string[];
  /** Operator-facing detail per blocker; may be empty when the tool has none. */
  readonly blockerDetails: readonly string[];
}

export interface CloseGateInput {
  readonly workspaceId: string;
  readonly goalId?: string;
  /** Every cleanup evaluation the caller could produce; rows for other goals are ignored. */
  readonly cleanup: readonly WorkspaceLifecycleCleanupEvaluation[];
  readonly removals: readonly CloseGateRemovalPreview[];
  readonly completion: readonly GoalCompletionWorktreeBlocker[];
}

export type CloseGateBlocker =
  | {
    readonly kind: 'cleanup';
    readonly workspaceId: string;
    readonly disposition: WorkspaceLifecycleCleanupEvaluation['disposition'];
    readonly reasons: readonly string[];
  }
  | {
    readonly kind: 'cleanup_unclassified';
    readonly workspaceId: string;
  }
  | {
    readonly kind: 'removal';
    readonly worktreePath: string;
    readonly status: 'blocked' | 'unavailable';
    readonly blockers: readonly string[];
  }
  | {
    readonly kind: 'completion';
    readonly worktreePath: string;
    readonly blockers: readonly string[];
  };

export interface CloseGateVerdict {
  readonly phase: 'close';
  readonly workspaceId: string;
  readonly goalId?: string;
  /** `true` only when every input is classified and none of them refuses. */
  readonly allowed: boolean;
  readonly blockers: readonly CloseGateBlocker[];
  /** Stable hash of the decision-relevant inputs; a receipt binds to it. */
  readonly fingerprint: string;
}

/**
 * Decides the `close` phase from already-computed inputs.
 *
 * Every refusal is a reason the operator can act on. An input this module cannot
 * classify refuses rather than passing: `retention_pending` means cleanup is
 * still waiting out its grace window, `unavailable` means the tool could not
 * verify safety, and a goal with no matching cleanup row has not been classified
 * at all. A `retention_candidate`, a `clean` worktree and an empty completion
 * blocker list are the only passing answers.
 */
export function evaluateCloseGate(input: CloseGateInput): CloseGateVerdict {
  const blockers: CloseGateBlocker[] = [];

  const evaluations = input.cleanup.filter((evaluation) =>
    evaluation.workspaceId === input.workspaceId
    && (input.goalId === undefined ? true : evaluation.goalId === input.goalId),
  );
  if (evaluations.length === 0) {
    blockers.push({ kind: 'cleanup_unclassified', workspaceId: input.workspaceId });
  }
  for (const evaluation of evaluations) {
    if (evaluation.disposition === 'retention_candidate') continue;
    blockers.push({
      kind: 'cleanup',
      workspaceId: evaluation.workspaceId,
      disposition: evaluation.disposition,
      reasons: evaluation.blockers,
    });
  }

  for (const removal of input.removals) {
    if (removal.status === 'clean') continue;
    blockers.push({
      kind: 'removal',
      worktreePath: removal.worktreePath,
      status: removal.status,
      blockers: removal.blockers,
    });
  }

  for (const entry of input.completion) {
    // `goalCompletionWorktreeBlockers` already dropped non-blocking entries, so
    // a row that survives it is a refusal even when its blocker list is empty.
    blockers.push({ kind: 'completion', worktreePath: entry.worktreePath, blockers: entry.blockers });
  }

  return {
    phase: 'close',
    workspaceId: input.workspaceId,
    ...(input.goalId === undefined ? {} : { goalId: input.goalId }),
    allowed: blockers.length === 0,
    blockers,
    fingerprint: closeGateFingerprint(input, evaluations),
  };
}

/**
 * Canonical, decision-relevant projection of the inputs.
 *
 * `evaluations` is the filtered set the verdict actually used, not every row the
 * caller produced: an unrelated goal's cleanup state changing must not invalidate
 * a receipt that describes this goal.
 */
function closeGateFingerprint(
  input: CloseGateInput,
  evaluations: readonly WorkspaceLifecycleCleanupEvaluation[],
): string {
  const canonical = JSON.stringify({
    phase: 'close',
    workspaceId: input.workspaceId,
    goalId: input.goalId ?? null,
    cleanup: evaluations
      .map((evaluation) => ({
        workspaceId: evaluation.workspaceId,
        goalId: evaluation.goalId ?? null,
        disposition: evaluation.disposition,
        blockers: [...evaluation.blockers].sort(),
      }))
      .sort((left, right) => (left.goalId ?? '').localeCompare(right.goalId ?? '')
        || left.workspaceId.localeCompare(right.workspaceId)),
    removals: input.removals
      .map((removal) => ({
        worktreePath: removal.worktreePath,
        status: removal.status,
        blockers: [...removal.blockers].sort(),
      }))
      .sort((left, right) => left.worktreePath.localeCompare(right.worktreePath)),
    completion: input.completion
      .map((entry) => ({ worktreePath: entry.worktreePath, blockers: [...entry.blockers].sort() }))
      .sort((left, right) => left.worktreePath.localeCompare(right.worktreePath)),
  });
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

export interface CloseGateReceipt {
  readonly kind: 'workflow-gate';
  readonly phase: 'close';
  readonly version: 1;
  readonly gateId: string;
  readonly createdAt: string;
  /** `HEAD` the gate was asked about, when the caller knows it. */
  readonly headSha?: string;
  readonly verdict: CloseGateVerdict;
}

/**
 * Writes the verdict as one file named after its subject and a fresh gate id, so
 * two runs never overwrite each other. The fingerprint is inside the receipt
 * rather than in the name: it describes the inputs, and a caller that wants to
 * match evidence to state reads it rather than parsing a filename.
 */
export async function writeCloseGateReceipt(options: {
  readonly directory: string;
  readonly verdict: CloseGateVerdict;
  readonly now?: () => Date;
  readonly gateId?: () => string;
  readonly headSha?: string;
}): Promise<Result<{ readonly path: string; readonly receipt: CloseGateReceipt }>> {
  const receipt: CloseGateReceipt = {
    kind: 'workflow-gate',
    phase: 'close',
    version: 1,
    gateId: (options.gateId ?? randomUUID)(),
    createdAt: (options.now ?? ((): Date => new Date()))().toISOString(),
    ...(options.headSha === undefined ? {} : { headSha: options.headSha }),
    verdict: options.verdict,
  };
  const subject = receipt.verdict.goalId ?? receipt.verdict.workspaceId;
  const file = path.join(options.directory, `${safeSegment(subject)}-${receipt.gateId}.json`);
  try {
    await mkdir(options.directory, { recursive: true });
    await writeFile(file, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  } catch (cause) {
    return err(appError('INTERNAL_ERROR', `Could not write the close gate receipt: ${(cause as Error).message}`));
  }
  return ok({ path: file, receipt });
}

/** Reads one receipt back. A file that is not a close gate receipt is refused. */
export async function readCloseGateReceipt(file: string): Promise<Result<CloseGateReceipt>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch (cause) {
    return err(appError('INVALID_INPUT', `Could not read ${file}: ${(cause as Error).message}`));
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return err(appError('INVALID_INPUT', `${file} is not a close gate receipt`));
  }
  const receipt = parsed as Partial<CloseGateReceipt>;
  const verdict = receipt.verdict;
  if (receipt.kind !== 'workflow-gate' || receipt.phase !== 'close' || receipt.version !== 1
    || typeof receipt.gateId !== 'string' || typeof receipt.createdAt !== 'string'
    || typeof verdict !== 'object' || verdict === null
    || typeof verdict.fingerprint !== 'string' || typeof verdict.allowed !== 'boolean'
    || typeof verdict.workspaceId !== 'string' || !Array.isArray(verdict.blockers)) {
    return err(appError('INVALID_INPUT', `${file} is not a close gate receipt`));
  }
  return ok(receipt as CloseGateReceipt);
}

/** Keeps an identifier usable as a filename segment without inventing a hash. */
function safeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, '_');
  return cleaned.length === 0 ? 'gate' : cleaned.slice(0, 96);
}

/** Operator-facing lines; `--json` prints the verdict itself instead. */
export function formatCloseGateVerdict(verdict: CloseGateVerdict): readonly string[] {
  const subject = verdict.goalId === undefined ? `workspace ${verdict.workspaceId}` : `goal ${verdict.goalId}`;
  if (verdict.allowed) return [`close gate for ${subject}: allowed`, `fingerprint ${verdict.fingerprint}`];
  const lines = [`close gate for ${subject}: refused (${verdict.blockers.length} blocker${verdict.blockers.length === 1 ? '' : 's'})`];
  for (const blocker of verdict.blockers) {
    lines.push(describeBlocker(blocker));
  }
  lines.push(`fingerprint ${verdict.fingerprint}`);
  return lines;
}

function describeBlocker(blocker: CloseGateBlocker): string {
  switch (blocker.kind) {
    case 'cleanup':
      return `  workspace ${blocker.workspaceId} is ${blocker.disposition}${blocker.reasons.length === 0 ? '' : ` (${blocker.reasons.join(', ')})`}`;
    case 'cleanup_unclassified':
      return `  workspace ${blocker.workspaceId} has no cleanup evaluation for this goal`;
    case 'removal':
      return `  worktree ${blocker.worktreePath} removal is ${blocker.status}${blocker.blockers.length === 0 ? '' : ` (${blocker.blockers.join(', ')})`}`;
    case 'completion':
      return `  worktree ${blocker.worktreePath} still holds work${blocker.blockers.length === 0 ? '' : ` (${blocker.blockers.join(', ')})`}`;
  }
}

/** `0` when the phase may proceed, `1` when it refuses. */
export function closeGateExitCode(verdict: CloseGateVerdict): number {
  return verdict.allowed ? 0 : 1;
}

export interface GateCheckCommand {
  readonly kind: 'gate-check';
  readonly phase: 'close';
  readonly workspaceId: string;
  readonly goalId?: string;
  readonly worktrees: readonly string[];
  readonly json: boolean;
  readonly dryRun: boolean;
}

const GATE_USAGE = 'Usage: unified-mpc gate check --phase close --workspace <id>'
  + ' [--goal <id>] [--worktree <path>]... [--json] [--dry-run]';

/**
 * Parses `gate check`. The phase is required rather than defaulted: this engine
 * grows one phase at a time and a missing phase must not silently pick one.
 */
export function parseGateArgs(args: readonly string[]): Result<GateCheckCommand> {
  if (args[0] !== 'check') return err(appError('INVALID_INPUT', GATE_USAGE));

  let phase: string | undefined;
  let workspaceId: string | undefined;
  let goalId: string | undefined;
  let json = false;
  let dryRun = false;
  const worktrees: string[] = [];

  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    const value = (): string | undefined => args[index + 1];
    switch (argument) {
      case '--phase':
        if (phase !== undefined || value() === undefined) return err(appError('INVALID_INPUT', GATE_USAGE));
        phase = value();
        index += 1;
        break;
      case '--workspace':
        if (workspaceId !== undefined || value() === undefined) return err(appError('INVALID_INPUT', GATE_USAGE));
        workspaceId = value();
        index += 1;
        break;
      case '--goal':
        if (goalId !== undefined || value() === undefined) return err(appError('INVALID_INPUT', GATE_USAGE));
        goalId = value();
        index += 1;
        break;
      case '--worktree':
        if (value() === undefined) return err(appError('INVALID_INPUT', GATE_USAGE));
        worktrees.push(value()!);
        index += 1;
        break;
      case '--json':
        if (json) return err(appError('INVALID_INPUT', GATE_USAGE));
        json = true;
        break;
      case '--dry-run':
        if (dryRun) return err(appError('INVALID_INPUT', GATE_USAGE));
        dryRun = true;
        break;
      default:
        return err(appError('INVALID_INPUT', GATE_USAGE));
    }
  }

  if (phase !== 'close') {
    return err(appError('INVALID_INPUT', phase === undefined ? GATE_USAGE : `Unknown gate phase: ${phase}`));
  }
  if (workspaceId === undefined) return err(appError('INVALID_INPUT', GATE_USAGE));

  return ok({
    kind: 'gate-check',
    phase,
    workspaceId,
    ...(goalId === undefined ? {} : { goalId }),
    worktrees,
    json,
    dryRun,
  });
}
