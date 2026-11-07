# Unified #210 slice — canonical store status in the WebUI

Issue: soulzerox/Unified-MPC-Server#210 (§11 observability, §13 WebUI projection)
Status: plan-first, implementation in this slice.

## Why this slice now

The canonical store already has an operator surface — `unified-mpc index status`
— and a read-only projection, `canonicalStatus()`, but the WebUI shows only
provider job progress. §11 asks one status surface to keep revision, tree,
manifest, pin, overlay and index-job identity apart; today an operator must
leave the dashboard to answer any of those questions. PR #677 also left one
nonblocking review note: the dashboard's legacy-row predicate did not mirror
the store's `parseJob` rule for un-migrated ledgers.

## What lands

### 1. CLI-owned probe

`apps/cli/src/commands/web.ts` exports `createCanonicalStatusProbe(dataPath)`.
It roots the canonical stores at `<dataPath>/canonical` and calls
`canonicalStatus()` with the same store classes `index status` uses.

The web package still does not depend on `@unified-mpc/workspace` and never
reads canonical files directly: the CLI owns the stores, the control plane
only projects the report. A missing or failing probe degrades one card, never
the dashboard.

### 2. `GET /api/canonical-status`

- `200 { available: true, scope: 'canonical-store', status }` when the probe
  succeeds. `Cache-Control: no-store`, like the other read-only endpoints.
- `503 { available: false, scope: 'canonical-store', error }` when no probe is
  wired or the probe throws. The error is fixed text; a store failure never
  leaks a path or stack trace into the dashboard.

### 3. Dashboard card

A `Canonical Index Store` card renders one read-only snapshot:

- summary: health verdict, manifest/pin/overlay/quarantine counts and the
  number of unsettled index jobs;
- one line per ref: ref name, short commit/tree, manifest id, manifest
  presence and entry count, pin state;
- one line per overlay: `base=live|drifted|missing` plus modified/added/deleted
  counts;
- one line per unsettled job: operation id, status, manifest presence;
- one blockers line: dangling refs, missing overlay bases, orphaned pins.

The card refreshes on demand and every 15s. A single in-flight guard prevents
overlapping polls. The card never renders `providerJobId`, provider `result`
payloads or raw store paths.

### 4. Legacy predicate parity

`summarizeRagIndexJobs` now classifies a row as legacy exactly when the store's
`parseJob` would: no `ownerId`, a non-canonical `workspaceId`, or an unknown
status. Rows without a usable job id are dropped, never attributed. This closes
the nonblocking note from PR #677 and keeps the dashboard and `index job list`
in agreement for an un-migrated ledger.

## Tests

- Web: the endpoint returns the probe's report with `no-store`, returns 503
  without a probe and when the probe throws, and the rendered dashboard
  contains the card, refresh control, fetch path, 15s interval and render
  markers.
- Web: the legacy predicate counts un-migrated no-owner and path-workspace rows
  and still drops untrusted rows.
- CLI: `createCanonicalStatusProbe` projects a manifest written under
  `<dataPath>/canonical` and reports it in the snapshot.
