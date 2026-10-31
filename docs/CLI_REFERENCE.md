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
Performs comprehensive operational diagnostics on core databases, capabilities, and system dependencies. It prints one `[STATUS] id: message` line per check and exits non-zero when a required check fails.
```bash
$ unified-mpc doctor
[PASS] database: Unified MCP core operational
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

## 8. Exit Code Contract

The `unified-mpc` CLI adheres to a deterministic exit code contract:
- `0`: Success / normal termination.
- `1`: Operational or runtime failure (e.g., command execution failed, connection refused).
- `2`: Syntax, argument, or validation error (e.g., unknown flag, missing required argument).

Unknown options are rejected, never ignored: `unified-mpc web --no-open` exits `2` with `Unknown option: --no-open` instead of starting the control plane on a default port.

