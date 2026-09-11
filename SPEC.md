# Unified-MPC-Server — Master Specification

> **Status**: `verified-and-hardened` (Milestones 1–6 Complete & Passing 100%)  
> **Target Version**: `1.0.0`  
> **Source Base**: `engasnm111/lnwjud` (Clean Option A Pivot: Linux-only, Zero Backward Compat)  
> **Repository**: `soulzerox/Unified-MPC-Server`  
> **Target Platform**: `Linux Ubuntu` (100% POSIX / Linux XDG native, zero Windows code)  
> **Package Namespace**: `@unified-mpc/*` (21 active monorepo packages)  
> **Engine**: Node.js `>=22.0.0` (Native `node:sqlite`)

---

## Problem Statement

Modern AI-assisted software engineering involves multiple fragmented developer interfaces: local IDEs (Cursor, VS Code, Windsurf), terminal CLI agents (Claude Code, Oh My Pi, OpenCode, Agy CLI), Google Antigravity environments, and remote browser-based models (ChatGPT Plus / Web). This fragmentation causes several acute problems:

1. **Configuration Duplication & Drift**: Developers must configure MCP server definitions, JSON-RPC arguments, and environment variables across half a dozen configuration files (`.cursor/mcp.json`, `claude_desktop_config.json`, `~/.config/opencode/opencode.jsonc`, `~/.omp/config.json`, `~/.gemini/config/mcp_config.json`), creating maintenance overhead and inconsistent toolsets.
2. **Installation Confusion (Skills vs MCP Servers)**: AI agents and human developers repeatedly confuse Agent Skills (markdown instruction manuals, prompt rules, workflows) with MCP Servers (executable JSON-RPC / HTTP background processes). Polyglot installers that blur these entities produce corrupted configurations, dead symlinks, and broken executions.
3. **Context Window Bloat**: Exposing dozens of MCP servers simultaneously injects hundreds of raw tool definitions into LLM context windows on every invocation, blowing token budgets and degrading reasoning quality.
4. **Fragile Remote Connectivity**: Remote web models like ChatGPT Web lack direct access to local development tools. Naive tunneling introduces orphaned requests and failure loops if the local bridge is not actively listening before connection is attempted.
5. **Session Amnesia & Lack of Engineering Discipline**: Disconnected agent turns lose context across sessions, lacking senior engineering standards (YAGNI, minimal diffs, root-cause verification) and durable task persistence.

---

## Solution

**Unified-MPC-Server** resolves these challenges by serving as a unified local orchestrator, senior engineering harness, and policy gatekeeper:

1. **Single Source of Truth**: Aggregates and synchronizes MCP servers, skill catalogs, and execution rules across Google Antigravity, Cursor, Claude, OpenCode, Oh My Pi, and Cline from one local engine.
2. **Bifurcated Dynamic Ingestion & Zero-Artifact Pruner**: Completely bifurcates the installation of **Skills** (`SKILL.md` instruction packages) from **MCP Servers** (executable tools) at the code interface, CLI subcommands, and local web UI, paired with an atomic pruner that leaves zero orphaned files or dead processes.
3. **Gated ChatGPT Web Integration**: Provides a local web control plane (`apps/web` on `http://127.0.0.1:18765/`) with an enforced state machine gate—ensuring the ChatGPT Web MCP server bridge is active and verified healthy before enabling web client connection.
4. **Senior Engineering Harness (Ponytail Runtime)**: Embeds pragmatic engineering principles (YAGNI, root-cause diagnosis, review gates) and durable task continuation backed by local SQLite goals, eliminating manual `/handoff` rituals.
5. **Two-Tier On-Demand Tool Catalog**: Advertises only essential core tools in the active context, dynamically activating specialized tools via lightweight catalog queries to preserve LLM token limits.

---

## User Stories

