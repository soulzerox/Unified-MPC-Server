# Web Control Plane SPA (`apps/web`)

The Web Control Plane provides a lightweight, reactive, zero-CDN local dashboard and REST API daemon for orchestrating Model Context Protocol (MCP) services, inspecting system telemetry, installing/pruning extensions, synchronizing multi-IDE policies, and managing gated remote tunnels.

---

## Architecture & Server Topology

The Control Plane is implemented in `apps/web/src/web-server.ts` as a Node.js HTTP server. By default, it binds strictly to loopback (`127.0.0.1:3000`). MCP HTTP runs separately on `127.0.0.1:18765`; Cloudflare forwards only MCP HTTP.

```
+-------------------------------------------------------------+
|              Web Browser / Local Dashboard                  |
|               (http://127.0.0.1:3000/)                      |
+------------------------------+------------------------------+
                               | HTTP / JSON REST API
                               v
+-------------------------------------------------------------+
|               Unified-MPC ControlPlaneServer                |
|  - Loopback-only origin validation                          |
|  - In-memory rate & payload size guards (1MB limit)         |
+--------------+---------------+--------------+---------------+
               |               |              |
               v               v              v
      +----------------+ +------------+ +-------------+
      | GatewayService | | Installer/ | | IdeSync     |
      | (Cloudflare    | | Pruner     | | Service     |
      |  Tunnel/Bridge)| | Services   | | (Multi-IDE) |
      +----------------+ +------------+ +-------------+
```

### Security & Origin Policy Guard

1. **Loopback and capability**: Control-plane requests require loopback `Host`/`Origin` plus startup capability cookie/header. MCP HTTP stays loopback-only unless explicit public hostname/origin allowlists are configured.
2. **Payload Protection**: Incoming request bodies are capped at 1 MB (`MAX_BODY_BYTES = 1024 * 1024`). Payloads exceeding this return `413 Payload Too Large`.
3. **Zero CDN Dependencies**: The SPA UI (`renderDashboardHtml()`) is 100% self-contained HTML/CSS/JS without third-party CDN scripts, fonts, or tracking beacons.

---

## REST API Specification

### 1. System Health & Status

#### `GET /api/status`
Returns general operational health and gateway status.

- **Response `200 OK`**:
```json
{
  "status": "healthy",
  "gateway": {
    "state": "STOPPED",
    "localPort": 18765
  }
}
```

### Projects & Durable Goal Continuation

The **Projects** view keeps durable work visible without eagerly loading every goal. `GET /api/workspaces` returns each registered project with `openGoalCount` and the validated `preferredGoalId`; the dashboard remains collapsed by default and requests goal details only after the user expands that project.

- `GET /api/workspaces/:workspaceId/goals` returns active goal summaries for that registered project, including objective, current phase, completed/total plan steps, blockers, next action, steps, and `updatedAt`.
- `PUT /api/workspaces/:workspaceId/goals/:goalId/continue` marks one active goal as the preferred continuation target and activates its workspace. It **does not acquire, renew, or steal the durable goal execution lease**.
- The preferred mapping is persisted in non-secret settings. `workspace_bootstrap` exposes the validated preferred goal as a continuation hint to MCP clients; stale or terminal selections are ignored.
- Goals with terminal durable status (`completed`, `failed`, `blocked`, or `cancelled`) are excluded from the open-goal count and list.

The expanded dashboard card shows the goal objective (what the goal is trying to accomplish), phase, progress, blockers, last update, and actions. **Open** reveals the next action and step list inline; **Continue** selects the preferred goal without starting work by itself.

### Authoritative Goal Runtime snapshots and SSE

The runtime projection is exposed separately from the durable Goal summary so selection/default state cannot become execution truth.

- `GET /api/workspaces/:workspaceId/goal-runtime` returns the bounded authoritative runtime snapshots for the registered project, a replay-safe snapshot `cursor`, the event log `latestSequence`, and the oldest retained sequence. The cursor is deliberately no newer than the runtime state represented by the returned snapshot set, so a consumer can reconnect without skipping a committed event that has not reached its projection yet.
- `GET /api/workspaces/:workspaceId/goal-runtime/events` is a loopback SSE stream. A new stream starts with an authoritative snapshot. Browser reconnects use the standard `Last-Event-ID` cursor and receive bounded missed events from the durable Goal event log.
- If the requested cursor fell outside the retained replay window (or is ahead of the current durable log after replacement/recovery), the stream sends a fresh `goal-runtime-snapshot` event instead of pretending the missing delta is complete.
- Live delivery polls only the bounded durable event log; it does not perform one-second full Projects polling or create a second frontend state store.
- Closing the browser stream cancels that connection's poll/keepalive timers. A stream-side read failure closes only the observational stream and never mutates or stops Goal execution.
- SSE event IDs are durable Goal runtime event sequences. `goal-runtime-event` carries a durable event record; `goal-runtime-snapshot` carries the current snapshot set and replacement cursor.

