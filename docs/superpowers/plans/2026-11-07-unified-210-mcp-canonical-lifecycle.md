# Unified #210 slice — canonical lifecycle reports over MCP

Issue: soulzerox/Unified-MPC-Server#210 (§7 lifecycle, §11 observability).
Follow-up to #679 (`canonical_index_status`) and #680 (WebUI lifecycle card).

## Why this slice now

The CLI owns the canonical stores and every mutating lifecycle verb. Two
read-only reports already answer the operator's pre-destructive questions:

- `unified-mpc index revision list` — which revision manifests exist, and which
  refs/pins/overlay bases/jobs still hold each one;
- `unified-mpc index gc status` — whether the GC lease and quarantine make
  `index gc expire --apply` safe right now.

The WebUI projects both (#680) and MCP projects the status verdict (#679), but
an agent driving the runtime still cannot read either report without shelling
out. §11 asks the status surface to expose pin/ref/GC blockers; this slice adds
the missing read-only MCP projection.

## What lands

### 1. `canonical_gc_status` (MCP tool)

No input. Returns `{ scope: 'canonical-store', ...GcStatusReport }` — the same
`gcStatus({ quarantine, lease }, { now: new Date() })` report the CLI verb
prints. Never acquires the lease, never releases a quarantine row.

### 2. `canonical_revision_list` (MCP tool)

Optional `limit` (1–200, default 50). Returns
`{ scope: 'canonical-store', total, returned, revisions }`.

The CLI report is unbounded because a terminal can scroll; an MCP response
cannot. The handler slices the already-built report and always reports `total`
so a truncated answer is visible rather than silent. The store read itself is
unchanged, matching `index revision list` exactly.

### 3. Services

`McpApplicationServices.canonicalRevisionList()` and
`McpApplicationServices.canonicalGcStatus()` are optional, like
`canonicalIndexStatus`. The stdio runtime wires the same `<dataPath>/canonical`
stores under `assertStorageIdentitySafe(dataPath)`, so the MCP report and the
CLI/WebUI report describe one store. A runtime without a canonical store fails
closed with `missingService()`.

### 4. Tests and catalog

- `canonical-tools.test.ts`: both tools project the report, both fail closed
  without a service, both keep a fixed error text on a throwing service, and the
  revision tool proves `total`/`returned` bounding.
- Core tool inventory moves 274 → 276, core 136 → 138; runtime fixtures and the
  generated `docs/architecture/TOOL_CONTRACT.md` are regenerated.
- `docs:tools` is part of `verify:local`.

## Non-goals

- No destructive lifecycle verb over MCP: `pin`, `unpin`, `prune`, `gc`,
  `verify` and `repair` stay CLI-only.
- No new scheduler, timer, lease or store read on startup.
- No provider job ids, result payloads or raw store paths in either response.

## Safety

- Read-only: both tools are `READ` with `readOnlyHint: true`.
- A store error degrades to fixed text, because the thrown error can name a
  local path.
- Revision responses are bounded; `total` keeps the truncation honest.

Refs #210. Parent #210 remains open.
