import { renderCanvasTopologySvg } from './canvas-telemetry.js';

export function renderDashboardViewsHtml(): string {
  return `
  <!-- TOP LEVEL VIEW: DASHBOARD (OVERVIEW) -->
  <div class="view-panel active" id="view-dashboard">
    <!-- Quick Telemetry Stats Row -->
    <div class="stats-row">
      <div class="stat-chip">
        <span class="stat-label">MCP Servers</span>
        <span class="stat-value" id="stat-servers-count">-</span>
      </div>
      <div class="stat-chip">
        <span class="stat-label">Agent Skills</span>
        <span class="stat-value" id="stat-skills-count">-</span>
      </div>
      <div class="stat-chip">
        <span class="stat-label">Policies</span>
        <span class="stat-value" id="stat-policies-count">P1-P7</span>
      </div>
      <div class="stat-chip">
        <span class="stat-label">Bridge State</span>
        <span class="stat-value" id="stat-bridge-state" style="font-size: 15px; color: var(--status-syncing);">STOPPED</span>
      </div>
      <div class="stat-chip">
        <span class="stat-label">Loopback Port</span>
        <span class="stat-value" id="stat-loopback-port">18765</span>
      </div>
    </div>

    <!-- Interactive Canvas Topology Component -->
    ${renderCanvasTopologySvg()}

    <!-- Dual-Column Telemetry Grid -->
    <div class="dashboard-grid">
      <!-- Main Telemetry Column -->
      <section>
        <div class="card">
          <div class="card-header">
            <h2>Subsystem Status & Downstream Servers</h2>
            <button class="btn btn-secondary btn-sm" id="refresh-status-btn">Refresh</button>
          </div>
          <div id="servers-telemetry" class="mono" style="font-size: 12px; color: var(--text-secondary);">
            Loading telemetry...
          </div>
        </div>

        <div class="card" id="servers-card">
          <div class="card-header">
            <h2>Installed MCP Servers</h2>
            <div style="display: flex; gap: 8px;">
              <button class="btn btn-secondary btn-sm" id="refresh-servers-btn">Refresh</button>
            </div>
          </div>
          <div class="table-responsive">
            <table id="server-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Source</th>
                  <th>Command</th>
                  <th>State</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody id="server-table-body">
                <tr><td colspan="5" style="color: var(--text-muted); text-align: center;">Loading servers...</td></tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="card" id="skills-card">
          <div class="card-header">
            <h2>Installed Skills</h2>
            <button class="btn btn-secondary btn-sm" id="refresh-skills-btn">Refresh</button>
          </div>
          <div class="table-responsive">
            <table id="skill-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Source</th>
                  <th>Description</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody id="skill-table-body">
                <tr><td colspan="4" style="color: var(--text-muted); text-align: center;">Loading skills...</td></tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="card">
          <div class="card-header">
            <h2>Policy Execution Priorities (P1–P7)</h2>
            <button class="btn btn-secondary btn-sm" id="sync-policies-btn">Sync All Policies</button>
          </div>
          <div class="table-responsive">
            <table id="policy-table">
              <thead>
                <tr>
                  <th>Priority</th>
                  <th>Resource</th>
                  <th>Type</th>
                  <th>Enforcement</th>
                  <th>Directive</th>
                </tr>
              </thead>
              <tbody id="policy-table-body">
                <tr><td colspan="5" style="color: var(--text-muted); text-align: center;">Loading policies...</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <!-- Sidebar Column -->
      <aside>
        <div class="card" id="chatgpt-bridge-card">
          <h2>ChatGPT Web Bridge (Gated)</h2>
          <div style="margin: 14px 0;">
            <p style="color: var(--text-secondary); margin-bottom: 6px;">
              Status: <span id="bridge-state" class="badge badge-state mono">STOPPED</span>
            </p>
            <p style="color: var(--text-secondary); margin-bottom: 16px;">
              Tunnel: <span id="tunnel-url" class="mono" style="font-size: 12px; word-break: break-all;">None</span>
            </p>
          </div>
          <div style="display: flex; flex-direction: column; gap: 8px;">
            <button class="btn" id="connect-btn" disabled>Connect ChatGPT Web</button>
            <div style="display: flex; gap: 8px;">
              <button class="btn btn-secondary btn-sm" id="start-gateway-btn" style="flex: 1;">Start Bridge</button>
              <button class="btn btn-secondary btn-sm" id="stop-gateway-btn" style="flex: 1;">Stop Bridge</button>
            </div>
          </div>
        </div>

        <div class="card">
          <h2>Bifurcated Ingestion</h2>
          <p style="color: var(--text-secondary); font-size: 12px; margin-bottom: 14px;">
            Clean separation between instruction prompt skills and executable MCP servers.
          </p>
          <div style="display: flex; flex-direction: column; gap: 8px;">
            <button class="btn" id="open-skill-modal-btn">Install Skill (SKILL.md)</button>
            <button class="btn btn-secondary" id="open-server-modal-btn">Install MCP Server</button>
          </div>
        </div>

        <div class="card">
          <h2>Security & Origin Fence</h2>
          <div style="font-size: 12px; color: var(--text-secondary); line-height: 1.7;">
            <div>&bull; Host: <span class="mono" style="color: var(--status-healthy);">127.0.0.1 loopback only</span></div>
            <div>&bull; Mutations: <span class="mono" style="color: var(--status-healthy);">Origin header validated</span></div>
            <div>&bull; Pruning: <span class="mono" style="color: var(--status-healthy);">Opaque serverId proof</span></div>
            <div>&bull; Payload Limit: <span class="mono">1 MB max</span></div>
          </div>
        </div>
      </aside>
    </div>
  </div>

  <!-- VIEW: SERVERS VIEW -->
  <div class="view-panel" id="view-servers">
    <div class="card">
      <div class="filter-bar">
        <div>
          <h2 style="margin-bottom: 4px;">Downstream MCP Servers Inventory</h2>
          <p style="font-size: 12px; color: var(--text-secondary);">Manage, inspect, and safely prune configured Model Context Protocol servers.</p>
        </div>
        <div style="display: flex; gap: 10px;">
          <input type="text" class="form-control mono" id="server-search-input" placeholder="Search servers by name or command..." style="width: 280px;">
          <button class="btn btn-secondary btn-sm" id="servers-view-refresh-btn">Refresh</button>
          <button class="btn btn-sm" id="servers-view-install-btn">+ Install Server</button>
        </div>
      </div>
      <div class="table-responsive">
        <table id="server-table-detailed">
          <thead>
            <tr>
              <th>Server ID / Name</th>
              <th>Source Config</th>
              <th>Executable Command</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="server-table-detailed-body">
            <tr><td colspan="5" style="color: var(--text-muted); text-align: center;">Loading server inventory...</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <!-- VIEW: SKILLS VIEW -->
  <div class="view-panel" id="view-skills">
    <div class="card">
      <div class="filter-bar">
        <div>
          <h2 style="margin-bottom: 4px;">Agent Skills Catalog</h2>
          <p style="font-size: 12px; color: var(--text-secondary);">Cataloged instruction skills (SKILL.md) discovered across global and workspace directories.</p>
        </div>
        <div style="display: flex; gap: 10px;">
          <input type="text" class="form-control mono" id="skill-search-input" placeholder="Search skills by name..." style="width: 280px;">
          <button class="btn btn-secondary btn-sm" id="skills-view-refresh-btn">Refresh</button>
          <button class="btn btn-sm" id="skills-view-install-btn">+ Install Skill</button>
        </div>
      </div>
      <div class="table-responsive">
        <table id="skill-table-detailed">
          <thead>
            <tr>
              <th>Skill Name</th>
              <th>Source Location</th>
              <th>Description</th>
              <th>Scope</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="skill-table-detailed-body">
            <tr><td colspan="5" style="color: var(--text-muted); text-align: center;">Loading skills catalog...</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <!-- VIEW: INSTALL VIEW (BIFURCATED WORKBENCH) -->
  <div class="view-panel" id="view-install">
    <div style="margin-bottom: 20px;">
      <h2 style="font-size: 18px; color: var(--text-primary); margin-bottom: 6px;">Bifurcated Extension Workbench</h2>
      <p style="color: var(--text-secondary); font-size: 13px;">Deploy new capabilities into the Unified MCP Server environment. Prompt instruction skills and executable server bridges are strictly bifurcated.</p>
    </div>
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 24px;">
      <!-- Skill Ingestion Box -->
      <div class="card">
        <div class="card-header">
          <h2>Install Agent Skill (SKILL.md)</h2>
          <span class="badge badge-mandatory">Instruction</span>
        </div>
        <p style="font-size: 12px; color: var(--text-secondary); margin-bottom: 16px;">
          Installs a structured markdown instruction folder containing a SKILL.md specification for autonomous agents.
        </p>
        <form id="workbench-skill-form">
          <div class="form-group">
            <label>Skill Name (alphanumeric, -, _)</label>
            <input type="text" class="form-control" id="wb-skill-name" required placeholder="e.g. database-debugger">
          </div>
          <div class="form-group">
            <label>Source Path or Git Repository</label>
            <input type="text" class="form-control" id="wb-skill-source" required placeholder="/path/to/skill or https://github.com/...">
          </div>
          <div class="form-group">
            <label>Installation Scope</label>
            <select class="form-control" id="wb-skill-scope">
              <option value="global">Global (~/.gemini, ~/.cline, etc.)</option>
              <option value="workspace">Workspace Local</option>
            </select>
          </div>
          <button type="submit" class="btn" style="width: 100%; margin-top: 10px;">Deploy Skill</button>
        </form>
      </div>

      <!-- Server Ingestion Box -->
      <div class="card">
        <div class="card-header">
          <h2>Install Executable MCP Server</h2>
          <span class="badge badge-optional">Executable</span>
        </div>
        <p style="font-size: 12px; color: var(--text-secondary); margin-bottom: 16px;">
          Registers a downstream stdio, SSE, or HTTP tool/resource server into the Unified MCP registry.
        </p>
        <form id="workbench-server-form">
          <div class="form-group">
            <label>Server Identifier</label>
            <input type="text" class="form-control" id="wb-server-name" required placeholder="e.g. sqlite-db">
          </div>
          <div class="form-group">
            <label>Transport Mechanism</label>
            <select class="form-control" id="wb-server-transport">
              <option value="stdio">stdio (Standard I/O)</option>
              <option value="sse">SSE (Server-Sent Events)</option>
              <option value="http">HTTP Stream</option>
            </select>
          </div>
          <div class="form-group" id="wb-command-group">
            <label>Executable Command</label>
            <input type="text" class="form-control mono" id="wb-server-command" placeholder="e.g. npx or uvx">
          </div>
          <div class="form-group" id="wb-args-group">
            <label>Arguments (comma-separated)</label>
            <input type="text" class="form-control mono" id="wb-server-args" placeholder="e.g. -y, @modelcontextprotocol/server-sqlite">
          </div>
          <div class="form-group" id="wb-url-group" style="display: none;">
            <label>Remote Endpoint URL</label>
            <input type="url" class="form-control mono" id="wb-server-url" placeholder="http://127.0.0.1:8080/sse">
          </div>
          <button type="submit" class="btn" style="width: 100%; margin-top: 10px;">Register MCP Server</button>
        </form>
      </div>
    </div>
  </div>

  <!-- VIEW: POLICIES VIEW -->
  <div class="view-panel" id="view-policies">
    <div class="card">
      <div class="filter-bar">
        <div>
          <h2 style="margin-bottom: 4px;">IDE Target Policy Sync Matrix (P1–P7)</h2>
          <p style="font-size: 12px; color: var(--text-secondary);">Enforces global MCP priority execution order and synchronizes rules across Cursor, VS Code, Windsurf, and Cline.</p>
        </div>
        <button class="btn btn-success btn-sm" id="policies-view-sync-btn">&check; Synchronize All IDE Policies</button>
      </div>
      <div class="table-responsive">
        <table id="policies-detailed-table">
          <thead>
            <tr>
              <th>Priority Level</th>
              <th>Server / Tool Resource</th>
              <th>Role & Architecture</th>
              <th>Enforcement Rule</th>
              <th>Execution Directive</th>
            </tr>
          </thead>
          <tbody id="policies-detailed-table-body">
            <tr><td colspan="5" style="color: var(--text-muted); text-align: center;">Loading policy matrix...</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <!-- VIEW: CHATGPT WEB VIEW -->
  <div class="view-panel" id="view-chatgpt">
    <div class="card">
      <div class="card-header">
        <h2>ChatGPT Companion Bridge — Lifecycle State Machine</h2>
        <div style="display: flex; gap: 8px;">
          <button class="btn btn-secondary btn-sm" id="chatgpt-view-refresh-btn">Check Status</button>
        </div>
      </div>
      <p style="font-size: 13px; color: var(--text-secondary); margin-bottom: 20px;">
        The ChatGPT Web Gateway bridges your browser ChatGPT session directly into local MCP server tools through Cloudflare Workers. It implements a strict 4-state lifecycle guard: <strong>STOPPED &rarr; INITIALIZING &rarr; BRIDGE_HEALTHY &rarr; SESSION_CONNECTED</strong>.
      </p>

      <!-- Stepper Visualizer -->
      <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 24px;" id="gateway-stepper">
        <div class="stat-chip" id="step-stopped">
          <span class="stat-label">Phase 1</span>
          <span style="font-weight: 600; font-size: 14px;">STOPPED</span>
          <span style="font-size: 11px; color: var(--text-muted);">Process dormant</span>
        </div>
        <div class="stat-chip" id="step-initializing">
          <span class="stat-label">Phase 2</span>
          <span style="font-weight: 600; font-size: 14px;">INITIALIZING</span>
          <span style="font-size: 11px; color: var(--text-muted);">Starting tunnel</span>
        </div>
        <div class="stat-chip" id="step-healthy">
          <span class="stat-label">Phase 3</span>
          <span style="font-weight: 600; font-size: 14px;">BRIDGE_HEALTHY</span>
          <span style="font-size: 11px; color: var(--text-muted);">Hard gate unblocked</span>
        </div>
        <div class="stat-chip" id="step-connected">
          <span class="stat-label">Phase 4</span>
          <span style="font-weight: 600; font-size: 14px;">CONNECTED</span>
          <span style="font-size: 11px; color: var(--text-muted);">Session streaming</span>
        </div>
      </div>

      <div style="background: var(--surface-2); border: 1px solid var(--border-subtle); border-radius: 6px; padding: 18px; margin-bottom: 24px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
          <span style="font-size: 12px; font-weight: 600; color: var(--text-secondary); text-transform: uppercase;">ChatGPT MCP URL</span>
          <span id="chatgpt-view-tunnel-badge" class="badge badge-state mono">Inactive</span>
        </div>
        <div id="chatgpt-view-tunnel-url" class="mono" style="font-size: 13px; color: var(--text-primary); word-break: break-all;">
          None
        </div>
      </div>

      <div style="display: flex; gap: 12px; flex-wrap: wrap;">
        <button class="btn btn-secondary" id="chatgpt-view-start-btn">Start Cloudflare Gateway</button>
        <button class="btn btn-secondary" id="chatgpt-view-stop-btn">Stop Gateway</button>
        <button class="btn" id="chatgpt-view-connect-btn" disabled>Connect ChatGPT Web Session</button>
      </div>
    </div>
  </div>

  <!-- VIEW: LOGS VIEW -->
  <div class="view-panel" id="view-logs">
    <div class="card" style="padding: 0; overflow: hidden;">
      <div class="terminal-box">
        <div class="terminal-toolbar">
          <div style="display: flex; align-items: center; gap: 10px;">
            <div class="led" id="logs-live-led"></div>
            <span style="font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em;">Telemetry Stream</span>
            <span class="badge badge-state mono" id="logs-count-badge">0 events</span>
          </div>
          <div style="display: flex; align-items: center; gap: 8px;">
            <input type="text" class="form-control mono" id="logs-filter-text" placeholder="Filter text..." style="padding: 4px 8px; font-size: 11px; width: 150px;">
            <select class="form-control mono" id="logs-level-select" style="padding: 4px 8px; font-size: 11px; width: 95px;">
              <option value="ALL">ALL</option>
              <option value="INFO">INFO</option>
              <option value="SUCCESS">SUCCESS</option>
              <option value="WARN">WARN</option>
              <option value="ERROR">ERROR</option>
            </select>
            <label style="font-size: 11px; color: var(--text-muted); display: flex; align-items: center; gap: 4px; user-select: none; cursor: pointer;">
              <input type="checkbox" id="logs-autoscroll" checked> Scroll
            </label>
            <button class="btn btn-secondary btn-sm" id="logs-copy-btn">Copy</button>
            <button class="btn btn-secondary btn-sm" id="logs-clear-btn">Clear</button>
          </div>
        </div>
        <div class="terminal-body" id="terminal-log-body">
          <div class="log-line">
            <span class="log-time">--:--:--</span>
            <span class="log-level INFO">[INIT]</span>
            <span class="log-msg">Obsidian Telemetry Stream initialized. Polling /api/logs...</span>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- Skill Modal -->
  <div class="modal-overlay" id="install-skill-modal">
    <div class="modal-content">
      <h3>Install Agent Skill</h3>
      <form id="skill-form">
        <div class="form-group">
          <label>Skill Name (alphanumeric, -, _)</label>
          <input type="text" class="form-control" id="skill-name" required placeholder="e.g. unit-testing">
        </div>
        <div class="form-group">
          <label>Source Path or Directory</label>
          <input type="text" class="form-control" id="skill-source" required placeholder="/path/to/skill or git repo">
        </div>
        <div class="form-group">
          <label>Scope</label>
          <select class="form-control" id="skill-scope">
            <option value="global">Global (~/.gemini, ~/.cline, etc.)</option>
            <option value="workspace">Workspace Local</option>
          </select>
        </div>
        <div class="form-actions">
          <button type="button" class="btn btn-secondary" id="close-skill-modal-btn">Cancel</button>
          <button type="submit" class="btn">Install Skill</button>
        </div>
      </form>
    </div>
  </div>

  <!-- Server Modal -->
  <div class="modal-overlay" id="install-server-modal">
    <div class="modal-content">
      <h3>Install Executable MCP Server</h3>
      <form id="server-form">
        <div class="form-group">
          <label>Server Name</label>
          <input type="text" class="form-control" id="server-name" required placeholder="e.g. sqlite">
        </div>
        <div class="form-group">
          <label>Transport</label>
          <select class="form-control" id="server-transport">
            <option value="stdio">stdio</option>
            <option value="sse">SSE</option>
            <option value="http">HTTP</option>
          </select>
        </div>
        <div class="form-group" id="command-group">
          <label>Command (Executable)</label>
          <input type="text" class="form-control mono" id="server-command" placeholder="e.g. npx or uvx">
        </div>
        <div class="form-group" id="args-group">
          <label>Arguments (comma-separated)</label>
          <input type="text" class="form-control mono" id="server-args" placeholder="e.g. -y, @modelcontextprotocol/server-sqlite">
        </div>
        <div class="form-group" id="url-group" style="display: none;">
          <label>Endpoint URL</label>
          <input type="url" class="form-control mono" id="server-url" placeholder="http://127.0.0.1:8080/sse">
        </div>
        <div class="form-actions">
          <button type="button" class="btn btn-secondary" id="close-server-modal-btn">Cancel</button>
          <button type="submit" class="btn">Install Server</button>
        </div>
      </form>
    </div>
  </div>

  <div class="toast" id="toast"></div>
  `;
}

