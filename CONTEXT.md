# Unified-MPC-Server — Project Context & Domain Model

> Living Context Document for AI Agents and Human Contributors.  
> Authored under `/writing-for-agents` and `/domain-modeling`.  
> **Rule**: When this document contradicts another file, this document is authoritative for domain vocabulary; `SPEC.md` is authoritative for behavioral decisions.

---

## 1. Domain Glossary

- **Unified-MPC-Server**: The central, local-first MCP orchestrator, policy compiler, and senior engineering platform. The binary is registered as `unified-mpc`.
- **Skill**: An agent instruction set consisting of markdown documentation (`SKILL.md`), optional prompt guidelines, and supporting scripts. Skills teach agents *how* to behave and execute workflows. Skills never spawn standalone background daemon processes.
- **MCP Server**: An executable process providing tools and resources adhering to the Model Context Protocol over stdio, SSE, or HTTP. MCP servers supply *what* capabilities are available to execute.
- **Bifurcated Installer**: An architectural separation ensuring that Skill ingestion and MCP Server mounting are separate, strongly-typed operations across interfaces, CLI commands, and UI screens. The split is enforced at the type level — `InstallSkillInput` and `InstallServerInput` share zero fields.
- **Zero-Artifact Pruner**: An atomic uninstallation transaction that cleanly shuts down child processes, wipes package files, and purges all target configuration references without leaving dangling state.
- **Gated ChatGPT Web Connection**: A state machine requirement on the local web control plane (`apps/web`) ensuring the remote MCP server bridge/gateway (`apps/cf-gateway`) is active, tunneled, and healthy before permitting a client session to initiate.
- **Ponytail Runtime**: A senior software engineering harness enforcing the YAGNI principle, minimal diff footprints, root-cause debugging, and review gates across model actions. Has four intensity modes: `OFF`, `LITE`, `FULL` (default), `ULTRA`.
- **Two-Tier Tool Catalog**: An on-demand tool exposition pattern where only core essential tools are permanently kept in the model's active context window, while hundreds of specialized tools are discovered via `catalog_list` and invoked via `call_tool_dynamic`.
- **Durable Goal**: A persistent execution task stored in SQLite (`node:sqlite`), allowing tasks to safely continue across turns and between different AI models without manual text handoffs.
- **Option A Clean Start**: Complete replacement of all internal `@lnwjud/*` package namespaces with `@unified-mpc/*` across all 18 monorepo packages, complete deletion of all Windows-specific code/scripts, and zero backward compatibility shims.
- **Upstream**: `engasnm111/lnwjud`. Cherry-picked security fixes and features are pulled manually. Never rebase onto upstream main automatically.

---

## 2. Architectural Invariants

These invariants must hold in any correct implementation. An agent that violates an invariant must refuse the task and report the conflict.

1. **Bifurcation Is Absolute**: No code path may call `installSkill` with server parameters or `installServer` with markdown source parameters. The seam between the two is the type system.
2. **Local-First**: The core platform (stdio transport + loopback HTTP) must work 100% offline. `apps/cf-gateway` is always optional.
3. **HTTP Loopback-Only**: `apps/web` and `apps/mcp-server` HTTP listeners bind to `127.0.0.1` only. The `origin-policy` must reject any non-localhost `Origin` header with `403`.
4. **Mutation Gate Fail-Closed**: Any tool call not explicitly classified as `READ`, `WRITE`, `EXECUTE`, or `DANGEROUS` is treated as `DANGEROUS` and blocked unless the user has provided `userConfirmed: true`.
5. **ChatGPT Gate**: The `[ Connect ChatGPT Web ]` action returns `412 Precondition Failed` when the `apps/cf-gateway` bridge is not in `BRIDGE_HEALTHY` state.
6. **No Self-Aggregation**: Unified-MPC-Server must never register itself as a downstream child MCP server (prevents infinite tool-call loops). The exclusion guard checks `unified-mpc` and `unified-mpc-server` strings.
7. **Workspace Path Containment**: All file writes and deletes must resolve to a path inside a registered workspace root. Path traversal attempts return `PATH_OUTSIDE_WORKSPACE`.
8. **Secret Redaction**: All audit log entries pass through `redactor.ts` before being written to disk. No raw API keys, tokens, or credentials appear in logs.
9. **Electron Is Gone**: `apps/desktop` must never be re-introduced. All UI lives in `apps/web` on loopback or the native CLI.
10. **Linux Ubuntu Target (Zero Windows Code)**: The runtime platform is 100% Linux Ubuntu (POSIX and Linux XDG). No PowerShell scripts, Windows binaries (`.exe`), WSB sandbox manifests, or `win32` platform branches exist or may be added.
11. **Clean Namespace & Zero Backward Compat**: All workspace packages exclusively reside under `@unified-mpc/*`. No legacy `@lnwjud/*` aliases, shims, or fallback directory checks are retained.

