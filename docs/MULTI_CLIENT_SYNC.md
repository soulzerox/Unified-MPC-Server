# Multi-Client Ecosystem & Policy Synchronization

Unified-MPC-Server acts as the single source of truth for MCP configurations, agent skill distribution, and execution priority policies across diverse AI coding environments.

---

## Supported Client Matrix

The policy engine and installer support 7 major AI developer environments natively on Linux:

| Environment | Config / Rule Target File | Scope | Format |
|---|---|---|---|
| **Google Antigravity** | `~/.gemini/antigravity/rules/mcp-policy.md`<br>`${WORKSPACE}/GEMINI.md` | Global & Workspace | Markdown Policy Block |
| **Cursor** | `${WORKSPACE}/.cursor/rules/00-mandatory-policy.mdc` | Workspace | MDC (Frontmatter + Markdown) |
| **Claude Code / Desktop** | `~/.claude/CLAUDE.md`<br>`${WORKSPACE}/CLAUDE.md` | Global & Workspace | Markdown Policy Block |
| **Cline (VS Code)** | `~/.cline/rules/mcp-policy.md`<br>`${WORKSPACE}/.clinerules` | Global & Workspace | Markdown Policy Block |
| **OpenCode / Codex** | `~/.config/opencode/AGENTS.md`<br>`${WORKSPACE}/AGENTS.md` | Global & Workspace | Markdown Policy Block |
| **Oh My Pi (OMP)** | `${WORKSPACE}/.omp/system.md` | Workspace | Markdown Policy Block |
| **Standard Agents** | `${WORKSPACE}/AGENTS.md` | Workspace | Markdown Policy Block |

---

## The Mandatory P1–P7 Execution Priority Standard

When AI coding assistants make tool calls, random or unguided tool selection leads to context bloat, hallucinated API calls, and broken state. Unified-MPC enforces an unambiguous, deterministic execution hierarchy:

| Priority | Resource ID | Type | Enforcement Tier | Mandatory | Role / Directive |
|---|---|---|---|---|---|
| **P1** | **`memory`** | MCP Server | `REALTIME` | ✅ YES | **Realtime Working Memory**: Work-log of active task. Read before starting, write at every critical step, link relations at completion. Never defer until task finish. |
| **P2** | **`thai-rag-mcp`** | MCP Server | `EVERY_SESSION` | ✅ YES | **Persistent Knowledge & Local RAG**: 100% Local RAG. Recall previous decisions before answering; remember permanent facts; code_search before reading whole files. |
| **P3** | **`godkiller`** | MCP Server | `SAFETY_PRE_CHECK` | ✅ YES | **Code Intel & Safety Pre-check**: Mode orchestration (`gk_route`), code exploration (`gk_code`), and blast radius impact analysis (`gk_task`) before any code edits. |
| **P4** | **`sequentialthinking`** | MCP Server | `ON_DEMAND` | Optional | **Structured Reasoning**: Multi-step hypothesis testing and revision for complex architecture, root-cause diagnosis, or large refactors. |
| **P5** | **`context7`** | MCP Server | `ON_DEMAND` | Optional | **Live Docs & Exact SDK APIs**: Query current library/SDK documentation and examples before touching external APIs or cloud services. |
| **P6** | **`filesystem`** | MCP Server | `ON_DEMAND` | Optional | **Batch & Cross-Project Filesystem**: Batch file reads, cross-repo inspection, and recursive directory tree traversal. |
| **P7** | **`ui-skills`** | Skill Bundle | `ON_DEMAND` | Optional | **UI/UX & Frontend Standards**: Component patterns, CSS layout best practices, and responsive design guidelines. |
| **Fallback** | Native Built-in Tools | Fallback | `FALLBACK` | — | Used only when no appropriate MCP tool exists, or for single-file local edits in the active workspace. |

---

## Atomic Block Synchronization Mechanism

Policy synchronization preserves user-customized instructions in target rule files by injecting an identifiable, delimited block:

```markdown
<!-- MCP-POLICY-START -->
# MCP Server Execution Priority — Mandatory Policy
...
<!-- MCP-POLICY-END -->
```

### Injection & Update Algorithm
1. **Detection**: The sync engine inspects the target file for `<!-- MCP-POLICY-START -->` and `<!-- MCP-POLICY-END -->`.
2. **Replacement**: If found, only the delimited section is replaced. All custom user rules before or after the block remain completely untouched.
3. **Appends**: If no block exists, the compiled block is appended cleanly to the end of the file.
4. **Atomic Safety**: All writes use atomic temporary file swaps (`.tmp` -> rename) to avoid file corruption if interrupted.

---

## Triggering Policy Sync

### Via CLI
Synchronize all connected clients or specific IDE targets:

```bash
# Sync all 7 IDE environments
pnpm cli sync

# Sync specific clients
pnpm cli sync --targets cursor,cline,antigravity
```

### Via Web Control Plane API
Send an HTTP POST request to the local daemon:

```bash
curl -X POST http://127.0.0.1:3000/api/policies/sync \
  -H "Content-Type: application/json" \
  -d '{"targets": ["all"]}'
```

---

## Verification & Auditing

To verify that your multi-client configuration files are in sync and correctly formatted:

```bash
pnpm cli doctor
```

The doctor command checks target paths, validates JSON schemas, verifies write permissions across Linux XDG directories, and confirms policy block integrity.