`integrationState` remains `unknown` unless the parent runtime has authoritative integration evidence. Neither this API nor the WebUI may infer integration from Goal completion, worktree presence/cleanliness, PR state, selection/default state, or leases.

---

### 2. Multi-IDE Policy Management

#### `GET /api/policies`
Fetches the live reconciled P1–Pn runtime policy. Semantic IDs remain stable while `priority` reflects the current user-selected execution position; availability and resolved resource information come from live discovery.

- **Response `200 OK`**:
```json
{
  "policies": [
    {
      "id": "p1-memory-priority",
      "name": "P1 Working Memory Priority",
      "enabled": true,
      "description": "Optional selective working memory for durable decisions and explicit recall"
    }
  ]
}
```

#### `POST /api/policies/sync`
Triggers synchronization of rules and configuration files across IDE environments.

- **Request Body**:
```json
{
  "targets": ["all"]
}
```
*(Options: `"all"`, `"antigravity"`, `"cursor"`, `"claude"`, `"opencode"`, `"cline"`, `"omp"`, `"codex"`)*

- **Response `200 OK`**:
```json
{
  "ok": true,
  "synced": ["antigravity", "cursor", "claude", "opencode", "cline", "omp", "codex"],
  "failed": []
}
```

---

### 3. Remote Gateway & Bridge State Machine

The gateway manages secure remote bridges with the states implemented by `GatewayService`:

```
[STOPPED] ---> [INITIALIZING] ---> [BRIDGE_HEALTHY] ---> [SESSION_CONNECTED]
    ^                 |                    |
    +-----------------+--------------------+
                      |
                    [ERROR]
```

`stop()` invalidates pending starts, cancels health/reconnect timers, and returns the service to `STOPPED`. A stale asynchronous start or in-flight health probe cannot resurrect the bridge after an explicit stop. While running, a watchdog probes the public bridge every 10 seconds; 3 consecutive failures replace the tunnel and retry indefinitely with capped exponential backoff plus jitter (1 second base, 30 second cap). If a ChatGPT Web session was connected before the failure, it is automatically restored after the bridge returns healthy.

#### State Machine Invariant
Connecting a client session via `/api/chatgpt-web/connect` is strictly gated. The bridge **must** be in the `BRIDGE_HEALTHY` state; attempting connection in any other state returns `412 Precondition Failed`.

#### `GET /api/chatgpt-gateway/status`
Returns current bridge state, tunnel URL, explicit MCP `/mcp` URL, measured health latency, and telemetry. Capability token and lease token never appear in status.

#### `POST /api/chatgpt-gateway/start`
Starts the tunnel and transitions state from `STOPPED` -> `INITIALIZING` -> `BRIDGE_HEALTHY`.

- **Response `200 OK`**:
```json
{
  "ok": true,
  "state": "BRIDGE_HEALTHY",
  "tunnelUrl": "https://mcp-gateway-preview.example.com"
}
```

#### `POST /api/chatgpt-gateway/stop`
Invalidates pending starts and session lease state, then returns the gateway to `STOPPED`.

- **Response `200 OK`**:
```json
{
  "ok": true,
  "state": "STOPPED"
}
```

#### `POST /api/chatgpt-web/connect`
Initiates a gated session lease handshake. A loopback `Origin` header is required.

- **Precondition**: `state === "BRIDGE_HEALTHY"`
- **Response `200 OK`**:
```json
{
  "leaseToken": "lease_opaque-id",
  "tunnelUrl": "https://mcp-gateway-preview.example.com"
}
```
- **Response `412 Precondition Failed`**:
```json
{
  "error": "Bridge must be in BRIDGE_HEALTHY state before connecting ChatGPT Web",
  "state": "STOPPED"
}
```

---

### 4. Extension Installation Ownership

The Web Control Plane is intentionally **not an installation surface**. It exposes extension inventory, policy management, health, and pruning, but it does not provide `POST /api/skills/install` or `POST /api/servers/install`; those paths return `404 Endpoint not found`.

Installation is owned by the Unified MCP parent runtime and is performed through the LLM-facing MCP tools:

- `skills_install { name, source }` validates a local or HTTPS Git skill and installs it into the canonical parent store at `<dataDir>/extensions/skills/<name>/`.
- `mcp_install { name, transport, ... }` registers a child server in `<dataDir>/extensions/mcp/registry.json` (and may materialize managed source versions under the parent data directory).

