# Unified-MPC-Server Architecture

## 1. System Overview

**Unified-MPC-Server** is a unified, local-first engineering harness and Model Context Protocol (MCP) orchestrator designed specifically for **Linux Ubuntu** environments. It serves as the single source of truth for downstream tools, skills, security policies, and IDE synchronization across modern AI coding agents.

```mermaid
graph TD
    subgraph Clients["Connected AI Clients & IDEs"]
        AG["Google Antigravity<br/>(IDE, Extension, CLI agy)"]
        CR["Cursor IDE"]
        CL["Claude Code CLI"]
        OC["OpenCode"]
        CN["Cline"]
        OM["Oh My Pi (OMP)"]
        CX["Codex CLI"]
    end

    subgraph Entrypoints["Unified-MPC Entrypoints"]
        CLI["apps/cli<br/>(binary: unified-mpc)"]
        WEB["apps/web<br/>(Control Plane SPA :18765)"]
        STDIO["Stdio MCP Server<br/>(Host-connected)"]
        HTTP["Loopback HTTP MCP<br/>(Streamable HTTP :18765)"]
    end

    subgraph CoreEngine["Core Orchestration Engine"]
        EXT["packages/extensions<br/>(Multiplexer, Installer, Pruner, IdeSync)"]
        MCP["packages/mcp-server<br/>(ToolRegistry, Security, Ponytail)"]
        APP["packages/application<br/>(Durable Goals, Checkpoints)"]
        STORE["packages/storage<br/>(node:sqlite WAL Database)"]
        CAP["packages/capabilities<br/>(Linux Shell, Process, System)"]
        FS["packages/filesystem<br/>(Path Guard, Scoped I/O)"]
        PERM["packages/permissions<br/>(Safe / Balanced / Full Bypass)"]
        AUDIT["packages/audit<br/>(Redacted Structured Logs)"]
    end

    subgraph Gateway["Remote Connectivity"]
        CFG["apps/cf-gateway<br/>(Decoupled Cloudflare Tunnel Companion)"]
        CW["ChatGPT Web / Remote Client"]
    end

    Clients -->|Direct Invocation / Rules| Entrypoints
    Entrypoints --> CoreEngine
    CW -.->|OAuth PKCE / Tunnel| CFG
    CFG -->|Loopback HTTP| HTTP
```

---

## 2. 100% Linux Ubuntu Native Target

Unified-MPC-Server is built from the ground up as a pure POSIX / Linux XDG-compliant service:
- **No Electron**: Desktop GUI dependencies have been eliminated in favor of a zero-overhead local Web Control Plane SPA (`apps/web`) and the native CLI binary (`apps/cli`).
- **No Windows / macOS Code**: Complete absence of PowerShell, Windows Sandbox, COM/Registry APIs, or macOS Swift bridges.
- **Node.js Native SQLite**: Leverages Node.js `>=22.0.0` built-in `node:sqlite` (`DatabaseSync`) in WAL mode, avoiding C++ native add-on compilation headaches.
- **XDG Base Directory Specification**:
  - Configuration & Data: `~/.local/share/unified-mpc/` (overridable via `UNIFIED_MPC_DATA_PATH`)
  - Runtime Database: `~/.local/share/unified-mpc/storage.sqlite`
  - Audit Logs: `~/.local/share/unified-mpc/audit.log`

---

## 3. Package Structure & Responsibilities

The monorepo contains 21 focused packages and applications:

| Category | Path | Package | Responsibility |
|---|---|---|---|
| **Applications** | `apps/cli` | `@unified-mpc/cli` | Standalone native CLI binary (`unified-mpc`) |
| | `apps/web` | `@unified-mpc/web` | Local Web Control Plane SPA & native `node:http` server |
| | `apps/cf-gateway` | `@unified-mpc/cf-gateway` | Decoupled Cloudflare Tunnel & ChatGPT Web companion |
| **Extensions & Ingestion** | `packages/extensions` | `@unified-mpc/extensions` | Parent-owned canonical skill/MCP registry, multi-client discovery, explicit compatibility exports, zero-artifact pruner, IDE policy sync |
| **MCP & Runtime** | `packages/mcp-server` | `@unified-mpc/mcp-server` | Core MCP server, two-tier catalog, security policies, Ponytail runtime |
| | `packages/capabilities` | `@unified-mpc/capabilities` | Linux process execution, shell task store, system probes, CDP |
| **Application & State** | `packages/application` | `@unified-mpc/application` | Durable goals, session continuation, checkpointing |
| | `packages/storage` | `@unified-mpc/storage` | SQLite database wrapper (WAL mode), repositories |
| | `packages/workspace` | `@unified-mpc/workspace` | Workspace registry, boundary guards, secret detection |
| **Infrastructure** | `packages/filesystem` | `@unified-mpc/filesystem` | Scoped filesystem operations, patch applier |
| | `packages/process` | `@unified-mpc/process` | Child process spawning, ring buffers, timeouts |
| | `packages/git` | `@unified-mpc/git` | Git status parsing, diff fingerprints, safe commits |
| | `packages/permissions`| `@unified-mpc/permissions`| Permission profiles (Safe, Balanced, Full Bypass) |
| | `packages/audit` | `@unified-mpc/audit` | Structured logging with cryptographic secret redaction |
| | `packages/search` | `@unified-mpc/search` | Fast ripgrep searching and symbol inspection |
| | `packages/shared` | `@unified-mpc/shared` | Shared contracts, constants, env resolution |
| | `packages/domain` | `@unified-mpc/domain` | `Result<T, E>`, `AppError`, value objects |
| | `packages/codex` | `@unified-mpc/codex` | Codex CLI delegation adapter and discovery |
| | `packages/project` | `@unified-mpc/project` | Project type and toolchain detection |
| | `packages/ipc-contracts`| `@unified-mpc/ipc-contracts`| IPC message type definitions |
| **Native Host** | `native/linux-host` | Rust crate | POSIX low-level process and terminal helper |