1. As a developer using Google Antigravity (IDE, VS Code extension, CLI `agy`, or Desktop), I want Unified-MPC-Server to automatically discover and aggregate tools defined in `~/.gemini/config/mcp_config.json`, so that I do not have to configure them separately.
2. As a developer using Google Antigravity, I want my agent skills in `~/.gemini/config/skills/`, `~/.gemini/skills/`, and `~/.gemini/antigravity/builtin/skills/` to be indexed in the central skill catalog, so that any connected agent can read and execute them.
3. As a developer switching between Cursor, OpenCode, and Antigravity, I want a single sync command to compile and distribute my P1–P7 tool prioritization rules to all IDE rule files simultaneously, so that agent behavior remains uniform across editors.
4. As a developer installing an Agent Skill, I want an explicit `unified-mpc install skill` command and a dedicated "Install Skill" web UI tab, so that I am never asked for binary command paths or port numbers when adding prompt guidelines.
5. As a developer installing a new MCP Server, I want an explicit `unified-mpc install server` command and a dedicated "Install MCP Server" web UI tab, so that I can configure stdio/SSE/HTTP transports, arguments, and environment variables without colliding with skill logic.
6. As a developer executing `unified-mpc install` without arguments, I want an interactive terminal prompt clearly distinguishing `1) [ Skill ]` from `2) [ MCP Server ]`, so that neither humans nor terminal agents can mistakenly pass mismatched flags.
7. As a developer uninstalling a tool or skill, I want a zero-artifact pruner to terminate running child processes, delete downloaded assets, and strip configuration entries cleanly, so that no dead references or orphaned processes linger on my system.
8. As a developer using ChatGPT Web, I want a local web dashboard that displays the live status of the ChatGPT Web MCP bridge, so that I can monitor tunnel connectivity and uptime at a glance.
9. As a developer using ChatGPT Web, I want the "Connect to ChatGPT Web" button to be strictly disabled until the ChatGPT Web MCP server bridge is running and healthy, so that I never attempt to initiate a remote session against a dead endpoint.
10. As a developer working offline or in air-gapped environments, I want the core Unified-MPC-Server to function 100% locally via stdio and loopback HTTP without requiring Cloudflare Tunnel or an active internet connection, so that local development is never blocked.
11. As an LLM coding agent with limited context space, I want Unified-MPC-Server to advertise a compact core toolset alongside a searchable catalog meta-tool, so that my context window is not saturated by hundreds of unused tool schemas.
12. As a terminal AI agent (Claude Code, OpenCode CLI, Agy CLI), I want to execute namespaced downstream tools directly through the `unified-mpc tools call` CLI with JSON output, so that I can leverage all system capabilities headlessly.
13. As a senior engineer, I want the system harness to enforce Ponytail engineering levels (LITE, FULL, ULTRA), so that AI models adhere to the YAGNI principle, avoid speculative over-engineering, and fix bugs at the root cause.
14. As an autonomous agent executing long-running workflows across turns, I want durable goal tracking backed by SQLite, so that subsequent agent invocations can resume pending tasks without manual handoff dumps.
15. As a developer auditing tool usage, I want all downstream tool executions, argument payloads, and process lifecycles to be recorded in local audit logs with secret redaction, so that sensitive tokens and private data are protected.

---

## Implementation Decisions

### 1. Monorepo Structure & Decoupled Architecture

The repository adheres to a modular monorepo layout powered by pnpm workspaces:

```text
Unified-MPC-Server/
├── apps/
│   ├── cli/                  # Native CLI entrypoint (bin: unified-mpc)
│   ├── web/                  # Local Web Control Plane (Fastify + Obsidian Telemetry SPA)
│   └── cf-gateway/           # Decoupled Cloudflare Tunnel + ChatGPT Remote Bridge
├── packages/
│   ├── extensions/           # Downstream Multiplexer, Dynamic Ingestion, Pruner, IDE Sync
│   ├── mcp-server/           # Core MCP server, Ponytail runtime, Two-Tier Catalog, security policies
│   ├── application/          # Agent swarm, durable goal continuation, checkpoint service
│   ├── storage/              # SQLite database (node:sqlite), durable goals, checkpoints
│   ├── process/              # Background job lifecycle, process supervision, timeouts
│   ├── filesystem/           # Scoped workspace I/O, paging, path safety
│   ├── git/                  # Guarded Git mutations, diff fingerprinting
│   ├── permissions/          # Standard and Full Bypass permission profiles
│   ├── audit/                # Structured event logging, secret redaction
│   ├── search/               # ripgrep integration, symbol searching
│   ├── shared/               # Constants (APP_NAME = 'Unified-MPC-Server'), domain contracts
│   └── domain/               # Result<T, E>, AppError, value objects
├── package.json
└── pnpm-workspace.yaml
```

- **Electron Elimination**: `apps/desktop` is completely removed. All management interfaces run via the local loopback web control plane (`http://127.0.0.1:18765/`) and the native CLI (`unified-mpc`).
- **Node.js Native SQLite**: Built for Node `>=22.0.0` leveraging built-in `node:sqlite` (`DatabaseSync`), eliminating compilation of native C++ bindings for SQLite.

### 2. Universal Multi-Client Ecosystem Integration

The discovery, aggregation, and policy sync subsystem (`packages/extensions`) acts as a unified hub across all primary AI coding clients and IDEs on Linux Ubuntu:

#### Client Integration Matrix

