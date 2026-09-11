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

  it('enforces gated connect button logic matching BRIDGE_HEALTHY in client script', () => {
    const html = renderDashboardHtml();
    expect(html).toContain('BRIDGE_HEALTHY');
    expect(html).toContain('connect-btn');
  });
});
