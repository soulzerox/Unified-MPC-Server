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
    }
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
    .card h2 {
      font-size: 14px;
      font-weight: 600;
      margin-bottom: 16px;
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
    }
    .btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
    .mono { font-family: var(--font-mono); }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; }
    th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--border-subtle); }
    th { color: var(--text-muted); font-size: 12px; }
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
      <a class="active">Dashboard</a>
      <a>Servers</a>
      <a>Skills</a>
      <a>Install</a>
      <a>Policies</a>
      <a>Logs</a>
    </nav>
  </header>
  <main>
    <section>
      <div class="card">
        <h2>Subsystem Status & Downstream Servers</h2>
        <div id="servers-telemetry">Telemetry loading...</div>
      </div>
      <div class="card">
        <h2>Policy Execution Priorities (P1–P7)</h2>
        <table id="policy-table">
          <thead>
            <tr><th>Priority</th><th>Resource</th><th>Type</th><th>Enforcement</th></tr>
          </thead>
          <tbody>
            <tr><td class="mono">P1</td><td>memory</td><td>server</td><td>REALTIME</td></tr>
            <tr><td class="mono">P2</td><td>thai-rag-mcp</td><td>server</td><td>EVERY_SESSION</td></tr>
            <tr><td class="mono">P3</td><td>godkiller</td><td>server</td><td>SAFETY_PRE_CHECK</td></tr>
          </tbody>
        </table>
      </div>
    </section>
    <aside>
      <div class="card" id="chatgpt-bridge-card">
        <h2>ChatGPT Web Bridge (Gated)</h2>
        <p style="color: var(--text-secondary); margin-bottom: 12px;">Status: <span id="bridge-state" class="mono">STOPPED</span></p>
        <p style="color: var(--text-secondary); margin-bottom: 16px;">Tunnel: <span id="tunnel-url" class="mono">None</span></p>
        <button class="btn" id="connect-btn" disabled>Connect ChatGPT Web</button>
      </div>
      <div class="card">
        <h2>Bifurcated Ingestion</h2>
        <div style="display: flex; gap: 8px; margin-bottom: 12px;">
          <button class="btn" style="flex: 1;">Install Skill</button>
          <button class="btn" style="flex: 1; background: var(--surface-2); border: 1px solid var(--border-default);">Install Server</button>
        </div>
      </div>
    </aside>
  </main>
</body>
</html>`;
}
