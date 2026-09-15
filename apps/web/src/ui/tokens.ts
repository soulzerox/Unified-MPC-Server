export const OBSIDIAN_THEME_CSS = `
  :root {
    --canvas:           #090A0C;
    --surface-1:        #111318;
    --surface-2:        #181B22;
    --surface-hover:    #222631;
    --surface-active:   #2A303E;
    --text-primary:     #E8EAED;
    --text-secondary:   #9AA0AE;
    --text-muted:       #5F6570;
    --border-subtle:    #1F2430;
    --border-default:   #2C3241;
    --border-accent:    #3B82F6;
    --status-healthy:   #10B981;
    --status-syncing:   #F59E0B;
    --status-offline:   #EF4444;
    --status-dormant:   #6366F1;
    --action-primary:   #3B82F6;
    --action-danger:    #DC2626;
    --action-success:   #10B981;
    --font-ui:          'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    --font-mono:        'JetBrains Mono', 'Fira Code', Menlo, monospace;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--canvas);
    color: var(--text-primary);
    font-family: var(--font-ui);
    font-size: 14px;
    line-height: 1.5;
    padding: 0 24px 48px;
    min-height: 100vh;
  }
  header {
    max-width: 1280px;
    margin: 0 auto;
    padding: 20px 0 16px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 1px solid var(--border-subtle);
    gap: 16px;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 12px;
    font-weight: 600;
    font-size: 16px;
    letter-spacing: -0.01em;
    user-select: none;
  }
  .brand-chip {
    font-size: 10px;
    font-family: var(--font-mono);
    color: var(--status-healthy);
    background: rgba(16, 185, 129, 0.1);
    border: 1px solid rgba(16, 185, 129, 0.25);
    padding: 2px 6px;
    border-radius: 4px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .led {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--status-healthy);
    box-shadow: 0 0 8px var(--status-healthy);
    transition: background 0.3s, box-shadow 0.3s;
    flex-shrink: 0;
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
    gap: 20px;
    overflow-x: auto;
    padding-bottom: 2px;
  }
  nav a {
    color: var(--text-muted);
    text-decoration: none;
    padding: 6px 4px 8px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: color 0.2s;
    border-bottom: 2px solid transparent;
    white-space: nowrap;
  }
  nav a:hover { color: var(--text-secondary); }
  nav a.active {
    color: var(--text-primary);
    border-bottom-color: var(--action-primary);
  }
  .app-container {
    max-width: 1280px;
    margin: 28px auto 0;
  }
  .view-panel {
    display: none;
    animation: fadeIn 180ms ease-out forwards;
  }
  .view-panel.active {
    display: block;
  }
  .dashboard-grid {
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
    position: relative;
    transition: border-color 0.2s;
  }
  .card:hover {
    border-color: var(--border-default);
  }
  .card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 16px;
    gap: 12px;
  }
  .card h2 {
    font-size: 13px;
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
    transition: opacity 0.2s, background 0.2s, transform 0.1s;
    font-family: inherit;
    text-decoration: none;
  }
  .btn:hover:not(:disabled) { opacity: 0.92; }
  .btn:active:not(:disabled) { transform: translateY(1px); }
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
    border-color: var(--border-accent);
  }
  .btn-danger {
    background: rgba(220, 38, 38, 0.15);
    border: 1px solid rgba(220, 38, 38, 0.4);
    color: #F87171;
  }
  .btn-danger:hover:not(:disabled) {
    background: var(--action-danger);
    color: #fff;
  }
  .btn-success {
    background: rgba(16, 185, 129, 0.15);
    border: 1px solid rgba(16, 185, 129, 0.4);
    color: #34D399;
  }
  .btn-success:hover:not(:disabled) {
    background: var(--action-success);
    color: #fff;
  }
  .btn-sm {
    padding: 4px 10px;
    font-size: 12px;
    border-radius: 4px;
  }
  .mono { font-family: var(--font-mono); }
  .table-responsive {
    overflow-x: auto;
    border: 1px solid var(--border-subtle);
    border-radius: 4px;
    background: var(--surface-1);
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  th, td {
    text-align: left;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border-subtle);
  }
  th {
    color: var(--text-muted);
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    background: var(--surface-2);
  }
  tr:last-child td {
    border-bottom: none;
  }
  tbody tr:hover {
    background: var(--surface-hover);
  }
  .badge {
    display: inline-block;
    padding: 2px 7px;
    border-radius: 4px;
    font-size: 11px;
    font-family: var(--font-mono);
    font-weight: 500;
  }
  .badge-mandatory { background: rgba(16, 185, 129, 0.15); color: var(--status-healthy); border: 1px solid rgba(16, 185, 129, 0.3); }
  .badge-optional { background: rgba(154, 160, 174, 0.12); color: var(--text-secondary); border: 1px solid rgba(154, 160, 174, 0.2); }
  .badge-state { background: var(--surface-2); border: 1px solid var(--border-subtle); color: var(--text-primary); }
  .badge-healthy { background: rgba(16, 185, 129, 0.15); color: var(--status-healthy); }
  .badge-syncing { background: rgba(245, 158, 11, 0.15); color: var(--status-syncing); }
  .badge-offline { background: rgba(239, 68, 68, 0.15); color: var(--status-offline); }

  .project-goals-row td {
    padding: 0;
    background: #0D1016;
  }
  .project-goals-row:hover { background: transparent; }
  .project-goals-panel {
    display: grid;
    gap: 10px;
    padding: 14px;
    color: var(--text-secondary);
  }
  .project-goal-card {
    border: 1px solid var(--border-default);
    border-radius: 6px;
    background: var(--surface-1);
    padding: 14px;
  }
  .project-goal-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 12px;
    margin-bottom: 8px;
  }
  .project-goal-updated {
    color: var(--text-muted);
    font-size: 11px;
    white-space: nowrap;
  }
  .project-goal-objective {
    color: var(--text-secondary);
    line-height: 1.6;
    margin-bottom: 10px;
  }
  .project-goal-meta,
  .project-goal-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 7px;
  }
  .project-goal-actions { margin-top: 12px; }
  .project-goal-blockers {
    margin-top: 10px;
    padding: 8px 10px;
    border-radius: 4px;
    border: 1px solid rgba(245, 158, 11, 0.3);
    background: rgba(245, 158, 11, 0.08);
    color: #FBBF24;
    font-size: 12px;
  }
  .project-goal-details {
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px solid var(--border-subtle);
    color: var(--text-secondary);
    font-size: 12px;
  }
  .project-goal-steps {
    margin: 8px 0 0 20px;
    display: grid;
    gap: 4px;
  }

  .stats-row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
    gap: 14px;
    margin-bottom: 20px;
  }
  .stat-chip {
    background: var(--surface-2);
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .stat-label {
    font-size: 11px;
    text-transform: uppercase;
    color: var(--text-muted);
    font-weight: 500;
    letter-spacing: 0.04em;
  }
  .stat-value {
    font-size: 20px;
    font-weight: 600;
    font-family: var(--font-mono);
    color: var(--text-primary);
  }

  /* Topology Canvas */
  .canvas-card {
    background: #0B0E14;
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    padding: 16px;
    margin-bottom: 24px;
    overflow: hidden;
  }
  .canvas-svg {
    width: 100%;
    height: auto;
    display: block;
  }

  /* Terminal Log Viewer */
  .terminal-box {
    background: #050608;
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-primary);
    display: flex;
    flex-direction: column;
    height: 520px;
    overflow: hidden;
  }
  .terminal-toolbar {
    background: var(--surface-2);
    padding: 8px 14px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 1px solid var(--border-subtle);
    gap: 10px;
  }
  .terminal-body {
    flex: 1;
    overflow-y: auto;
    padding: 12px 16px;
    line-height: 1.6;
    user-select: text;
  }
  .log-line {
    display: flex;
    gap: 12px;
    padding: 2px 0;
    border-bottom: 1px solid rgba(31, 36, 48, 0.4);
  }
  .log-time { color: var(--text-muted); min-width: 80px; flex-shrink: 0; }
  .log-level { min-width: 60px; font-weight: 600; }
  .log-level.INFO { color: var(--action-primary); }
  .log-level.SUCCESS { color: var(--status-healthy); }
  .log-level.WARN { color: var(--status-syncing); }
  .log-level.ERROR { color: var(--status-offline); }
  .log-msg { flex: 1; word-break: break-word; }

  /* Forms & Filters */
  .search-input-wrap {
    position: relative;
    max-width: 320px;
    width: 100%;
  }
  .filter-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    margin-bottom: 16px;
    flex-wrap: wrap;
  }

  /* Toast notification */
  .toast {
    position: fixed;
    bottom: 24px;
    right: 24px;
    background: var(--surface-2);
    border: 1px solid var(--border-default);
    color: var(--text-primary);
    padding: 12px 20px;
    border-radius: 6px;
    font-size: 13px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.6);
    z-index: 9999;
    display: none;
    animation: slideUp 200ms ease-out forwards;
    max-width: 400px;
  }

  /* Modal */
  .modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.75);
    backdrop-filter: blur(5px);
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
    max-width: 520px;
    padding: 24px;
    box-shadow: 0 12px 36px rgba(0,0,0,0.7);
    animation: scaleIn 180ms ease-out forwards;
  }
  .modal-content h3 {
    font-size: 16px;
    margin-bottom: 16px;
    color: var(--text-primary);
  }
  .form-group {
    margin-bottom: 16px;
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
    padding: 9px 12px;
    border-radius: 5px;
    font-family: inherit;
    font-size: 13px;
    outline: none;
    transition: border-color 0.2s, box-shadow 0.2s;
  }
  .form-control:focus {
    border-color: var(--border-accent);
    box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.2);
  }
  .form-actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    margin-top: 24px;
  }

  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(3px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @keyframes slideUp {
    from { opacity: 0; transform: translateY(12px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @keyframes scaleIn {
    from { opacity: 0; transform: scale(0.97); }
    to { opacity: 1; transform: scale(1); }
  }

  @media (max-width: 900px) {
    .dashboard-grid { grid-template-columns: 1fr; }
    header { flex-direction: column; align-items: flex-start; }
    nav { width: 100%; }
  }
`;