| Client | Form Factors Supported | MCP Config Discovery | Skill Discovery Roots | Rule / Policy Sync Target |
|---|---|---|---|---|
| **Google Antigravity** | VS Code Extension, Antigravity IDE, CLI `agy`, Desktop | `~/.gemini/config/mcp_config.json`<br>`<workspace>/.gemini/mcp.json` | `~/.gemini/config/skills/`<br>`~/.gemini/skills/`<br>`~/.gemini/antigravity/builtin/skills/`<br>`<workspace>/.gemini/skills/` | `~/.gemini/config/GEMINI.md`<br>`<workspace>/GEMINI.md`<br>`~/.gemini/antigravity/rules/mcp-policy.md` |
| **Cline** | CLI (`~/.cline/`),<br>VS Code Extension | `~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`<br>`<workspace>/.cline/mcp.json` | `~/.cline/skills/`<br>`<workspace>/.cline/skills/` | `.clinerules` (block replacement)<br>`~/.cline/rules/` |
| **OpenCode** | CLI, VS Code Extension, Standalone | `~/.config/opencode/opencode.jsonc`<br>`<workspace>/.opencode/mcp.json` | `~/.config/opencode/skill/`<br>`<workspace>/.opencode/skills/` | `AGENTS.md` (project root)<br>`~/.config/opencode/AGENTS.md` |
| **Freebuff** | Standalone Desktop (`~/.config/freebuff-desktop/`) | Loopback MCP or project state | `.agents/skills/`<br>`<workspace>/skills/` | `AGENTS.md` (root `injectAgentsMd`) |
| **Cursor** | Editor / IDE | `~/.cursor/mcp.json`<br>`<workspace>/.cursor/mcp.json` | `~/.cursor/skills/`<br>`<workspace>/.cursor/skills/` | `.cursor/rules/00-mandatory-policy.mdc` |
| **Claude** | Claude Desktop, Claude Code CLI | `~/.config/Claude/claude_desktop_config.json` | `~/.claude/skills/`<br>`<workspace>/.claude/skills/` | `~/.claude/CLAUDE.md`<br>`<workspace>/CLAUDE.md` |
| **Oh My Pi (OMP)** | CLI / Terminal Agent | `~/.omp/config.json` | `~/.omp/skills/`<br>`<workspace>/.omp/skills/` | `.omp/system.md` |
| **Codex CLI** | CLI Tool | Standard Codex Engine | `~/.codex/skills/`<br>`~/.codex/plugins/cache/` | `AGENTS.md` |

- **Unified Downstream Multiplexer (`McpConfigLoader`)**: Ingests server definitions from all configured client configs, canonicalizes server names, filters self-references, and mounts them into the local runtime.
- **Universal Skill Catalog (`SkillCatalog`)**: Discovers and indexes markdown skill manuals across all client skill roots, providing unified listing and content retrieval.
- **Cross-Client Policy Synchronizer (`IdeSyncService`)**: Compiles P1–P7 tool execution priorities and guardrails, pushing atomic updates across all client rule files simultaneously.

### 3. Bifurcated Dynamic Ingestion Engine (`packages/extensions/src/installer.ts`)

To eliminate the conflation of Skills and MCP Servers, the installer is strictly bifurcated at the interface level into two independent pipelines:

```typescript
export type InstallTarget = 'antigravity' | 'cursor' | 'claude' | 'codex' | 'cline' | 'opencode' | 'all';

export interface InstallSkillInput {
  readonly name: string;
  readonly source: string; // Git URL, local directory path, or registry slug
  readonly targets: readonly InstallTarget[];
  readonly scope?: 'global' | 'workspace';
  readonly workspaceRoot?: string;
}

export interface InstallServerInput {
  readonly name: string;
  readonly transport: 'stdio' | 'sse' | 'http';
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly url?: string;
  readonly cwd?: string;
  readonly targets: readonly InstallTarget[];
  readonly scope?: 'global' | 'workspace';
  readonly workspaceRoot?: string;
}
```

- **Skill Installation Pipeline**:
  1. Validates `SKILL.md` existence and extracts YAML frontmatter (`name`, `description`).
  2. Copies or links skill assets into the target skill directories (e.g., `~/.gemini/config/skills/<name>/`).
  3. Registers the skill into the local index and re-indexes without spawning any background processes.
- **Server Installation Pipeline**:
  1. Validates executable existence on disk or verifies HTTP/SSE endpoint reachable via ping.
  2. Performs a sandboxed handshake (JSON-RPC `tools/list` or `initialize`).
  3. Injects structured server configuration into target configuration files (e.g., `~/.gemini/config/mcp_config.json`, `.cursor/mcp.json`).
  4. Mounts the server dynamically into `McpSessionManager` without requiring a host restart.

### 4. Zero-Artifact Pruner (`packages/extensions/src/pruner.ts`)