---

## 4. Security Boundaries & Guardrails

Unified-MPC-Server enforces strict defensive guardrails:

1. **Loopback-Only Origin Policy**:
   The Local Web Control Plane (`http://127.0.0.1:3000/`) and MCP HTTP endpoint (`127.0.0.1:18765`) default to loopback. Public MCP access requires explicit hostname/origin allowlists; foreign values receive `403 Forbidden`.
2. **Fail-Closed Mutation Policy**:
   Tools are categorized into `READ`, `WRITE`, `EXECUTE`, and `DANGEROUS`. Any unrecognized or unclassified tool call fails closed.
3. **Workspace Boundary Path Guards**:
   All filesystem reads, writes, and deletions are strictly resolved against registered workspace roots. Path traversal attacks (`../`) are intercepted and rejected with `PERMISSION_DENIED`.
4. **Secret Redaction**:
   Audit logs automatically redact API tokens (`sk-...`, `ghp_...`, Bearer tokens, private keys) before persisting them to disk.
5. **Double-Leasing Prevention**:
   Remote ChatGPT Web sessions require an explicit lease token and state transition gate (`BRIDGE_HEALTHY`), preventing conflicting workers from mutating the workspace simultaneously.

---

## 5. Runtime Workspace Harness for ChatGPT Web

The MCP transport does not rely on prompt compliance alone for coding policy. `ToolRegistry` maintains a transport-session `HarnessActivationLedger` keyed by session + workspace and enforces the following runtime sequence:

```text
ChatGPT / MCP client
        │
        ▼
workspace_bootstrap(workspaceId)
        │
        ├── read + SHA-256 fingerprint AGENTS.md (fail closed if unavailable)
        ├── discover mandatory native children
        │     ├── memory
        │     └── thai-rag-mcp
        ├── reject workspace-scoped definitions for mandatory-native promotion
        ├── connect + pin child sessions
        ├── fingerprint child launch/catalog contracts
        └── verify required tool names
              │
              ▼
prepare_code_change(workspaceId, filePath)
        │
        ├── revalidate AGENTS.md fingerprint
        └── thai-rag-mcp / pre_edit_context
              │
              ▼
      one-path authorization
              │
              ▼
        code mutation
              │
              └── authorization consumed after success
```

The default mandatory set is `memory` and `thai-rag-mcp`. Bootstrap only accepts globally/user-configured child definitions for trusted mandatory promotion; a repository-controlled `.cursor/mcp.json`, `.claude/mcp.json`, or other workspace MCP file cannot replace one of these trusted children. The bootstrap validates the capabilities the harness depends on (`memory`: `search_nodes`, `create_entities`, `add_observations`; `thai-rag-mcp`: `pre_edit_context`). Missing mandatory children, missing capabilities, stale contracts, or an unreadable `AGENTS.md` all fail closed. `godkiller` stays outside workspace readiness as an optional `ON_DEMAND` safety analyzer. For high-risk work, `prepare_code_change(..., runGodkillerSafetyCheck=true)` uses a curated parent-owned route that accepts only a non-workspace-scoped, drift-free Godkiller contract and invokes the fixed `gk_task(action=edit_safe)` operation with live fingerprints.

`working_memory_search` and `working_memory_record` are curated first-party adapters over the pinned `memory` child. The child server is not flattened wholesale into the top-level MCP catalog. This keeps the ChatGPT-facing surface stable while preserving child contract fingerprints at dispatch time.

HTTP and stdio transports share the same harness ledger across request-scoped `ToolRegistry` recreation, so bootstrap/pre-edit state follows the MCP transport session rather than one transient request object. MCP `instructions` explicitly tell coding clients to call `workspace_bootstrap` before the first code mutation and `prepare_code_change` before each development-artifact mutation; the registry still enforces both rules even if a client ignores those instructions.

Mutation approval remains a host boundary rather than an MCP-client assertion. `startMcpStdio` is the common composition root for Unified-MPC CLI, standalone local STDIO, and IDE integrations that launch the stdio entrypoint, and it installs the shared trusted human exact-action provider unless the embedding host supplies its own provider. The default provider uses only out-of-band human surfaces (OS dialog or controlling TTY), never MCP stdin; a real denial is terminal and absence of every trusted surface fails closed. HTTP composition intentionally does not install this provider, so ChatGPT Web/providerless HTTP sessions cannot turn `userConfirmed` into host approval and approval-required mutations remain denied.

