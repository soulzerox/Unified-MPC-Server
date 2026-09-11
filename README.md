<p align="center">
  <img src="assets/logo/logo-256x256.png" width="140" alt="Unified-MPC-Server logo" />
</p>

<h1 align="center">Unified-MPC-Server</h1>

<p align="center">
  <strong>Central Local-First MCP Orchestrator, Multi-Client Policy Synchronizer & Gated Remote Gateway</strong><br />
  <em>Unified tool discovery, bifurcated dynamic ingestion, zero-artifact pruning, and senior engineering harness across Google Antigravity, Cline, OpenCode, Freebuff, Cursor, Claude, Oh My Pi, and Codex CLI on Linux Ubuntu.</em>
</p>

<p align="center">
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-blue.svg" /></a>
  <img alt="Platform" src="https://img.shields.io/badge/platform-Linux%20Ubuntu-E95420" />
  <img alt="Node" src="https://img.shields.io/badge/Node.js-%3E%3D22.0.0-339933" />
  <img alt="Engine" src="https://img.shields.io/badge/database-node%3Asqlite-003B57" />
  <img alt="Milestones" src="https://img.shields.io/badge/milestones%201--6-100%25%20verified-brightgreen" />
</p>

---

## Overview

**Unified-MPC-Server** serves as a unified local orchestrator, senior engineering harness, and policy gatekeeper for modern AI-assisted software development. It consolidates fragmented configurations, prevents context window bloat via an on-demand Two-Tier Tool Catalog, and enforces rigorous software engineering discipline.

### Key Architectural Pillars

1. **Option A Clean Start & Linux Ubuntu Foundation**: 100% Linux POSIX and XDG compliance. Zero Windows-specific code (`.ps1`, `.exe`, `.bat`, `win32`) and zero legacy backward-compatibility debt.
2. **Universal Multi-Client Integration**: Automatically discovers MCP servers, indexes skills, and pushes compiled P1–P7 tool prioritization rules simultaneously to **Google Antigravity**, **Cline**, **OpenCode**, **Freebuff**, **Cursor**, **Claude**, **Oh My Pi (OMP)**, and **Codex CLI**.
3. **Bifurcated Dynamic Ingestion Engine**: Strictly separates the installation of **Agent Skills** (`SKILL.md` instruction packages) from **MCP Servers** (executable JSON-RPC/SSE/HTTP processes) at the code interface, CLI subcommands, and local web UI.
4. **Zero-Artifact Pruner**: Atomic uninstallation with graceful `SIGTERM` -> `SIGKILL` process termination, multi-IDE configuration purging, dangling symlink cleanup, and strict path-containment boundary guards.
5. **Gated ChatGPT Web Gateway & Local Web Control Plane**: Decoupled Cloudflare companion gateway (`apps/cf-gateway`) with a 4-state lifecycle machine (`STOPPED` -> `INITIALIZING` -> `BRIDGE_HEALTHY` -> `SESSION_CONNECTED`) and local web dashboard (`apps/web` on `http://127.0.0.1:18765/`). Enforces hard `412 Precondition Failed` gating before session connections.
6. **Unified Headless CLI (`unified-mpc`)**: Standalone executable CLI binary with exit code contracts (0, 1, 2) enabling headless operation for human developers and terminal AI coding agents (Claude Code, OpenCode CLI, Agy CLI).
7. **Senior Engineering Harness (Ponytail Runtime)**: Enforces YAGNI, minimal diffs, root-cause verification, and durable goal tracking backed by native `node:sqlite`.

---

## Monorepo Architecture

The repository is organized into 21 active workspace packages under the `@unified-mpc/*` namespace:

```text
Unified-MPC-Server/
├── apps/
│   ├── cli/                  # Native CLI entrypoint (bin: unified-mpc)
│   ├── web/                  # Local Web Control Plane (native node:http + Obsidian Telemetry)
│   └── cf-gateway/           # Decoupled Cloudflare Tunnel + ChatGPT Remote Bridge
├── packages/
│   ├── extensions/           # Multi-Client Ingestion, Pruner, Config Loader, Skill Catalog, IDE Sync
│   ├── mcp-server/           # Core MCP server, Ponytail runtime, Two-Tier Catalog, security policies
│   ├── application/          # Agent swarm, durable goal continuation, checkpoint service
│   ├── storage/              # SQLite database (node:sqlite WAL mode), durable goals, checkpoints
│   ├── process/              # Background job lifecycle, process supervision, timeouts
│   ├── filesystem/           # Scoped workspace I/O, paging, path safety
│   ├── git/                  # Guarded Git mutations, diff fingerprinting
│   ├── permissions/          # Permission profiles: safe (default), balanced, full, custom
│   ├── audit/                # Structured event logging, secret redaction
│   ├── search/               # ripgrep integration, symbol searching
│   ├── shared/               # Constants (APP_NAME = 'Unified-MPC-Server'), domain contracts
│   └── domain/               # Result<T, E>, AppError, value objects
├── package.json
└── pnpm-workspace.yaml
```

---

## Supported Clients & IDE Matrix

