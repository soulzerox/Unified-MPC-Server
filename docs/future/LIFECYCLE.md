> **Future — not in v0.1.** The Lifecycle updater downloads, rebuilds, and hot-swaps code — a supply-chain surface deferred until a provenance policy and update-rollback tests exist. Required seams: UpdateSource (future-defined) + EventEnvelope (locked). Primary source preserved below. Status: docs/FUTURE.md entry 4.

# Lifecycle — Fire-and-Forget Update Daemon

## Purpose

Once installed, every resource (MCP server and skill) stays current with its upstream GitHub repository without user intervention. The hub itself also self-updates.

## Check cycle

**Frequency**: every `config.updateIntervalHours` hours (default: 6). Also triggered on demand via `POST /api/check-updates`.

**For each installed resource** (read from `config/servers.json` entries with `sourceUrl`):

1. Send `HEAD https://api.github.com/repos/:owner/:repo/commits/:branch` with header `If-None-Match: <stored_etag>`.

2. **304 Not Modified** — no change. Cost: zero GitHub rate limit tokens (conditional requests are free). Skip.

3. **200 OK** — upstream has new commits.
   - Extract the new commit SHA from the response body.
   - Extract the new ETag from the response header.
   - Queue an update job.

## Update job (server)

1. Download the new tarball to a temporary directory.
2. Run the build pipeline (same as installer: `pnpm install && pnpm build` or `uv sync`).
3. If build fails: log the error, emit `UPDATE_FAILED` WebSocket event, keep the old version running. Do not interrupt service.
4. If build succeeds:
   a. Unmount the old server process.
   b. Move the new build from temp to `data/servers/<id>/` (overwrite).
   c. Mount the new server process.
   d. Update `commitSha` and `etag` in `config/servers.json`.
   e. Emit `RESOURCE_UPDATED` WebSocket event with `{ id, oldSha, newSha }`.

Total downtime for the individual server: the time between unmount and mount (typically < 2 seconds). Other servers remain unaffected.

## Update job (skill)

1. Download the new tarball.
2. Validate the `SKILL.md` is still present and valid.
3. Overwrite `data/skills/<id>/` with the new content.
4. Re-register in the SkillRegistry (unregister + register).
5. Re-sync IDE files via IDESync.
6. Update `commitSha` and `etag`.
7. Emit `RESOURCE_UPDATED`.

No downtime — the skill is re-registered in memory instantly.

## Self-update

The hub checks its own source repository (configured as `config.hubSourceUrl` in `config/config.json`). When a new version is detected:

1. `git pull --ff-only` in the hub's own directory.
2. `pnpm install && pnpm build`.
3. If build succeeds: write a signal file `.update-ready` and emit `HUB_UPDATE_READY` WebSocket event. The supervisor (systemd, pm2, or the startup script) watches for this file and restarts the process.
4. If build fails: log the error, continue running the old version.

Self-update is opt-in: set `config.selfUpdate: true` in `config/config.json`.

## Rate limiting

GitHub API allows 60 unauthenticated requests/hour. With conditional requests (ETag), unchanged repos cost 0. Only changed repos cost 1 request.

For setups with many servers (>30), provide a GitHub Personal Access Token in `config.githubToken` to raise the limit to 5000/hour.

## WebSocket events

All lifecycle events are broadcast to connected dashboard clients:

| Event | Payload |
|---|---|
| `UPDATE_CHECK_START` | `{ totalResources: number }` |
| `UPDATE_CHECK_COMPLETE` | `{ checked, updated, failed }` |
| `RESOURCE_UPDATED` | `{ id, type, oldSha, newSha }` |
| `UPDATE_FAILED` | `{ id, type, error, stderr }` |
| `HUB_UPDATE_READY` | `{ newSha }` |

