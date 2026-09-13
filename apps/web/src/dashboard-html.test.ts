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
    expect(html).toContain('/api/policies');
    expect(html).toContain('/api/policies/sync');
    expect(html).toContain('/api/chatgpt-gateway/status');
    expect(html).toContain('/api/chatgpt-web/connect');
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
