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
- **Zero-Artifact Pruner**: A recoverable uninstallation transaction that cleanly shuts down child processes, purges target configuration references, and moves approved data paths into Recovery Trash before completion. Failed follow-up mutations restore moved data when possible and report recovery status.
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
12. **Mutation Recovery**: Destructive extension data removal must use Recovery Trash; config mutation transactions use an OS lock so separate processes cannot interleave snapshots and writes. Checkpoint key parents must be owner-controlled, mode `0700`, and free of symlink components.

---

## 3. Core Directory & Architecture Map

| Directory | Purpose |
|---|---|
| `apps/cli/` | Native CLI binary (`unified-mpc`) providing headless operations for terminal agents. |
| `apps/web/` | Native `node:http` local web control plane serving the modular Obsidian Telemetry Dashboard on `http://127.0.0.1:18765/`. |
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
| Scheduled Continuation | `packages/application/src/scheduled-continuation-service.ts` | Unified-MPC durable continuation service; not externally advertised in v1. |

---

## 7. Milestones & Implementation Progress

| Milestone | Scope | Status | Verification & Evidence |
|---|---|---|---|
| **Milestone 1** | **Option A Clean Start & Linux-Only Foundation**: Monorepo namespace `@unified-mpc/*` rename across 220+ files; complete Windows code and script deletion; POSIX XDG runtime; zero backward compatibility. | ✅ **Audited & Hardened** | Full test suite passed across all packages; hardened POSIX process probes; 100 concurrent WAL writes test (`packages/shared/src/linux-foundation.test.ts`); Commits `0c72016`, `9637708`. |
| **Milestone 2** | **Universal Multi-Client Discovery & Dynamic Policy Sync**: Discovery across Antigravity, Cline, OpenCode, Freebuff, Cursor, Claude, OMP, Codex; `SkillCatalog` multi-root scanner; `McpConfigLoader` JSONC aggregator; stable semantic policy IDs with user-editable P1–Pn execution positions; atomic/idempotent `IdeSyncService` block sync. | ✅ **Audited & Hardened** | Runtime reconciliation, reorder-safe policy compilation, policy-driven mandatory child capabilities, and multi-client sync are covered by the current extensions tests. |
| **Milestone 3** | **Parent-Owned Bifurcated Ingestion Engine**: `installSkill` and `installServer` remain strictly separated, but LLM-facing `skills_install`/`mcp_install` are hard-bound to the canonical Unified MCP data store instead of per-client IDE directories/configs. Platform targets remain an explicit compatibility/export seam. | ✅ **Audited & Hardened** | Canonical skill store and child-MCP registry are covered by installer/loader/runtime tests; LLM schemas reject platform-target overrides; self-aggregation, URL, symlink, and prototype-pollution guards remain enforced. |
| **Milestone 4** | **Zero-Artifact Pruner**: Atomic uninstallation; graceful SIGTERM -> SIGKILL process termination; config purging across all IDEs (Antigravity, Cline, OpenCode, Cursor, Claude, Codex); data directory cleanup; broken symlink & orphaned artifact purging. | ✅ **Audited & Hardened** | 11/11 tests passing in `packages/extensions/src/pruner.test.ts`; strict identifier regex validation; `isSafePurgePath` path traversal guards (SPEC.md line 218); Commit `fe6e601`. |
| **Milestone 5** | **Gated ChatGPT Web Gateway & Web Control Plane**: Decoupled `apps/cf-gateway` lifecycle plus a loopback `node:http` control plane for telemetry, inventory, policies, gateway control, and safe pruning. Extension installation is deliberately absent from WebUI and its REST surface; LLM install flows go through the parent-owned canonical store. | ✅ **Audited & Hardened** | Current Web tests cover loopback Host/Origin/capability gates, 1 MiB body limit, concurrent requests, inventory/prune behavior, and assert that the former skill/server install endpoints return 404. |
| **Milestone 6** | **Unified CLI Commands & End-to-End Integration**: `unified-mpc install skill/server`, `prune skill/server`, `sync`, `web`, `tools list/call`; POSIX path cleanups; full CLI argument parsing and execution dispatching. | ✅ **Audited & Hardened** | 75/75 tests passing in `apps/cli`; shebang and standalone binary entry; child process e2e smoketests (`milestone-6-e2e.test.ts`); exit code validation; capabilities syntax hardening; Commit `b1cc510`. |

---

## 8. Comprehensive Audit, Stress Test & Hardening Report (/goal Loop)

Following the Matt Pocock `/diagnosing-bugs` and `/scaffold-exercises` TDD workflow, an exhaustive audit loop was executed across all 6 milestones with zero skipping:

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
    - Verified 412 state gate enforcement on `POST /api/chatgpt-web/connect` across full state machine lifecycle (STOPPED -> 412, BRIDGE_HEALTHY -> 200, SESSION_CONNECTED -> 412); `POST /api/chatgpt-web/disconnect` clears lease.
   - Stress tested with 50 concurrent requests (`milestone-5-stress.test.ts`).
