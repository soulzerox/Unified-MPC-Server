import { request as httpRequest } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ControlPlaneServer, type WebGoalSummary, type WebWorkspaceSelectionSnapshot, type WebWorkspaceSummary } from './web-server.js';
import { GatewayService } from '@unified-mpc/cf-gateway';
import {
  InstallerService,
  McpConfigLoader,
  PrunerService,
  IdeSyncService,
  SkillCatalog,
  DEFAULT_EXTENSIONS_SETTINGS,
} from '@unified-mpc/extensions';

describe('ControlPlaneServer - Local Web Control Plane & Telemetry', () => {
  const capabilityToken = 'test-capability-token';
  const gatewayOptions = { localPort: 0, tunnelProvider: async (): Promise<{ url: string; stop(): Promise<void> }> => ({ url: 'https://fixture.example.trycloudflare.com', stop: async (): Promise<void> => {} }), healthProbe: async (): Promise<number> => 200 };
  let server: ControlPlaneServer;
  let gateway: GatewayService;
  let port: number;

  beforeEach(async () => {
    gateway = new GatewayService(gatewayOptions);
    const installer = new InstallerService();
    const pruner = new PrunerService();
    const ideSync = new IdeSyncService();
    const skillCatalog = new SkillCatalog({ settings: DEFAULT_EXTENSIONS_SETTINGS });

    server = new ControlPlaneServer({
      port: 0, // OS assigned random available port
      gateway,
      installer,
      pruner,
      ideSync,
      skillCatalog,
      capabilityToken,
    });

    await server.listen();
    port = server.port;
  });

  afterEach(async () => {
    await server.close();
  });

  it('serves the Obsidian Telemetry dashboard HTML on GET /', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Unified-MPC-Server');
    expect(html).toContain('#090A0C'); // Canvas color from DESIGN.md
    expect(html).toContain('Dashboard');
    expect(html).toContain('Servers');
    expect(html).toContain('Skills');
    expect(html).toContain('Install');
    expect(html).toContain('Policies');
  });

  it('requires startup capability for mutations and does not expose it in status or logs', async () => {
    const denied = await fetch(`http://127.0.0.1:${port}/api/chatgpt-gateway/start`, {
      method: 'POST', headers: { Origin: `http://127.0.0.1:${port}` },
    });
    expect(denied.status).toBe(401);
    const status = await fetch(`http://127.0.0.1:${port}/api/status`);
    const logs = await fetch(`http://127.0.0.1:${port}/api/logs`);
    expect(await status.text()).not.toContain(capabilityToken);
    expect(await logs.text()).not.toContain(capabilityToken);
  });

  it('rejects wrong capability values', async () => {
    const denied = await fetch(`http://127.0.0.1:${port}/api/chatgpt-gateway/stop`, {
      method: 'POST', headers: { Origin: `http://127.0.0.1:${port}`, 'x-unified-mpc-capability': 'wrong' },
    });
    expect(denied.status).toBe(401);
  });

  it('rotates capability on restart and accepts dashboard cookie', async () => {
    const first = await fetch(`http://127.0.0.1:${port}/`);
    const cookie = first.headers.get('set-cookie');
    expect(cookie).toContain('unified_mpc_capability=');
    const allowed = await fetch(`http://127.0.0.1:${port}/api/chatgpt-gateway/stop`, {
      method: 'POST',
      headers: { Origin: `http://127.0.0.1:${port}`, Cookie: cookie!.split(';')[0]! },
    });
    expect(allowed.status).toBe(200);
  });

  it('rejects a capability cookie issued by a previous server process', async () => {
    const first = new ControlPlaneServer({ port: 0, gateway });
    await first.listen();
    const landing = await fetch(`http://127.0.0.1:${first.port}/`);
    const oldCookie = landing.headers.get('set-cookie')!.split(';')[0]!;
    await first.close();

    const second = new ControlPlaneServer({ port: 0, gateway });
    await second.listen();
    try {
      const denied = await fetch(`http://127.0.0.1:${second.port}/api/chatgpt-gateway/stop`, {
        method: 'POST',
        headers: { Origin: `http://127.0.0.1:${second.port}`, Cookie: oldCookie },
      });
      expect(denied.status).toBe(401);
    } finally {
      await second.close();
    }
  });

  it('blocks non-localhost origins with 403 Forbidden (Origin Policy Guard)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/status`, {
      headers: { Origin: 'https://malicious-attacker.com' },
    });
    expect(res.status).toBe(403);
  });

  it('rejects mutation requests without an Origin header', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/servers/prune`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverId: 'server_missing_origin' }),
    });
    expect(res.status).toBe(403);
  });

  it('rejects requests with a foreign Host header even when Origin is loopback', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest({
        hostname: '127.0.0.1',
        port,
        path: '/api/status',
        headers: {
          Host: 'evil.example',
          Origin: `http://127.0.0.1:${port}`,
        },
      }, (response) => {
        response.resume();
        response.once('end', () => resolve(response.statusCode ?? 0));
      });
      request.once('error', reject);
      request.end();
    });
    expect(status).toBe(403);
  });

  it('rejects raw PID pruning input without a server-issued ownership proof', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/servers/prune`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}`, 'x-unified-mpc-capability': capabilityToken },
      body: JSON.stringify({ name: 'fixture', pid: process.pid }),
    });
    expect(res.status).toBe(403);
  });

  it('allows loopback localhost origins', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/status`, {
      headers: { Origin: `http://127.0.0.1:${port}`, 'x-unified-mpc-capability': capabilityToken },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('healthy');
  });

  it('lists registered projects and updates the shared Active Project selection through guarded workspace APIs', async () => {
    let selection = { primaryWorkspaceId: 'a', activeWorkspaceIds: ['a'] as string[] };
    const workspaceControl = {
      list: async (): Promise<readonly WebWorkspaceSummary[]> => [
        { id: 'a', displayName: 'Project A', rootPath: '/projects/a', realRootPath: '/projects/a' },
        { id: 'b', displayName: 'Project B', rootPath: '/projects/b', realRootPath: '/projects/b' },
      ],
      selection: async (): Promise<WebWorkspaceSelectionSnapshot> => selection,
      activate: async (workspaceId: string): Promise<WebWorkspaceSelectionSnapshot> => {
        if (!selection.activeWorkspaceIds.includes(workspaceId)) selection = { ...selection, activeWorkspaceIds: [...selection.activeWorkspaceIds, workspaceId] };
        return selection;
      },
      deactivate: async (workspaceId: string): Promise<WebWorkspaceSelectionSnapshot> => {
        selection = { ...selection, activeWorkspaceIds: selection.activeWorkspaceIds.filter((id) => id !== workspaceId) };
        return selection;
      },
      setPrimary: async (workspaceId: string): Promise<WebWorkspaceSelectionSnapshot> => {
        selection = { primaryWorkspaceId: workspaceId, activeWorkspaceIds: [workspaceId, ...selection.activeWorkspaceIds.filter((id) => id !== workspaceId)] };
        return selection;
      },
      remove: async (workspaceId: string): Promise<WebWorkspaceSelectionSnapshot | null> => {
        if (workspaceId === 'b') selection = { primaryWorkspaceId: 'a', activeWorkspaceIds: ['a'] };
        return selection;
      },
    };
    const projectsServer = new ControlPlaneServer({ port: 0, gateway, capabilityToken, workspaceControl });
    await projectsServer.listen();
    try {
      const listed = await fetch(`http://127.0.0.1:${projectsServer.port}/api/workspaces`);
      expect(listed.status).toBe(200);
      expect(await listed.json()).toMatchObject({
        workspaces: [{ id: 'a' }, { id: 'b' }],
        selection: { primaryWorkspaceId: 'a', activeWorkspaceIds: ['a'] },
      });

      const headers = { Origin: `http://127.0.0.1:${projectsServer.port}`, 'x-unified-mpc-capability': capabilityToken };
      const activated = await fetch(`http://127.0.0.1:${projectsServer.port}/api/workspaces/b/active`, { method: 'PUT', headers });
      expect(activated.status).toBe(200);
      expect((await activated.json()).selection.activeWorkspaceIds).toEqual(['a', 'b']);

      const primary = await fetch(`http://127.0.0.1:${projectsServer.port}/api/workspaces/b/primary`, { method: 'PUT', headers });
      expect(primary.status).toBe(200);
      expect((await primary.json()).selection).toEqual({ primaryWorkspaceId: 'b', activeWorkspaceIds: ['b', 'a'] });

      const deactivated = await fetch(`http://127.0.0.1:${projectsServer.port}/api/workspaces/a/active`, { method: 'DELETE', headers });
      expect(deactivated.status).toBe(200);
      expect((await deactivated.json()).selection).toEqual({ primaryWorkspaceId: 'b', activeWorkspaceIds: ['b'] });

      const removed = await fetch(`http://127.0.0.1:${projectsServer.port}/api/workspaces/b`, { method: 'DELETE', headers });
      expect(removed.status).toBe(200);
      expect((await removed.json()).selection).toEqual({ primaryWorkspaceId: 'a', activeWorkspaceIds: ['a'] });
    } finally {
      await projectsServer.close();
    }
  });

  it('summarizes open goals per project without eagerly loading goal details, then lazy-loads and continues one goal', async () => {
    let selection = { primaryWorkspaceId: 'a', activeWorkspaceIds: ['a'] as string[] };
    let listOpenCalls = 0;
    let preferredGoalId: string | null = null;
    const goal: WebGoalSummary = {
      goalId: 'goal-a',
      goalKey: 'ship-project-goals',
      objective: 'Expose unfinished durable goals in the Projects view.',
      status: 'active',
      currentPhase: 'frontend',
      progress: { completed: 2, total: 4 },
      blockers: ['Waiting for UI verification'],
      nextAction: 'Finish the project goal drawer.',
      steps: [
        { id: 'inspect', title: 'Inspect current APIs', status: 'completed' },
        { id: 'frontend', title: 'Build project goal drawer', status: 'active' },
      ],
      updatedAt: '2026-09-16T01:00:00.000Z',
    };
    const workspaceControl = {
      list: async (): Promise<readonly WebWorkspaceSummary[]> => [
        { id: 'a', displayName: 'Project A', rootPath: '/projects/a', realRootPath: '/projects/a' },
      ],
      selection: async (): Promise<WebWorkspaceSelectionSnapshot> => selection,
      activate: async (workspaceId: string): Promise<WebWorkspaceSelectionSnapshot> => {
        if (!selection.activeWorkspaceIds.includes(workspaceId)) selection = { ...selection, activeWorkspaceIds: [...selection.activeWorkspaceIds, workspaceId] };
        return selection;
      },
      deactivate: async (): Promise<WebWorkspaceSelectionSnapshot> => selection,
      setPrimary: async (): Promise<WebWorkspaceSelectionSnapshot> => selection,
      remove: async (): Promise<WebWorkspaceSelectionSnapshot> => selection,
    };
    const goalControl = {
      countOpen: async (workspaceId: string): Promise<number> => workspaceId === 'a' ? 1 : 0,
      preferred: async (): Promise<string | null> => preferredGoalId,
      listOpen: async (): Promise<readonly WebGoalSummary[]> => {
        listOpenCalls += 1;
        return [goal];
      },
      continue: async (workspaceId: string, goalId: string): Promise<WebGoalSummary> => {
        if (workspaceId !== 'a' || goalId !== goal.goalId) throw new Error('Goal was not found');
        preferredGoalId = goalId;
        return goal;
      },
    };
    const projectsServer = new ControlPlaneServer({ port: 0, gateway, capabilityToken, workspaceControl, goalControl });
    await projectsServer.listen();
    try {
      const listed = await fetch(`http://127.0.0.1:${projectsServer.port}/api/workspaces`);
      expect(listed.status).toBe(200);
      expect(await listed.json()).toMatchObject({
        workspaces: [{ id: 'a', openGoalCount: 1, preferredGoalId: null }],
      });
      expect(listOpenCalls).toBe(0);

      const goals = await fetch(`http://127.0.0.1:${projectsServer.port}/api/workspaces/a/goals`);
      expect(goals.status).toBe(200);
      expect(await goals.json()).toEqual({ goals: [goal], preferredGoalId: null });
      expect(listOpenCalls).toBe(1);

      const headers = { Origin: `http://127.0.0.1:${projectsServer.port}`, 'x-unified-mpc-capability': capabilityToken };
      const continued = await fetch(`http://127.0.0.1:${projectsServer.port}/api/workspaces/a/goals/goal-a/continue`, { method: 'PUT', headers });
      expect(continued.status).toBe(200);
      expect(await continued.json()).toMatchObject({
        goal: { goalId: 'goal-a', goalKey: 'ship-project-goals' },
        preferredGoalId: 'goal-a',
        selection: { primaryWorkspaceId: 'a', activeWorkspaceIds: ['a'] },
      });
    } finally {
      await projectsServer.close();
    }
  });

  it('enforces hard gating: POST /api/chatgpt-web/connect returns 412 Precondition Failed when bridge is STOPPED', async () => {
    expect(gateway.status().state).toBe('STOPPED');

    const res = await fetch(`http://127.0.0.1:${port}/api/chatgpt-web/connect`, {
      method: 'POST',
      headers: { Origin: `http://127.0.0.1:${port}`, 'x-unified-mpc-capability': capabilityToken },
    });
    expect(res.status).toBe(412);
    const body = await res.json();
    expect(body.error).toContain('Bridge must be in BRIDGE_HEALTHY state');
  });

  it('allows POST /api/chatgpt-web/connect with 200 OK when bridge is BRIDGE_HEALTHY', async () => {
    await gateway.start();
    expect(gateway.status().state).toBe('BRIDGE_HEALTHY');

    const res = await fetch(`http://127.0.0.1:${port}/api/chatgpt-web/connect`, {
      method: 'POST',
      headers: { Origin: `http://127.0.0.1:${port}`, 'x-unified-mpc-capability': capabilityToken },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.leaseToken).toBeDefined();
    expect(body.tunnelUrl).toBeDefined();
    expect(body.mcpUrl).toBe('https://fixture.example.trycloudflare.com/mcp');
  });

  it('disconnects ChatGPT Web sessions with POST and leaves bridge healthy', async () => {
    await gateway.start();
    const headers = { Origin: `http://127.0.0.1:${port}`, 'x-unified-mpc-capability': capabilityToken };
    await fetch(`http://127.0.0.1:${port}/api/chatgpt-web/connect`, { method: 'POST', headers });
    const res = await fetch(`http://127.0.0.1:${port}/api/chatgpt-web/disconnect`, { method: 'POST', headers });
    expect(res.status).toBe(200);
    expect(gateway.status().state).toBe('BRIDGE_HEALTHY');
  });

  it('restores a persisted named tunnel to BRIDGE_HEALTHY when the control plane restarts', async () => {
    const settings = new Map<string, string>([
      ['cloudflare_public_url', 'https://mcp.example.com'],
      ['cloudflare_tunnel_token_configured', 'true'],
    ]);
    const secrets = new Map<string, string>([['cloudflare_tunnel_token', 'persisted-runtime-token']]);
    const restartGateway = new GatewayService({
      localPort: 18765,
      tunnelProviderFactory: (configuration) => async (): Promise<{ url: string; stop: () => Promise<void> }> => ({
        url: configuration.publicUrl ?? 'https://missing.example.com',
        stop: async (): Promise<void> => {},
      }),
      healthProbe: async (): Promise<number> => 200,
    });
    const restarted = new ControlPlaneServer({
      port: 0,
      gateway: restartGateway,
      capabilityToken,
      settingsRepository: {
        get: (key: string): string | null => settings.get(key) ?? null,
        set: (key: string, value: string): void => { settings.set(key, value); },
        delete: (key: string): void => { settings.delete(key); },
      },
      secretStore: {
        get: async (key: string): Promise<string | null> => secrets.get(key) ?? null,
        set: async (key: string, value: string): Promise<void> => { secrets.set(key, value); },
        delete: async (key: string): Promise<void> => { secrets.delete(key); },
      },
    });

    await restarted.listen();
    try {
      expect(restartGateway.configuration()).toEqual({
        publicUrl: 'https://mcp.example.com',
        tunnelToken: 'persisted-runtime-token',
      });
      expect(restartGateway.status().state).toBe('SESSION_CONNECTED');
      expect(settings.get('cloudflare_gateway_desired_state')).toBe('RUNNING');
    } finally {
      await restarted.close();
    }
  });

  it('persists an explicit gateway stop and keeps the bridge stopped after restart', async () => {
    const settings = new Map<string, string>([
      ['cloudflare_public_url', 'https://mcp.example.com'],
      ['cloudflare_tunnel_token_configured', 'true'],
    ]);
    const secrets = new Map<string, string>([['cloudflare_tunnel_token', 'persisted-runtime-token']]);
    const settingsRepository = {
      get: (key: string): string | null => settings.get(key) ?? null,
      set: (key: string, value: string): void => { settings.set(key, value); },
      delete: (key: string): void => { settings.delete(key); },
    };
    const secretStore = {
      get: async (key: string): Promise<string | null> => secrets.get(key) ?? null,
      set: async (key: string, value: string): Promise<void> => { secrets.set(key, value); },
      delete: async (key: string): Promise<void> => { secrets.delete(key); },
    };
    const createGateway = (): GatewayService => new GatewayService({
      localPort: 18765,
      tunnelProviderFactory: (configuration) => async () => ({
        url: configuration.publicUrl ?? 'https://missing.example.com',
        stop: async (): Promise<void> => {},
      }),
      healthProbe: async (): Promise<number> => 200,
    });

    const firstGateway = createGateway();
    const first = new ControlPlaneServer({ port: 0, gateway: firstGateway, capabilityToken, settingsRepository, secretStore });
    await first.listen();
    try {
      expect(firstGateway.status().state).toBe('SESSION_CONNECTED');
      const stopped = await fetch(`http://127.0.0.1:${first.port}/api/chatgpt-gateway/stop`, {
        method: 'POST',
        headers: { Origin: `http://127.0.0.1:${first.port}`, 'x-unified-mpc-capability': capabilityToken },
      });
      expect(stopped.status).toBe(200);
      expect(settings.get('cloudflare_gateway_desired_state')).toBe('STOPPED');
    } finally {
      await first.close();
    }

    const secondGateway = createGateway();
    const second = new ControlPlaneServer({ port: 0, gateway: secondGateway, capabilityToken, settingsRepository, secretStore });
    await second.listen();
    try {
      expect(secondGateway.configuration()).toEqual({
        publicUrl: 'https://mcp.example.com',
        tunnelToken: 'persisted-runtime-token',
      });
      expect(secondGateway.status().state).toBe('STOPPED');
    } finally {
      await second.close();
    }
  });

  it('persists an explicit gateway start and restores the bridge after restart', async () => {
    const settings = new Map<string, string>([
      ['cloudflare_public_url', 'https://mcp.example.com'],
      ['cloudflare_tunnel_token_configured', 'true'],
      ['cloudflare_gateway_desired_state', 'STOPPED'],
    ]);
    const secrets = new Map<string, string>([['cloudflare_tunnel_token', 'persisted-runtime-token']]);
    const settingsRepository = {
      get: (key: string): string | null => settings.get(key) ?? null,
      set: (key: string, value: string): void => { settings.set(key, value); },
      delete: (key: string): void => { settings.delete(key); },
    };
    const secretStore = {
      get: async (key: string): Promise<string | null> => secrets.get(key) ?? null,
      set: async (key: string, value: string): Promise<void> => { secrets.set(key, value); },
      delete: async (key: string): Promise<void> => { secrets.delete(key); },
    };
    const createGateway = (): GatewayService => new GatewayService({
      localPort: 18765,
      tunnelProviderFactory: (configuration) => async () => ({
        url: configuration.publicUrl ?? 'https://missing.example.com',
        stop: async (): Promise<void> => {},
      }),
      healthProbe: async (): Promise<number> => 200,
    });

    const firstGateway = createGateway();
    const first = new ControlPlaneServer({ port: 0, gateway: firstGateway, capabilityToken, settingsRepository, secretStore });
    await first.listen();
    try {
      expect(firstGateway.status().state).toBe('STOPPED');
      const started = await fetch(`http://127.0.0.1:${first.port}/api/chatgpt-gateway/start`, {
        method: 'POST',
        headers: { Origin: `http://127.0.0.1:${first.port}`, 'x-unified-mpc-capability': capabilityToken },
      });
      expect(started.status).toBe(200);
      expect(firstGateway.status().state).toBe('BRIDGE_HEALTHY');
      expect(settings.get('cloudflare_gateway_desired_state')).toBe('RUNNING');
    } finally {
      await first.close();
    }

    const secondGateway = createGateway();
    const second = new ControlPlaneServer({ port: 0, gateway: secondGateway, capabilityToken, settingsRepository, secretStore });
    await second.listen();
    try {
      expect(secondGateway.status().state).toBe('SESSION_CONNECTED');
    } finally {
      await second.close();
    }
  });

  it('retries persisted gateway startup when the origin is not ready yet', async () => {
    const settings = new Map<string, string>([
      ['cloudflare_public_url', 'https://mcp.example.com'],
      ['cloudflare_tunnel_token_configured', 'true'],
    ]);
    const secrets = new Map<string, string>([['cloudflare_tunnel_token', 'persisted-runtime-token']]);
    let probes = 0;
    const retryGateway = new GatewayService({
      localPort: 18765,
      healthAttempts: 1,
      tunnelProviderFactory: (configuration) => async (): Promise<{ url: string; stop: () => Promise<void> }> => ({
        url: configuration.publicUrl ?? 'https://missing.example.com',
        stop: async (): Promise<void> => {},
      }),
      healthProbe: async (): Promise<number> => { probes += 1; return probes === 1 ? 503 : 200; },
    });
    const restarted = new ControlPlaneServer({
      port: 0,
      gateway: retryGateway,
      capabilityToken,
      settingsRepository: {
        get: (key: string): string | null => settings.get(key) ?? null,
        set: (key: string, value: string): void => { settings.set(key, value); },
        delete: (key: string): void => { settings.delete(key); },
      },
      secretStore: {
        get: async (key: string): Promise<string | null> => secrets.get(key) ?? null,
        set: async (key: string, value: string): Promise<void> => { secrets.set(key, value); },
        delete: async (key: string): Promise<void> => { secrets.delete(key); },
      },
    });

    await restarted.listen();
    try {
      await expect.poll(() => retryGateway.status().state, { timeout: 1_500 }).toBe('SESSION_CONNECTED');
      expect(probes).toBeGreaterThanOrEqual(2);
    } finally {
      await restarted.close();
    }
  });

  it('persists non-secret settings, masks token, and rejects invalid wildcard allowlists', async () => {
    const settings = new Map<string, string>();
    const secrets = new Map<string, string>();
    const configured = new ControlPlaneServer({
      port: 0,
      gateway,
      capabilityToken,
      settingsRepository: { get: (key: string): string | null => settings.get(key) ?? null, set: (key: string, value: string): void => { settings.set(key, value); }, delete: (key: string): void => { settings.delete(key); } },
      secretStore: { get: async (key: string): Promise<string | null> => secrets.get(key) ?? null, set: async (key: string, value: string): Promise<void> => { secrets.set(key, value); }, delete: async (key: string): Promise<void> => { secrets.delete(key); } },
    });
    await configured.listen();
    try {
      const headers = { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${configured.port}`, 'x-unified-mpc-capability': capabilityToken };
      const saved = await fetch(`http://127.0.0.1:${configured.port}/api/settings`, { method: 'POST', headers, body: JSON.stringify({ publicUrl: 'https://mcp.example.com', tunnelToken: 'not-returned', allowedHostnames: ['mcp.example.com'], allowedOrigins: ['https://mcp.example.com'] }) });
      expect(saved.status).toBe(200);
      expect(await saved.text()).not.toContain('not-returned');
      expect(secrets.get('cloudflare_tunnel_token')).toBe('not-returned');
      const read = await fetch(`http://127.0.0.1:${configured.port}/api/settings`);
      expect(await read.json()).toMatchObject({ settings: { tunnelTokenConfigured: true, allowedHostnames: ['mcp.example.com'] } });
      const invalid = await fetch(`http://127.0.0.1:${configured.port}/api/settings`, { method: 'POST', headers, body: JSON.stringify({ allowedHostnames: ['*'] }) });
      expect(invalid.status).toBe(400);
    } finally { await configured.close(); }
  });

  it('reconciles Cloudflare from user input, stores both secrets securely, and starts gateway', async () => {
    const settings = new Map<string, string>();
    const secrets = new Map<string, string>();
    let capturedToken = '';
    let capturedSetup: Record<string, string> | undefined;
    const configured = new ControlPlaneServer({
      port: 0,
      gateway,
      capabilityToken,
      settingsRepository: { get: (key: string): string | null => settings.get(key) ?? null, set: (key: string, value: string): void => { settings.set(key, value); }, delete: (key: string): void => { settings.delete(key); } },
      secretStore: { get: async (key: string): Promise<string | null> => secrets.get(key) ?? null, set: async (key: string, value: string): Promise<void> => { secrets.set(key, value); }, delete: async (key: string): Promise<void> => { secrets.delete(key); } },
      cloudflareReconciler: { reconcile: async (apiToken: string, setup: Record<string, string>): Promise<{ tunnelId: string; tunnelToken: string; zoneId: string; hostname: string }> => {
        capturedToken = apiToken;
        capturedSetup = setup;
        return { tunnelId: 'remote-id', tunnelToken: 'runtime-token', zoneId: 'zone-id', hostname: 'mcp.example.com' };
      } } as never,
    });
    await configured.listen();
    try {
      const headers = { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${configured.port}`, 'x-unified-mpc-capability': capabilityToken };
      const response = await fetch(`http://127.0.0.1:${configured.port}/api/cloudflare/reconcile`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          accountId: '0123456789abcdef0123456789abcdef',
          zoneName: 'example.com',
          tunnelName: 'user-tunnel',
          publicUrl: 'https://mcp.example.com',
          originUrl: 'http://127.0.0.1:18765',
          apiToken: 'user-api-token',
          allowedHostnames: ['mcp.example.com'],
          allowedOrigins: ['https://mcp.example.com'],
        }),
      });
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(body).not.toContain('user-api-token');
      expect(body).not.toContain('runtime-token');
      expect(capturedToken).toBe('user-api-token');
      expect(capturedSetup).toMatchObject({ tunnelName: 'user-tunnel', publicUrl: 'https://mcp.example.com', originUrl: 'http://127.0.0.1:18765' });
      expect(secrets).toEqual(new Map([['cloudflare_api_token', 'user-api-token'], ['cloudflare_tunnel_token', 'runtime-token']]));
      expect(settings.get('cloudflare_account_id')).toBe('0123456789abcdef0123456789abcdef');
      expect(settings.get('cloudflare_remote_tunnel_id')).toBe('remote-id');
      expect(settings.get('cloudflare_gateway_desired_state')).toBe('RUNNING');
      expect(gateway.status().state).toBe('BRIDGE_HEALTHY');
    } finally { await configured.close(); }
  });

  it('keeps user-submitted Cloudflare settings when reconcile fails so the form stays prefilled', async () => {
    const settings = new Map<string, string>();
    const secrets = new Map<string, string>();
    const configured = new ControlPlaneServer({
      port: 0,
      gateway,
      capabilityToken,
      settingsRepository: { get: (key: string): string | null => settings.get(key) ?? null, set: (key: string, value: string): void => { settings.set(key, value); }, delete: (key: string): void => { settings.delete(key); } },
      secretStore: { get: async (key: string): Promise<string | null> => secrets.get(key) ?? null, set: async (key: string, value: string): Promise<void> => { secrets.set(key, value); }, delete: async (key: string): Promise<void> => { secrets.delete(key); } },
      cloudflareReconciler: { reconcile: async (): Promise<{ tunnelId: string; tunnelToken: string; zoneId: string; hostname: string }> => { throw new Error('Cloudflare zone was not found or is not active'); } } as never,
    });
    await configured.listen();
    try {
      const headers = { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${configured.port}`, 'x-unified-mpc-capability': capabilityToken };
      const response = await fetch(`http://127.0.0.1:${configured.port}/api/cloudflare/reconcile`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          accountId: '0123456789abcdef0123456789abcdef',
          zoneName: 'example.com',
          tunnelName: 'user-tunnel',
          publicUrl: 'https://mcp.example.com',
          originUrl: 'http://127.0.0.1:18765',
          apiToken: 'user-api-token',
          allowedHostnames: ['mcp.example.com'],
          allowedOrigins: ['https://mcp.example.com'],
        }),
      });
      expect(response.status).toBe(400);
      expect(settings.get('cloudflare_account_id')).toBe('0123456789abcdef0123456789abcdef');
      expect(settings.get('cloudflare_zone_name')).toBe('example.com');
      expect(settings.get('cloudflare_tunnel_name')).toBe('user-tunnel');
      expect(settings.get('cloudflare_public_url')).toBe('https://mcp.example.com');
      expect(settings.get('cloudflare_origin_url')).toBe('http://127.0.0.1:18765');
      expect(settings.get('mcp_allowed_hostnames')).toBe('mcp.example.com');
      expect(settings.get('mcp_allowed_origins')).toBe('https://mcp.example.com');
      expect(settings.get('cloudflare_remote_tunnel_id')).toBeUndefined();
      expect(settings.get('cloudflare_api_token_configured')).toBeUndefined();
      expect(secrets.size).toBe(0);
    } finally { await configured.close(); }
  });

  it('reuses the stored Cloudflare API token when the request omits it', async () => {
    const settings = new Map<string, string>();
    const secrets = new Map<string, string>();
    let capturedToken = '';
    const configured = new ControlPlaneServer({
      port: 0,
      gateway,
      capabilityToken,
      settingsRepository: { get: (key: string): string | null => settings.get(key) ?? null, set: (key: string, value: string): void => { settings.set(key, value); }, delete: (key: string): void => { settings.delete(key); } },
      secretStore: { get: async (key: string): Promise<string | null> => secrets.get(key) ?? null, set: async (key: string, value: string): Promise<void> => { secrets.set(key, value); }, delete: async (key: string): Promise<void> => { secrets.delete(key); } },
      cloudflareReconciler: { reconcile: async (apiToken: string): Promise<{ tunnelId: string; tunnelToken: string; zoneId: string; hostname: string }> => { capturedToken = apiToken; return { tunnelId: 'remote-id', tunnelToken: 'runtime-token', zoneId: 'zone-id', hostname: 'mcp.example.com' }; } } as never,
    });
    secrets.set('cloudflare_api_token', 'stored-api-token');
    await configured.listen();
    try {
      const headers = { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${configured.port}`, 'x-unified-mpc-capability': capabilityToken };
      const response = await fetch(`http://127.0.0.1:${configured.port}/api/cloudflare/reconcile`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          accountId: '0123456789abcdef0123456789abcdef',
          zoneName: 'example.com',
          tunnelName: 'user-tunnel',
          publicUrl: 'https://mcp.example.com',
          originUrl: 'http://127.0.0.1:18765',
          allowedHostnames: ['mcp.example.com'],
          allowedOrigins: ['https://mcp.example.com'],
        }),
      });
      expect(response.status).toBe(200);
      expect(await response.text()).not.toContain('stored-api-token');
      expect(capturedToken).toBe('stored-api-token');
      expect(secrets.get('cloudflare_api_token')).toBe('stored-api-token');
      expect(secrets.get('cloudflare_tunnel_token')).toBe('runtime-token');
      expect(settings.get('cloudflare_api_token_configured')).toBe('true');
    } finally { await configured.close(); }
  });

  it('persists Cloudflare allowlists before health probe', async () => {
    const settings = new Map<string, string>();
    const secrets = new Map<string, string>();
    let probeSawConfiguredHostname = false;
    const probeGateway = new GatewayService({
      localPort: 18765,
      tunnelProvider: async (): Promise<{ readonly url: string; stop(): Promise<void> }> => ({
        url: 'https://mcp.example.com',
        stop: async (): Promise<void> => {},
      }),
      healthProbe: async (): Promise<number> => {
        probeSawConfiguredHostname = settings.get('mcp_allowed_hostnames') === 'mcp.example.com';
        return probeSawConfiguredHostname ? 200 : 403;
      },
    });
    const configured = new ControlPlaneServer({
      port: 0,
      gateway: probeGateway,
      capabilityToken,
      settingsRepository: { get: (key: string): string | null => settings.get(key) ?? null, set: (key: string, value: string): void => { settings.set(key, value); }, delete: (key: string): void => { settings.delete(key); } },
      secretStore: { get: async (key: string): Promise<string | null> => secrets.get(key) ?? null, set: async (key: string, value: string): Promise<void> => { secrets.set(key, value); }, delete: async (key: string): Promise<void> => { secrets.delete(key); } },
      cloudflareReconciler: { reconcile: async (): Promise<{ tunnelId: string; tunnelToken: string; zoneId: string; hostname: string }> => ({ tunnelId: 'remote-id', tunnelToken: 'runtime-token', zoneId: 'zone-id', hostname: 'mcp.example.com' }) } as never,
    });
    await configured.listen();
    try {
      const response = await fetch(`http://127.0.0.1:${configured.port}/api/cloudflare/reconcile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${configured.port}`, 'x-unified-mpc-capability': capabilityToken },
        body: JSON.stringify({
          accountId: '0123456789abcdef0123456789abcdef',
          zoneName: 'example.com',
          tunnelName: 'user-tunnel',
          publicUrl: 'https://mcp.example.com',
          originUrl: 'http://127.0.0.1:18765',
          apiToken: 'user-api-token',
          allowedHostnames: ['mcp.example.com'],
          allowedOrigins: ['https://mcp.example.com'],
        }),
      });
      expect(response.status).toBe(200);
      expect(probeSawConfiguredHostname).toBe(true);
    } finally { await configured.close(); }
  });

  it('lists servers with opaque IDs and prunes by ownership proof, never request PID', async () => {
    let captured: Record<string, unknown> | undefined;
    const serverCatalog = {
      discover: async () => [{
        name: 'owned-server',
        source: 'unified-mpc-registry',
        enabled: true,
        excluded: false,
        config: { command: 'node' },
      }],
    } as unknown as McpConfigLoader;
    const pruner = {
      pruneServer: async (input: Record<string, unknown>) => {
        captured = input;
        return {
          ok: true as const,
          value: { name: String(input.name), updatedConfigFiles: [], processTerminated: false, removedPaths: [], recoveryStatus: 'completed', recoveryIds: [] },
        };
      },
    } as unknown as PrunerService;
    const ownedServer = new ControlPlaneServer({ port: 0, gateway, serverCatalog, pruner, capabilityToken });
    await ownedServer.listen();
    try {
      const listed = await fetch(`http://127.0.0.1:${ownedServer.port}/api/servers`);
      expect(listed.status).toBe(200);
      const server = (await listed.json()).servers[0];
      expect(server.serverId).toMatch(/^server_/);
      expect(server).not.toHaveProperty('pid');

      const pruned = await fetch(`http://127.0.0.1:${ownedServer.port}/api/servers/prune`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${ownedServer.port}`, 'x-unified-mpc-capability': capabilityToken },
        body: JSON.stringify({ serverId: server.serverId, pid: process.pid }),
      });
      expect(pruned.status).toBe(200);
      expect(captured).toEqual({ name: 'owned-server', targets: ['unified-mpc'] });
    } finally {
      await ownedServer.close();
    }
  });

  it('discovers canonical parent-owned resources from dataDir and applies persisted extension settings live', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'web-parent-inventory-'));
    const dataDir = path.join(root, 'data');
    const managedSkillRoot = path.join(dataDir, 'extensions', 'skills');
    const skillDir = path.join(managedSkillRoot, 'web-parent-skill');
    const registryDir = path.join(dataDir, 'extensions', 'mcp');
    await mkdir(skillDir, { recursive: true });
    await mkdir(registryDir, { recursive: true });
    await writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: web-parent-skill\ndescription: Parent-owned Web skill\n---\n# Parent\n', 'utf8');
    await writeFile(path.join(registryDir, 'registry.json'), JSON.stringify({
      mcpServers: { 'web-parent-server': { command: 'node', args: ['parent.js'] } },
    }), 'utf8');
    const settings = new Map<string, string>();
    const dynamic = new ControlPlaneServer({
      port: 0,
      gateway: new GatewayService(gatewayOptions),
      capabilityToken,
      dataDir,
      settingsRepository: {
        get: (key: string): string | null => settings.get(key) ?? null,
        set: (key: string, value: string): void => { settings.set(key, value); },
        delete: (key: string): void => { settings.delete(key); },
      },
    });
    await dynamic.listen();
    try {
      const initialSkills = await fetch(`http://127.0.0.1:${dynamic.port}/api/skills`);
      expect((await initialSkills.json()).skills).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'web-parent-skill', source: 'unified-mpc-skills' }),
      ]));
      const initialServers = await fetch(`http://127.0.0.1:${dynamic.port}/api/servers`);
      expect((await initialServers.json()).servers).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'web-parent-server', source: 'unified-mpc-registry', enabled: true }),
      ]));

      settings.set('extensions', JSON.stringify({
        mode: 'enable_all',
        disabledServers: ['web-parent-server'],
        disabledSkillRoots: [managedSkillRoot],
      }));

      const updatedSkills = await fetch(`http://127.0.0.1:${dynamic.port}/api/skills`);
      expect((await updatedSkills.json()).skills.some((skill: { name: string }) => skill.name === 'web-parent-skill')).toBe(false);
      const updatedServers = await fetch(`http://127.0.0.1:${dynamic.port}/api/servers`);
      expect((await updatedServers.json()).servers).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'web-parent-server', enabled: false }),
      ]));
    } finally {
      await dynamic.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns 500 for a route dependency rejection and remains available', async () => {
    const failingCatalog = { discover: async () => { throw new Error('synthetic catalog failure'); } } as unknown as McpConfigLoader;
    const failingServer = new ControlPlaneServer({ port: 0, gateway, serverCatalog: failingCatalog, capabilityToken });
    await failingServer.listen();
    try {
      const failed = await fetch(`http://127.0.0.1:${failingServer.port}/api/servers`);
      expect(failed.status).toBe(500);
      const healthy = await fetch(`http://127.0.0.1:${failingServer.port}/api/status`);
      expect(healthy.status).toBe(200);
    } finally {
      await failingServer.close();
    }
  });

  it('does not expose WebUI extension installation routes', async () => {
    for (const pathname of ['/api/skills/install', '/api/servers/install']) {
      const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}`, 'x-unified-mpc-capability': capabilityToken },
        body: '{}',
      });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'Endpoint not found' });
    }
  });

  it('rejects unregistered workspace mutations and caller-supplied purge paths', async () => {
    const workspace = '/tmp/unregistered-workspace';
    const skill = await fetch(`http://127.0.0.1:${port}/api/skills/prune`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}`, 'x-unified-mpc-capability': capabilityToken },
      body: JSON.stringify({ name: 'fixture', scope: 'workspace', workspaceRoot: workspace, targets: ['cursor'] }),
    });
    expect(skill.status).toBe(403);

    const serverCatalog = {
      discover: async () => [{ name: 'owned-server', source: 'fixture', enabled: true, excluded: false, config: { command: 'node' } }],
    } as unknown as McpConfigLoader;
    const ownedServer = new ControlPlaneServer({ port: 0, gateway, serverCatalog, capabilityToken });
    await ownedServer.listen();
    try {
      const listed = await fetch(`http://127.0.0.1:${ownedServer.port}/api/servers`);
      const server = (await listed.json()).servers[0];
      const prune = await fetch(`http://127.0.0.1:${ownedServer.port}/api/servers/prune`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${ownedServer.port}`, 'x-unified-mpc-capability': capabilityToken },
        body: JSON.stringify({ serverId: server.serverId, purgeDataDirs: ['/tmp'] }),
      });
      expect(prune.status).toBe(403);
    } finally {
      await ownedServer.close();
    }
  });

  it('returns policy table on GET /api/policies', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/policies`);
    expect(res.status, await res.clone().text()).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.policies)).toBe(true);
    expect(data.policies[0]).toMatchObject({ priority: 'P1', id: 'session-start:ask-matt' });
  });

  it('persists user-edited policies in requested P1-Pn order without changing semantic ids', async () => {
    const settings = new Map<string, string>();
    const emptyServerCatalog = { discover: async () => [] } as unknown as McpConfigLoader;
    const emptySkillCatalog = { list: async () => ({ ok: true, value: { skills: [] } }) } as unknown as SkillCatalog;
    const editable = new ControlPlaneServer({
      port: 0,
      gateway: new GatewayService(gatewayOptions),
      capabilityToken,
      serverCatalog: emptyServerCatalog,
      skillCatalog: emptySkillCatalog,
      settingsRepository: {
        get: (key: string): string | null => settings.get(key) ?? null,
        set: (key: string, value: string): void => { settings.set(key, value); },
        delete: (key: string): void => { settings.delete(key); },
      },
    });
    await editable.listen();
    try {
      const response = await fetch(`http://127.0.0.1:${editable.port}/api/policies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${editable.port}`, 'x-unified-mpc-capability': capabilityToken },
        body: JSON.stringify({ policies: [
          { id: 'custom:second', resourceId: 'second-skill', resourceType: 'skill', mandatory: false, enforcement: 'ON_DEMAND', directive: 'Run second skill when relevant' },
          { id: 'custom:first', resourceId: 'first-server', resourceType: 'server', mandatory: true, enforcement: 'EVERY_SESSION', directive: 'Run first server before the rest', requiredTools: ['ping'], readOnlyTools: ['search', 'inspect'] },
        ] }),
      });
      expect(response.status, await response.clone().text()).toBe(200);
      const saved = await response.json();
      expect(saved.policies.slice(0, 2)).toMatchObject([
        { priority: 'P1', id: 'custom:second', resourceId: 'second-skill' },
        { priority: 'P2', id: 'custom:first', resourceId: 'first-server' },
      ]);

      const persisted = JSON.parse(settings.get('extensions')!);
      expect(persisted.policies.map((policy: { id: string }) => policy.id)).toEqual(['custom:second', 'custom:first']);
      expect(persisted.policies[1].readOnlyTools).toEqual(['search', 'inspect']);
      expect(persisted.mandatoryMcpServers).toEqual(['first-server']);

      const reread = await fetch(`http://127.0.0.1:${editable.port}/api/policies`);
      expect((await reread.json()).policies.slice(0, 2)).toMatchObject([
        { priority: 'P1', id: 'custom:second' },
        { priority: 'P2', id: 'custom:first', readOnlyTools: ['search', 'inspect'] },
      ]);
    } finally {
      await editable.close();
    }
  });

  it('rejects duplicate semantic policy ids instead of saving an ambiguous order', async () => {
    const settings = new Map<string, string>();
    const editable = new ControlPlaneServer({
      port: 0,
      gateway: new GatewayService(gatewayOptions),
      capabilityToken,
      settingsRepository: {
        get: (key: string): string | null => settings.get(key) ?? null,
        set: (key: string, value: string): void => { settings.set(key, value); },
        delete: (key: string): void => { settings.delete(key); },
      },
    });
    await editable.listen();
    try {
      const policy = { id: 'duplicate:id', resourceId: 'mock', resourceType: 'server', mandatory: false, enforcement: 'ON_DEMAND', directive: 'Mock' };
      const response = await fetch(`http://127.0.0.1:${editable.port}/api/policies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${editable.port}`, 'x-unified-mpc-capability': capabilityToken },
        body: JSON.stringify({ policies: [policy, policy] }),
      });
      expect(response.status).toBe(400);
      expect(settings.get('extensions')).toBeUndefined();
    } finally {
      await editable.close();
    }
  });

  it('returns recorded telemetry events on GET /api/logs', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/logs`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.logs)).toBe(true);
    expect(data.logs.length).toBeGreaterThan(0);
    expect(data.logs[0]).toHaveProperty('time');
    expect(data.logs[0]).toHaveProperty('level');
    expect(data.logs[0]).toHaveProperty('msg');
  });
});

