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
        <span class="stat-value" id="stat-policies-count">P1-Pn</span>
      </div>
      <div class="stat-chip">
        <span class="stat-label">Bridge State</span>
        <span class="stat-value" id="stat-bridge-state" style="font-size: 15px; color: var(--status-syncing);">STOPPED</span>
      </div>
      <div class="stat-chip">
        <span class="stat-label">Loopback Port</span>
        <span class="stat-value" id="stat-loopback-port">18765</span>
      </div>
      <div class="stat-chip">
        <span class="stat-label">MCP RSS</span>
        <span class="stat-value" id="stat-runtime-rss">—</span>
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
            <h2>Policy Execution Priorities (P1–Pn)</h2>
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
          <h2>LLM-managed Extensions</h2>
          <p style="color: var(--text-secondary); font-size: 12px; margin-bottom: 0; line-height: 1.7;">
            Skill and child MCP installation is LLM-managed through the canonical Unified MCP store. This dashboard is intentionally limited to inventory, policy management, health, and safe pruning.
          </p>
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

  <!-- VIEW: PROJECTS / CONTEXT + AUTHORITATIVE RUNTIME -->
  <div class="view-panel" id="view-projects">
    <div class="card">
      <div class="filter-bar">
        <div>
          <h2 style="margin-bottom: 4px;">Projects — Context & Runtime</h2>
          <p style="font-size: 12px; color: var(--text-secondary);">Web Scope and Default are context controls only. Runtime state comes from authoritative Goal Runtime snapshots, so several projects may report work independently.</p>
        </div>
        <button class="btn btn-secondary btn-sm" id="projects-refresh-btn" type="button">Refresh</button>
      </div>
      <div class="table-responsive">
        <table id="projects-table">
          <thead>
            <tr>
              <th>Project</th>
              <th>Path</th>
              <th>Scope</th>
              <th>Default</th>
              <th>Runtime</th>
              <th>Goals</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="projects-table-body">
            <tr><td colspan="7" style="color: var(--text-muted); text-align: center;">Loading registered projects...</td></tr>
          </tbody>
        </table>
      </div>
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

  <!-- VIEW: POLICIES VIEW -->
  <div class="view-panel" id="view-policies">
    <div class="card">
      <div class="filter-bar">
        <div>
          <h2 style="margin-bottom: 4px;">Runtime Policy Editor (P1–Pn)</h2>
          <p style="font-size: 12px; color: var(--text-secondary);">Semantic policy IDs stay stable while P1–Pn is derived from this editable execution order. Save first, then synchronize the same order across IDE targets.</p>
        </div>
        <div style="display: flex; gap: 8px; flex-wrap: wrap;">
          <button class="btn btn-secondary btn-sm" id="policy-add-btn" type="button">+ Add Policy</button>
          <button class="btn btn-sm" id="policy-save-btn" type="button">Save Order & Policies</button>
          <button class="btn btn-success btn-sm" id="policies-view-sync-btn" type="button">&check; Save & Sync IDE Policies</button>
        </div>
      </div>
      <div class="table-responsive">
        <table id="policies-detailed-table">
          <thead>
            <tr>
              <th>Priority</th>
              <th>Policy ID</th>
              <th>Resource</th>
              <th>Type</th>
              <th>Mandatory</th>
              <th>Enforcement</th>
              <th>Required Tools</th>
              <th>Directive</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody id="policies-detailed-table-body">
            <tr><td colspan="9" style="color: var(--text-muted); text-align: center;">Loading policy matrix...</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <!-- VIEW: CHATGPT WEB VIEW -->
  <div class="view-panel" id="view-chatgpt">
    <div class="card">
      <div class="card-header">
        <h2>Gateway Configuration</h2>
        <button class="btn btn-secondary btn-sm" id="settings-refresh-btn" type="button">Reload</button>
      </div>
      <form id="gateway-settings-form">
        <p style="font-size: 13px; color: var(--text-secondary);">Enter Cloudflare account and hostname values. System creates or reuses tunnel, configures ingress and DNS, stores credentials in Linux Secret Service, starts cloudflared, then verifies bridge health.</p>
        <div class="form-group"><label for="settings-account-id">Cloudflare Account ID</label><input class="form-control mono" id="settings-account-id" type="text" required autocomplete="off" placeholder="32-character account ID"></div>
        <div class="form-group"><label for="settings-zone-name">Cloudflare Zone Name</label><input class="form-control mono" id="settings-zone-name" type="text" required autocomplete="off" placeholder="example.com"></div>
        <div class="form-group"><label for="settings-tunnel-name">Named Tunnel Name</label><input class="form-control mono" id="settings-tunnel-name" type="text" required autocomplete="off" placeholder="Enter tunnel name"></div>
        <div class="form-group"><label for="settings-public-url">Public URL</label><input class="form-control mono" id="settings-public-url" type="url" required placeholder="https://your-host.example.com"></div>
        <div class="form-group"><label for="settings-origin-url">Local MCP Origin</label><input class="form-control mono" id="settings-origin-url" type="url" required placeholder="http://127.0.0.1:&lt;mcp-port&gt;"></div>
        <div class="form-group"><label for="settings-api-token">Cloudflare API Token <span class="mono">(write-only)</span></label><input class="form-control mono" id="settings-api-token" type="password" autocomplete="new-password" placeholder="Leave blank to reuse the saved token — paste a new token to replace it"></div>
        <div class="form-group"><label for="settings-allowed-hostnames">Allowed MCP Hostnames</label><input class="form-control mono" id="settings-allowed-hostnames" type="text" required placeholder="Enter allowed hostname(s)"></div>
        <div class="form-group"><label for="settings-allowed-origins">Allowed MCP Origins</label><input class="form-control mono" id="settings-allowed-origins" type="text" required placeholder="https://your-hostname"></div>
        <button class="btn" type="submit">Validate, Configure & Start</button>
        <span id="settings-token-status" class="badge badge-state mono">Credentials not configured</span>
      </form>
    </div>
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
        <button class="btn btn-danger" id="chatgpt-view-disconnect-btn">Disconnect ChatGPT Web Session</button>
      </div>
    </div>
  </div>

  <!-- VIEW: LOGS / DIAGNOSTICS -->
  <div class="view-panel" id="view-logs">
    <div class="card" id="runtime-diagnostics-panel">
      <div class="card-header">
        <div>
          <h2>Runtime Diagnostics</h2>
          <div style="margin-top: 4px; color: var(--text-muted); font-size: 12px;">Local MCP process · authoritative control-plane telemetry</div>
        </div>
        <div style="display: flex; align-items: center; gap: 8px;">
          <span class="badge badge-state mono" id="runtime-diagnostics-source">waiting</span>
          <button class="btn btn-secondary btn-sm" id="runtime-diagnostics-refresh-btn">Refresh</button>
        </div>
      </div>
      <div class="stats-row" style="margin-bottom: 16px;">
        <div class="stat-chip">
          <span class="stat-label">RSS</span>
          <span class="stat-value" id="runtime-rss">—</span>
        </div>
        <div class="stat-chip">
          <span class="stat-label">Heap Used</span>
          <span class="stat-value" id="runtime-heap-used">—</span>
        </div>
        <div class="stat-chip">
          <span class="stat-label">Heap Total</span>
          <span class="stat-value" id="runtime-heap-total">—</span>
        </div>
        <div class="stat-chip">
          <span class="stat-label">External / Array Buffers</span>
          <span class="stat-value" id="runtime-external">—</span>
        </div>
      </div>
      <div style="margin-bottom: 8px; color: var(--text-muted); font-size: 12px;">— means no process-authoritative owner is exposed for that counter.</div>
      <div class="table-responsive">
        <table aria-label="Runtime retention diagnostics">
          <thead>
            <tr>
              <th>Retained State</th>
              <th>Current</th>
              <th>Limit</th>
            </tr>
          </thead>
          <tbody id="runtime-retention-body">
            <tr><td colspan="3" style="color: var(--text-muted); text-align: center;">Loading MCP runtime diagnostics...</td></tr>
          </tbody>
        </table>
      </div>
    </div>

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

  <div class="toast" id="toast"></div>
  `;
}

