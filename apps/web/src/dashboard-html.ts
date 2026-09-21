import { OBSIDIAN_THEME_CSS } from './ui/tokens.js';
import { renderDashboardViewsHtml } from './ui/views.js';
import { getClientScriptJs } from './ui/client-script.js';

export function renderDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Unified-MPC-Server — Obsidian Telemetry</title>
  <style>
${OBSIDIAN_THEME_CSS}
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <div class="led" id="status-led"></div>
      <span>Unified-MPC-Server</span>
      <span id="build-commit" class="mono" style="color: var(--text-muted); font-size: 12px;" title="Waiting for MCP runtime build identity">unknown</span>
      <span class="brand-chip">Obsidian Telemetry</span>
    </div>
    <nav>
      <a class="active" id="nav-dashboard">Dashboard</a>
      <a id="nav-projects">Projects</a>
      <a id="nav-servers">Servers</a>
      <a id="nav-skills">Skills</a>
      <a id="nav-policies">Policies</a>
      <a id="nav-chatgpt">ChatGPT Web</a>
      <a id="nav-logs">Logs</a>
    </nav>
  </header>

  <main class="app-container">
${renderDashboardViewsHtml()}
  </main>

  <script>
${getClientScriptJs()}
  </script>
</body>
</html>`;
}