| Client | Form Factors Supported | MCP Config Discovery | Skill Discovery Roots | Rule / Policy Sync Target |
|---|---|---|---|---|
| **Google Antigravity** | VS Code Extension, Antigravity IDE, CLI `agy`, Desktop | `~/.gemini/config/mcp_config.json`<br>`<workspace>/.gemini/mcp.json` | `~/.gemini/config/skills/`<br>`~/.gemini/skills/`<br>`~/.gemini/antigravity/builtin/skills/`<br>`<workspace>/.gemini/skills/` | `~/.gemini/config/GEMINI.md`<br>`<workspace>/GEMINI.md`<br>`~/.gemini/antigravity/rules/mcp-policy.md` |
| **Cline** | CLI (`~/.cline/`), VS Code Extension | `~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`<br>`<workspace>/.cline/mcp.json` | `~/.cline/skills/`<br>`<workspace>/.cline/skills/` | `.clinerules` (block replacement)<br>`~/.cline/rules/` |
| **OpenCode** | CLI, VS Code Extension, Standalone | `~/.config/opencode/opencode.jsonc`<br>`<workspace>/.opencode/mcp.json` | `~/.config/opencode/skill/`<br>`<workspace>/.opencode/skills/` | `AGENTS.md` (project root)<br>`~/.config/opencode/AGENTS.md` |
| **Freebuff** | Standalone Desktop | Loopback MCP or project state | `.agents/skills/`<br>`<workspace>/skills/` | `AGENTS.md` (root `injectAgentsMd`) |
| **Cursor** | Editor / IDE | `~/.cursor/mcp.json`<br>`<workspace>/.cursor/mcp.json` | `~/.cursor/skills/`<br>`<workspace>/.cursor/skills/` | `.cursor/rules/00-mandatory-policy.mdc` |
| **Claude** | Claude Desktop, Claude Code CLI | `~/.config/Claude/claude_desktop_config.json` | `~/.claude/skills/`<br>`<workspace>/.claude/skills/` | `~/.claude/CLAUDE.md`<br>`<workspace>/CLAUDE.md` |
| **Oh My Pi (OMP)** | CLI / Terminal Agent | `~/.omp/config.json` | `~/.omp/skills/`<br>`<workspace>/.omp/skills/` | `.omp/system.md` |
| **Codex CLI** | CLI Tool | Standard Codex Engine | `~/.codex/skills/`<br>`~/.codex/plugins/cache/` | `AGENTS.md` |

---

## Milestones & Verification Status

| Milestone | Scope & Description | Status | Verification & Hardening Evidence |
|---|---|---|---|
| **Milestone 1** | **Option A Clean Start & Linux-Only Foundation**: Complete monorepo rename from `@lnwjud/*` to `@unified-mpc/*` across 220+ files; deletion of all Windows code/scripts; POSIX XDG runtime; zero backward compatibility. | ✅ **Audited & Hardened** | Full test suite passed across all packages; hardened POSIX process probes; 100 concurrent WAL writes test (`packages/shared/src/linux-foundation.test.ts`); Commits `0c72016`, `9637708`. |
| **Milestone 2** | **Universal Multi-Client Discovery & Policy Sync**: Discovery across Antigravity, Cline, OpenCode, Freebuff, Cursor, Claude, OMP, Codex; `SkillCatalog` multi-root scanner; `McpConfigLoader` JSONC aggregator; `IdeSyncService` atomic P1–P7 markdown compiler & idempotent block sync. | ✅ **Audited & Hardened** | 63/63 tests in `packages/extensions`; JSONC trailing commas and mixed comment parsing; circular/broken symlinks resilience; concurrent multi-client sync; Commit `d5d63fa`. |
| **Milestone 3** | **Bifurcated Dynamic Ingestion Engine**: Strict interface split between `installSkill` (`InstallSkillInput`) and `installServer` (`InstallServerInput`); validation pipelines; multi-target file injection (Antigravity, Cline, OpenCode, Cursor, Claude, Codex); atomic writes; self-aggregation prevention. | ✅ **Audited & Hardened** | 69/69 tests in `packages/extensions`; prototype pollution guards; URL protocol validation (HTTP/HTTPS); self-aggregation loop blocking; `withFileLock` mutex tested with 20 concurrent server installs; Commit `8582f23`. |
| **Milestone 4** | **Zero-Artifact Pruner**: Atomic uninstallation; graceful SIGTERM -> SIGKILL process termination; config purging across all IDEs (Antigravity, Cline, OpenCode, Cursor, Claude, Codex); data directory cleanup; broken symlink & orphaned artifact purging. | ✅ **Audited & Hardened** | 11/11 tests passing in `packages/extensions/src/pruner.test.ts`; strict identifier regex validation; `isSafePurgePath` path traversal guards; Commit `fe6e601`. |
| **Milestone 5** | **Gated ChatGPT Web Gateway & Local Web Control Plane**: Decoupled `apps/cf-gateway` companion gateway with 4-state lifecycle machine (`STOPPED` -> `INITIALIZING` -> `BRIDGE_HEALTHY` -> `SESSION_CONNECTED`); native `node:http` `ControlPlaneServer` (`apps/web`) on `http://127.0.0.1:18765/`; Origin header security guard (403); 412 Precondition Failed gating on `/api/chatgpt-web/connect`; bifurcated ingestion & pruning routes; Obsidian Telemetry UI. | ✅ **Audited & Hardened** | 18/18 tests in `apps/web`; 5/5 tests in `apps/cf-gateway`; Origin HTTP/HTTPS protocol validation; 1MB body limit & 413 Payload Too Large; 50 concurrent requests; Commit `c60781e`. |
| **Milestone 6** | **Unified CLI Commands & End-to-End Integration**: `unified-mpc install skill/server`, `prune skill/server`, `sync`, `web`, `tools list/call`; POSIX path cleanups; full CLI argument parsing and execution dispatching. | ✅ **Audited & Hardened** | 75/75 tests passing in `apps/cli`; shebang and standalone binary entry; child process e2e smoketests (`milestone-6-e2e.test.ts`); exit code validation; capabilities syntax hardening; Commit `b1cc510`. |

