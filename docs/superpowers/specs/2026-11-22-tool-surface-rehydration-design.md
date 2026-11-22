# Tool-surface rehydration across session rollover

Date: 2026-11-22
Issue: [#174](https://github.com/soulzerox/Unified-MPC-Server/issues/174)

## Decision

A resumed ChatGPT turn must be able to reattach to the Unified tool surface
without depending on the transport session that served the previous turn. Two
server-side pieces make that possible, and one client-side behaviour has to be
observable before it can be trusted:

1. **Revive window** — a request that names an evicted or unknown
   `mcp-session-id` is served by a fresh session in the same request scope
   instead of a bare `404`, and the response carries the new id. The host's next
   request therefore works even when it never re-ran `initialize`.
2. **Truthful `recovery_status`** — the tool reports the live session count and
   the last eviction reason instead of a static
   `reconnect: 'enabled-at-transport-boundary'` string.
3. **Observable re-init hint** — the `404` body, when the revive window is
   disabled by configuration, states `reason: 'session_not_found'` and
   `reinitialize: true`, so a host that logs error bodies can tell "my session
   died" from "the server is broken".

Nothing here relaxes authorization, scope, or the durable goal lease: a revived
session is a new transport session with the same request scope, not a restored
authorization context.

## What actually fails

The issue's runtime evidence shows the split directly:

- `recovery_status.reconnect = enabled-at-transport-boundary`
- `recovery_status.staleContinuation = detected`
- durable goals, checkpoints, activity logs and the tool catalog all healthy
- the resumed turn still cannot see or call the tool surface

So the backend is fine and the *binding* is gone. That is consistent with how
the server currently treats a stale id.

## Current mechanics

```text
turn N (host)                              unified mcp-http
  POST initialize            -> 200, mcp-session-id: S
  POST tools/call (S)        -> ok
  ... idle TTL / transport close / backend restart ...
  POST tools/list (S)        -> 404 {"code":-32001,"message":"Session not found"}
```

- `packages/mcp-server/src/http.ts:391` reads `mcp-session-id`, and a missing
  header mints a new legacy session (`createLegacySession`), so a host that
  drops the header recovers on its own.
- `http.ts:396-403` looks the id up in a `BoundedRetentionMap`; `evicted` and
  `missing` both return `sessionNotFoundResponse()` (`http.ts:205`), a bare
  `404` with no machine-readable reason.
- Sessions are evicted on idle TTL (`pruneLegacySessions`), on `DELETE`, on a
  protocol error, and on backend shutdown, each recorded through
  `trackSessionEviction` — the evidence exists, it is just not exposed.
- `upgrade-runtime.ts:501` answers `recovery_status` with a constant object, so
  a session that *cannot* reach the surface still gets `reconnect:
  'enabled-at-transport-boundary'`. That is the claim the issue is really about.

## Options

| Option | Effect | Why not / why |
|---|---|---|
| Host re-runs `initialize` on `404` | Correct MCP behaviour, no server change | Not under our control; the issue exists because the host does not do it reliably |
| Accept stateless requests with no session id | Any request works | Already happens; useless when the host keeps sending the dead id |
| **Revive on unknown id (recommended)** | Stale id keeps working | Needs a bound: only for ids we can attribute to a scope, only within a window, and never for `DELETE` |
| Infinite session retention | Stale id never dies | Unbounded memory, and a dead transport cannot be resumed anyway |
| Push a client patch | Fixes the root cause | Out of scope for this repository |

## Recommended shape

```text
POST tools/list  (id S, evicted 40 s ago, scope known)
   -> revive: new session S2, same request scope, empty transport state
   -> 200 with mcp-session-id: S2
POST tools/list  (id S, unknown / outside window)
   -> 404 {"code":-32001,"message":"Session not found",
           "data":{"reason":"session_not_found","reinitialize":true}}
```

- **Attribution.** The revive path needs the scope of the dead session, which
  `trackSessionEviction` already receives. Keep a bounded map
  `evictedSessionId -> { scopeSessionId, evictedAt, reason }` with a TTL
  (proposal: 10 minutes, at most 64 entries) and drop it on eviction pressure.
- **Never revive** a `DELETE` request, a request whose scope no longer resolves,
  or one whose eviction reason was `protocol_error` — a corrupt session must not
  be silently replaced.
- **One revive per id.** Spending an evicted id removes it from the map, so a
  later request with the same stale id falls back to the explicit `404` and the
  host gets the re-init hint.
- **`recovery_status`** gains `liveSessions`, `lastEviction: { sessionId,
  reason, at }`, and `reviveWindowMs`, all read from the same state the sweep
  already maintains. The static `reconnect` string stays only if it is backed by
  those numbers.

## Phases

1. **Evidence first.** Expose `liveSessions` / `lastEviction` in
   `recovery_status` and assert them in `mcp-http.integration.test.ts`. No
   behaviour change; this makes the next failure diagnosable instead of
   mysterious.
2. **Explicit 404.** Add `reason` / `reinitialize` to `sessionNotFoundResponse`
   and pin it with a test. Safe for every client: unknown fields in an error body
   are ignored by spec-conforming hosts.
3. **Revive window.** Bounded evicted-id map, one revive per id, scope re-check,
   `DELETE` and `protocol_error` excluded, `mcp-session-id` returned on the
   revived response.
4. **Conformance.** Exercise a stale id against the real clients listed in #294
   item 5 before claiming the issue is fixed; a green integration test is not
   evidence that ChatGPT reattached.

## Verification

- `mcp-http.integration.test.ts`: stale id inside the window → `200` with a new
  id and a working `tools/list`; stale id after a revive → `404` with
  `reinitialize: true`; `DELETE` with an evicted id → `404`, no revive;
  `protocol_error` id → `404`, no revive.
- `recovery_status` reports the same numbers the sweep computed, asserted against
  a session that was actually evicted.
- No test may assert `reconnect: 'enabled-at-transport-boundary'` as a string
  constant any more; that is what made the issue invisible.

## Non-goals

- Restoring transport state (in-flight requests, pending writes) across a
  revival. A revived session is empty on purpose.
- Extending authorization, workspace scope or a goal lease across sessions.
- Changing the modern/stateless path, which already re-creates a session per
  request.
- Keeping sessions alive longer to mask the problem.

## Open questions

- Does the ChatGPT connector send `mcp-session-id` at all after a rollover, or
  does it send a *new* id and rely on `initialize`? The revive window only helps
  the first case; phase 1's counters answer it on the next real rollover.
- Is 10 minutes the right window, or should it be bounded by the host's own
  continuation interval?
