# Unified #210 slice — bound the canonical GC quarantine projection over MCP

Issue: soulzerox/Unified-MPC-Server#210 (§7 lifecycle, §11 observability).
Follow-up: nonblocking resource finding from the PR #681 review.

## Why this slice now

PR #681 bounded `canonical_revision_list` because an MCP response cannot
scroll, but its sibling `canonical_gc_status` still returns every quarantine
row. A large quarantine backlog therefore produces an unbounded tool result —
the same problem the revision list just stopped having.

## What lands

### 1. Optional `limit`

`canonical_gc_status` gains `limit` (1–200, default 50), validated by the
existing zod schema path, matching `canonical_revision_list`.

### 2. Bounded rows, honest counts

The response slices `quarantine.rows` and adds a top-level `returned` count.
`quarantine.total`, `due` and `inGrace` stay full-store counts, so a truncated
answer is visible rather than silent.

### 3. Tests

`canonical-tools.test.ts` proves the bounded projection, the default limit and
that the full counts survive truncation.

## Non-goals

- No change to `gcStatus()`, the CLI verb or the WebUI card.
- No reachability judgement: a due row is still reported as due, never garbage.
- No new tool, so the generated catalog counts do not move.

## Safety

- Read-only: `READ` with `readOnlyHint: true`; the store read is unchanged.
- A store error still degrades to fixed text, never a local path.

Refs #210. Parent #210 remains open.
