# Unified-MPC-Server Core Concepts & Design Philosophy

## 1. Bifurcated Dynamic Ingestion Engine

### The Problem
Traditional tool installers frequently blur the distinction between **Agent Skills** and **MCP Servers**. This confusion results in agents attempting to execute markdown manuals as background daemons or attempting to inject executable command paths into prompt instruction directories.

### The Unified-MPC Solution
Unified-MPC-Server enforces an architectural bifurcation at every level (TypeScript interfaces, CLI commands, and Web UI modals):

```
┌─────────────────────────────────────────────────────────────┐
│                 Unified Dynamic Ingestion                   │
├──────────────────────────────┬──────────────────────────────┤
│        SKILL PIPELINE        │      MCP SERVER PIPELINE     │
├──────────────────────────────┼──────────────────────────────┤
│ • Markdown guidelines        │ • Executable tools           │
│ • YAML frontmatter           │ • Transports: stdio/sse/http │
│ • No background process      │ • Running daemon process     │
│ • Injected into skill roots  │ • Injected into mcp.json     │
│ • Command: install skill     │ • Command: install server    │
└──────────────────────────────┴──────────────────────────────┘
```

- **Skills**: Instruction manuals (`SKILL.md`) parsed for metadata and copied to IDE skill directories (e.g., `~/.gemini/config/skills/`, `.cursor/skills/`). No processes are spawned.
- **MCP Servers**: Live executable tools verified via handshakes and registered in configuration files (e.g., `~/.gemini/config/mcp_config.json`, `.cursor/mcp.json`). Spawned and supervised on demand.

---

## 2. Zero-Artifact Pruning

When a server or skill is removed, standard package managers often leave orphaned background processes, dangling symlinks, or dirty configuration files.

Unified-MPC-Server provides an atomic **Zero-Artifact Pruner**:
1. **Process Termination**: Sends `SIGTERM` to running child processes, escalating to `SIGKILL` after 3,000ms.
2. **Configuration Clean**: Rewrites all target IDE JSON/JSONC configuration files atomically, preserving valid syntax and other installed servers.
3. **Storage Purge**: Deletes associated cache and data directories with strict path traversal boundaries (`isSafePurgePath`).
4. **Symlink Sweep**: Cleans broken symlinks and empty parent directories to guarantee a clean system state.

---

## 3. Gated Remote ChatGPT Bridge

Remote web models (such as ChatGPT Plus / Web) cannot directly access local filesystem tools without a secure tunnel. Naive tunneling leads to failed requests and hung sessions if the local endpoint is down.

Unified-MPC-Server implements an explicit **State Machine Gate**:

```
[ STOPPED ] ──( Start Bridge )──> [ INITIALIZING ] ──( Ping Passed )──> [ BRIDGE_HEALTHY ]
                                                                                │
                                                            [ Connect ChatGPT Web ] (Enabled)
                                                                                │
                                                                                ▼
                                                                    [ SESSION_CONNECTED ]
```

- Endpoint `/api/chatgpt-web/connect` returns **`412 Precondition Failed`** unless the bridge is verified in `BRIDGE_HEALTHY` state.
- The UI button remains hard-disabled until the local health check passes.
- Double-leasing is strictly prevented; a leased session cannot be overwritten by another incoming connection.

---

## 4. Senior Engineering Harness (Ponytail Runtime)

The Ponytail harness embeds senior engineering discipline into every AI turn:
- **YAGNI (You Aren't Gonna Need It)**: Refuse speculative abstractions, excessive layers, and unnecessary dependencies.
- **Standard Library First**: Prioritize Node.js standard libraries and POSIX tools over external packages.
- **Intensity Tiers**:
  - `OFF`: Standard tool execution pass-through.
  - `LITE`: Advisory warnings on large diffs and unreferenced imports.
  - `FULL` (Default): Requires unit test verification before marking steps complete.
  - `ULTRA`: Strict red-green-refactor loop; blocks commits without passing tests.

---

## 5. Two-Tier On-Demand Tool Catalog

Injecting hundreds of tool schemas into an LLM's context window exhausts token budgets and degrades reasoning accuracy.

Unified-MPC-Server solves this with a **Two-Tier Catalog**:
- **Tier 1 (Core)**: 10–12 essential tools (`read_file`, `edit_file`, `run_command`, `git_status`, `catalog_list`, `call_tool_dynamic`) advertised in the primary system prompt.
- **Tier 2 (On-Demand)**: Specialized downstream tools discovered dynamically via `catalog_list` metadata queries and invoked via `call_tool_dynamic(tool_name, args)`.

---

## 6. Universal Multi-Client Policy Synchronization

Rather than manually editing prompt rules across 7 different editors, the `IdeSyncService` compiles global tool prioritization rules (P1–P7) and distributes them idempotently into:
- Google Antigravity (`~/.gemini/antigravity/rules/mcp-policy.md`, `GEMINI.md`)
- Cursor (`.cursor/rules/00-mandatory-policy.mdc`)
- Claude Code (`CLAUDE.md`)
- OpenCode (`AGENTS.md`)
- Cline (`.clinerules`)
- Oh My Pi (`.omp/system.md`)

Each file receives an idempotent block (`<!-- MCP-POLICY-START -->` ... `<!-- MCP-POLICY-END -->`) that can be safely updated repeatedly without duplicate rule drift.

