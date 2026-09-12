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

---

### 2. Multi-IDE Policy Management

#### `GET /api/policies`
Fetches the currently active global MCP policies and rules (e.g., P1–P7 tool ordering, memory priority, and safety limits).

- **Response `200 OK`**:
```json
{
  "policies": [
    {
      "id": "p1-memory-priority",
      "name": "P1 Working Memory Priority",
      "enabled": true,
      "description": "Realtime working memory log required before and after operations"
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

`stop()` invalidates pending starts and returns the service to `STOPPED`. A stale asynchronous start cannot restore `BRIDGE_HEALTHY`.

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

#### `GET /api/chatgpt-web/connect`
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

### 4. Extension Ingestion (Bifurcated Engine)

#### `POST /api/skills/install`
Installs an agent skill markdown bundle (`SKILL.md` + companion assets).

- **Request Body**:
```json
{
  "name": "my-skill",
  "source": "/mnt/workspace_data/skill-source",
  "targets": ["antigravity"],
  "scope": "workspace",
  "workspaceRoot": "/mnt/workspace_data/project"
}
```
- **Response `200 OK`**:
```json
{
  "ok": true,
  "value": {
    "name": "my-skill",
    "installedPaths": ["/mnt/workspace_data/project/.gemini/skills/my-skill/SKILL.md"],
    "targets": ["antigravity"]
  }
}
```

#### `POST /api/servers/install`
Configures a new MCP server in the target IDE configuration.

- **Request Body**:
```json
{
  "name": "custom-sqlite",
  "targets": ["cursor"],
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "mcp-server-sqlite", "--db", "/var/data/app.db"],
  "env": {
    "SQLITE_TIMEOUT": "5000"
  },
  "scope": "global"
}
```
- **Response `200 OK`**:
```json
{
  "ok": true,
  "value": {
    "name": "custom-sqlite",
    "targets": ["cursor"],
    "updatedConfigFiles": ["/home/user/.cursor/mcp.json"]
  }
}
```

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

For real ChatGPT Web access, install `cloudflared` or set `UNIFIED_MPC_CLOUDFLARED_BIN`. Quick tunnels are transient. Stable named tunnels additionally require `UNIFIED_MPC_CLOUDFLARE_TUNNEL_NAME`, `UNIFIED_MPC_CLOUDFLARE_TUNNEL_TOKEN`, `UNIFIED_MPC_CLOUDFLARE_PUBLIC_URL`, `UNIFIED_MPC_MCP_ALLOWED_HOSTNAMES`, and `UNIFIED_MPC_MCP_ALLOWED_ORIGINS`. Copy dashboard `mcpUrl` into ChatGPT Web connector.

