import { describe, expect, it } from 'vitest';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCloudflaredTunnelProvider, GatewayService, type TunnelHandle } from './gateway-service.js';

function tunnel(url = 'https://chatgpt.example.trycloudflare.com'): TunnelHandle {
  return { url, stop: async (): Promise<void> => {} };
}

describe('GatewayService - ChatGPT Web Bridge State Machine', () => {
  it('starts in STOPPED state where session connection is disallowed', () => {
    const gateway = new GatewayService({ localPort: 18765 });
    const status = gateway.status();

    expect(status.state).toBe('STOPPED');
    expect(gateway.canConnectSession()).toBe(false);
    expect(status.tunnelUrl).toBeUndefined();
  });

  it('transitions STOPPED -> INITIALIZING -> BRIDGE_HEALTHY on start', async () => {
    const gateway = new GatewayService({
      localPort: 18765,
      tunnelProvider: async (): Promise<TunnelHandle> => tunnel(),
      healthProbe: async (): Promise<number> => 200,
    });
    const startResult = await gateway.start();

    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;

    const status = gateway.status();
    expect(status.state).toBe('BRIDGE_HEALTHY');
    expect(gateway.canConnectSession()).toBe(true);
    expect(status.tunnelUrl).toContain('https://');
    expect(status.mcpUrl).toBe('https://chatgpt.example.trycloudflare.com/mcp');
    expect(status.localPort).toBe(18765);
    expect(status.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('enforces hard gating: rejects session connect if not in BRIDGE_HEALTHY state', async () => {
    const gateway = new GatewayService({ localPort: 18765 });

    // When STOPPED
    const connectResult = await gateway.connectSession();
    expect(connectResult.ok).toBe(false);
    if (!connectResult.ok) {
      expect(connectResult.error.code).toBe('PERMISSION_DENIED');
      expect(connectResult.error.message).toContain('Bridge must be in BRIDGE_HEALTHY state');
    }
  });

  it('transitions BRIDGE_HEALTHY -> SESSION_CONNECTED upon authorized connection', async () => {
    const gateway = new GatewayService({
      localPort: 18765,
      tunnelProvider: async (): Promise<TunnelHandle> => tunnel(),
      healthProbe: async (): Promise<number> => 200,
    });
    await gateway.start();

    const connectResult = await gateway.connectSession();
    expect(connectResult.ok).toBe(true);
    if (!connectResult.ok) return;

    expect(connectResult.value.leaseToken).toBeDefined();
    expect(connectResult.value.tunnelUrl).toBeDefined();
    expect(connectResult.value.mcpUrl).toBe('https://chatgpt.example.trycloudflare.com/mcp');
    expect(gateway.status().state).toBe('SESSION_CONNECTED');
  });

  it('does not resurrect a bridge after a pending start is stopped', async () => {
    let release: ((url: string) => void) | undefined;
    const pending = new Promise<string>((resolve) => { release = resolve; });
    const gateway = new GatewayService({
      tunnelProvider: async (): Promise<TunnelHandle> => ({ url: await pending, stop: async (): Promise<void> => {} }),
      healthProbe: async (): Promise<number> => 200,
    });

    const starting = gateway.start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(gateway.status().state).toBe('INITIALIZING');

    await gateway.stop();
    release?.('https://stale.invalid');
    await starting;

    expect(gateway.status().state).toBe('STOPPED');
    expect(gateway.status().tunnelUrl).toBeUndefined();
  });

  it('stops cleanly and returns to STOPPED state', async () => {
    const gateway = new GatewayService({
      localPort: 18765,
      tunnelProvider: async (): Promise<TunnelHandle> => tunnel(),
      healthProbe: async (): Promise<number> => 200,
    });
    await gateway.start();
    await gateway.connectSession();

    await gateway.stop();
    const status = gateway.status();
    expect(status.state).toBe('STOPPED');
    expect(gateway.canConnectSession()).toBe(false);
  });

  it('requires a real tunnel URL and successful origin health probe before becoming healthy', async () => {
    const gateway = new GatewayService({
      tunnelProvider: async (): Promise<TunnelHandle> => tunnel('https://real.example.trycloudflare.com'),
      healthProbe: async (): Promise<number> => 503,
    });

    const result = await gateway.start();

    expect(result.ok).toBe(false);
    expect(gateway.status()).toMatchObject({ state: 'ERROR', lastError: 'Bridge health probe returned HTTP 503' });
  });

  it('measures health latency and stops owned tunnel process', async () => {
    let stopped = false;
    const gateway = new GatewayService({
      tunnelProvider: async (): Promise<TunnelHandle> => ({ url: 'https://real.example.trycloudflare.com', stop: async (): Promise<void> => { stopped = true; } }),
      healthProbe: async (): Promise<number> => {
        await new Promise<void>((resolve) => setTimeout(resolve, 2));
        return 200;
      },
    });

    await gateway.start();
    expect(gateway.status().latencyMs).toBeGreaterThanOrEqual(0);
    await gateway.stop();
    expect(stopped).toBe(true);
  });

  it('rejects ambiguous named tunnel configuration before spawning', async () => {
    await expect(createCloudflaredTunnelProvider(18765, 'name', undefined, undefined)()).rejects.toThrow('exactly one public URL');
    await expect(createCloudflaredTunnelProvider(18765, 'name', 'token', 'https://mcp.example.com')()).rejects.toThrow('mutually exclusive');
    await expect(createCloudflaredTunnelProvider(18765, undefined, undefined, 'https://mcp.example.com')()).rejects.toThrow('exactly one public URL');
  });

  it('reconfigures a running gateway and restores prior configuration after probe failure', async () => {
    const urls = ['https://first.example.com', 'https://broken.example.com', 'https://first.example.com'];
    const stopped: string[] = [];
    const gateway = new GatewayService({
      tunnelProviderFactory: (configuration) => async (): Promise<TunnelHandle> => {
        const url = urls.shift()!;
        return { url, stop: async (): Promise<void> => { stopped.push(configuration.publicUrl ?? 'quick'); } };
      },
      healthProbe: async (url): Promise<number> => url.includes('broken') ? 503 : 200,
    });
    expect((await gateway.start()).ok).toBe(true);
    const result = await gateway.applyConfiguration({ tunnelName: 'new-tunnel', publicUrl: 'https://new.example.com' });
    expect(result.ok).toBe(false);
    expect(gateway.configuration()).toEqual({});
    expect(gateway.status().state).toBe('BRIDGE_HEALTHY');
    expect(stopped.length).toBeGreaterThanOrEqual(2);
  });

  it('disconnects a session and expires a lease without stopping healthy bridge', async () => {
    const gateway = new GatewayService({
      sessionLeaseTtlMs: 10,
      tunnelProvider: async (): Promise<TunnelHandle> => tunnel(),
      healthProbe: async (): Promise<number> => 200,
    });
    await gateway.start();
    await gateway.connectSession();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(gateway.status().state).toBe('BRIDGE_HEALTHY');
    await gateway.connectSession();
    await gateway.disconnectSession();
    expect(gateway.status().state).toBe('BRIDGE_HEALTHY');
  });

  it('keeps named tunnel token out of cloudflared argv and passes it through child environment', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-cloudflared-'));
    const script = path.join(root, 'cloudflared-fixture');
    const capture = path.join(root, 'capture');
    const previous = process.env.UNIFIED_MPC_CLOUDFLARED_BIN;
    await writeFile(script, `#!/bin/sh\nprintf '%s\\n' "$TUNNEL_TOKEN" > '${capture}'\nprintf '%s\\n' "$@" >> '${capture}'\nsleep 30\n`, 'utf8');
    await chmod(script, 0o700);
    process.env.UNIFIED_MPC_CLOUDFLARED_BIN = script;
    try {
      const provider = createCloudflaredTunnelProvider(18765, undefined, 'token-not-in-argv', 'https://mcp.example.com');
      const handle = await provider();
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      const captured = await readFile(capture, 'utf8');
      expect(captured).toContain('token-not-in-argv');
      expect(captured).not.toContain('--token\ntoken-not-in-argv');
      expect(captured).toContain('tunnel\n--no-autoupdate\nrun');
      await handle.stop();
    } finally {
      if (previous === undefined) delete process.env.UNIFIED_MPC_CLOUDFLARED_BIN;
      else process.env.UNIFIED_MPC_CLOUDFLARED_BIN = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
});