- **Atomic Teardown**:
  1. Identifies all running child processes associated with the server ID and issues graceful `SIGTERM`, falling back to `SIGKILL` after a 3000ms timeout.
  2. Removes configuration entries across all registered IDE target files.
  3. Safely removes directories, cloned repositories, virtual environments, and symlinks associated with the package.
  4. Scans for broken symlinks or orphaned directories across skill and server folders, removing dangling pointers to guarantee zero leftover artifacts.

### 5. Gated ChatGPT Web Connection (`apps/web` & `apps/cf-gateway`)

The Local Web Control Plane enforces an explicit state machine for ChatGPT Web connectivity:

```
[ STOPPED ] ──( Start Bridge )──> [ INITIALIZING ] ──( Healthcheck Passed )──> [ BRIDGE_HEALTHY ]
                                                                                       │
                                                                   [ Connect ChatGPT Web ] (Enabled)
                                                                                       │
                                                                                       ▼
                                                                           [ SESSION_CONNECTED ]
```

- **Hard Gating Invariant**:
  - The `[ Connect ChatGPT Web ]` UI button is disabled whenever the bridge state is not `BRIDGE_HEALTHY`.
  - HTTP endpoint `GET /api/chatgpt-web/connect` returns `412 Precondition Failed` if called while the gateway bridge is stopped, initializing, or already in `SESSION_CONNECTED` state (preventing double leasing).
  - The UI displays live status: Tunnel URL (Cloudflare), Local Port, Session Lease Token, and Ping Latency.
- **Decoupled Gateway Service (`apps/cf-gateway`)**:
  - Spawns `cloudflared tunnel` and authenticates incoming remote ChatGPT requests via OAuth 2.0 PKCE.
  - Passes valid requests over local loopback HTTP to the core Unified MCP Server.
  - Can be stopped or started on demand without interrupting local IDE or CLI operations.
- **Local Web Control Plane (`apps/web`)**:
  - Built with native `node:http` (zero-overhead lightweight runtime, default port `18765`).
  - Origin Policy Guard: Validates that `Origin` headers strictly match `http:` or `https:` protocols on `localhost` or `127.0.0.1`. Malformed origins, non-http protocols (e.g. `ftp://localhost`), and remote spoofed origins receive `403 Forbidden` immediately.
  - Request Body Size Guard: Enforces a strict 1MB maximum payload on all POST requests, returning `413 Payload Too Large` if exceeded.
  - Serves the native Obsidian Telemetry dashboard on `GET /` and exposes REST APIs for status, bifurcated installation, and pruning.

### 6. Unified CLI Commands & Headless Integration (`apps/cli`)

The native CLI binary (`unified-mpc`) provides complete command-line control for human developers and headless AI agents (Claude Code, OpenCode CLI, Agy CLI):
- **Standalone Binary**: Includes shebang `#!/usr/bin/env node` and auto-wires default production dependencies (`createDefaultCliDependencies`) connecting SQLite storage, workspace services, and dynamic extensions.
- **Command Dispatcher**:
  - `unified-mpc status`: Displays overall system health, active SQLite goals, and workspace status.
  - `unified-mpc install skill --name <n> --source <s> [--targets <t>] [--scope <global|workspace>]`: Ingests markdown skills without daemon processes.
  - `unified-mpc install server --name <n> --transport <stdio|sse|http> --command <cmd> [--args <a...>]`: Mounts executable MCP servers.
  - `unified-mpc prune skill --name <n>` & `unified-mpc prune server --name <n>`: Atomically uninstalls packages and purges configuration entries.
  - `unified-mpc sync [--targets <t...>]`: Compiles and pushes P1–P7 tool rules to all connected IDE configuration files simultaneously.
  - `unified-mpc web [--port <p>] [--no-open]`: Boots the Local Web Control Plane on loopback.
  - `unified-mpc tools list` & `tools call <tool> <args-json>`: Directly calls namespaced downstream MCP tools headlessly.
- **Deterministic Exit Code Contract**:
  - `0`: Success / normal termination.
  - `1`: Domain or operational failure (e.g., target directory not found, command execution failed).
  - `2`: Syntax, argument, or validation error (e.g., unknown flag, missing required subcommand).

### 7. Universal Senior Engineering Harness (Ponytail Runtime)

Embedded in `packages/mcp-server`:
- **Mindset Enforcement**: Prioritizes standard libraries and minimal diffs. Restricts speculative abstractions and premature dependencies.
- **Intensity Tiers**:
  - `OFF`: Standard tool pass-through.
  - `LITE`: Warnings on oversized diffs and unreferenced dependencies.
  - `FULL` (Default): Requires unit test verification before marking steps complete; triggers over-engineering checks.
  - `ULTRA`: Strict red-green-refactor loop; blocks changes lacking test coverage or introducing non-essential packages.
