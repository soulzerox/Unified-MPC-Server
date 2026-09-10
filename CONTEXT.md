# Unified MCP Server - Context

A single local gateway that lets tools and agents use MCP capabilities from many upstream MCP servers through one enforced, policy-controlled connection.

## Glossary

### ProtocolGateway

The one core program: receives client connections, forwards tool requests to upstream MCP servers, and enforces policy on everything passing through. It never executes agent work itself.

### Upstream MCP server

Any external MCP server the gateway connects to as a client. The gateway aggregates their tools behind one endpoint. Upstreams are configured, never trusted with policy.

### Policy engine

The component that decides, per request, which tools are allowed, denied, shaped, or rate-limited according to the unified config. The single enforcement point of the gateway.

### Unified config

One versioned document describing upstreams, policy, and gateway settings. The only source of truth. Changes go through validation and migration, never silent rewrites. Read once by the runtime; the control plane is the only writer.

### Control plane

The web UI the user opens in a browser to view and manage the gateway: status, upstreams, policy, config edits, and audit. The gateway's front door on the web destination.

### Client

A consumer connecting to the gateway's single endpoint to use aggregated tools, e.g. a local agent or IDE integration. Clients are policy-enforced, not policy-setting.

### Audit log

The append-only record of every request decision and config change the gateway made, including what was denied and why.

### Session

A single authenticated browser visit to the control plane, scoped to one local user visit via a loopback token issued at daemon start.

### Gateway daemon

The long-running gateway process: mounts upstreams, enforces policy, serves the control plane. Single instance per data dir.

### stdio bridge

The thin MCP peer process each client spawns. It forwards JSON-RPC to the daemon over the GatewayLink. Users never interact with it.

### GatewayLink

The authenticated Unix domain socket channel between bridge and daemon: mode 0600 plus a link token issued at daemon start.

### Embedded mode

`--embedded` zero-setup mode: bridge + hosting + control plane in one process, no daemon.

### Apply-on-restart

The only config apply path: the control plane writes a new config version, then the user restarts — no hot-reload.

### Config history

Archived previous config documents under the data dir; rollback re-confirms an archived document through the versioned flow.

### Start token

The one-time random value printed at daemon start, exchanged for a session cookie on first visit.

### Seam

A reserved, contract-level extension point in the gateway's design that a future layer plugs into without reworking the core. Locking seams is v0.1 work; building the layer is not.

### Future record

The explicit, owned place where deferred platform features (harness, orchestrator, installer, remote connector) live, each annotated with the seam it requires. Deferred, not deleted.

## Invariants

Moved to the specification — see [`SPEC.md`](SPEC.md) "Invariants".
