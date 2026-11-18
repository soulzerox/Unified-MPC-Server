import { appError, err, ok, type Result } from '@unified-mpc/domain';
import type { ListWorkspaceJournalRequest, WorkspaceJournalEntry } from '@unified-mpc/storage';

/**
 * The default and hard bound for one resume snapshot.
 *
 * Kept below the journal store's own list cap so the reader can ask for one row more
 * than the bound and prove `truncated` instead of inferring it from a clamped reply.
 */
export const WORKSPACE_RESUME_DEFAULT_LIMIT = 20;
export const WORKSPACE_RESUME_MAX_LIMIT = 100;

/** What the projection compares a row's inherited generation against. */
export interface WorkspaceResumeGoalScope {
  /** The goal that currently fences this workspace's mutations. */
  readonly goalId: string;
  /**
   * That goal's current generation, read from the mutation fence at snapshot time.
   * Rows admitted under an older generation of the same goal belong to an execution
   * that is over: whoever held them is gone, so their work must not read as current.
   */
  readonly executionGeneration: number;
}

/** What a session that was not there asks: what happened here, from where I stopped. */
export interface WorkspaceResumeRequest {
  readonly workspaceId: string;
  /**
   * Optional authoritative scope. Without it no row is judged superseded: only the
   * goal runtime knows which generation is current, and guessing from the window
   * would let a dead generation's newer row look like the live one.
   */
  readonly currentGoal?: WorkspaceResumeGoalScope;
  /** The `cursor` of the previous snapshot; rows at or below it are already read. */
  readonly afterSequence?: number;
  /**
   * Which end of the journal the window is taken from.
   *
   * `oldest` (the default) replays from `afterSequence` forward. `newest` starts at the
   * current end of the journal, which is what a session recovering work needs: the rows
   * that describe today, not the first rows ever recorded. The two cursors are not
   * interchangeable: `newest` with `afterSequence`, or `beforeSequence` without `newest`,
   * is refused rather than answered with the other direction.
   */
  readonly window?: 'oldest' | 'newest';
  /** With `window: 'newest'`: the `olderCursor` of the previous snapshot, for paging back. */
  readonly beforeSequence?: number;
  readonly limit?: number;
}

/** One journal row, projected into the vocabulary a resumed session reads. */
export interface WorkspaceResumeEvent {
  readonly sequence: number;
  readonly operationKind: string;
  readonly toolName?: string;
  readonly phase: WorkspaceJournalEntry['phase'];
  readonly status: WorkspaceJournalEntry['status'];
  readonly resultCode?: string;
  readonly summary?: string;
  readonly recordedAt: string;
  /**
   * The journal still holds this call open: its work may still be running.
   *
   * Judged for every row of the call, not only its `started` one: a handle-returning
   * call is open after its own `completed` row, and a window can begin between the
   * two rows.
   */
  readonly open: boolean;
  /**
   * The call was admitted under an older generation of the scope's goal, so its work
   * belongs to an execution that already ended. A superseded row is never `open`, even
   * when the journal still holds it open, and its generation is reported so a caller
   * can see why rather than treating a silent `open: false` as proof of completion.
   *
   * Only a call the window can judge is marked: a call whose correlated row fell
   * outside the window stays `false` and reads as unknown, not stale.
   */
  readonly superseded: boolean;
  /** Absent for work outside a goal and for calls the journal never correlated. */
  readonly goalId?: string;
  readonly executionGeneration?: number;
}

export interface WorkspaceResumeSnapshot {
  readonly workspaceId: string;
  readonly generatedAt: string;
  /**
   * The newest sequence in this window. Pass it back as `afterSequence` for the next
   * forward snapshot; a newest window is already at the journal end, so paging from here
   * returns nothing and `olderCursor` is the direction that has rows left.
   */
  readonly cursor: number;
  /**
   * Rows were left out of this window: the caller should ask again rather than assume it
   * saw everything. Which side they are on is the cursor field: `cursor` for a forward
   * window, `olderCursor` for a newest one.
   */
  readonly truncated: boolean;
  /**
   * With `window: 'newest'`: rows exist *before* this window, and this is the sequence to
   * pass as `beforeSequence` to read them. `null` when the window reached the journal
   * start, which is what tells a newest window apart from a truncated one.
   */
  readonly olderCursor: number | null;
  /** Oldest first, so a caller can replay them in order. */
  readonly events: readonly WorkspaceResumeEvent[];
  readonly openReferences: {
    /** Open calls inside this window, not across the whole journal. */
    readonly count: number;
    readonly latestSequence: number | null;
  };
}