- **Two-Tier Tool Catalog**:
  - **Tier 1 (Core)**: 10–12 fundamental tools (`read_file`, `edit_file`, `run_command`, `git_status`, `catalog_list`, `call_tool_dynamic`).
  - **Tier 2 (On-Demand)**: All specialized downstream tools accessible via `catalog_list` (search metadata) and `call_tool_dynamic(tool_name, args)`.

---

## Security Guardrails

These guardrails exist in the inherited codebase and **must be preserved** during all adaptations:

### 1. HTTP Origin Policy (localhost-only)
- `packages/mcp-server/src/origin-policy.ts` enforces that the local HTTP server (`http://127.0.0.1:18765/`) only accepts requests from localhost origins.
- Requests with `Origin: http://evil.example` receive `403 Forbidden` immediately.
- This guardrail must not be weakened when adding the `apps/web` control plane. The web control plane is loopback-only; all public access routes through `apps/cf-gateway` with authentication.

### 2. Mutation Gate (Fail-Closed)
- `packages/mcp-server/src/mutation-policy.ts` and `destructive-policy.ts` classify all tool calls as `READ`, `WRITE`, `EXECUTE`, or `DANGEROUS` and require explicit `userConfirmed: true` for destructive operations.
- The gate fails **closed**—any unclassified operation is treated as `DANGEROUS` and blocked by default.
- `packages/mcp-server/src/sandbox-contract.ts` enforces that sandbox paths remain inside registered workspace roots.

### 3. Permission Profiles (safe / balanced / full / custom)
- `packages/permissions/src/profiles.ts` defines four runtime profiles. `safe` is the default: `READ=ALLOW`, `WRITE=ASK`, `EXECUTE=ASK`, `DANGEROUS=DENY`.
- An agent requesting `Full Bypass` (full profile) must go through the permission engine explicitly. The Ponytail harness constrains this further.

### 4. Secret Redaction on Audit Logs
- `packages/audit/src/redactor.ts` strips API keys, tokens, credentials, and personal data from all audit log entries before they are written to disk.
- This must remain active when the installer injects server configurations that may contain `env` entries with secret values.

### 5. Workspace Path Guard (Path Traversal Prevention)
- All file I/O via `packages/filesystem` validates that resolved paths remain inside registered workspace roots.
- The pruner must use this same guard when deleting package directories to prevent path traversal attacks on the host filesystem.

### 6. Self-Reference Exclusion in Aggregation
- `packages/extensions/src/mcp-config-loader.ts` contains an `exclusionReason` function that prevents Unified-MPC-Server from aggregating itself as a downstream child (recursive loop prevention).
- This guard explicitly checks `unified-mpc` and `unified-mpc-server` strings.

### 7. Run Budget — Outcome-Driven (no wall-clock rewrite)
- `packages/mcp-server/src/run-budget.ts`: wall-clock time must never rewrite a successful tool result or inject unexpected handoff/background instructions. The `RunBudgetGuard` is outcome-driven, not time-driven.

---

## Clean Start & Naming Resolution (Option A — Completed)

Under user direction, the repository executed **Option A (Clean Sweep)** with zero backward compatibility for `lnwjud` and complete removal of all Windows-specific code to target **100% Linux Ubuntu**:

| Category | Previous State (`lnwjud`) | Clean Option A State (`Unified-MPC-Server`) | Status |
|---|---|---|---|
| **npm package namespaces** | `@lnwjud/domain`, `@lnwjud/shared`, etc. | All 18 monorepo packages renamed to `@unified-mpc/*` across 220+ files | ✅ Complete |
| **Platform Target** | Windows + macOS + Linux multi-platform | **100% Linux Ubuntu** (POSIX / Linux XDG native; zero Windows code) | ✅ Complete |
| **Windows-specific code** | 19 `.ts`/`.ps1` Windows bridge & WSB files | **Deleted** entirely (no Windows Sandbox, no PowerShell bridge, no OCR) | ✅ Complete |
| **Windows shell scripts** | 11 `.ps1`/`.bat` scripts in `scripts/` | **Deleted** entirely (no `start-lnwjud-tunnel.ps1`, etc.) | ✅ Complete |
| **Data directory** | `~/.local/share/lnwjud` / `%APPDATA%\lnwjud` | Standard Linux XDG `~/.local/share/unified-mpc/` (`UNIFIED_MPC_DATA_PATH`) | ✅ Complete |
| **Database filename** | `lnwjud.sqlite` with migration shims | Direct `unified-mpc.sqlite` (no legacy database fallbacks) | ✅ Complete |
| **Self-aggregation strings** | `'lnwjud'`, `'lnwjud-'` | `'unified-mpc'`, `'unified-mpc-server'` | ✅ Complete |
| **Recovery/trash dirs** | `.lnwjud-recovery`, `.lnwjud-trash` | `.unified-mpc-recovery`, `.unified-mpc-trash` | ✅ Complete |
| **Settings source label** | `'lnwjud-settings'` | `'unified-mpc-settings'` | ✅ Complete |
| **Backward compatibility** | Legacy fallback paths and alias checks | **Zero backward compatibility** (clean start, no dead aliases) | ✅ Complete |

