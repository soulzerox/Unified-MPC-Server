> **Future — not in v0.1.** The P1–P7 priority compile writes into third-party IDE config directories — per-target format contracts the audit deferred until the v0.1 request-policy engine is proven and per-target atomic-write tests pass. Required seam: IdeTargetWriter (future-defined). Primary source preserved below. Status: docs/FUTURE.md entry 6. The v0.1 request-level policy engine lives in docs/POLICY-ENGINE.md.

# Policy Engine — Priority & Enforcement Compilation

The policy engine maintains the mandatory execution priority table — the user's ranking of which MCP servers and skills must be used, in what order, and with what enforcement level.

## Data Model

`config/policies.json`:
```json
[
  {
    "priority": "P1",
    "resourceId": "memory",
    "resourceType": "server",
    "mandatory": true,
    "enforcement": "REALTIME",
    "directive": "บันทึก current progress, next goal, hypothesis ทุก step สำคัญ ห้ามรอจบงาน"
  },
  {
    "priority": "P2",
    "resourceId": "thai-rag-mcp",
    "resourceType": "server",
    "mandatory": true,
    "enforcement": "EVERY_SESSION",
    "directive": "recall ก่อนตอบเรื่องอดีต, remember ข้อมูลถาวร, code_search ก่อนอ่านไฟล์ยาว"
  },
  {
    "priority": "P3",
    "resourceId": "godkiller",
    "resourceType": "server",
    "mandatory": true,
    "enforcement": "SAFETY_PRE_CHECK",
    "directive": "ใช้ gk_task ตรวจ blast_radius และ safety pre-check ก่อนแก้โค้ด"
  }
]
```

### Fields

- `priority`: `P1` through `P7`. Unique — no two entries share a priority.
- `resourceId`: the ID of an installed server or skill.
- `resourceType`: `"server"` or `"skill"`.
- `mandatory`: if `true`, the agent MUST follow this without exception.
- `enforcement`: one of `REALTIME`, `EVERY_SESSION`, `SAFETY_PRE_CHECK`, `ON_DEMAND`.
- `directive`: natural-language directive text compiled into system prompts.

## Compile

`compile()` produces markdown text written to every IDE target:

```markdown
# MCP Server Execution Priority — Mandatory Policy

| Priority | Resource | Type | Enforcement | Mandatory |
|---|---|---|---|---|
| P1 | memory | server | REALTIME | ✅ YES |
| P2 | thai-rag-mcp | server | EVERY_SESSION | ✅ YES |
| P3 | godkiller | server | SAFETY_PRE_CHECK | ✅ YES |

## Enforcement Rules

1. **P1 memory** (REALTIME): บันทึก current progress, next goal, hypothesis ทุก step สำคัญ ห้ามรอจบงาน
2. **P2 thai-rag-mcp** (EVERY_SESSION): recall ก่อนตอบเรื่องอดีต, remember ข้อมูลถาวร, code_search ก่อนอ่านไฟล์ยาว
3. **P3 godkiller** (SAFETY_PRE_CHECK): ใช้ gk_task ตรวจ blast_radius และ safety pre-check ก่อนแก้โค้ด
```

## Distribution Targets

The compiled output is synchronized across all enabled IDE targets using atomic temp-rename writes:

| Target | Target file | Method |
|---|---|---|
| Cursor | `.cursor/rules/00-mandatory-policy.mdc` | Overwrite entire file with frontmatter: `alwaysApply: true` |
| Cline / Roo Code | `.clinerules` | Replace section between `<!-- MCP-POLICY-START -->` and `<!-- MCP-POLICY-END -->` markers |
| Claude Code | `~/.claude/CLAUDE.md` | Replace section between `<!-- MCP-POLICY-START -->` and `<!-- MCP-POLICY-END -->` markers |
| Antigravity | `~/.gemini/antigravity/rules/mcp-policy.md` | Overwrite entire file |
| OpenCode | `AGENTS.md` (or `.opencode/rules/mcp-policy.md`) | Overwrite or block replace |
| Oh My Pi (omp) | `.omp/system.md` (or `AGENTS.md`) | Overwrite or block replace |
| Continue.dev | `~/.continue/config.json` | Merge into `systemMessage` field |

## Concurrency & File Safety

During policy synchronization:
- An in-process file lock prevents concurrent writes if multiple IDEs trigger sync simultaneously.
- Atomic writes (`write temp file -> fs.rename`) ensure no client ever reads a truncated or corrupted file.
