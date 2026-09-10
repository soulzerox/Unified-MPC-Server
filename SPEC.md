# Unified MCP Gateway — v0.1 Specification

One local gateway that multiplexes upstream MCP servers behind a single stdio endpoint, enforces policy on every forwarded request, and is managed entirely from a loopback web control plane.

**Authority**: ADR [0001](docs/adr/0001-gateway-first-platform-as-layer.md) · [0002](docs/adr/0002-web-first-local-control-plane.md) · [0003](docs/adr/0003-versioned-config-editing-and-future-record.md) · [0004](docs/adr/0004-stdio-only-transport-and-gateway-link.md) plus two owner constraints (strict config, session policy). This spec **supersedes** the earlier 14-step platform build spec; that content is preserved under [`docs/future/`](docs/future/) and indexed in [`docs/FUTURE.md`](docs/FUTURE.md). Glossary: [`CONTEXT.md`](CONTEXT.md).

## Current State

- Repository is docs-only; `src/` is empty. Everything below is buildable from zero.
- Old config seeds encoded withdrawn claims (bearer token, IDE targets, HTTP+SSE transport, self-update) — they are removed; `config/config.json` is rewritten as the strict seed below.
- The old platform spec (harness, installer, pruner, IDE sync, lifecycle) is relocated to `docs/future/`, not deleted.

## Destination

A single program the user manages from the browser as the only front door: agents connect over stdio; the user sees status, edits policy/config through a versioned flow, reads the audit, and restarts — without ever hand-editing a file or opening a CLI.

## v0.1 Scope

1. **Gateway daemon** — single instance per data dir; mounts upstream MCP servers as stdio children; multiplexes tools namespaced `<id>__<tool>`; never executes agent work.
2. **stdio bridge + GatewayLink** — thin MCP peer each client spawns; forwards JSON-RPC to the daemon over a Unix domain socket (mode 0600, link token); `--embedded` zero-setup mode runs bridge + hosting in one process.
3. **Web control plane** — loopback-only TCP listener, single front door; start token, Origin/Host checks, HttpOnly+SameSite session cookie, CSP, frame-ancestors none; no accounts.
4. **Versioned config** — strict schema, `configVersion` field; the control plane is the only writer: validate → diff-confirm → atomic write + archive → **apply-on-restart** (no hot-reload).
5. **Request-level policy engine** — the single enforcement point: allow/deny/rate-limit per (upstream, tool) on every forward; fail-closed defaults.
6. **Audit log** — append-only JSONL of every decision and config change, with redaction.
7. **CLI** — `start` / `bridge` / `stop` / `status` only.
8. **Seams locked** — ExecutionPipeline, EventEnvelope, Transport, Auth, StateSplit; reserved names only for IdeTargetWriter, IngestionSource, UpdateSource.

## Out of Scope (v0.1) — owned by the Future record

Universal harness, orchestrator/agent runtime, installer, pruner, lifecycle updater, priority-compile/IDE sync, any MCP-over-TCP client surface, accounts/multi-tenant auth, config hot-reload. Each entry, its seams and re-entry criteria: [`docs/FUTURE.md`](docs/FUTURE.md).

## Invariants

1. The gateway forwards tool requests; it never executes agent work itself.
2. The policy engine is the only enforcement point; no component sets policy.
3. The unified config is the only source of truth; every change is versioned, validated, and migrated.
4. The control plane is the only web surface; it is loopback-only and single-user.
5. Every request decision and config change is recorded in the audit log.
6. Future layers plug into seams; no seam is reworked per feature.
7. The gateway reads **one strict versioned config** from an absolute `--config` path; runtime reads once and never writes it; unknown fields, duplicate/invalid IDs, relative upstream command/cwd paths, and non-regular or group/world-writable config files are rejected; the config holds **no secret values**.
8. Session policy: idle timeout 30 minutes; stdio bridge pings every 60 seconds; cap 32 upstream sessions; explicit close, transport close, or auth failure cleans the session immediately; a stuck cancellation exits fail-closed.
9. Denied tool calls never reach upstream — enforcement happens in the multiplexer, and every deny is audited with a stable reason.

## Success Criteria

Round-1 locked, checkable without opening a CLI:

1. `unified-mcp start --config /abs/config.json` → browser opens `http://127.0.0.1:7420` → status visible. ✔/✘
2. Versioned edit through the UI (prepare → diff → confirm) + one-click restart → change live. ✔/✘ — no hand-edited file, no CLI.
3. Claude Code (`.mcp.json` spawning the bridge) lists and calls tools through the gateway. ✔/✘
4. A deny rule blocks a tool call with an audited reason; the call never reaches upstream. ✔/✘
5. Session caps hold: the 33rd upstream session is refused; an idle session is cleaned at 30 minutes; a stuck cancellation exits fail-closed. ✔/✘
6. The config seed has zero secret-typed fields; strict validation rejects the old seed shape. ✔/✘

## Build Steps

Each step has a completion criterion; steps are ordered by dependency.

| step | deliverable | completion criterion |
|---|---|---|
| 1 | Scaffold & tooling | pnpm workspace, strict `tsconfig.json`, vitest green on a smoke test |
| 2 | Config module | zod schema = [`docs/CONFIG.md`](docs/CONFIG.md); loader rejects every strict case with exit 2; typed snapshot exposed |
| 3 | Daemon core | single-instance lock; upstream mount/unmount as stdio children; namespaced multiplexer |
| 4 | Policy engine + audit | every forward decided; deny audited with a stable reason; rate-limit buckets in the runtime dir |
| 5 | stdio bridge + GatewayLink | UDS mode 0600 + link token; ping 60 s; cap 32; fail-closed stuck-cancellation exit |
| 6 | Control plane server | loopback bind; start token → cookie; Origin/Host checks; CSP; no-store; frame-ancestors none |
| 7 | Versioned editing flow | prepare → diff → confirm; atomic write + history archive; applies on restart |
| 8 | Web client | 4 views (status / upstreams / policy+config / audit); no inline script; text-rendered values |
| 9 | Embedded mode + CLI glue | `--embedded` one-process zero-setup; start/bridge/stop/status with documented exit codes |
| 10 | Tests + threat-model checks | origin rejection, CSRF, perms, 32-session cap, idle timeout, strict-rejection matrix green |

Detailed contracts: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) · [`docs/CONFIG.md`](docs/CONFIG.md) · [`docs/CONTROL-PLANE.md`](docs/CONTROL-PLANE.md) · [`docs/POLICY-ENGINE.md`](docs/POLICY-ENGINE.md) · [`docs/CLI.md`](docs/CLI.md) · [`docs/FUTURE.md`](docs/FUTURE.md)