The public LLM install schemas do not accept IDE targets, workspace scope, or workspace-root overrides. They are hard-bound to the parent-owned `unified-mpc` target, so asking the LLM to install a skill or child MCP does **not** write Cursor, Cline, Claude, Codex, Antigravity, or OpenCode configuration. Legacy/direct installer platform targets remain an explicit compatibility/export seam and are not the default LLM path.

---

### 5. Zero-Artifact Pruning Engine

#### `POST /api/skills/prune`
Safely purges skill directories across target clients.

- **Request Body**:
```json
{
  "name": "obsolete-skill",
  "targets": ["all"],
  "scope": "workspace",
  "workspaceRoot": "/mnt/workspace_data/project"
}
```

#### `POST /api/servers/prune`
Removes server definitions from target configuration files without destroying unrelated keys or comments. The route does not accept caller-supplied names or PIDs. First call `GET /api/servers`; send its server-issued opaque `serverId` as ownership proof.

- **Request Body**:
```json
{
  "serverId": "server_opaque-id",
  "targets": ["all"],
  "scope": "global"
}
```

Unknown IDs, raw PID-only requests, requests without mutation `Origin`, and requests without startup capability are rejected.

---

## Starting the Web Control Plane

Run the web dashboard from the CLI:

```bash
# Web control plane default port 3000
pnpm cli web

# Custom port
pnpm cli web --port 8080
```

Open `http://127.0.0.1:3000/` to view telemetry and controls. Start MCP HTTP separately:

```bash
UNIFIED_MPC_WORKSPACE=/path/to/workspace unified-mpc-mcp-http
unified-mpc web --port 3000
```

For real ChatGPT Web access, install `cloudflared` or set `UNIFIED_MPC_CLOUDFLARED_BIN`. Quick tunnels are transient. Stable named tunnels use non-secret `UNIFIED_MPC_CLOUDFLARE_TUNNEL_NAME` plus `UNIFIED_MPC_CLOUDFLARE_PUBLIC_URL`; save token through `POST /api/settings`, which writes Linux Secret Service and never returns token. `UNIFIED_MPC_MCP_ALLOWED_HOSTNAMES` and `UNIFIED_MPC_MCP_ALLOWED_ORIGINS` are exact allowlists, not wildcards. Copy dashboard `mcpUrl` into ChatGPT Web connector.

#### `POST /api/cloudflare/reconcile`
Validates the user-entered Cloudflare tunnel configuration against the live Cloudflare API, creates or reuses the named tunnel, configures ingress and DNS, stores both tokens in the Linux Secret Service, starts `cloudflared`, and probes bridge health.

- **`apiToken` is optional**: omit it (or send an empty string) to reuse the token previously stored in the Secret Service. A provided token replaces the stored one; a `Bearer ` prefix and surrounding whitespace are stripped automatically before use. Tokens are never returned by any endpoint.
- **User-entered non-secret settings persist immediately on submission** (account ID, zone name, tunnel name, public URL, origin URL, allowlists), so a failed attempt keeps the settings form prefilled. Only runtime/credential identity (`remoteTunnelId`, token-configured flags) and stored secrets roll back on failure.
- **Validation enforced up front**: Public URL must be an HTTPS origin without path/query/credentials; Local MCP Origin must be an HTTP(S) loopback URL **without a path** — Cloudflare ingress forbids origin paths (API error `1056`) and forwards the incoming request path unchanged; origin URLs are normalized to strip the trailing slash.
- **Cloudflare API failures surface real error codes/messages** (e.g. `HTTP 400: 6111: Invalid format for Authorization header` for malformed Bearer tokens) instead of a bare HTTP status.


#### `POST /api/chatgpt-web/disconnect`
Clears the current session lease **and** the desired connected-session intent. Sessions are long-lived by default and do not expire on a fixed TTL; callers may still opt into a finite `sessionLeaseTtlMs` when constructing `GatewayService`. A process restart invalidates the old in-memory lease, then persisted `RUNNING` gateway state restores the bridge and creates a fresh connected session automatically. After an explicit disconnect, bridge self-healing continues but recovery stops at `BRIDGE_HEALTHY` until a new connect request is made.

#### `GET /api/settings` / `POST /api/settings`
Reads masked non-secret gateway settings or validates/applies new settings. SQLite stores non-secret values only. Tunnel token goes to Linux Secret Service; response exposes only `tunnelTokenConfigured: true|false`. Runtime applies candidate settings by stopping, starting, probing identity, and committing only after success; failed probes restore previous runtime settings.

