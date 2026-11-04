# Unified-MPC CLI Reference Manual

The `unified-mpc` command-line interface provides comprehensive control over the server, dynamic ingestion, policy synchronization, and tool execution.

```bash
# Usage
unified-mpc <command> [subcommand] [flags]
```

---

## 1. System Commands

### `unified-mpc status`
Prints the number of registered workspaces. For diagnostics, use `doctor`.
```bash
$ unified-mpc status
workspaces: 1
```

### `unified-mpc doctor`
Runs the operational diagnostics the runtime itself depends on: operating system, the SQLite core database, Git, ripgrep, the workspace registry, the HTTP MCP port, and Codex. It prints one `[STATUS] id: message` line per check and exits non-zero when a required check fails.

Required checks are `os`, `database`, `ripgrep`, and `mcp-port`. `git`, `workspaces`, and `codex` are informational: missing Git, a clean profile without a registered project, or no Codex install is reported as `WARN` without failing the command. A port already held by the running server is also a `WARN`, so `doctor` stays usable while Unified-MPC is up.
```bash
$ unified-mpc doctor
[PASS] os: linux x64 (6.8.0-1018-azure)
[PASS] database: Unified MCP core operational
[PASS] git: Git ready (/usr/bin/git)
[PASS] ripgrep: ripgrep ready (/usr/bin/rg)
[PASS] workspaces: 1 workspace configured
[WARN] mcp-port: MCP port 18765 is already in use
[WARN] codex: Codex is not installed
```

---

## 2. Dynamic Ingestion Commands

### `unified-mpc install skill`
Installs an Agent Skill package from a directory or git repository into target IDE skill directories without spawning background daemons.
```bash
# Syntax
unified-mpc install skill <name> <source-path> [--targets <target1,target2,...>] [--scope global|workspace] [--workspace <path>]

# Example: Install skill globally for Antigravity and Cursor
unified-mpc install skill agy-customizations /path/to/skill --targets antigravity,cursor

# Example: Install skill into workspace .gemini/skills/
unified-mpc install skill local-helper /path/to/skill --workspace /home/user/project
```

