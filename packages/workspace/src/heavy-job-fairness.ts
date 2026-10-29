/**
 * Cross-project fairness for the durable heavy-job queue (#145).
 *
 * Fairness is a selection policy, never a durable position change: the store
 * keeps FIFO positions as the audit order and restart fallback, while this
 * module decides which queued candidate a runtime should try first.
 *
 * Ordering rules, in order:
 * 1. blocking work first (existing #145 U12 promotion is not reordered across
 *    tiers), rotated by workspace inside the tier;
 * 2. aged work (`now - requestedAt >= agingMs`) FIFO, so no workspace can be
 *    starved by pathological admission denials;
 * 3. least-recently-served workspace first, rotating one candidate per
 *    workspace per pass so a burst cannot hold a single heavy slot.
 *
 * Rotation applies inside the blocking tier too: every current producer
 * (declared heavy `shell`, pre-edit gate) enqueues blocking work, so FIFO
 * among blocking jobs would leave cross-project fairness inert in production.
 * Blocking still always precedes aged and background work.
 *
 * The state is deliberately process-local: `lastServedAt` is a bounded map of
 * workspaces this runtime has actually admitted. After a restart it is empty,
 * so the first pick falls back to the oldest queued job and rotation resumes.
 */

/** One queued job as seen by the fairness policy. */
export interface HeavyJobFairnessCandidate {
  readonly operationId: string;
  readonly workspaceId: string;
  readonly requestedAt: string;
  readonly blocking: boolean;
  readonly position: number;
}

export interface HeavyJobFairnessContext {
  readonly now: number;
  /** Jobs waited at least this long jump ahead of the workspace rotation. */
  readonly agingMs: number;
  /** Last admission time per workspace; missing means never served here. */
  readonly lastServedAt: ReadonlyMap<string, number>;
}

const NEVER_SERVED = Number.NEGATIVE_INFINITY;

/**
 * Returns the operation ids in the order the caller should try them against the
 * admission controller. The controller remains the final authority; this only
 * changes candidate order.
 */
export function orderHeavyJobs(
  candidates: readonly HeavyJobFairnessCandidate[],
  context: HeavyJobFairnessContext,
): readonly string[] {
  if (!Number.isSafeInteger(context.agingMs) || context.agingMs < 1) {
    throw new RangeError('agingMs must be a positive safe integer');
  }

  const blocking = candidates.filter((candidate) => candidate.blocking);
  const nonBlocking = candidates.filter((candidate) => !candidate.blocking);
  const aged = nonBlocking
    .filter((candidate) => context.now - requestTime(candidate, context.now) >= context.agingMs)
    .sort((left, right) => compareFifo(left, right, context.now));
  const agedIds = new Set(aged.map((candidate) => candidate.operationId));
  const rotating = nonBlocking.filter((candidate) => !agedIds.has(candidate.operationId));

  return [
    ...rotateByWorkspace(blocking, context),
    ...aged.map((candidate) => candidate.operationId),
    ...rotateByWorkspace(rotating, context),
  ];
}

/**
 * One candidate per workspace per pass, choosing the least-recently-served
 * workspace first. A workspace that was already selected in this pass moves
 * behind every other workspace with candidates, so a cap above one still
 * alternates instead of draining one workspace's rows inside a single drain().
 */
function rotateByWorkspace(
  candidates: readonly HeavyJobFairnessCandidate[],
  context: HeavyJobFairnessContext,
): readonly string[] {
  const groups = new Map<string, HeavyJobFairnessCandidate[]>();
  for (const candidate of candidates) {
    const existing = groups.get(candidate.workspaceId);
    if (existing === undefined) groups.set(candidate.workspaceId, [candidate]);
    else existing.push(candidate);
  }
  const batches = [...groups.entries()]
    .map(([workspaceId, entries]) => ({
      workspaceId,
      entries: entries.sort((left, right) => compareFifo(left, right, context.now)),
    }))
    .sort((left, right) => {
      const leftServed = servedAt(context.lastServedAt, left.workspaceId);
      const rightServed = servedAt(context.lastServedAt, right.workspaceId);
      if (leftServed !== rightServed) return leftServed - rightServed;
      const byHead = compareFifo(left.entries[0]!, right.entries[0]!, context.now);
      if (byHead !== 0) return byHead;
      return compareIds(left.workspaceId, right.workspaceId);
    });

  const ordered: string[] = [];
  while (batches.length > 0) {
    const batch = batches.shift()!;
    const next = batch.entries.shift()!;
    ordered.push(next.operationId);
    if (batch.entries.length > 0) batches.push(batch);
  }
  return ordered;
}

/** Unparseable request times are treated as recent instead of aged. */
function requestTime(candidate: HeavyJobFairnessCandidate, now: number): number {
  const parsed = Date.parse(candidate.requestedAt);
  return Number.isFinite(parsed) ? parsed : now;
}

function compareFifo(
  left: HeavyJobFairnessCandidate,
  right: HeavyJobFairnessCandidate,
  now: number,
): number {
  const byTime = requestTime(left, now) - requestTime(right, now);
  if (byTime !== 0) return byTime;
  if (left.position !== right.position) return left.position - right.position;
  return compareIds(left.operationId, right.operationId);
}

/** Codepoint comparison keeps ordering identical across locales and hosts. */
function compareIds(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function servedAt(lastServedAt: ReadonlyMap<string, number>, workspaceId: string): number {
  const served = lastServedAt.get(workspaceId);
  return served === undefined || Number.isNaN(served) ? NEVER_SERVED : served;
}
