# CONFIG — Strict Unified Config v0.1

**One strict versioned JSON file** (owner constraint, reconciled in ADR 0003). Provided by an absolute `--config` path; read once at startup; **never written by the gateway runtime**. The control plane is the only writer (prepare → confirm), and its writes apply on restart.

## Seed (`config/config.json`)

```json
{
  "configVersion": 1,
  "gateway": { "bind": "127.0.0.1", "controlPlanePort": 7420, "dataDir": "./data" },
  "upstreams": [],
  "policy": { "defaultAction": "deny", "rules": [], "redact": [] }
}
```

Strict mode seeds `defaultAction: "deny"` (fail-closed — you allow what you use through the control plane). `--embedded` zero-setup seeds `"allow"`.

## Schema (configVersion 1)

| field | rules |
|---|---|
| `configVersion` | positive int; every meaning change bumps it with a migration |
| `gateway.bind` | `"127.0.0.1"` only in v0.1 |
| `gateway.controlPlanePort` | 1–65535; seed 7420 |
| `gateway.dataDir` | path; history, audit, locks live here |
| `upstreams[]` | `{ id, command, args?, env?, cwd? }` — `command` and `cwd` **absolute**; `id` unique, `[a-z0-9-]+` |
| `policy.defaultAction` | `"allow"` \| `"deny"` |
| `policy.rules[]` | `{ match: { upstream?, tool? }, action: "allow"\|"deny"\|"rate-limit", rate?, reason }` — `reason` required |
| `policy.redact[]` | parameter names to redact in audit |

## Validation (reject at load, exit code 2)

Unknown fields · bad/duplicate/invalid IDs · relative upstream `command`/`cwd` · non-regular file · group/world-writable file · malformed JSON · `configVersion` newer than known · duplicate/invalid IDs anywhere.

**No secrets by construction**: the schema has no secret-typed field at all; there is nothing to enforce — bearerToken, githubToken, hubSourceUrl and friends from the old seed are removed and must not return.

## Versioning & history

- Every schema meaning change = `configVersion` bump + migration entry (no silent in-place rewrites).
- Control-plane confirm archives the previous document to `<dataDir>/history/<version>-<ts>.json`.
- Rollback = confirming an archived document through the same versioned flow — never a runtime hot-swap.