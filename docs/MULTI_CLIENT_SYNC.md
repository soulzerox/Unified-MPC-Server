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

## The User-Editable P1–Pn Runtime Policy Standard

When AI coding assistants make tool calls, random or unguided tool selection leads to context bloat, hallucinated API calls, and broken state. Unified-MPC therefore keeps an ordered runtime policy. The order is user-editable: semantic IDs identify policies permanently, while P1–Pn is derived from the current array position.

The default order is:

| Position | Stable Policy ID | Resource ID | Type | Enforcement Tier | Mandatory | Role / Directive |
|---|---|---|---|---|---|---|
| **P1** | `session-start:ask-matt` | **`ask-matt`** | Skill | `EVERY_SESSION` | ✅ YES | Load session-start engineering guidance before planning or acting. |
| **P2** | `memory:workspace-selective` | **`native-memory`** | capability | `ON_DEMAND` | Optional | Selective workspace-scoped memory for durable decisions, constraints, preferences, and explicit recall; do not persist every turn. |
| **P3** | `code:pre-edit-context` | **`native-thai-rag`** | capability | `SAFETY_PRE_CHECK` | ✅ YES | Parent-owned Thai-RAG retrieval and mandatory `pre_edit_context` before development-artifact mutation. |
| **P4** | `code-safety:godkiller` | **`godkiller`** | MCP Server | `ON_DEMAND` | Optional | For high-risk changes, set `runGodkillerSafetyCheck=true` on `prepare_code_change`; the parent then invokes only curated `gk_task(action=edit_safe)` after live source/drift/fingerprint validation. |
| **P5** | `optional:sequentialthinking` | **`sequentialthinking`** | MCP Server | `ON_DEMAND` | Optional | Structured reasoning for complex tasks. |
| **P6** | `optional:context7` | **`context7`** | MCP Server | `ON_DEMAND` | Optional | Current library/SDK documentation and examples. |
| **P7** | `optional:filesystem` | **`filesystem`** | MCP Server | `ON_DEMAND` | Optional | Batch and cross-project filesystem operations. |
| **P8** | `optional:ui-skills` | **`ui-skills`** | Skill Bundle | `ON_DEMAND` | Optional | UI/UX and frontend standards. |

Users can add/remove entries, edit enforcement and required-tool metadata, and reorder policies in the Web Control Plane. `policy_snapshot` returns the live reconciled P1–Pn view, including availability and auto-routed discovered resources.

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