The install name must match the `name:` declared in the skill's `SKILL.md`
frontmatter. A mismatch is rejected with `CONFLICT` (`reason:
skill-name-conflict`) so the canonical catalog cannot advertise one logical
Skill under two IDs (issue #294).

### `unified-mpc install server`
Installs and registers an executable MCP Server into target IDE configurations.
```bash
# Syntax (stdio transport)
unified-mpc install server <name> --transport stdio --command <cmd> [--args <arg1,arg2,...>] [--env <KEY=VAL,...>] [--targets <targets>]

# Syntax (SSE or HTTP transport)
unified-mpc install server <name> --transport sse --url <http://endpoint:port/sse> [--targets <targets>]

# Example: Install SQLite MCP server
unified-mpc install server sqlite --transport stdio --command uvx --args mcp-server-sqlite,--db,app.db --targets cline,opencode
```

---

## 3. Zero-Artifact Pruning Commands

### `unified-mpc prune skill`
Removes an installed skill across target IDE directories and clears residual directories.
```bash
# Syntax
unified-mpc prune skill <name> [--targets <targets>] [--scope global|workspace] [--workspace <path>]

# Example
unified-mpc prune skill local-helper --workspace /home/user/project
```

### `unified-mpc prune server`
Terminates running server child processes (`SIGTERM` -> `SIGKILL`) and purges entries from all IDE config files.
```bash
# Syntax
unified-mpc prune server <name> [--targets <targets>] [--scope global|workspace] [--workspace <path>] [--no-kill]

# Example
unified-mpc prune server sqlite --targets cline,opencode
```

Data purge moves approved paths into Recovery Trash before success. Successful results include `recoveryStatus: "completed"` and `recoveryIds`; later failure reports `recoveryStatus` as `partial` or `rollback_failed`.

---

## 4. Policy Synchronization Command

### `unified-mpc sync`
Compiles the persisted user-editable P1–Pn runtime policy and synchronizes it idempotently into all connected IDE rule files. Semantic policy IDs remain stable when users reorder execution positions.
```bash
# Syntax
unified-mpc sync [--targets <t1,t2,...>] [--workspace <path>]

# Supported targets: antigravity, cursor, claude, opencode, cline, omp, codex, all (default: all)

# Example: Synchronize policy across all clients in workspace
unified-mpc sync --workspace /home/user/my-project
```

---

## 5. Web Control Plane Command

### `unified-mpc web`
Launches the local reactive Web Control Plane SPA daemon on loopback HTTP.
```bash
# Syntax
unified-mpc web [--port <number>]

# Default: http://127.0.0.1:3000/
unified-mpc web --port 3000
```

---

## 6. Headless Tool Execution Commands

### `unified-mpc tools list`
Prints one tab-separated `name<TAB>description` line per available downstream tool.
```bash
$ unified-mpc tools list
read_file	Read file contents
tool_categories	List tool categories
```

### `unified-mpc tools call`
Directly invokes any registered tool headlessly from terminal scripts or non-MCP agents.
```bash
# Syntax
unified-mpc tools call <tool-name> '<json-arguments>'

# Example
$ unified-mpc tools call tool_categories '{}'
{
  "categories": [ ... ]
}
```

---

## 7. Publish Credential Commands

The operator surface for the host-owned HTTP(S) publish credential (#297). The
secret is read from stdin only, never from argv or the environment. Grant
requires a promoted release; see
[PUBLISH_CREDENTIAL_RUNBOOK.md](PUBLISH_CREDENTIAL_RUNBOOK.md) for rotation and
emergency revocation.

```bash
# Grant one short-lived lease. The command prompts without echo on a TTY.
unified-mpc publish-credential grant <remote> \
  --workspace <id-or-path> --username <user> --ttl <seconds>

# Revoke a lease (idempotent). Removes the Secret Service entry first, then
# tombstones the row. An id that was never granted is refused with no audit row.
unified-mpc publish-credential revoke <leaseId>

# Show lease metadata and state without the secret.
unified-mpc publish-credential status <leaseId>
```

Every `publish-credential` command first sweeps leases whose TTL has passed, so
a lease that already expired usually has no row left: `revoke` exits 1 with
`publish-credential-not-found`, and `status` prints `publish credential not
found` and exits 0. `status` can still report `state: expired` for a row that
outlived its TTL, for example when the sweep could not delete its secret, and
`revoked` for a lease revoked before its TTL.

`grant` writes a `publish_credential_grant` audit row, `revoke` writes
`publish_credential_revoke` with result code `SUCCESS`, or `UNVERIFIED` when the
secret was deleted but the lease could not be read back or marked revoked (and
also when the Secret Service delete itself failed), and a credential-bound
publish writes
`publish_credential_use`. The audit rows carry lease metadata only; the secret
never enters them.

---

## 8. Storage Commands

Operator surface for the SQLite file that backs the workspace registry, audit log,
settings and goal runtime. Both commands print their report on stdout; a failure
prints on stderr and exits `1`.

### `unified-mpc storage recover`

Replaces the canonical database with one unambiguous historical SQLite file, for
example after an interrupted upgrade left the runtime reading an empty store.

```bash
$ unified-mpc storage recover
storage recovery not needed
```

When a historical database is present, the command names the source it moved
aside, the destination now in use, and the provenance record it wrote:

```text
storage recovered: /home/operator/.local/share/unified-mpc/legacy.sqlite -> /home/operator/.local/share/unified-mpc/unified-mpc.sqlite
provenance: /home/operator/.local/share/unified-mpc/recovery/provenance.json
```

Recovery refuses to act when more than one candidate matches, or when the
canonical database became populated after the replacement decision, so a rerun
cannot merge two unrelated histories. `storage recovery not needed` is a success
with exit `0`, not a skipped failure.

### `unified-mpc storage metrics [--json]`

Reports physical space for the canonical database. Logical GC deletes rows and
never shrinks the file, so these numbers keep "rows gone" and "bytes reclaimed"
apart.

```bash
$ unified-mpc storage metrics
database	/home/operator/.local/share/unified-mpc/unified-mpc.sqlite
bytes	db=4116480 wal=0 shm=32768 live=3317760
pages	size=4096 count=1005 freelist=195 (798720 bytes, 0.1940)
checkpoint	mode=passive busy=false walPages=0 checkpointedPages=0 truncated=false
compaction	recommended=false reason=none
```

`--json` prints the unprojected metrics document instead of the operator lines:

```bash
$ unified-mpc storage metrics --json
{"measuredAt":"2026-11-04T00:00:00.000Z","inMemory":false,"databasePath":"/home/operator/.local/share/unified-mpc/unified-mpc.sqlite","databaseBytes":4116480,"walBytes":0,"shmBytes":32768,"pageSizeBytes":4096,"pageCount":1005,"freelistCount":195,"freelistBytes":798720,"liveBytes":3317760,"freelistRatio":0.19402985074626866,"checkpoint":{"mode":"passive","busy":false,"walPages":0,"checkpointedPages":0,"truncated":false},"compactionRecommended":false,"compactionReason":null}
```

Any other flag is refused with the usage line and exit `2`, so a typo cannot
silently become a report nobody asked for. The command is evidence only: it never
vacuums, truncates or checkpoints destructively. `compaction.recommended` flips
to `true` only when the freelist is both at least 25% of the file and at least
64 MiB, and `reason` then names the measured bytes, ratio and thresholds.
Compaction itself stays a separate bounded maintenance step under the existing
owner fence.

---

## 9. Exit Code Contract

The `unified-mpc` CLI adheres to a deterministic exit code contract:
- `0`: Success / normal termination.
- `1`: Operational or runtime failure (e.g., command execution failed, connection refused).
- `2`: Syntax, argument, or validation error (e.g., unknown flag, missing required argument).

Unknown options are rejected, never ignored: `unified-mpc web --no-open` exits `2` with `Unknown option: --no-open` instead of starting the control plane on a default port.

