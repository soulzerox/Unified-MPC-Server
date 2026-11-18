/**
 * Goal-generation correlation for the workspace journal (issue #170, stale-generation step).
 *
 * A journal row says work happened; it does not say which execution generation
 * started it. Without that a resumed session reads a dead generation's `started`
 * row as current work and either waits on it or reruns it. These columns keep the
 * correlation the task metadata already records, so the resume projection can say
 * "this belongs to generation 4, the goal is on 6" instead of comparing the row
 * with whatever generation happens to be current by then.
 *
 * Both are nullable on purpose: work started outside a goal has no generation, and
 * a row whose admission never reached the journal must read as "unknown", never as
 * a default generation.
 */
export const WORKSPACE_JOURNAL_GOAL_CORRELATION_MIGRATION_SQL = `
ALTER TABLE workspace_journal_events
  ADD COLUMN goal_id TEXT CHECK (goal_id IS NULL OR length(goal_id) BETWEEN 1 AND 128);
ALTER TABLE workspace_journal_events
  ADD COLUMN execution_generation INTEGER CHECK (execution_generation IS NULL OR execution_generation >= 1);
CREATE INDEX IF NOT EXISTS idx_workspace_journal_goal_generation
  ON workspace_journal_events(workspace_id, goal_id, execution_generation);
`;