---

## 3. Core Directory & Architecture Map

| Directory | Purpose |
|---|---|
| `apps/cli/` | Native CLI binary (`unified-mpc`) providing headless operations for terminal agents. |
| `apps/web/` | Fastify local web control plane serving the Obsidian Telemetry Dashboard on `http://127.0.0.1:18765/`. |
| `apps/cf-gateway/` | Decoupled companion gateway managing `cloudflared tunnel` and OAuth for ChatGPT Web remote sessions. Optional — core server works without it. |
| `packages/extensions/` | Downstream MCP child process multiplexer, dynamic bifurcated installer, zero-artifact pruner, and IDE synchronizer. |
| `packages/mcp-server/` | Host MCP server runtime implementing Ponytail engineering modes, security policies, and the Two-Tier Tool Catalog. |
| `packages/application/` | Agent swarm coordination, durable goal continuation, checkpoint service, scheduled continuation. **v1.0.0**: goal continuation and checkpointing are active; swarm and scheduled continuation are present but not externally advertised. |
| `packages/storage/` | SQLite database transactions, durable goals, backups, and checkpoints. |
| `packages/permissions/` | Permission profiles: `safe` (default), `balanced`, `full`, `custom`. |
| `packages/audit/` | Structured event logging with secret redaction via `redactor.ts`. |
| `packages/domain/` | Shared domain value objects, `Result<T, E>` monadic wrappers, and error definitions. |

---

## 4. Supported IDE & Agent Form Factors

Unified-MPC-Server natively discovers downstream servers, aggregates skills, and synchronizes rules/policies across all major AI coding clients on Linux Ubuntu:

1. **Google Antigravity**:
   - Surfaces: VS Code Extension, Antigravity IDE, CLI `agy`, and Desktop.
   - MCP Server Config: `~/.gemini/config/mcp_config.json` (primary), `~/.gemini/antigravity/mcp_config.json` (fallback).
   - Workspace Config: `<workspace>/.gemini/mcp.json`.
   - Skill Folders: `~/.gemini/config/skills/`, `~/.gemini/skills/`, `~/.gemini/antigravity/builtin/skills/`, `<workspace>/.gemini/skills/`, `<workspace>/.agents/skills/`.
   - Rules: `~/.gemini/config/GEMINI.md`, `~/.gemini/antigravity/rules/mcp-policy.md`, `<workspace>/GEMINI.md`.
2. **Cline**:
   - Surfaces: CLI (`~/.cline/`), VS Code Extension (`saoudrizwan.claude-dev`).
   - MCP Server Config: `~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`, `<workspace>/.cline/mcp.json`.
   - Skill Folders: `~/.cline/skills/` (global catalog with 40+ skills), `<workspace>/.cline/skills/`, `<workspace>/.agents/skills/`.
   - Rules: `<workspace>/.clinerules` (managed via `<!-- MCP-POLICY-START -->` and `<!-- MCP-POLICY-END -->` block replacement), `~/.cline/rules/`.
3. **OpenCode**:
   - Surfaces: CLI, VS Code Extension, Standalone Desktop.
   - MCP Server Config: `~/.config/opencode/opencode.jsonc`, `~/.config/opencode/opencode.json`, `<workspace>/.opencode/mcp.json`.
   - Skill Folders: `~/.config/opencode/skill/`, `<workspace>/.opencode/skills/`.
   - Rules: `AGENTS.md` (project root), `~/.config/opencode/AGENTS.md`.
4. **Freebuff**:
   - Surfaces: Standalone Desktop (`~/.config/freebuff-desktop/` state and preferences).
   - MCP Server Config: Loopback MCP or project state.
   - Skill Folders: `<workspace>/.agents/skills/`, `<workspace>/skills/`.
   - Rules: `AGENTS.md` (project root, read when `injectAgentsMd: true`).
5. **Cursor**:
   - Surfaces: Cursor IDE.
   - MCP Server Config: `~/.cursor/mcp.json`, `<workspace>/.cursor/mcp.json`.
   - Skill Folders: `~/.cursor/skills/`, `<workspace>/.cursor/skills/`.
   - Rules: `<workspace>/.cursor/rules/00-mandatory-policy.mdc`.
6. **Claude Desktop & Code**:
   - Surfaces: Claude Desktop, Claude Code CLI.
   - MCP Server Config: `~/.config/Claude/claude_desktop_config.json` (Linux XDG), `$XDG_CONFIG_HOME/Claude/claude_desktop_config.json`.
   - Skill Folders: `~/.claude/skills/`, `<workspace>/.claude/skills/`.
   - Rules: `~/.claude/CLAUDE.md`, `<workspace>/CLAUDE.md`.