6. **Unified CLI & Monorepo Verification (Milestone 6)**:
   - Added shebang and `createDefaultCliDependencies` to `apps/cli/src/index.ts`, enabling standalone CLI binary execution.
   - Fixed child process execution to reliably exit with correct codes (0, 1, 2).
   - Diagnosed and fixed syntax/bracket issues in `packages/capabilities` (`durable-shell-task-store.ts` and `browser-cdp-protocol.ts`).
   - Verified via subprocess e2e smoketests (`milestone-6-e2e.test.ts`).
   - Full monorepo `corepack pnpm typecheck` (`tsc --build`) passes with 0 errors across all 21 packages.
   - Full monorepo `corepack pnpm test` passes 100% across all 21 packages.

---

## 9. Codebase Hygiene & Legacy Bloat Removal (Option 1 — Completed)

Following the Matt Pocock `/improve-codebase-architecture` and `ponytail-audit` workflow, the codebase was systematically purged of all legacy `lnwjud` residue to achieve a pure, zero-debt Linux Ubuntu architecture (Commit `58352f4`):

1. **Purged Legacy Scripts (8 files deleted)**:
   - Eliminated Electron startup and cleanup scripts (`scripts/diagnose-electron-startup.mjs`, `scripts/electron-startup-cleanup.mjs`).
   - Eliminated macOS smoke/verification scripts (`scripts/stage-macos-smoke-app.sh`, `scripts/verify-macos-release.sh`).
   - Eliminated legacy release packager and platform scripts (`scripts/collect-release-assets.mjs`, `scripts/verify-platform-release.mjs`, `scripts/verify-linux-release.sh`, `scripts/update-runtime-dependencies.mjs`).
   - Removed empty directory `scripts/lib/`.
2. **Purged macOS Swift Native Host (13 files deleted)**:
   - Completely deleted `native/macos-host/` (`Package.swift`, `Sources/`, `Tests/`), retaining solely the Linux Rust host (`native/linux-host`).
3. **Purged Obsolete Multi-Platform Test Suites (21 files deleted)**:
   - Deleted `tests/packaging/` (Electron packaging, macOS notarization, AppImage layout).
   - Deleted `tests/release/` (tests asserting on `apps/desktop`, `.ps1` files, and `lnwjud.exe`).
   - Deleted `tests/integration/cross-platform-release-scenarios.test.ts` and `platform-composition.test.ts`.
   - Verified remaining integration tests: `codex-review-flow.test.ts` and `mcp-development-flow.test.ts` pass 100%.
4. **Purged Obsolete GitHub Actions Workflows (3 files deleted, 1 rewritten)**:
   - Deleted `dev-installer.yml` (Windows installer), `release.yml` (Electron release), and `runtime-dependency-update.yml`.
   - Rewrote `.github/workflows/ci.yml` to a clean Linux Ubuntu 24.04 CI pipeline (Node 22, pnpm, typecheck, lint, package tests, root integration tests, build, and CLI binary execution).
5. **Standardized Runtime Environment & CLI Usability**:
   - Cleaned `.gitignore` removing all legacy `apps/desktop`, `native/macos-host`, and `lnwjud` lines.
   - Enforced `UNIFIED_MPC_*` environment variables across `packages/capabilities` (`UNIFIED_MPC_BROWSER_*`), `packages/shared` (`UNIFIED_MPC_UNRESTRICTED`), and `apps/cli` (`UNIFIED_MPC_ALLOWED_ROOTS`, `UNIFIED_MPC_CHECKPOINT_KEY_BASE64`).
   - Added `--help`, `-h`, `help` usage dispatcher to `apps/cli/src/index.ts` returning exit code 0.
   - Verified full monorepo typecheck clean (0 errors) and 100% tests passing across all 21 packages.

---

## 10. Real-World Host Dogfooding & Live Smoke Testing (Option 2 — Completed)

Comprehensive host-environment dogfooding and smoke testing verified all runtime entrypoints and subsystems in a live Linux environment:

1. **CLI Runtime & Tool Execution**:
   - Wired `ToolRegistry` from `@unified-mpc/mcp-server` into default CLI dependencies (`apps/cli/src/index.ts`).
   - Verified `unified-mpc status` (exit code 0, workspace inventory).
   - Verified `unified-mpc doctor` (exit code 0, operational database pass).
   - Verified `unified-mpc tools list` (enumerates all downstream tools) and `unified-mpc tools call tool_categories '{}'` (executes live tool returning structured JSON).
2. **Dynamic Ingestion & Pruning Lifecycle**:
   - Installed test skill `dogfood-test-skill` into workspace (`.gemini/skills/dogfood-test-skill/SKILL.md`) via CLI.
   - Identified and fixed scope resolution in `PrunerService` (`packages/extensions/src/pruner.ts`) and `apps/cli/src/commands/prune.ts`: auto-infer `scope: 'workspace'` when `--workspace` is specified and support explicit `--scope`.
   - Pruned skill verifying 100% removal with zero lingering files.
   - Installed test server `dogfood-sqlite` into workspace `.gemini/mcp.json` and pruned it, confirming clean entry removal while preserving valid JSON syntax.
