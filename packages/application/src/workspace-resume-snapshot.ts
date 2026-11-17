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

/** What a session that was not there asks: what happened here, from where I stopped. */
export interface WorkspaceResumeRequest {
  readonly workspaceId: string;
  /** The `cursor` of the previous snapshot; rows at or below it are already read. */
  readonly afterSequence?: number;
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
}

export interface WorkspaceResumeSnapshot {
  readonly workspaceId: string;
  readonly generatedAt: string;
  /** Pass back as `afterSequence` for the next snapshot. */
  readonly cursor: number;
  /** Rows exist beyond `cursor`: the caller should ask again rather than assume it saw all. */
  readonly truncated: boolean;
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
  read(request: WorkspaceResumeRequest): Result<WorkspaceResumeSnapshot>;
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
}): WorkspaceResumeSnapshotReader {
  return {
    read(request): Result<WorkspaceResumeSnapshot> {
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

      // One row past the bound answers "is there more" without a second query.
      const rows = options.journal.list({
        workspaceId,
        ...(afterSequence === 0 ? {} : { afterSequence }),
        limit: limit + 1,
      });
      const truncated = rows.length > limit;
      const included = truncated ? rows.slice(0, limit) : rows;
      const windowCallIds = [...new Set(included.map((row) => row.callId))];
      // One extra store read, and never a judgement from the window: whether a call is
      // open depends on rows the window may not hold (a completion past the cursor, a
      // `closure_code` written later) and on its kind.
      const openCallIds = windowCallIds.length === 0
        ? new Set<string>()
        : new Set(options.journal.openCallIds({ workspaceId, callIds: windowCallIds }));
      const events = included.map((entry) => toEvent(entry, openCallIds));
      const openRows = included.filter((entry) => openCallIds.has(entry.callId));
      const openCallCount = new Set(openRows.map((row) => row.callId)).size;
      const last = included.at(-1);

      return ok({
        workspaceId,
        generatedAt: (options.now?.() ?? new Date()).toISOString(),
        cursor: last?.sequence ?? afterSequence,
        truncated,
        events,
        openReferences: {
          count: openCallCount,
          latestSequence: openRows.at(-1)?.sequence ?? null,
        },
      });
    },
  };
}

function toEvent(entry: WorkspaceJournalEntry, openCallIds: ReadonlySet<string>): WorkspaceResumeEvent {
  return {
    sequence: entry.sequence,
    operationKind: entry.operationKind,
    ...(entry.toolName === undefined ? {} : { toolName: entry.toolName }),
    phase: entry.phase,
    status: entry.status,
    ...(entry.resultCode === undefined ? {} : { resultCode: entry.resultCode }),
    ...(entry.summary === undefined ? {} : { summary: entry.summary }),
    recordedAt: entry.recordedAt,
    open: openCallIds.has(entry.callId),
  };
}
