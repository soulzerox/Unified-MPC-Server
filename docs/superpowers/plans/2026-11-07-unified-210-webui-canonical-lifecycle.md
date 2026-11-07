# Unified #210 slice — canonical revision history and GC detail in the WebUI

Issue: soulzerox/Unified-MPC-Server#210 (§7 lifecycle, §11 observability)
Status: plan-first, implementation in this slice.

## Why this slice now

The dashboard can now show the canonical status projection: refs with
commit/tree/manifest identity, Goal overlays, unsettled jobs and GC blockers.
It still cannot answer the two questions an operator asks before running a
destructive lifecycle verb:

- which revision manifests exist, and which refs/pins/overlay bases/jobs still
  hold each one (`unified-mpc index revision list`);
- whether the GC lease and quarantine make `index gc expire --apply` safe right
  now (`unified-mpc index gc status`).

§11 asks status/WebUI to distinguish revision, tree, manifest identity and
pin/ref/GC blockers. Both reports already exist and are read-only; only the
operator surface is missing.

## What lands

### 1. CLI-owned probe

`apps/cli/src/commands/web.ts` exports `createCanonicalLifecycleProbe(dataPath)`:

- builds the same canonical stores under `<dataPath>/canonical` that
  `index revision list` and `index gc status` read, and calls
  `canonicalRevisionList()` and `gcStatus({ quarantine, lease }, { now: new Date() })`;
- returns `{ revisions, gc }`.

`runWeb` already refuses to start when `assertStorageIdentitySafe(dataPath)`
throws, so a probe cannot run against a drifted identity; the probe itself
stays a pure read, matching `createCanonicalStatusProbe`. The web package still
never reads canonical stores directly.

### 2. Endpoint

`CanonicalLifecycleProbe` option on `ControlPlaneServer`, and
`GET /api/canonical-lifecycle`:

- `200 { available: true, scope: 'canonical-store', revisions, gc }` with
  `Cache-Control: no-store`;
- `503 { available: false, scope: 'canonical-store', error: 'Canonical store lifecycle detail unavailable' }`
  when no probe is wired or the probe throws. The error is fixed text; no path,
  stack trace or provider payload is copied into the response.

### 3. Dashboard card

`canonical-lifecycle-card` with `canonical-lifecycle-refresh-btn` and a
`canonical-lifecycle` container:

- `revisions N`, then one line per revision: manifest id, short commit/tree,
  entry count, created time, and `refs/pins/overlays/index-jobs` markers only
  when non-empty (an unreachable revision stays visibly bare);
- `gc status: healthy|degraded`, one lease line (free/held/released/corrupt),
  `quarantine N (due X, in-grace Y)`, then one line per row with target and
  expiry;
- refresh button and one initial load, no interval: revision history grows with
  the store, so this stays an on-demand snapshot. In-flight guard plus a
  `loaded <time>` line so an old snapshot is not mistaken for live state.

### 4. Tests

- `apps/web/src/canonical-lifecycle-view.test.ts`: endpoint 200, missing probe
  503, throwing probe 503 with fixed text and no path leak, and dashboard
  markup/renderer markers (revision line, lease line, quarantine line, refresh
  wiring, no interval).
- `apps/cli/src/commands/web.test.ts`: the probe projects a manifest and a
  quarantined artifact written under `<dataPath>/canonical`, plus the free GC
  lease, so both reports are proven to come from the same store.

### 5. Docs

This plan.

## Non-goals

- No destructive lifecycle verb over MCP or WebUI: `pin`, `unpin`, `prune`,
  `gc`, `verify` and `repair` stay CLI-only.
- No reachability verdict: the revision list shows retention roots, and GC
  status shows due rows, never "garbage".
- No background polling, no store read on server startup.

## Safety

- Read-only: no lease acquisition, no quarantine release, no manifest delete.
- A store failure degrades to a fixed 503 instead of a partial or invented
  report.
- Revision identities (manifest id, commit, tree) are already public through
  `index revision list --json`; no artifact content or provider payload is
  added.

Refs #210.
