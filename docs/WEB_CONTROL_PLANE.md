# Web Control Plane SPA (`apps/web`)

The Web Control Plane provides a lightweight, reactive, zero-CDN local dashboard and REST API daemon for orchestrating Model Context Protocol (MCP) services, inspecting system telemetry, installing/pruning extensions, synchronizing multi-IDE policies, and managing gated remote tunnels.

---

## Architecture & Server Topology

The Control Plane is implemented in `apps/web/src/web-server.ts` as a Node.js HTTP server. By default, it binds strictly to the loopback interface (`127.0.0.1:18765`), ensuring zero external network exposure unless explicitly forwarded.

```
+-------------------------------------------------------------+
|              Web Browser / Local Dashboard                  |
|               (http://127.0.0.1:18765/)                     |
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

1. **Loopback Only**: All requests with an `Origin` header are checked against `http://127.0.0.1`, `https://127.0.0.1`, `http://localhost`, or `https://localhost`. Any external origin receives a `403 Forbidden`.
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
    "state": "DISCONNECTED",
    "tunnelUrl": null,
    "localPort": 18765,
    "metrics": {
      "requestsTotal": 0,
      "errorsTotal": 0,
      "activeConnections": 0
    }
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

The gateway manages secure remote bridges (such as Cloudflare Named Tunnels) with a strict five-state deterministic state machine:

```
[DISCONNECTED] ---> [CONNECTING] ---> [BRIDGE_HEALTHY] ---> [DRAINING] ---> [DISCONNECTED]
                           |                 |
                           +--------> [ERROR]<+
```

#### State Machine Invariant
Connecting a client session via `/api/chatgpt-web/connect` is strictly gated. The bridge **must** be in the `BRIDGE_HEALTHY` state; attempting connection in any other state returns `412 Precondition Failed`.

#### `GET /api/chatgpt-gateway/status`
Returns current bridge state, active tunnel URL, and telemetry.

#### `POST /api/chatgpt-gateway/start`
Starts the tunnel and transitions state from `DISCONNECTED` -> `CONNECTING` -> `BRIDGE_HEALTHY`.

- **Response `200 OK`**:
```json
{
  "ok": true,
  "state": "BRIDGE_HEALTHY",
  "tunnelUrl": "https://mcp-gateway-preview.example.com"
}
```

#### `POST /api/chatgpt-gateway/stop`
Gracefully drains existing connections and tears down the tunnel process.

- **Response `200 OK`**:
```json
{
  "ok": true,
  "state": "DISCONNECTED"
}
```

#### `GET /api/chatgpt-web/connect`
Initiates a gated session token handshake.

- **Precondition**: `state === "BRIDGE_HEALTHY"`
- **Response `200 OK`**:
```json
{
  "sessionToken": "cf-session-98a72b14c7",
  "bridgeUrl": "https://mcp-gateway-preview.example.com/mcp",
  "expiresAt": "2026-09-12T00:00:00Z"
}
```
- **Response `412 Precondition Failed`**:
```json
{
  "error": "Bridge must be in BRIDGE_HEALTHY state before connecting ChatGPT Web",
  "state": "DISCONNECTED"
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
  "skillContent": "---\nname: my-skill\ndescription: Demo skill\n---\n# My Skill\nInstructions...",
  "target": "antigravity",
  "scope": "workspace",
  "workspaceDir": "/mnt/workspace_data/project",
  "companionFiles": [
    {
      "relativePath": "scripts/helper.sh",
      "content": "#!/usr/bin/env bash\necho 'Helper'"
    }
  ]
}
```
- **Response `200 OK`**:
```json
{
  "ok": true,
  "installedPath": "/mnt/workspace_data/project/.agents/skills/my-skill/SKILL.md"
}
```

#### `POST /api/servers/install`
Configures a new MCP server in the target IDE configuration.

- **Request Body**:
```json
{
  "name": "custom-sqlite",
  "target": "cursor",
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
  "targetFile": "/home/user/.cursor/mcp.json"
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
  "target": "all",
  "scope": "workspace",
  "workspaceDir": "/mnt/workspace_data/project"
}
```

#### `POST /api/servers/prune`
Removes server definitions from target configuration files without destroying unrelated keys or comments.

- **Request Body**:
```json
{
  "name": "deprecated-server",
  "target": "all",
  "scope": "global"
}
```

---

## Starting the Web Control Plane

Run the web dashboard from the CLI:

```bash
# Default port 18765
pnpm cli web

# Custom port
pnpm cli web --port 8080
```

Open your browser to `http://127.0.0.1:18765/` to view the real-time telemetry gauges, server list, and interactive management tools.