/** The journal reads this module needs: the store's own list and its open-call rule. */
export interface WorkspaceResumeJournalReader {
  /** Rows for one workspace, ordered by `sequence` ascending, at most `limit` of them. */
  list(request: ListWorkspaceJournalRequest): readonly WorkspaceJournalEntry[];
  /**
   * Which of these call ids the journal still holds open. Asked for every call id in
   * the window, because whether a call ended depends on rows that may sit past the
   * cursor and on its kind: reading that from the window alone would call finished
   * work running, or running work finished.
   */
  openCallIds(request: { readonly workspaceId: string; readonly callIds: readonly string[] }): readonly string[];
}

export interface WorkspaceResumeSnapshotReader {
  /**
   * Async because the superseded judgement needs the goal's *current* generation, which
   * only the mutation fence can answer. A resolver that fails leaves every call unjudged
   * (unknown) instead of failing the snapshot: a resume must still be able to read.
   */
  read(request: WorkspaceResumeRequest): Promise<Result<WorkspaceResumeSnapshot>>;
}

/**
 * Read a bounded, resumable view of one workspace's journal.
 *
 * The reduction is the point: a caller gets "what happened since my cursor, bounded,
 * in order, plus how many of those calls are still open" from one call, and never
 * learns the row shape, the cursor arithmetic or the store's list cap. The journal is
 * workspace-scoped, so no snapshot can mix two workspaces.
 */
export function createWorkspaceResumeSnapshotReader(options: {
  readonly journal: WorkspaceResumeJournalReader;
  readonly now?: () => Date;
  /**
   * The workspace's current goal generation, read from the authoritative fence. Wired
   * once here so every caller of the projection judges staleness the same way.
   */
  readonly currentGoal?: (workspaceId: string) => Promise<WorkspaceResumeGoalScope | null>;
}): WorkspaceResumeSnapshotReader {
  return {
    async read(request): Promise<Result<WorkspaceResumeSnapshot>> {
      const workspaceId = request.workspaceId.trim();
      if (workspaceId.length === 0) {
        return err(appError('INVALID_INPUT', 'workspace_resume requires a workspaceId'));
      }
      const limit = request.limit ?? WORKSPACE_RESUME_DEFAULT_LIMIT;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > WORKSPACE_RESUME_MAX_LIMIT) {
        return err(appError('INVALID_INPUT', `workspace_resume limit must be an integer between 1 and ${WORKSPACE_RESUME_MAX_LIMIT}`));
      }
      const afterSequence = request.afterSequence ?? 0;
      if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
        return err(appError('INVALID_INPUT', 'workspace_resume afterSequence must be a non-negative integer'));
      }
      const beforeSequence = request.beforeSequence ?? 0;
      if (!Number.isSafeInteger(beforeSequence) || beforeSequence < 0) {
        return err(appError('INVALID_INPUT', 'workspace_resume beforeSequence must be a non-negative integer'));
      }
      const fromNewest = request.window === 'newest';
      if (fromNewest && afterSequence !== 0) {
        return err(appError('INVALID_INPUT', 'workspace_resume reads one direction at a time: newest does not take afterSequence'));
      }
      // Refused, not ignored: a backward cursor on a forward window would silently
      // answer a different question than the caller asked.
      if (!fromNewest && beforeSequence !== 0) {
        return err(appError('INVALID_INPUT', 'workspace_resume reads one direction at a time: beforeSequence requires window newest'));
      }

      // One row past the bound answers "is there more" without a second query.
      const rows = options.journal.list({
        workspaceId,
        ...(fromNewest
          ? { fromNewest: true, ...(beforeSequence === 0 ? {} : { beforeSequence }) }
          : (afterSequence === 0 ? {} : { afterSequence })),
        limit: limit + 1,
      });
      const truncated = rows.length > limit;
      // Both directions keep the rows the caller asked for: the oldest `limit` when
      // replaying forward, the newest `limit` when starting at the end. The extra probe
      // row is the one dropped, and it is what proves more rows exist on the far side.
      const included = truncated ? (fromNewest ? rows.slice(-limit) : rows.slice(0, limit)) : rows;
      const windowCallIds = [...new Set(included.map((row) => row.callId))];
      // One extra store read, and never a judgement from the window: whether a call is
      // open depends on rows the window may not hold (a completion past the cursor, a
      // `closure_code` written later) and on its kind.
      const openCallIds = windowCallIds.length === 0
        ? new Set<string>()
        : new Set(options.journal.openCallIds({ workspaceId, callIds: windowCallIds }));
      // One generation per call: a call's rows are the same admission, so the newest
      // correlated row speaks for it whichever phase the window happens to hold.
      const callGenerations = new Map<string, WorkspaceResumeGoalScope>();
      for (const entry of included) {
        if (entry.goalId === undefined || entry.executionGeneration === undefined) continue;
        const seen = callGenerations.get(entry.callId);
        if (seen === undefined || entry.executionGeneration > seen.executionGeneration) {
          callGenerations.set(entry.callId, { goalId: entry.goalId, executionGeneration: entry.executionGeneration });
        }
      }
      const supersededCallIds = new Set<string>();
      const scope = await resolveScope(request.currentGoal, options.currentGoal, workspaceId);
      if (scope !== null) {
        for (const [callId, correlation] of callGenerations) {
          if (correlation.goalId === scope.goalId && correlation.executionGeneration < scope.executionGeneration) {
            supersededCallIds.add(callId);
          }
        }
      }
      const events = included.map((entry) => toEvent(entry, openCallIds, supersededCallIds));
      // Counted per call, not per row, and superseded calls are dropped first: a dead
      // generation must not make `openReferences` claim the workspace still has live work.
      const standingOpenCallIds = new Set([...openCallIds].filter((callId) => !supersededCallIds.has(callId)));
      const openRows = included.filter((entry) => standingOpenCallIds.has(entry.callId));
      const openCallCount = standingOpenCallIds.size;
      const first = included.at(0);
      const last = included.at(-1);

      return ok({
        workspaceId,
        generatedAt: (options.now?.() ?? new Date()).toISOString(),
        cursor: last?.sequence ?? afterSequence,
        truncated,
        // Only a newest window can be truncated on its older side, and this is the
        // sequence that reaches those rows. An oldest window leaves it null so nothing
        // invites a backward read that would repeat the same rows.
        olderCursor: fromNewest && truncated && first !== undefined ? first.sequence : null,
        events,
        openReferences: {
          count: openCallCount,
          latestSequence: openRows.at(-1)?.sequence ?? null,
        },
      });
    },
  };
}