3. **Multi-IDE Dynamic Policy Synchronization**:
   - Synchronizes the persisted P1–Pn runtime policy across `.cursor/rules/00-mandatory-policy.mdc`, `.clinerules`, `~/.cline/rules/mcp-policy.md`, `~/.gemini/antigravity/rules/mcp-policy.md`, `GEMINI.md`, and `AGENTS.md`.
   - P-positions are user-editable execution order; semantic policy IDs remain stable when reordered.
   - Verified strict idempotency: repeated executions maintain exactly one policy block without duplication.
4. **Local Web Control Plane**:
   - Refactored `apps/cli/src/index.ts` daemon lifecycle so the web process remains running until SIGINT/SIGTERM.
   - Probed `GET /`: Returned 200 OK with Obsidian Telemetry dashboard HTML.
   - Probed `GET /api/chatgpt-gateway/status`: Returned 200 OK (`{"state":"STOPPED","localPort":18765}`).
    - Probed `POST /api/chatgpt-web/connect`: Returned 412 Precondition Failed, enforcing the bridge health invariant.
   - Probed foreign `Origin`: Returned 403 Forbidden (`Origin not allowed: loopback only`).
   - Probed loopback `Origin`: Returned 200 OK with CORS headers.
   - Probed `GET /api/policies`: Returns the live reconciled P1–Pn policy snapshot; `POST /api/policies` persists user edits and reorder operations while preserving semantic IDs.
   - Verified clean graceful shutdown on termination.

---

## 11. Web Control Plane SPA Reactivity, Residual Naming Purge & Diagnosing-Bugs Loop (Completed)

1. **Option 1: Interactive Reactive Web Control Plane SPA (`apps/web`)**:
   - Kept UI dependency-free and modular: `dashboard-html.ts` composes `ui/tokens.ts`, `ui/views.ts`, and `ui/client-script.ts`.
   - Live telemetry polling covers `/api/status`, `/api/logs`, `/api/servers`, `/api/skills`, and `/api/chatgpt-gateway/status`.
   - Policy sync, inventory, gateway control, and prune actions call the real REST routes; extension installation is intentionally excluded from WebUI and owned by LLM-facing parent MCP tools.
   - Server pruning uses a server-issued opaque `serverId`; raw PID input is rejected.
   - Host/Origin checks, mutation Origin requirements, 1 MiB body limits, and route failure handling are covered by `apps/web/src/web-server.test.ts`.
   - Detailed remediation record: `docs/AUDIT_REMEDIATION.md`.

2. **Option 2: Residual `lnwjud` Purge & Skill Modernization**:
   - Created `.agents/skills/unified-mpc-scheduled-continuation/SKILL.md` aligned with 100% Linux Ubuntu runtime and POSIX commands (`gh run watch <RUN_ID> -i 20 --exit-status`).
   - Removed obsolete legacy scheduled-continuation alias; only `.agents/skills/unified-mpc-scheduled-continuation/` remains.
   - Cleaned `AGENTS.md` removing Windows PowerShell snippets, enforcing Linux POSIX commands, updating skill pointers, and replacing `lnwjud approval gates` with `unified-mpc approval gates`.
   - Modernized `packages/mcp-server/src/server.ts` instructions.
   - Modernized `.env.example` to use `UNIFIED_MPC_*` variables and Linux POSIX paths (`~/.local/share/unified-mpc`).
   - Contract test in `packages/mcp-server/src/scheduled-continuation-skill-contract.test.ts` passes 2/2 tests.

3. **Diagnosing-Bugs Loop & Monorepo Stress/E2E Verification**:
   - Followed `/diagnosing-bugs` discipline across all modules and milestones.
   - Monorepo full typecheck: `corepack pnpm typecheck` (`tsc --build`) passes with 0 errors across all 21 packages.
   - Monorepo full test suite: `npx vitest run` passes 195/195 test files (1,785 passed, 0 failures).
   - Root integration tests: `codex-review-flow.test.ts` (1/1) and `mcp-development-flow.test.ts` (1/1) pass 100%.
   - Milestone 6 CLI E2E tests: `milestone-6-e2e.test.ts` (6/6 passing).
   - Milestone 5 Web stress tests: `milestone-5-stress.test.ts` (12/12 passing).
   - Milestone 2 & 3 extensions stress tests: `milestone-2-stress.test.ts` (7/7) and `milestone-3-stress.test.ts` (6/6 passing).
   - Milestone 1 Linux foundation tests: `linux-foundation.test.ts` (3/3 passing).
   - Milestone 4 Pruner tests: `pruner.test.ts` (11/11 passing).
   - 0 bugs detected; 100% clean and green.