---

## Quickstart & Installation

### Requirements
- **OS**: Linux Ubuntu `>=22.04 LTS` (POSIX native)
- **Node.js**: `>=22.0.0` (with native `node:sqlite`)
- **Package Manager**: `pnpm >=9.0.0` (or `corepack enable`)

### Setup Commands
```bash
# 1. Clone repository
git clone https://github.com/soulzerox/Unified-MPC-Server.git
cd Unified-MPC-Server

# 2. Install dependencies
corepack pnpm install

# 3. Build all 21 packages
corepack pnpm build

# 4. Typecheck across monorepo
corepack pnpm typecheck

# 5. Run test suite
corepack pnpm test
```

---

## CLI Usage (`unified-mpc`)

The binary is located at `apps/cli/dist/index.js` or linked globally via `pnpm link`.

```bash
# Check status and health
unified-mpc status

# Synchronize policy and priority rules across IDEs (Antigravity, Cline, OpenCode, Cursor, etc.)
unified-mpc sync
unified-mpc sync --targets antigravity,cursor,cline

# Install an Agent Skill (markdown instructions)
unified-mpc install skill --name my-skill --source /path/to/skill-folder --targets all

# Install an MCP Server (executable stdio/SSE/HTTP process)
unified-mpc install server --name my-server --transport stdio --command "node" --args "/path/to/server.js" --targets antigravity,cursor

# Prune an Agent Skill cleanly
unified-mpc prune skill --name my-skill

# Prune an MCP Server cleanly (kills processes and purges configs)
unified-mpc prune server --name my-server

# Start the Local Web Control Plane
unified-mpc web --port 18765

# Headless downstream tool calling
unified-mpc tools list
unified-mpc tools call memory__search_nodes '{"query": "milestone"}'
```

---

## Local Web Control Plane

The Local Web Control Plane runs at `http://127.0.0.1:18765/`:

- **Obsidian Telemetry Dashboard**: Real-time status cards showing Tunnel URL, Session Lease Token, Bridge Status, Active IDEs, Installed Skills, and Mounted Servers.
- **Hard-Gated ChatGPT Web Connection**: The `[ Connect ChatGPT Web ]` action returns `412 Precondition Failed` unless the gateway bridge has reached `BRIDGE_HEALTHY` state.
- **Bifurcated Management UI**: Dedicated tabs for installing Skills vs installing MCP Servers to prevent polyglot configuration errors.
- **Loopback Origin Security**: Strictly enforces `localhost` / `127.0.0.1` origins, blocking external or non-HTTP schemes with `403 Forbidden`.
- **Payload Protection**: Enforces 1MB maximum body limit on incoming requests (`413 Payload Too Large`).

---

## Security Guardrails

| Guardrail | Location | What It Prevents |
|---|---|---|
| **Origin Policy** | `packages/mcp-server/src/origin-policy.ts` & `apps/web/src/web-server.ts` | Non-localhost and non-HTTP requests to local HTTP endpoints (403 Forbidden). |
| **Mutation Gate** | `packages/mcp-server/src/mutation-policy.ts` | Destructive mutations without explicit user confirmation (fail-closed). |
| **Workspace Path Containment** | `packages/filesystem/` & `packages/extensions/src/pruner.ts` | Path traversal attacks outside registered workspace roots or system directories. |
| **Secret Redaction** | `packages/audit/src/redactor.ts` | API keys, tokens, and private credentials leaking into audit logs. |
| **Self-Aggregation Block** | `packages/extensions/src/mcp-config-loader.ts` | Unified-MPC-Server recursively calling itself as a downstream child. |
| **ChatGPT Gate Invariant** | `apps/web/src/web-server.ts` | Remote sessions initiating against dead or unhealthy tunnel endpoints (412 Precondition Failed). |
| **Permission Profiles** | `packages/permissions/src/profiles.ts` | Unauthorized escalation to full bypass mode without engine approval. |

---

## Authoritative Documentation

- [`SPEC.md`](SPEC.md): Master technical specification and behavioral decisions.
- [`CONTEXT.md`](CONTEXT.md): Domain glossary, architectural invariants, and living context.

---

## License

[MIT](LICENSE)
