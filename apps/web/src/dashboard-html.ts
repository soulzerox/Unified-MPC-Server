export function renderDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Unified-MPC-Server — Obsidian Telemetry</title>
  <style>
    :root {
      --canvas:           #090A0C;
      --surface-1:        #111318;
      --surface-2:        #181B22;
      --surface-hover:    #222631;
      --text-primary:     #E8EAED;
      --text-secondary:   #9AA0AE;
      --text-muted:       #5F6570;
      --border-subtle:    #1F2430;
      --border-default:   #2C3241;
      --status-healthy:   #10B981;
      --status-syncing:   #F59E0B;
      --status-offline:   #EF4444;
      --status-dormant:   #6366F1;
      --action-primary:   #3B82F6;
      --action-danger:    #DC2626;
      --action-success:   #10B981;
      --font-ui:          'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      --font-mono:        'JetBrains Mono', monospace;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--canvas);
      color: var(--text-primary);
      font-family: var(--font-ui);
      font-size: 14px;
      line-height: 1.5;
      padding: 0 24px 48px;
    }
    header {
      max-width: 1200px;
      margin: 0 auto;
      padding: 24px 0 16px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid var(--border-subtle);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      font-weight: 600;
      font-size: 16px;
      letter-spacing: -0.01em;
    }
    .led {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--status-healthy);
      box-shadow: 0 0 8px var(--status-healthy);
      transition: background 0.3s, box-shadow 0.3s;
    }
    .led.offline {
      background: var(--status-offline);
      box-shadow: 0 0 8px var(--status-offline);
    }
    .led.syncing {
      background: var(--status-syncing);
      box-shadow: 0 0 8px var(--status-syncing);
    }
    nav {
      display: flex;
      gap: 24px;
    }
    nav a {
      color: var(--text-muted);
      text-decoration: none;
      padding-bottom: 4px;
      font-size: 13px;
      cursor: pointer;
      transition: color 0.2s;
    }
    nav a:hover { color: var(--text-secondary); }
    nav a.active {
      color: var(--text-primary);
      border-bottom: 2px solid var(--action-primary);
    }
    main {
      max-width: 1200px;
      margin: 32px auto 0;
      display: grid;
      grid-template-columns: 2fr 1fr;
      gap: 24px;
    }
    .card {
      background: var(--surface-1);
      border: 1px solid var(--border-subtle);
      border-radius: 6px;
      padding: 20px;
      margin-bottom: 24px;
    }
    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
    }
    .card h2 {
      font-size: 14px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-secondary);
    }
    .btn {
      background: var(--action-primary);
      color: #fff;
      border: none;
      border-radius: 6px;
      padding: 8px 16px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      transition: opacity 0.2s, background 0.2s;
    }
    .btn:hover:not(:disabled) { opacity: 0.9; }
    .btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
    .btn-secondary {
      background: var(--surface-2);
      border: 1px solid var(--border-default);
      color: var(--text-primary);
    }
    .btn-secondary:hover:not(:disabled) {
      background: var(--surface-hover);
    }
    .btn-sm {
      padding: 4px 10px;
      font-size: 12px;
    }
    .mono { font-family: var(--font-mono); }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; }
    th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--border-subtle); font-size: 13px; }
    th { color: var(--text-muted); font-size: 12px; font-weight: 500; }
    .badge {
      display: inline-block;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 11px;
      font-family: var(--font-mono);
    }
    .badge-mandatory { background: rgba(16, 185, 129, 0.15); color: var(--status-healthy); }
    .badge-optional { background: rgba(154, 160, 174, 0.15); color: var(--text-secondary); }
    .badge-state { background: var(--surface-2); border: 1px solid var(--border-subtle); }
    .toast {
      position: fixed;
      bottom: 24px;
      right: 24px;
      background: var(--surface-2);
      border: 1px solid var(--border-default);
      color: var(--text-primary);
      padding: 12px 18px;
      border-radius: 6px;
      font-size: 13px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.5);
      z-index: 9999;
      display: none;
    }
    /* Modal styles */
    .modal-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.7);
      backdrop-filter: blur(4px);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }
    .modal-content {
      background: var(--surface-1);
      border: 1px solid var(--border-default);
      border-radius: 8px;
      width: 100%;
      max-width: 500px;
      padding: 24px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.6);
    }
    .modal-content h3 {
      font-size: 16px;
      margin-bottom: 16px;
      color: var(--text-primary);
    }
    .form-group {
      margin-bottom: 14px;
    }
    .form-group label {
      display: block;
      margin-bottom: 6px;
      font-size: 12px;
      color: var(--text-secondary);
      font-weight: 500;
    }
    .form-control {
      width: 100%;
      background: var(--surface-2);
      border: 1px solid var(--border-subtle);
      color: var(--text-primary);
      padding: 8px 12px;
      border-radius: 4px;
      font-family: inherit;
      font-size: 13px;
      outline: none;
    }
    .form-control:focus {
      border-color: var(--action-primary);
    }
    .form-actions {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      margin-top: 20px;
    }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <div class="led" id="status-led"></div>
      <span>Unified-MPC-Server</span>
      <span class="mono" style="color: var(--text-muted); font-size: 12px;">v1.0.0</span>
    </div>
    <nav>
      <a class="active" id="nav-dashboard">Dashboard</a>
      <a id="nav-servers">Servers</a>
      <a id="nav-skills">Skills</a>
      <a id="nav-install">Install</a>
      <a id="nav-policies">Policies</a>
      <a id="nav-chatgpt">ChatGPT Web</a>
      <a id="nav-logs">Logs</a>
    </nav>
  </header>

  <main>
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

      <div class="card">
        <div class="card-header">
          <h2>Policy Execution Priorities (P1–P7)</h2>
          <button class="btn btn-secondary btn-sm" id="sync-policies-btn">Sync All Policies</button>
        </div>
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
    </section>

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
    </aside>
  </main>

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
          <input type="text" class="form-control" id="server-command" placeholder="e.g. npx or uvx">
        </div>
        <div class="form-group" id="args-group">
          <label>Arguments (comma-separated)</label>
          <input type="text" class="form-control" id="server-args" placeholder="e.g. -y, @modelcontextprotocol/server-sqlite">
        </div>
        <div class="form-group" id="url-group" style="display: none;">
          <label>Endpoint URL</label>
          <input type="url" class="form-control" id="server-url" placeholder="http://127.0.0.1:8080/sse">
        </div>
        <div class="form-actions">
          <button type="button" class="btn btn-secondary" id="close-server-modal-btn">Cancel</button>
          <button type="submit" class="btn">Install Server</button>
        </div>
      </form>
    </div>
  </div>

  <div class="toast" id="toast"></div>

  <script>
    (function () {
      function showToast(message, isError = false) {
        const toast = document.getElementById('toast');
        toast.textContent = message;
        toast.style.borderColor = isError ? 'var(--status-offline)' : 'var(--action-primary)';
        toast.style.display = 'block';
        setTimeout(() => { toast.style.display = 'none'; }, 4000);
      }

      async function loadStatus() {
        try {
          const res = await fetch('/api/status');
          if (!res.ok) throw new Error('Status request failed');
          const data = await res.json();
          document.getElementById('status-led').className = 'led';
          document.getElementById('servers-telemetry').innerHTML =
            '<div style="line-height: 1.8;">' +
            '<div>Status: <span style="color: var(--status-healthy);">' + data.status + '</span></div>' +
            '<div>Gateway State: ' + (data.gateway?.state || 'STOPPED') + '</div>' +
            '<div>Local Loopback Port: ' + (data.gateway?.localPort || 18765) + '</div>' +
            '</div>';
        } catch (err) {
          document.getElementById('status-led').className = 'led offline';
          document.getElementById('servers-telemetry').textContent = 'Unable to reach backend: ' + err.message;
        }
      }

      async function loadPolicies() {
        try {
          const res = await fetch('/api/policies');
          if (!res.ok) throw new Error('Policies request failed');
          const data = await res.json();
          const tbody = document.getElementById('policy-table-body');
          if (!data.policies || data.policies.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" style="text-align: center;">No policies configured</td></tr>';
            return;
          }
          tbody.innerHTML = data.policies.map(p => {
            const badgeClass = p.mandatory ? 'badge badge-mandatory' : 'badge badge-optional';
            const mandatoryText = p.mandatory ? '✅ YES' : 'Optional';
            return '<tr>' +
              '<td class="mono">' + p.priority + '</td>' +
              '<td><strong>' + p.resourceId + '</strong></td>' +
              '<td>' + p.resourceType + '</td>' +
              '<td><span class="' + badgeClass + '">' + p.enforcement + '</span></td>' +
              '<td style="color: var(--text-secondary);">' + p.directive + '</td>' +
              '</tr>';
          }).join('');
        } catch (err) {
          document.getElementById('policy-table-body').innerHTML =
            '<tr><td colspan="5" style="color: var(--status-offline);">Failed to load policies: ' + err.message + '</td></tr>';
        }
      }

      async function loadGatewayStatus() {
        try {
          const res = await fetch('/api/chatgpt-gateway/status');
          if (!res.ok) throw new Error('Gateway status failed');
          const data = await res.json();
          const state = data.state || 'STOPPED';
          const bridgeEl = document.getElementById('bridge-state');
          const connectBtn = document.getElementById('connect-btn');
          const tunnelEl = document.getElementById('tunnel-url');

          bridgeEl.textContent = state;
          tunnelEl.textContent = data.tunnelUrl || 'None';

          if (state === 'BRIDGE_HEALTHY') {
            connectBtn.disabled = false;
            connectBtn.title = 'Ready to connect';
            bridgeEl.style.color = 'var(--status-healthy)';
          } else {
            connectBtn.disabled = true;
            connectBtn.title = 'Bridge must be in BRIDGE_HEALTHY state before connecting';
            bridgeEl.style.color = state === 'INITIALIZING' ? 'var(--status-syncing)' : 'var(--text-secondary)';
          }
        } catch (err) {
          console.error(err);
        }
      }

      document.getElementById('sync-policies-btn').addEventListener('click', async () => {
        try {
          showToast('Syncing policies across IDE targets...');
          const res = await fetch('/api/policies/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targets: ['all'] }),
          });
          const result = await res.json();
          if (result.ok) {
            showToast('Synchronized ' + result.value.updatedFiles.length + ' policy files!');
          } else {
            showToast('Sync failed: ' + (result.error?.message || 'Error'), true);
          }
        } catch (err) {
          showToast('Sync failed: ' + err.message, true);
        }
      });

      document.getElementById('connect-btn').addEventListener('click', async () => {
        try {
          const res = await fetch('/api/chatgpt-web/connect');
          if (res.status === 412) {
            const errData = await res.json();
            showToast('Hard Gate Blocked (412): ' + errData.error, true);
            return;
          }
          const data = await res.json();
          if (res.ok) {
            showToast('Connected to ChatGPT Web successfully!');
          } else {
            showToast('Connection failed: ' + (data.message || 'Error'), true);
          }
          loadGatewayStatus();
        } catch (err) {
          showToast('Connect error: ' + err.message, true);
        }
      });

      document.getElementById('start-gateway-btn').addEventListener('click', async () => {
        try {
          showToast('Starting ChatGPT Gateway...');
          const res = await fetch('/api/chatgpt-gateway/start', { method: 'POST' });
          const result = await res.json();
          showToast(result.ok ? 'Gateway started!' : 'Failed: ' + result.error?.message, !result.ok);
          loadGatewayStatus();
        } catch (err) {
          showToast('Start failed: ' + err.message, true);
        }
      });

      document.getElementById('stop-gateway-btn').addEventListener('click', async () => {
        try {
          const res = await fetch('/api/chatgpt-gateway/stop', { method: 'POST' });
          const result = await res.json();
          showToast('Gateway stopped');
          loadGatewayStatus();
        } catch (err) {
          showToast('Stop failed: ' + err.message, true);
        }
      });

      // Modals
      const skillModal = document.getElementById('install-skill-modal');
      const serverModal = document.getElementById('install-server-modal');

      document.getElementById('open-skill-modal-btn').onclick = () => skillModal.style.display = 'flex';
      document.getElementById('close-skill-modal-btn').onclick = () => skillModal.style.display = 'none';

      document.getElementById('open-server-modal-btn').onclick = () => serverModal.style.display = 'flex';
      document.getElementById('close-server-modal-btn').onclick = () => serverModal.style.display = 'none';

      document.getElementById('server-transport').addEventListener('change', (e) => {
        const isUrl = e.target.value === 'sse' || e.target.value === 'http';
        document.getElementById('url-group').style.display = isUrl ? 'block' : 'none';
        document.getElementById('command-group').style.display = isUrl ? 'none' : 'block';
        document.getElementById('args-group').style.display = isUrl ? 'none' : 'block';
      });

      document.getElementById('skill-form').onsubmit = async (e) => {
        e.preventDefault();
        const payload = {
          name: document.getElementById('skill-name').value.trim(),
          source: document.getElementById('skill-source').value.trim(),
          scope: document.getElementById('skill-scope').value,
          targets: ['all'],
        };
        try {
          showToast('Installing skill ' + payload.name + '...');
          const res = await fetch('/api/skills/install', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          const result = await res.json();
          if (result.ok) {
            showToast('Installed skill ' + payload.name + ' successfully!');
            skillModal.style.display = 'none';
            document.getElementById('skill-form').reset();
          } else {
            showToast('Install failed: ' + (result.error?.message || 'Error'), true);
          }
        } catch (err) {
          showToast('Error: ' + err.message, true);
        }
      };

      document.getElementById('server-form').onsubmit = async (e) => {
        e.preventDefault();
        const transport = document.getElementById('server-transport').value;
        const argsRaw = document.getElementById('server-args').value.trim();
        const payload = {
          name: document.getElementById('server-name').value.trim(),
          transport,
          command: document.getElementById('server-command').value.trim() || undefined,
          args: argsRaw ? argsRaw.split(',').map(a => a.trim()).filter(Boolean) : undefined,
          url: document.getElementById('server-url').value.trim() || undefined,
          targets: ['all'],
          scope: 'global',
        };
        try {
          showToast('Installing server ' + payload.name + '...');
          const res = await fetch('/api/servers/install', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          const result = await res.json();
          if (result.ok) {
            showToast('Installed server ' + payload.name + ' successfully!');
            serverModal.style.display = 'none';
            document.getElementById('server-form').reset();
            loadStatus();
          } else {
            showToast('Install failed: ' + (result.error?.message || 'Error'), true);
          }
        } catch (err) {
          showToast('Error: ' + err.message, true);
        }
      };

      document.getElementById('refresh-status-btn').onclick = () => {
        loadStatus();
        loadGatewayStatus();
        loadPolicies();
      };

      // Initial load
      loadStatus();
      loadPolicies();
      loadGatewayStatus();
      setInterval(loadGatewayStatus, 5000);
    })();
  </script>
</body>
</html>`;
}
