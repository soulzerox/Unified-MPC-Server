#!/usr/bin/env node
/* global process */
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Report whether a workspace's *active* Native Thai-RAG generation is complete.
 *
 * `#438` acceptance is "the pre-edit gate serves evidence again", and the gate
 * only serves a generation whose channels were published as healthy. A
 * generation can be `active` while a channel is `degraded`/`missing` (the
 * vector channel is the usual one), and an abandoned/staging-only workspace has
 * no baseline at all, which is exactly the state that keeps the gate shut
 * (`#445`). Reading it out of `local_context.db` was ad-hoc SQL until now.
 *
 * Read-only by construction: the database is opened with `readOnly`, so this is
 * safe against a live runtime that is mid-build.
 */

export const REQUIRED_CHANNELS = ['parent', 'lexical', 'structural', 'vector'];

export function defaultDatabasePath(environment = process.env, home = os.homedir()) {
  const xdgDataHome = environment.XDG_DATA_HOME?.trim();
  const dataHome = xdgDataHome === undefined || xdgDataHome.length === 0 ? path.join(home, '.local', 'share') : xdgDataHome;
  return path.join(dataHome, 'unified-mpc', 'thai-rag', 'runtime', 'local_context.db');
}

export function readGenerationHealth(databasePath, workspaceIds) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const workspaces = workspaceIds === undefined || workspaceIds.length === 0
      ? database.prepare('SELECT DISTINCT workspace_id FROM index_generations ORDER BY workspace_id').all().map((row) => String(row.workspace_id))
      : workspaceIds;
    return workspaces.map((workspaceId) => readWorkspaceHealth(database, workspaceId));
  } finally {
    database.close();
  }
}

function readWorkspaceHealth(database, workspaceId) {
  const active = database
    .prepare("SELECT generation_id, activated_at FROM index_generations WHERE workspace_id = ? AND status = 'active' LIMIT 1")
    .get(workspaceId);
  if (active === undefined) {
    const known = database
      .prepare('SELECT COUNT(*) AS total FROM index_generations WHERE workspace_id = ?')
      .get(workspaceId);
    return {
      workspaceId,
      generationId: undefined,
      activatedAt: undefined,
      channels: [],
      violations: Number(known?.total ?? 0) === 0
        ? [{ kind: 'no-generations', detail: 'no index generation has ever been recorded for this workspace' }]
        : [{ kind: 'no-active-generation', detail: 'generations exist but none is active' }],
    };
  }
  const generationId = String(active.generation_id);
  const channels = database
    .prepare('SELECT channel, state, detail FROM index_generation_channels WHERE generation_id = ? ORDER BY channel')
    .all(generationId)
    .map((row) => ({
      channel: String(row.channel),
      state: String(row.state),
      ...(row.detail === null || row.detail === undefined ? {} : { detail: String(row.detail) }),
    }));
  const violations = [];
  for (const channel of REQUIRED_CHANNELS) {
    const recorded = channels.find((entry) => entry.channel === channel);
    if (recorded === undefined) {
      violations.push({ kind: 'missing-channel', detail: `channel ${channel} was never published` });
    } else if (recorded.state !== 'ok') {
      violations.push({
        kind: 'unhealthy-channel',
        detail: `channel ${channel} is ${recorded.state}${recorded.detail === undefined ? '' : ` (${recorded.detail})`}`,
      });
    }
  }
  return {
    workspaceId,
    generationId,
    activatedAt: active.activated_at === null || active.activated_at === undefined ? undefined : String(active.activated_at),
    channels,
    violations,
  };
}

function argumentValues(name) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === name && process.argv[index + 1] !== undefined) values.push(process.argv[index + 1]);
  }
  return values;
}

function argumentValue(name) {
  return argumentValues(name)[0];
}

const invokedPath = process.argv[1] === undefined ? undefined : path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  const databasePath = path.resolve(argumentValue('--db') ?? defaultDatabasePath());
  if (!existsSync(databasePath)) {
    process.stderr.write(`Native Thai-RAG database not found: ${databasePath}\n`);
    process.exit(2);
  }
  const workspaceIds = argumentValues('--workspace');
  const report = readGenerationHealth(databasePath, workspaceIds.length === 0 ? undefined : workspaceIds);
  const failing = report.filter((workspace) => workspace.violations.length > 0);
  for (const workspace of report) {
    if (workspace.generationId === undefined) {
      process.stdout.write(`${workspace.workspaceId}: no active generation\n`);
    } else {
      const channelSummary = REQUIRED_CHANNELS
        .map((channel) => `${channel}=${workspace.channels.find((entry) => entry.channel === channel)?.state ?? 'absent'}`)
        .join(' ');
      process.stdout.write(
        `${workspace.workspaceId}: generation ${workspace.generationId} active since ${workspace.activatedAt ?? 'unknown'} ${channelSummary}\n`,
      );
    }
    for (const violation of workspace.violations) process.stdout.write(`  - ${violation.kind}: ${violation.detail}\n`);
  }
  if (failing.length === 0) {
    process.stdout.write(`Native Thai-RAG generation health passed for ${report.length} workspace(s).\n`);
  } else {
    process.stderr.write(
      `Native Thai-RAG generation health failed for ${failing.length} of ${report.length} workspace(s). `
      + 'The pre-edit gate cannot serve evidence from a generation without every published channel healthy.\n',
    );
    process.exitCode = 1;
  }
}
