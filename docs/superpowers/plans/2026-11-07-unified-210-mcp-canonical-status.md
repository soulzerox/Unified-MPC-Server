# Unified #210 slice — read-only canonical index status over MCP

Issue: soulzerox/Unified-MPC-Server#210 (§7 lifecycle capabilities, §11 observability)
Status: plan-first, implementation in this slice.

## Why this slice now

The canonical store now has one read-only projection — `canonicalStatus()` — and
three operator surfaces: `unified-mpc index status`, `GET /api/canonical-status`
and the dashboard card. Agents driving the lifecycle have no way to see the same
state: `rag_index_status` reports provider job progress, and
`workspace_index_status` reports the workspace file index, but neither answers
"which ref/commit/tree/manifest is active, which Goal overlay is drifted, which
unsettled jobs root at a missing manifest, and what blocks GC".

§7 lists the public/admin capabilities. The CLI owns the mutation verbs
(`pin`, `unpin`, `prune`, `gc`, `verify`, `repair`). This slice exposes only the
read-only projection over MCP; destructive lifecycle operations stay CLI-only
until they have an MCP lease/approval contract of their own.

## What lands

### 1. Service port

`McpApplicationServices.canonicalIndexStatus?: () => Promise<CanonicalStatusReport>`.
The MCP package already depends on `@unified-mpc/workspace`, so the report type is
shared, not re-declared. A runtime without the service returns `missingService()`
instead of inventing an empty report.

### 2. `canonical_index_status` tool

- `permission: READ`, `readOnlyHint: true`, `destructiveHint: false`, strict empty
  input schema.
- Returns `{ scope: 'canonical-store', ...report }`: health verdict, refs with
  commit/tree/manifest identity and pin reasons, overlays with
  `base=live|drifted|missing`, unsettled index jobs with manifest presence,
  counts, and dangling-ref/missing-overlay-base/orphaned-pin blockers.
- A store read failure returns a fixed `INTERNAL_ERROR` message; the raw error
  (which can name a local path) is not copied into the response.
- The report contains no `providerJobId`, provider `result` payload or raw
  store path.

The name is deliberately distinct from `rag_index_status` (provider execution
history) and `workspace_index_status` (workspace file index).

### 3. Runtime wiring

`apps/cli/src/runtime/stdio-mcp-runtime.ts` builds the six canonical stores at
`<dataPath>/canonical` and calls the same `canonicalStatus()` the CLI and WebUI
use. It runs `assertStorageIdentitySafe(dataPath)` first, matching `index
status`, so a misconfigured data root fails closed.

### 4. Catalog and tests

- Runtime fixture `canonical_index_status: service({}, 'canonicalIndexStatus')`
  so the generated tool contract keeps truthful evidence.
- Registry order, core-tool counts, mutation policy (`read`) and the generated
  `docs/architecture/TOOL_CONTRACT.md` are updated by their own checks.
- Unit tests cover the success projection, a missing service, a throwing
  service, and the read-only annotation.

## Non-goals

- No MCP exposure of `index revision pin/unpin/prune`, `index gc`,
  `index verify` or `index repair` in this slice.
- No new persistence, no store read on server startup, no background polling.
- No change to the CLI, WebUI or canonical store semantics.

Refs #210.
