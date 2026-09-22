import { describe, expect, it } from 'vitest';
import { renderDashboardHtml } from './dashboard-html.js';

describe('Dashboard HTML Reactive SPA', () => {
  it('renders complete HTML shell with Obsidian styling', () => {
    const html = renderDashboardHtml();
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Unified-MPC-Server');
    expect(html).toContain('Obsidian Telemetry');
    expect(html).toContain('--canvas:           #090A0C;');
  });

  it('renders only the live artifact commit identity in the header', () => {
    const html = renderDashboardHtml();
    expect(html).toContain('id="build-commit"');
    expect(html).toContain('identity.buildShortCommit');
    expect(html).not.toContain('v4.61.0');
    expect(html).not.toContain('identity.buildVersion || identity.version');
    expect(html).toContain('setInterval(loadStatus, 5000)');
  });

  it('contains client-side JavaScript for live reactivity', () => {
    const html = renderDashboardHtml();
    expect(html).toContain('<script>');
    expect(html).toContain('</script>');
  });

  it('wires telemetry and policy API endpoints in script', () => {
    const html = renderDashboardHtml();
    expect(html).toContain('/api/status');
    expect(html).toContain('/api/runtime-diagnostics');
    expect(html).toContain('/api/workspaces');
    expect(html).toContain('/api/policies');
    expect(html).toContain('/api/policies/sync');
    expect(html).toContain('/api/chatgpt-gateway/status');
    expect(html).toContain('/api/chatgpt-web/connect');
  });

  it('renders project goals collapsed by default and lazy-loads them with Select Goal/Open actions', () => {
    const html = renderDashboardHtml();
    expect(html).toContain('project-goals-toggle');
    expect(html).toContain('loadWorkspaceGoals');
    expect(html).toContain("'/goals'");
    expect(html).toContain("'/continue'");
    expect(html).toContain('goal-continue-btn');
    expect(html).toContain('Select Goal');
    expect(html).toContain('goal-open-btn');
    expect(html).toContain('No open goals');
  });

  it('keeps Web context separate from authoritative concurrent Goal runtime state', () => {
    const html = renderDashboardHtml();
    expect(html).toContain('Projects — Context & Runtime');
    expect(html).toContain('<th>Scope</th>');
    expect(html).toContain('<th>Default</th>');
    expect(html).toContain('<th>Runtime</th>');
    expect(html).toContain("active ? 'In Scope' : 'Out of Scope'");
    expect(html).toContain("primary ? 'Default' : '—'");
    expect(html).toContain('Set Default');
    expect(html).toContain("'/goal-runtime'");
    expect(html).toContain("'/goal-runtime/events'");
    expect(html).toContain('new EventSource(endpoint)');
    expect(html).toContain('const workspaceRuntimeRefreshControllers = new Map()');
    expect(html).toContain("cachedWorkspaces.some((workspace) => workspace.id === workspaceId)");
    expect(html).toContain('fetch(endpoint, { signal: controller.signal })');
    expect(html).toContain('if (controller) controller.abort()');
    expect(html).toContain('...workspaceRuntimeRefreshControllers.keys()');
    expect(html).toContain("stream.addEventListener('goal-runtime-snapshot'");
    expect(html).toContain("stream.addEventListener('goal-runtime-event', (event) => {");
    expect(html).toContain('noteWorkspaceRuntimeEvent(workspace.id, JSON.parse(event.data))');
    expect(html).toContain('Number(record.lastEventSequence) >= sequence');
    expect(html).toContain('Projection catching up');
    expect(html).toContain("'Integration: ' + runtimeProjection.integrationState");
    expect(html).toContain('Runtime blocker: ');
    expect(html).not.toContain("addCell(row, active ? 'Active' : 'Inactive')");
    expect(html).not.toContain("addCell(row, primary ? 'Primary' : '—')");
  });

  it('renders a user-editable P1-Pn policy editor with reorder and save controls', () => {
    const html = renderDashboardHtml();
    expect(html).toContain('policy-add-btn');
    expect(html).toContain('policy-save-btn');
    expect(html).toContain('policy-priority-input');
    expect(html).toContain('savePolicies');
    expect(html).toContain("fetch('/api/policies'");
  });

  it('keeps extension inventory and pruning in WebUI but removes all install surfaces', () => {
    const html = renderDashboardHtml();
    expect(html).toContain('/api/servers');
    expect(html).toContain('/api/skills');
    expect(html).toContain('/api/servers/prune');
    expect(html).toContain('/api/skills/prune');
    expect(html).toContain('LLM-managed');
    for (const forbidden of [
      '/api/skills/install',
      '/api/servers/install',
      'install-skill-modal',
      'install-server-modal',
      'workbench-skill-form',
      'workbench-server-form',
      'servers-view-install-btn',
      'skills-view-install-btn',
      'id="view-install"',
      'id="nav-install"',
    ]) expect(html).not.toContain(forbidden);
  });

  it('contains live inventory and opaque-ID prune workflows', () => {
    const html = renderDashboardHtml();
    expect(html).toContain('/api/servers');
    expect(html).toContain('/api/skills');
    expect(html).toContain('/api/servers/prune');
    expect(html).toContain('/api/skills/prune');
    expect(html).toContain('serverId');
    expect(html).toContain('prune-server-btn');
    expect(html).not.toContain('pid:');
  });

  it('enforces gated connect button logic matching BRIDGE_HEALTHY in client script', () => {
    const html = renderDashboardHtml();
    expect(html).toContain('BRIDGE_HEALTHY');
    expect(html).toContain('connect-btn');
  });

  it('shows top-level API errors and reloads after stale capability expiry', () => {
    const html = renderDashboardHtml();
    expect(html).toContain('const error = data?.error ?? data?.message;');
    expect(html).toContain('Capability expired; reloading dashboard');
  });

  it('routes every remaining dashboard mutation through shared capability-expiry recovery', () => {
    const html = renderDashboardHtml();
    expect(html).toContain('async function mutationJson(');
    expect(html).toContain('Capability expired; reloading dashboard');
    expect(html).toContain('window.location.reload()');

    for (const endpoint of [
      '/api/cloudflare/reconcile',
      '/api/policies/sync',
      '/api/chatgpt-web/connect',
      '/api/chatgpt-gateway/start',
      '/api/chatgpt-gateway/stop',
      '/api/chatgpt-web/disconnect',
      '/api/skills/prune',
      '/api/servers/prune',
    ]) {
      expect(html).toContain(`mutationJson('${endpoint}'`);
    }
  });

  it('renders modular tab navigation views for management subsystems', () => {
    const html = renderDashboardHtml();
    expect(html).toContain('id="view-dashboard"');
    expect(html).toContain('id="view-servers"');
    expect(html).toContain('id="view-skills"');
    expect(html).toContain('id="view-policies"');
    expect(html).toContain('id="view-chatgpt"');
    expect(html).toContain('id="view-logs"');
    expect(html).not.toContain('id="view-install"');
  });

  it('embeds the museum-grade canvas topology visualizer', () => {
    const html = renderDashboardHtml();
    expect(html).toContain('topology-canvas-container');
    expect(html).toContain('canvas-svg');
    expect(html).toContain('Obsidian Control Plane Topology');
    expect(html).toContain('UNIFIED CONTROL');
  });

  it('renders authoritative MCP process memory and retention diagnostics without project-health inference', () => {
    const html = renderDashboardHtml();
    expect(html).toContain('Logs / Diagnostics');
    expect(html).toContain('id="stat-runtime-rss"');
    expect(html).toContain('id="runtime-diagnostics-panel"');
    expect(html).toContain('id="runtime-rss"');
    expect(html).toContain('id="runtime-heap-used"');
    expect(html).toContain('id="runtime-retention-body"');
    expect(html).toContain('Local MCP process');
    expect(html).toContain('/api/runtime-diagnostics');
    expect(html).toContain('activityCompletedEntryLimit');
    expect(html).toContain('no process-authoritative owner is exposed');
    expect(html).toContain("typeof value === 'number'");
    expect(html).not.toContain('Project memory pressure');
  });

  it('wires real-time telemetry log terminal and /api/logs', () => {
    const html = renderDashboardHtml();
    expect(html).toContain('terminal-box');
    expect(html).toContain('terminal-log-body');
    expect(html).toContain('/api/logs');
  });
});