---

## Milestones & Implementation Progress

| Milestone | Scope & Description | Status | Verification & Hardening Evidence |
|---|---|---|---|
| **Milestone 1** | **Option A Clean Start & Linux-Only Foundation**: Complete monorepo rename from `@lnwjud/*` to `@unified-mpc/*` across 220+ files; deletion of all Windows code/scripts; POSIX XDG runtime; zero backward compatibility. | ✅ **Audited & Hardened** | Full test suite passed across all packages; hardened POSIX process probes; 100 concurrent WAL writes test (`packages/shared/src/linux-foundation.test.ts`); Commits `0c72016`, `9637708`. |
| **Milestone 2** | **Universal Multi-Client Discovery & Policy Sync**: Discovery across Antigravity, Cline, OpenCode, Freebuff, Cursor, Claude, OMP, Codex; `SkillCatalog` multi-root scanner; `McpConfigLoader` JSONC aggregator; `IdeSyncService` atomic P1–P7 markdown compiler & idempotent block sync. | ✅ **Audited & Hardened** | 63/63 tests in `packages/extensions`; JSONC trailing commas and mixed comment parsing; circular/broken symlinks resilience; concurrent multi-client sync; Commit `d5d63fa`. |
| **Milestone 3** | **Bifurcated Dynamic Ingestion Engine**: Strict interface split between `installSkill` (`InstallSkillInput`) and `installServer` (`InstallServerInput`); validation pipelines; multi-target file injection (Antigravity, Cline, OpenCode, Cursor, Claude, Codex); atomic writes; self-aggregation prevention. | ✅ **Audited & Hardened** | 69/69 tests in `packages/extensions`; prototype pollution guards; URL protocol validation (HTTP/HTTPS); self-aggregation loop blocking; `withFileLock` mutex tested with 20 concurrent server installs; Commit `8582f23`. |
| **Milestone 4** | **Zero-Artifact Pruner**: Atomic uninstallation; graceful SIGTERM -> SIGKILL process termination; config purging across all IDEs (Antigravity, Cline, OpenCode, Cursor, Claude, Codex); data directory cleanup; broken symlink & orphaned artifact purging. | ✅ **Audited & Hardened** | 11/11 tests passing in `packages/extensions/src/pruner.test.ts`; strict identifier regex validation; `isSafePurgePath` path traversal guards (SPEC.md line 218); Commit `fe6e601`. |
| **Milestone 5** | **Gated ChatGPT Web Gateway & Local Web Control Plane**: Decoupled `apps/cf-gateway` companion gateway with 4-state lifecycle machine (`STOPPED` -> `INITIALIZING` -> `BRIDGE_HEALTHY` -> `SESSION_CONNECTED`); native `node:http` `ControlPlaneServer` (`apps/web`) on `http://127.0.0.1:18765/`; Origin header security guard (403); 412 Precondition Failed gating on `/api/chatgpt-web/connect`; bifurcated ingestion & pruning routes; Obsidian Telemetry UI. | ✅ **Audited & Hardened** | 18/18 tests in `apps/web`; 5/5 tests in `apps/cf-gateway`; Origin HTTP/HTTPS protocol validation; 1MB body limit & 413 Payload Too Large; 50 concurrent requests; Commit `c60781e`. |
| **Milestone 6** | **Unified CLI Commands & End-to-End Integration**: `unified-mpc install skill/server`, `prune skill/server`, `sync`, `web`, `tools list/call`; POSIX path cleanups; full CLI argument parsing and execution dispatching. | ✅ **Audited & Hardened** | 75/75 tests passing in `apps/cli`; shebang and standalone binary entry; child process e2e smoketests (`milestone-6-e2e.test.ts`); exit code validation; capabilities syntax hardening; Commit `b1cc510`. |

---

## Comprehensive Audit, Stress Test & Hardening Evidence (/goal Loop)

An exhaustive audit, stress test, and end-to-end verification loop was completed across all 6 milestones using Matt Pocock's `/diagnosing-bugs` and `/scaffold-exercises` TDD discipline:

1. **Linux Foundation (Milestone 1)**:
   - Scanned and eliminated all residual `powershell.exe` and `path.win32` probes in `packages/capabilities` and `packages/mcp-server`.
   - Verified 100 concurrent async read/write operations against SQLite WAL mode with zero errors (`linux-foundation.test.ts`).
