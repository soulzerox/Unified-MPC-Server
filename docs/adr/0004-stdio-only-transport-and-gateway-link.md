# 0004 - MCP clients touch stdio only; stdio bridge over a local domain socket link

- Status: Accepted
- Date: 2026-09-11
- Deciders: product owner

## Context

The original spec served MCP clients over stdio and a bearer-protected Streamable HTTP/SSE endpoint. The audit withdrew the HTTP endpoint: an MCP surface reachable over TCP multiplies the trust surface (bearer token theft, cross-origin calls, exposure strategy) before any threat model for it exists. But MCP-over-stdio requires the client (IDE/agent) to spawn the server as its own child, while the web control plane needs a long-running daemon independent of any IDE. The user's session policy already names a **stdio bridge** (60-second ping, 32-upstream-session cap, fail-closed cleanup) - confirming a bridge process exists.

## Decision

MCP clients connect **over stdio only** in v0.1. The process model splits in two:

- **Gateway daemon** (`unified-mcp start`): long-running. Mounts upstream connections (stdio children), decides policy, audits, holds the unified config, and serves the loopback web control plane.
- **stdio bridge** (`unified-mcp bridge`): the thin MCP peer each client spawns. Forwards JSON-RPC to the daemon over the **GatewayLink** - a Unix domain socket under the data dir, mode 0600, presenting the link token issued at daemon start; auth failure cleans the session immediately. An `--embedded` mode runs bridge + hosting in one process with no daemon for zero-setup use.

The **Transport seam** is reserved: a future public client transport (e.g. Streamable HTTP) plugs there, gated on a designed threat model.

## Consequences

- No MCP-over-TCP surface exists in v0.1; the only TCP listener is the loopback control plane (ADR 0002).
- Every client spawns its own bridge; the daemon stays single-instance per data dir.
- Adding a public transport later means implementing one transport adapter, not reworking hosting.

## Alternatives

- Bearer HTTP endpoint (original spec): rejected - withdrawn by the audit; ships an internet-shaped surface with no threat model.
- stdio gateway only, no daemon: rejected - the control plane would die with the first IDE that closed.
- Loopback HTTP as the internal bridge channel: rejected - indistinguishable from the withdrawn public endpoint; the socket-file permission model is narrower.