async function resolveScope(
  explicit: WorkspaceResumeGoalScope | undefined,
  resolver: ((workspaceId: string) => Promise<WorkspaceResumeGoalScope | null>) | undefined,
  workspaceId: string,
): Promise<WorkspaceResumeGoalScope | null> {
  if (explicit !== undefined) return explicit;
  if (resolver === undefined) return null;
  try {
    return await resolver(workspaceId);
  } catch {
    // Unjudged, not failed: a fence read that dies must not hide the journal from a
    // session that just lost its context. A missing scope only costs the superseded
    // marking, and callers still see each row's own generation.
    return null;
  }
}

function toEvent(
  entry: WorkspaceJournalEntry,
  openCallIds: ReadonlySet<string>,
  supersededCallIds: ReadonlySet<string>,
): WorkspaceResumeEvent {
  const superseded = supersededCallIds.has(entry.callId);
  return {
    sequence: entry.sequence,
    operationKind: entry.operationKind,
    ...(entry.toolName === undefined ? {} : { toolName: entry.toolName }),
    phase: entry.phase,
    status: entry.status,
    ...(entry.resultCode === undefined ? {} : { resultCode: entry.resultCode }),
    ...(entry.summary === undefined ? {} : { summary: entry.summary }),
    recordedAt: entry.recordedAt,
    // A superseded call is not open: its generation ended, so no caller can still
    // reach the work, and reporting it open is what makes a session wait or rerun.
    open: openCallIds.has(entry.callId) && !superseded,
    superseded,
    ...(entry.goalId === undefined ? {} : { goalId: entry.goalId }),
    ...(entry.executionGeneration === undefined ? {} : { executionGeneration: entry.executionGeneration }),
  };
}
