# Architecture — Unified MCP Gateway v0.1

Deep-module principle (per codebase-design): the **policy engine** is the high-leverage seam — everything that forwards touches it; everything else hides behind a few deep modules.

## Process Model (ADR 0004)

```
 IDE / agent (Claude Code, Cursor, …)
   │ spawns
   ▼
 stdio bridge (thin MCP peer, one per client)
   │ JSON-RPC over GatewayLink (UDS, mode 0600, link token)
   ▼
 Gateway daemon (single instance per data dir)
   ├── upstream supervisor ── upstream MCP servers (stdio children)
   ├── multiplexer (namespace <id>__<tool>)
   ├── policy engine (single enforcement point)
   ├── audit log (append-only)
   ├── config loader (strict, read once, apply-on-restart)
   └── control plane server (loopback TCP :7420)
                                             ▲
                        browser (single front door, ADR 0002)
```

`--embedded` runs bridge + hosting + control plane in one process — same modules, no daemon.

## Modules

| module | responsibility | hides |
|---|---|---|
| `daemon/config` | load + validate strict config; expose a typed snapshot | schema rules, perm checks, version, migrations |
| `daemon/upstreams` | mount/unmount stdio children; supervise | spawn env, stderr rolling, restart, health |
| `daemon/policy` | decide every forward; emit audit records | rules, rate-limit buckets, redaction |
| `daemon/control-plane` | serve loopback web + versioned editing flow | origin checks, token, atomic writes, history |
| `daemon/gatewaylink` | authenticated UDS channel for bridges | framing, link token, session caps, keepalive |
| `bridge` | speak MCP stdio to the client; forward via link | JSON-RPC framing, ping, reconnect |

## Trust Boundaries

| boundary | defense |
|---|---|
| browser ↔ control plane | loopback bind, start token → cookie, Origin/Host allow, HttpOnly+SameSite, CSP, frame-ancestors none, no-store ([docs/CONTROL-PLANE.md](CONTROL-PLANE.md)) |
| bridge ↔ daemon | UDS file mode 0600 + link token; auth failure cleans the session |
| daemon ↔ upstream | untrusted; every forward passes policy; upstream never sets policy |
| config file | strict read-once; no secret-typed fields; perms checked ([docs/CONFIG.md](CONFIG.md)) |

## Seams (locked contracts)

| seam | contract | locked in | future consumer |
|---|---|---|---|
| ExecutionPipeline | ordered pre/post hooks around the request lifecycle | v0.1 | Harness (F1), Orchestrator (F5) |
| EventEnvelope | typed event shape `{ type, ts, session, payload }` | v0.1 | Harness, Lifecycle (F4) |
| Transport | client-transport adapter interface | v0.1 | MCP-over-TCP (F7) |
| Auth | control-plane auth provider interface | v0.1 | Accounts (F8) |
| StateSplit | config vs runtime vs audit state separation | v0.1 | — |
| IdeTargetWriter | reserved name only | future | Priority-compile (F6) |
| IngestionSource | reserved name only | future | Installer (F2) |
| UpdateSource | reserved name only | future | Lifecycle (F4) |

## State Split (StateSplit seam)

- **config** — versioned, strict, apply-on-restart (ADR 0003)
- **runtime** — locks, session caps, rate buckets — data dir, daemon-owned
- **audit** — append-only JSONL, redaction applied at write time
