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

  it('contains client-side JavaScript for live reactivity', () => {
    const html = renderDashboardHtml();
    expect(html).toContain('<script>');
    expect(html).toContain('</script>');
  });

  it('wires telemetry and policy API endpoints in script', () => {
    const html = renderDashboardHtml();
    expect(html).toContain('/api/status');
    expect(html).toContain('/api/workspaces');
    expect(html).toContain('/api/policies');
    expect(html).toContain('/api/policies/sync');
    expect(html).toContain('/api/chatgpt-gateway/status');
    expect(html).toContain('/api/chatgpt-web/connect');
  });

  it('renders a user-editable P1-Pn policy editor with reorder and save controls', () => {
    const html = renderDashboardHtml();
    expect(html).toContain('policy-add-btn');
    expect(html).toContain('policy-save-btn');
    expect(html).toContain('policy-priority-input');
    expect(html).toContain('savePolicies');
    expect(html).toContain("fetch('/api/policies'");
  });

  it('contains interactive modal/form elements for bifurcated installation', () => {
    const html = renderDashboardHtml();
    // Skill installation modal & endpoints
    expect(html).toContain('install-skill-modal');
    expect(html).toContain('/api/skills/install');
    // Server installation modal & endpoints
    expect(html).toContain('install-server-modal');
    expect(html).toContain('/api/servers/install');
  });

  it('accepts an HTTPS Git repository as the stdio MCP server source in both install surfaces', () => {
    const html = renderDashboardHtml();
    expect(html).toContain('server-source');
    expect(html).toContain('wb-server-source');
    expect(html).toContain('source: source ? source.trim() : undefined');
    expect(html).toContain('https://github.com/example/mcp-server.git');
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

  it('routes every dashboard mutation through shared capability-expiry recovery', () => {
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
      '/api/skills/install',
      '/api/servers/install',
      '/api/skills/prune',
      '/api/servers/prune',
    ]) {
      expect(html).toContain(`mutationJson('${endpoint}'`);
    }
  });

  it('renders modular tab navigation views for all subsystems', () => {
    const html = renderDashboardHtml();
    expect(html).toContain('id="view-dashboard"');
    expect(html).toContain('id="view-servers"');
    expect(html).toContain('id="view-skills"');
    expect(html).toContain('id="view-install"');
    expect(html).toContain('id="view-policies"');
    expect(html).toContain('id="view-chatgpt"');
    expect(html).toContain('id="view-logs"');
  });

  it('embeds the museum-grade canvas topology visualizer', () => {
    const html = renderDashboardHtml();
    expect(html).toContain('topology-canvas-container');
    expect(html).toContain('canvas-svg');
    expect(html).toContain('Obsidian Control Plane Topology');
    expect(html).toContain('UNIFIED CONTROL');
  });

  it('wires real-time telemetry log terminal and /api/logs', () => {
    const html = renderDashboardHtml();
    expect(html).toContain('terminal-box');
    expect(html).toContain('terminal-log-body');
    expect(html).toContain('/api/logs');
  });
});