2. **Multi-Client Discovery (Milestone 2)**:
   - Enhanced `stripJsonComments` to safely strip trailing commas before `}` and `]` outside quotes, allowing malformed JSONC configs from VS Code and Cline to parse cleanly.
   - Hardened `SkillCatalog` and `allowlist` with nullish coalescing to prevent `TypeError` when dealing with partial or missing setting arrays.
   - Tested circular and broken symlinks resilience in `milestone-2-stress.test.ts`.
3. **Bifurcated Ingestion Engine (Milestone 3)**:
   - Blocked prototype pollution attacks (`constructor`, `__proto__`, `prototype`) on both skill and server names.
   - Enforced HTTP/HTTPS URL protocols for SSE/HTTP transports, rejecting `file://` and `javascript:`.
   - Hardened `exclusionReason` against recursive self-aggregation (detecting CLI stdio wrappers like `node dist/bin/mcp-stdio.js`).
   - Implemented `withFileLock` in-process mutex around config file mutations, verified with 20 concurrent server installs with zero lost updates (`milestone-3-stress.test.ts`).
4. **Zero-Artifact Pruner (Milestone 4)**:
   - Added `isSafePurgePath` boundary check strictly prohibiting purge of `/`, system directories (`/etc`, `/usr`, `/var`), and non-whitelisted paths.
   - Enforced `/^[A-Za-z0-9_-]+$/` on all skill and server identifiers.
5. **Gated Web Gateway (Milestone 5)**:
   - Hardened `Origin` policy guard to verify HTTP/HTTPS protocols, strictly rejecting non-http protocols (e.g. `ftp://localhost`), `null`, and spoofed origins with `403 Forbidden`.
   - Added 1MB request body limit returning `413 Payload Too Large`.
   - Verified 412 state gate enforcement on `/api/chatgpt-web/connect` across full state machine lifecycle (STOPPED -> 412, BRIDGE_HEALTHY -> 200, SESSION_CONNECTED -> 412).
   - Stress tested with 50 concurrent requests (`milestone-5-stress.test.ts`).
6. **Unified CLI & Monorepo Verification (Milestone 6)**:
   - Added shebang and `createDefaultCliDependencies` to `apps/cli/src/index.ts`, enabling standalone CLI binary execution.
   - Fixed child process execution to reliably exit with correct codes (0, 1, 2).
   - Diagnosed and fixed syntax/bracket issues in `packages/capabilities` (`durable-shell-task-store.ts` and `browser-cdp-protocol.ts`).
   - Verified via subprocess e2e smoketests (`milestone-6-e2e.test.ts`).
   - Full monorepo `corepack pnpm typecheck` (`tsc --build`) passes with 0 errors across all 21 packages.
   - Full monorepo `corepack pnpm test` passes 100% across all 21 packages.
7. **Codebase Hygiene & Legacy Bloat Removal (Option 1)**:
   - Eliminated 50 residual legacy files (-5,673 lines of code) across `scripts/`, `native/macos-host/`, and `tests/packaging/` & `tests/release/`.
   - Replaced multi-platform CI workflows with native Ubuntu 24.04 pipeline (`.github/workflows/ci.yml`).
   - Cleaned `.gitignore` removing all legacy `apps/desktop` and `lnwjud` references.
   - Standardized runtime environment variables to `UNIFIED_MPC_*` across `capabilities`, `shared`, and `cli`.
   - Added user-friendly CLI `--help`, `-h`, and `help` commands returning exit code 0.
   - Preserved active integration test suites (`mcp-development-flow.test.ts`, `codex-review-flow.test.ts`) passing 100%.
8. **Real-World Host Dogfooding & Live Smoke Testing (Option 2)**:
   - Wired live `ToolRegistry` into CLI headless tool execution (`unified-mpc tools list` and `unified-mpc tools call`).
   - Fixed `PrunerService` and CLI prune commands to correctly handle workspace-scoped pruning with auto-inferred scope.
   - Validated live dynamic ingestion and pruning lifecycle for both skills and servers.
   - Confirmed live policy sync idempotency across 7 IDE target files.
   - Verified Local Web Control Plane (`http://127.0.0.1:18765/`) endpoints, Obsidian dashboard HTML, 412 hard gating invariant, and 403 loopback origin enforcement.
   - Full monorepo `corepack pnpm typecheck` (`tsc --build`) passes with 0 errors across all 21 packages.
   - Full monorepo `corepack pnpm test` and root `npx vitest run tests/` pass 100%.

---

## Testing Decisions

