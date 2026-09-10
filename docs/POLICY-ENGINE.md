# Policy Engine v0.1 — Request-Level Enforcement

The single enforcement point (CONTEXT: policy engine). Decides per forwarded request. This is **not** the P1–P7 priority compile into IDE rule files — that is a Future entry ([`docs/future/POLICY-COMPILE.md`](future/POLICY-COMPILE.md)).

## Policy document

Lives inside the unified config — versioned with it (ADR 0003):

```
policy: {
  defaultAction: "allow" | "deny",
  rules: [
    { match: { upstream?: id, tool?: name | "<id>__*" },
      action: "allow" | "deny" | "rate-limit",
      rate?: { max, windowSec },
      reason: string }
  ],
  redact: [paramName, …]
}
```

- Rules evaluate top-down; first match wins; no rule → `defaultAction`.
- Unknown tools (not mounted) are denied with reason `unmounted` regardless of rules.
- Strict mode seeds `defaultAction: "deny"` (fail-closed); `--embedded` seeds `"allow"`.

## Evaluation points

- `tools/list` — denied tools are **hidden** from the list (not errored).
- `tools/call` — deny → JSON-RPC error + audited reason; allow → forward; rate-limit → token bucket per (upstream, tool), exceeded → deny `rate_limited`.
- `prompts/list` / `prompts/get` — the same rules apply by namespace match.

## Rate limiting

Token bucket per (upstreamId, toolName); bucket state lives in the **runtime dir** — never in config (StateSplit).

## Audit + redaction

- Every decision appends to the audit JSONL: `{ ts, session, upstream, tool, action, reason }`.
- Values of parameters listed in `redact` are replaced with `***` before write.
- Deny paths never reach upstream — enforced in the multiplexer, not by rules alone (SPEC invariant 9).

## Error contract

Deny returns JSON-RPC `-32001 policy_denied`; rate-limit `-32002 rate_limited`. Reason strings are a stable enum (`unmounted`, `rule`, `rate_limited`, …) — not free text — so audits stay greppable.