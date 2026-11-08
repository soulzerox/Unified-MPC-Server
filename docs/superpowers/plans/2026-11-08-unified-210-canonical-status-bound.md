# Unified #210 slice — bound the canonical status projection

Issue: soulzerox/Unified-MPC-Server#210 (§7 lifecycle, §11 observability).
Follow-up: #684 bounded `/api/canonical-lifecycle`, but `/api/canonical-status`
and the MCP `canonical_index_status` tool still return every ref, Goal overlay,
unsettled job and GC blocker row. A store with a long Goal history therefore
produces a response proportional to the store, and an agent call can exceed its
context budget.

## Why this slice now

`canonicalStatus()` is the last read-only canonical report with an unbounded
row projection. `canonical_revision_list` (`#681`), `canonical_gc_status`
(`#682`) and the WebUI lifecycle card (`#684`) already advertise a `limit` and
keep full-store counts. The status surface has the same shape and the same
failure mode: refs, overlays, jobs, `danglingRefs`, `missingOverlayBases` and
`orphanedPins` are all returned in full.

## What lands

### 1. Honest full-store counts

`CanonicalStatusReport` gains `refCount`, `danglingRefCount`,
`missingOverlayBaseCount` and `orphanedPinCount`. `overlayCount` and
`activeJobCount` already describe the whole store. Every count stays a
full-store count after bounding; only the row arrays shrink.

### 2. `boundCanonicalStatusReport(report, limit)`

New pure export in `packages/workspace/src/canonical-status.ts`. It returns the
same report with `refs`, `overlays`, `jobs`, `danglingRefs`,
`missingOverlayBases` and `orphanedPins` sliced to `limit`, leaving every count
unchanged. The store read and the health verdict are untouched: the verifier
must still scan the store to answer `healthy|degraded`, so this bounds the
response, not the read.

### 3. MCP `canonical_index_status`

Input gains `limit` (1–200, default 50), matching the sibling tools. The handler
applies the shared bound again even if a port ignores it, and the description
states which counts stay full. The catalog and generated tool contract are
regenerated.

### 4. WebUI status card

`GET /api/canonical-status` accepts `?limit=` as an integer from 1 to 200
(default 50). An invalid value returns `400 {"error":"limit must be an integer
from 1 to 200"}` before the store is touched. `CanonicalStatusProbe` accepts
`{ limit?: number }`; `createCanonicalStatusProbe` resolves the limit
defensively and applies the shared bound. The card renders
`refs X of Y`, `overlays X of Y` and `jobs X of Y` and reports blocker counts
from the full-store counts.

## Non-goals

- No mutation: no pin, prune, GC, repair or lease verb from MCP or the WebUI.
- No bound on `unified-mpc index status`: it is an operator verb on a terminal,
  where the whole report is useful.
- No change to the health verdict, drift classification or store semantics.
- No change to the CLI/WebUI lifecycle projections shipped in #684.

## Safety

- The route parser accepts only `^[1-9][0-9]{0,2}$` up to 200 and rejects
  `0`, `201+`, signs, whitespace and repeated parameters before any store read.
- The probe resolves omitted/non-finite/fractional values to a bounded integer,
  so an embedded caller cannot widen the card.
- A store error still degrades only this card with fixed text; nothing from the
  thrown error is copied into the response.
- The status card remains read-only and on-demand.

Refs #210. Parent #210 remains open.