### What Makes a Good Test
- **External Behavior Over Implementation Details**: Tests must exercise the public interfaces of modules (`installSkill`, `installServer`, `prune`, `sync`) rather than asserting on private internal functions or transient variables.
- **Deterministic Filesystem & Process Fakes**: File operations and process spawning in tests must execute against temporary sandboxes (`os.tmpdir()`) or controlled test fixtures to ensure cross-platform reproducibility.
- **Failure-Mode Verification**: Every success test must be paired with tests verifying correct error handling (e.g., attempting to install an invalid skill markdown, unreachable server binaries, or calling gated endpoints prematurely).

### Modules Tested
1. `packages/extensions`:
   - `skill-catalog.test.ts`: Discovery across Antigravity (`~/.gemini/`), Cursor, Claude, and workspace roots.
   - `mcp-config-loader.test.ts`: Parsing and normalising `mcp_config.json`, handling malformed JSON, applying exclusion rules (including `unified-mpc`).
   - `installer.test.ts`: Clean separation of `installSkill` and `installServer`; verifying target paths.
   - `pruner.test.ts`: Verifying zero lingering artifacts, process killing, and configuration purging.
   - `ide-sync.test.ts`: Verification of markdown rule compilation and multi-IDE file synchronization.
   - `milestone-2-stress.test.ts`: Concurrent sync, circular symlinks, malformed JSONC resilience.
   - `milestone-3-stress.test.ts`: Mutex locking under 20 concurrent installations, prototype pollution blocking.
2. `apps/cli`:
   - Command routing for `unified-mpc install skill`, `install server`, `prune`, `sync`, `web`, and `tools list/call`.
   - `milestone-6-e2e.test.ts`: Subprocess e2e smoketests executing CLI commands via child processes and validating exit codes (0, 1, 2).
3. `apps/cf-gateway`:
   - `gateway-service.test.ts`: 4-state lifecycle machine and hard gating invariant verification.
4. `apps/web`:
   - `web-server.test.ts`: Route tests for status, bifurcated installation, pruning, and 412 status on `/api/chatgpt-web/connect`.
   - `milestone-5-stress.test.ts`: Origin policy tests (403), 1MB payload limit (413), and 50 concurrent requests stress test.
5. `tests/integration`:
   - `mcp-development-flow.test.ts`: End-to-end fixture workflow verifying application services.
   - `codex-review-flow.test.ts`: Codex review delegation, diff inspection, and background task management.

### Prior Art
- Test patterns from `packages/extensions/src/extensions-service.test.ts` and `mcp-session-manager.integration.test.ts`.
- Security tests from `packages/mcp-server/src/mcp-http-security.test.ts` (origin, body size limits).
- Mutation gate tests from `packages/mcp-server/src/mutation-policy.test.ts`.

---

## Out of Scope

- **Electron Native Bundling**: Building desktop `.deb`, `.dmg`, or `.exe` installer packages for Electron. (The platform is dedicated to CLI + Web Control Plane).
- **Public Cloud Hosting**: Deploying the Unified MCP Server as a multi-tenant public SaaS. (This is strictly a local-first, single-user developer tool).
- **Automated Upstream Git Merges**: Automatic auto-merging of upstream `engasnm111/lnwjud` changes into active production branches without developer review.
- **Computer Vision / Screen Capture**: The `computer-use-service.ts` (set-of-marks, DOM CDP, accessibility) exists in the inherited codebase but is not part of the v1.0.0 adaptation scope.
- **LSP Integration**: `lsp-runtime.ts` exists in the inherited codebase. Language Server Protocol features are out of scope for v1.0.0 and must not be enabled by default.
- **Agent Swarm Orchestration**: `agent-swarm-service.ts` provides multi-agent coordination. This is a future feature; it must not be exposed as an MCP tool in v1.0.0 without explicit security review and a dedicated User Story.
- **Windows Platform & Tooling**: Completely removed from the project. No PowerShell scripts, Windows executables, WSB sandbox manifests, or win32 platform branches exist in the repository. The target platform is 100% Linux Ubuntu.
- **Upgrade Runtime Auto-Update**: `upgrade-runtime.ts` is operator-triggered only. Never runs unsupervised in v1.0.0.

---

## Further Notes

- **CLI Alias**: The CLI is registered under `unified-mpc` (e.g., `unified-mpc --help`).
- **Data Directory**: Runtime state, SQLite databases, and telemetry logs reside at `~/.local/share/unified-mpc/` (configurable via `UNIFIED_MPC_DATA_PATH`).
- **Zero Backward Compatibility**: As a clean start, all legacy `lnwjud` backward-compatibility shims, aliases, and fallbacks have been eliminated. Unified-MPC-Server exclusively uses the `@unified-mpc/*` namespace and `unified-mpc` paths.
- **Upstream Cherry-Picks**: To pull security fixes or features from upstream, cherry-pick specific commits manually. Never rebase directly onto upstream main.
