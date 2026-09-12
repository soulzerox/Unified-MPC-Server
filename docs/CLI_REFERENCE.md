# Unified-MPC CLI Reference Manual

The `unified-mpc` command-line interface provides comprehensive control over the server, dynamic ingestion, policy synchronization, and tool execution.

```bash
# Usage
unified-mpc <command> [subcommand] [flags]
```

---

## 1. System Commands

### `unified-mpc status`
Outputs overall server health, active SQLite database state, and registered workspace inventory.
```bash
$ unified-mpc status
Unified MPC Server status:
  workspaces: 1
```

### `unified-mpc doctor`
Performs comprehensive operational diagnostics on core databases, capabilities, and system dependencies.
```bash
$ unified-mpc doctor
Unified MPC Doctor Report:
  [PASS] database: Unified MCP core operational
Exit code: 0
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

---

## 4. Policy Synchronization Command

### `unified-mpc sync`
Compiles global P1–P7 tool prioritization rules and synchronizes them idempotently into all connected IDE rule files.
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
Outputs JSON list of all available tools across connected downstream MCP servers.
```bash
$ unified-mpc tools list
[
  {
    "name": "read_file",
    "description": "Read file contents"
  },
  {
    "name": "tool_categories",
    "description": "List tool categories"
  }
]
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

## 7. Exit Code Contract

The `unified-mpc` CLI adheres to a deterministic exit code contract:
- `0`: Success / normal termination.
- `1`: Operational or runtime failure (e.g., command execution failed, connection refused).
- `2`: Syntax, argument, or validation error (e.g., unknown flag, missing required argument).

