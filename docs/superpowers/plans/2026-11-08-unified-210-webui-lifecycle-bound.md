# Unified #210 slice — bound the WebUI lifecycle projection

Issue: soulzerox/Unified-MPC-Server#210 (§7 observability).
Follow-ups: PR #680 review finding (the WebUI card loads every revision and
every quarantine row, and reads one pin file per manifest) and PR #678 review
finding (the dashboard legacy-row predicate is case-insensitive while the store
is not).

## Why this slice now

`/api/canonical-lifecycle` is the only read-only canonical surface still
unbounded. It calls `canonicalRevisionList` with no limit, so a store with
thousands of manifests produces a response proportional to the store, and each
manifest costs one `pins.list()` read even when the response is truncated by
the caller. The MCP `canonical_revision_list` tool already advertises `limit`
(1–200, default 50) but only slices the finished report, so the pin reads are
still unbounded and `total` would become the returned count once the service is
bounded.

Separately, `summarizeRagIndexJobs` accepts any hex casing for the workspace
UUID (`/i`) while `ThaiRagIndexJobStore.parseJob` and
`parseCanonicalWorkspaceId` only accept lowercase. An uppercase UUID therefore
renders as an attributed job in the dashboard and as a legacy row in the store.

## What lands

### 1. `canonicalRevisionList(deps, options?)`

- New `CanonicalRevisionListOptions { limit?: number }`; omitted means no bound.
- Manifests are sorted newest-first (`createdAt` desc, `manifestId` asc) before
  any pin read, then sliced to `limit`, and only retained manifests are read
  through `RevisionPinRegistry.list`. Pin I/O is bounded, not just the output.
- `CanonicalRevisionListReport` gains `total`, the full manifest count before
  the limit, so every projection can say "returned X of Y".
- The CLI `index revision list` keeps calling it unbounded and prints
  `revisions <n> of <total>` only when the report is truncated.

### 2. WebUI probe and route

- `CanonicalLifecycleProbe` accepts `{ limit?: number }`.
- `createCanonicalLifecycleProbe` defaults to 50, caps at 200, forwards the
  limit to `canonicalRevisionList`, and slices `gc.quarantine.rows` while
  keeping the full `total`, `due` and `inGrace` counts and adding `returned`.
- `GET /api/canonical-lifecycle` accepts `?limit=` as an integer from 1 to 200
  (default 50). An invalid value returns `400 {"error":"limit must be an
  integer from 1 to 200"}` without touching the store.
- The dashboard card renders `revisions <returned> of <total>` and appends
  `· showing <returned> of <total>` to the quarantine line when truncated.

### 3. MCP parity

- `canonical_revision_list` forwards `limit` to the service port and uses
  `report.total` for its `total` field, so the bounded service and the tool
  agree. `McpApplicationServices.canonicalRevisionList` and both CLI adapters
  (in-process and stdio runtime) forward the option.

### 4. Uppercase-UUID legacy parity

- `summarizeRagIndexJobs` drops `/i`, matching `ThaiRagIndexJobStore.parseJob`
  and `parseCanonicalWorkspaceId`. An uppercase workspace UUID is a legacy row,
  counted but never attributed.
- A regression row is added to `rag-index-progress.test.ts`; the expected
  legacy count becomes 4.

## Non-goals

- No mutation: no prune, expire, pin or unpin from the WebUI or MCP.
- No new persistence format or migration.
- No bound on the CLI `index revision list` output: it is an operator verb, and
  the store owner asked for the whole history.
- No change to the quarantine `due`/`inGrace` semantics; they still describe
  the whole store, not the returned window.

## Safety

- The route never copies a store error into the response; a failed probe still
  degrades only this card with fixed text.
- The `limit` parser accepts only `^[1-9][0-9]{0,2}$` and rejects `0`, `201+`,
  signs, whitespace and repeated parameters before any store read.
- The card is read-only and on-demand; it does not poll.