7. **Oh My Pi (OMP)**:
   - Surfaces: CLI / Terminal Agent.
   - MCP Server Config: `~/.omp/config.json`.
   - Skill Folders: `~/.omp/skills/`, `<workspace>/.omp/skills/`.
   - Rules: `.omp/system.md`.
8. **OpenAI Codex CLI**:
   - Surfaces: CLI Tool.
   - Adapter: `packages/codex/` (`codex-discovery.ts`).
   - Skill Folders: `~/.codex/skills/`, `~/.codex/plugins/cache/`.
   - Rules: `AGENTS.md`.

---

## 5. Key Security Boundaries (Do Not Remove)

| Guardrail | Location | What It Prevents |
|---|---|---|
| Origin Policy | `packages/mcp-server/src/origin-policy.ts` | Non-localhost requests to local HTTP endpoints. |
| Mutation Gate | `packages/mcp-server/src/mutation-policy.ts` | Destructive writes without explicit user confirmation. |
| Workspace Path Guard | `packages/filesystem/` | Path traversal outside registered workspace roots. |
| Secret Redactor | `packages/audit/src/redactor.ts` | API keys / tokens appearing in logs. |
| Self-Aggregation Block | `packages/extensions/src/mcp-config-loader.ts` | Unified-MPC-Server calling itself as a downstream child. |
| Run Budget Guard | `packages/mcp-server/src/run-budget.ts` | Wall-clock timeouts rewriting successful tool results. |
| Permission Profiles | `packages/permissions/src/profiles.ts` | Agents escalating to `full` profile without engine approval. |

---

## 6. Out-of-Scope Components (Inherited but Deferred)

These components exist in the codebase from the lnwjud upstream but are **not active in v1.0.0**:

| Component | File | Status |
|---|---|---|
| Computer Vision / DOM CDP | `packages/mcp-server/src/computer-use-service.ts` | Disabled — no external API contract in v1.0.0. |
| Language Server Protocol | `packages/mcp-server/src/lsp-runtime.ts` | Disabled — not exposed as MCP tool in v1.0.0. |
| Agent Swarm Orchestration | `packages/application/src/agent-swarm-service.ts` | Present but not externally advertised in v1.0.0. |
| Upgrade Runtime (auto-update) | `packages/mcp-server/src/upgrade-runtime.ts` | Operator-triggered only. Never runs autonomously in v1.0.0. |
| Scheduled Continuation | `packages/application/src/scheduled-continuation-service.ts` | Inherited from lnwjud. Review and rename before exposing in v2. |

---

## 7. Milestones & Implementation Progress

| Milestone | Scope | Status | Verification & Evidence |
|---|---|---|---|
| **Milestone 1** | **Option A Clean Start & Linux-Only Foundation**: Monorepo namespace `@unified-mpc/*` rename across 220+ files; complete Windows code and script deletion; POSIX XDG runtime; zero backward compatibility. | ✅ **Completed** | Full test suite passed across all packages; Commit `4d52fe2`. |
| **Milestone 2** | **Universal Multi-Client Discovery & Policy Sync**: Discovery across Antigravity, Cline, OpenCode, Freebuff, Cursor, Claude, OMP, Codex; `SkillCatalog` multi-root scanner; `McpConfigLoader` JSONC aggregator; `IdeSyncService` atomic P1–P7 markdown compiler & idempotent block sync. | ✅ **Completed** | 38/38 tests in `packages/extensions`; monorepo typecheck clean; Commit `3fcf6e6`. |
| **Milestone 3** | **Bifurcated Dynamic Ingestion Engine**: Strict interface split between `installSkill` (`InstallSkillInput`) and `installServer` (`InstallServerInput`); validation pipelines; multi-target file injection (Antigravity, Cline, OpenCode, Cursor, Claude, Codex); atomic writes; self-aggregation prevention. | ✅ **Completed** | 7/7 tests passing in `packages/extensions/src/installer.test.ts`; 45/45 package tests; typecheck clean. |
| **Milestone 4** | **Zero-Artifact Pruner**: Atomic uninstallation; graceful SIGTERM -> SIGKILL; config purging across all IDEs; orphaned file/symlink purging. | ⏳ Planned | TDD in `packages/extensions/src/pruner.ts`. |
| **Milestone 5** | **Gated ChatGPT Web Gateway & Web Control Plane**: Fastify endpoints, 412 state machine gating on `BRIDGE_HEALTHY`, cloudflared tunnel integration, Obsidian-themed telemetry UI. | ⏳ Planned | TDD in `apps/web` & `apps/cf-gateway`. |
| **Milestone 6** | **Unified CLI Commands & End-to-End Integration**: `unified-mpc install skill/server`, `prune`, `sync`, `tools call/list`; e2e system verification. | ⏳ Planned | TDD in `apps/cli`. |

