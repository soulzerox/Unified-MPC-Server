export const AGENT_SWARM_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS agent_swarms (
  id TEXT PRIMARY KEY NOT NULL,
  owner_client_id TEXT NOT NULL,
  owner_session_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  max_concurrency INTEGER NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_client_id, owner_session_id, workspace_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS agent_swarm_tasks (
  swarm_id TEXT NOT NULL REFERENCES agent_swarms(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  prompt_digest TEXT NOT NULL,
  prompt_length INTEGER NOT NULL,
  depends_on_json TEXT NOT NULL,
  state TEXT NOT NULL,
  codex_task_id TEXT,
  result_text TEXT NOT NULL DEFAULT '',
  output_truncated INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  PRIMARY KEY(swarm_id, task_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_swarms_owner_workspace ON agent_swarms(owner_client_id, owner_session_id, workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_swarm_tasks_state ON agent_swarm_tasks(swarm_id, state);
`;
