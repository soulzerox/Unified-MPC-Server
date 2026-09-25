import { describe, expect, it, vi } from 'vitest';
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

  it('does not treat a local session lease as ChatGPT connector registration', async () => {
    const gateway = new GatewayService({
      tunnelProvider: async (): Promise<TunnelHandle> => tunnel(),
      healthProbe: async (): Promise<number> => 200,
    });
    await gateway.start();
    await gateway.connectSession();

    expect(gateway.status()).toMatchObject({
      state: 'SESSION_CONNECTED',
      sessionState: 'leased',
      connectorRegistration: {
        state: 'unverified',
        reason: 'host_projection_unavailable',
        action: 'reconnect_chatgpt_session',
      },
      endToEndState: 'unverified',
    });
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
      healthAttempts: 1,
      healthProbe: async (): Promise<number> => 503,
    });

    const result = await gateway.start();

    expect(result.ok).toBe(false);
    expect(gateway.status()).toMatchObject({ state: 'ERROR', lastError: 'Bridge health probe returned HTTP 503' });
  });

  it('keeps one named tunnel alive through delayed public bridge readiness', async () => {
    let probes = 0;
    let stops = 0;
    const gateway = new GatewayService({
      tunnelName: 'named-bridge',
      publicUrl: 'https://mcp.example.com',
      bridgeReadinessTimeoutMs: 100,
      healthRetryDelayMs: 1,
      tunnelProviderFactory: () => async (): Promise<TunnelHandle> => ({
        url: 'https://mcp.example.com',
        stop: async (): Promise<void> => { stops += 1; },
      }),
      healthProbe: async (): Promise<number> => {
        probes += 1;
        if (probes === 1) throw new Error('edge not connected yet');
        return probes < 8 ? 530 : 200;
      },
    });

    const result = await gateway.start();

    expect(result.ok).toBe(true);
    expect(probes).toBe(8);
    expect(stops).toBe(0);
    expect(gateway.status().state).toBe('BRIDGE_HEALTHY');

    await gateway.stop();
    expect(stops).toBe(1);
  });

  it('bounds bridge readiness and stops the tunnel when the public route never becomes healthy', async () => {
    let probes = 0;
    let stops = 0;
    const gateway = new GatewayService({
      bridgeReadinessTimeoutMs: 20,
      healthAttempts: 100,
      healthRetryDelayMs: 5,
      tunnelProvider: async (): Promise<TunnelHandle> => ({
        url: 'https://mcp.example.com',
        stop: async (): Promise<void> => { stops += 1; },
      }),
      healthProbe: async (): Promise<number> => {
        probes += 1;
        return 530;
      },
    });

    const result = await gateway.start();

    expect(result.ok).toBe(false);
    expect(probes).toBeLessThan(100);
    expect(stops).toBe(1);
    expect(gateway.status()).toMatchObject({
      state: 'ERROR',
      lastError: 'Bridge health probe returned HTTP 530',
    });
  });

  it('cancels an in-flight readiness start when an explicit stop supersedes it', async () => {
    let probes = 0;
    let stops = 0;
    let releaseProbe: ((statusCode: number) => void) | undefined;
    const pendingProbe = new Promise<number>((resolve) => { releaseProbe = resolve; });
    const gateway = new GatewayService({
      bridgeReadinessTimeoutMs: 1_000,
      healthAttempts: 30,
      healthRetryDelayMs: 1,
      tunnelProvider: async (): Promise<TunnelHandle> => ({
        url: 'https://mcp.example.com',
        stop: async (): Promise<void> => { stops += 1; },
      }),
      healthProbe: async (): Promise<number> => {
        probes += 1;
        return probes === 1 ? 530 : pendingProbe;
      },
    });

    const starting = gateway.start();
    await expect.poll(() => probes, { timeout: 500 }).toBeGreaterThanOrEqual(2);

    await gateway.stop();
    // Owned startup tunnel must be stopped as part of explicit stop itself,
    // without needing to release the pending probe first.
    expect(stops).toBe(1);
    expect(gateway.status().state).toBe('STOPPED');

    // Start must resolve as superseded without waiting for probe release.
    const result = await starting;

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('CONFLICT');
    expect(stops).toBe(1);
    expect(gateway.status().state).toBe('STOPPED');

    // Late stale probe resolution must not resurrect state or double-stop.
    releaseProbe?.(200);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(stops).toBe(1);
    expect(gateway.status().state).toBe('STOPPED');
  });

  it('stops the superseded readiness owner before a newer start can become healthy', async () => {
    let probes = 0;
    let providerCalls = 0;
    let stopsA = 0;
    let stopsB = 0;
    let releasePending: ((statusCode: number) => void) | undefined;
    const pendingProbe = new Promise<number>((resolve) => { releasePending = resolve; });
    const gateway = new GatewayService({
      bridgeReadinessTimeoutMs: 1_000,
      healthAttempts: 30,
      healthRetryDelayMs: 1,
      tunnelProvider: async (): Promise<TunnelHandle> => {
        providerCalls += 1;
        if (providerCalls === 1) return { url: 'https://mcp.example.com', stop: async (): Promise<void> => { stopsA += 1; } };
        return { url: 'https://mcp.example.com', stop: async (): Promise<void> => { stopsB += 1; } };
      },
      healthProbe: async (): Promise<number> => {
        probes += 1;
        if (probes === 1) return 530;
        if (probes === 2) return pendingProbe;
        return 200;
      },
    });

    const startA = gateway.start();
    await expect.poll(() => probes, { timeout: 500 }).toBeGreaterThanOrEqual(2);

    const startB = gateway.start();
    const resultB = await startB;

    expect(resultB.ok).toBe(true);
    expect(stopsA).toBe(1);
    expect(gateway.status().state).toBe('BRIDGE_HEALTHY');

    const resultA = await startA;
    expect(resultA.ok).toBe(false);
    if (!resultA.ok) expect(resultA.error.code).toBe('CONFLICT');

    releasePending?.(200);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(stopsA).toBe(1);
    expect(stopsB).toBe(0);
    expect(gateway.status().state).toBe('BRIDGE_HEALTHY');

    await gateway.stop();
    expect(stopsB).toBe(1);
  });

  it('does not publish a new pending start after an explicit stop lands during stale shutdown', async () => {
    let probes = 0;
    let providerCalls = 0;
    let stopACalls = 0;
    let releaseStopA!: () => void;
    const stopABlocked = new Promise<void>((resolve) => { releaseStopA = resolve; });
    let releaseProbe!: (statusCode: number) => void;
    const pendingProbe = new Promise<number>((resolve) => { releaseProbe = resolve; });
    const gateway = new GatewayService({
      bridgeReadinessTimeoutMs: 1_000,
      healthAttempts: 30,
      healthRetryDelayMs: 1,
      tunnelProvider: async (): Promise<TunnelHandle> => {
        providerCalls += 1;
        return {
          url: 'https://mcp.example.com',
          stop: async (): Promise<void> => {
            stopACalls += 1;
            await stopABlocked;
          },
        };
      },
      healthProbe: async (): Promise<number> => {
        probes += 1;
        return pendingProbe;
      },
    });

    const startA = gateway.start();
    await expect.poll(() => probes, { timeout: 500 }).toBeGreaterThanOrEqual(1);
    expect(providerCalls).toBe(1);

    const startB = gateway.start();
    await expect.poll(() => stopACalls, { timeout: 500 }).toBeGreaterThanOrEqual(1);

    await gateway.stop();
    expect(gateway.status().state).toBe('STOPPED');

    releaseStopA();
    const resultB = await startB;
    expect(resultB.ok).toBe(false);
    if (!resultB.ok) expect(resultB.error.code).toBe('CONFLICT');

    const resultA = await startA;
    expect(resultA.ok).toBe(false);
    if (!resultA.ok) expect(resultA.error.code).toBe('CONFLICT');

    expect(providerCalls).toBe(1);
    expect(gateway.status().state).toBe('STOPPED');

    releaseProbe(200);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(providerCalls).toBe(1);
    expect(gateway.status().state).toBe('STOPPED');
  });

  it('does not let an older stop clobber a newer start that took ownership during shutdown', async () => {
    let providerCalls = 0;
    let stopACalls = 0;
    let stopsB = 0;
    let releaseStopA!: () => void;
    const stopABlocked = new Promise<void>((resolve) => { releaseStopA = resolve; });
    const gateway = new GatewayService({
      bridgeReadinessTimeoutMs: 1_000,
      healthAttempts: 30,
      healthRetryDelayMs: 1,
      tunnelProvider: async (): Promise<TunnelHandle> => {
        providerCalls += 1;
        if (providerCalls === 1) {
          return {
            url: 'https://mcp.example.com',
            stop: async (): Promise<void> => {
              stopACalls += 1;
              await stopABlocked;
            },
          };
        }
        return { url: 'https://mcp.example.com', stop: async (): Promise<void> => { stopsB += 1; } };
      },
      healthProbe: async (): Promise<number> => 200,
    });

    const first = await gateway.start();
    expect(first.ok).toBe(true);
    expect(providerCalls).toBe(1);
    expect(gateway.status().state).toBe('BRIDGE_HEALTHY');

    const oldStop = gateway.stop();
    await expect.poll(() => stopACalls, { timeout: 500 }).toBeGreaterThanOrEqual(1);

    const newStart = gateway.start();
    // Newer start must launch a fresh tunnel instead of returning the stale URL
    // whose handle was already captured for shutdown.
    await expect.poll(() => providerCalls, { timeout: 500 }).toBeGreaterThanOrEqual(2);
    const newResult = await newStart;
    expect(newResult.ok).toBe(true);
    expect(gateway.status().state).toBe('BRIDGE_HEALTHY');

    releaseStopA();
    await oldStop;

    expect(stopACalls).toBe(1);
    expect(stopsB).toBe(0);
    expect(gateway.status().state).toBe('BRIDGE_HEALTHY');

    await gateway.stop();
    expect(stopsB).toBe(1);
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
      healthAttempts: 1,
      healthProbe: async (url): Promise<number> => url.includes('broken') ? 503 : 200,
    });
    expect((await gateway.start()).ok).toBe(true);
    const result = await gateway.applyConfiguration({ tunnelName: 'new-tunnel', publicUrl: 'https://new.example.com' });
    expect(result.ok).toBe(false);
    expect(gateway.configuration()).toEqual({});
    expect(gateway.status().state).toBe('BRIDGE_HEALTHY');
    expect(stopped.length).toBeGreaterThanOrEqual(2);
  });

  it('preserves a connected ChatGPT Web session across successful gateway reconfiguration', async () => {
    const gateway = new GatewayService({
      healthMonitorIntervalMs: 10_000,
      tunnelProviderFactory: (configuration) => async (): Promise<TunnelHandle> => ({
        url: configuration.publicUrl ?? 'https://fallback.example.com',
        stop: async (): Promise<void> => {},
      }),
      healthProbe: async (): Promise<number> => 200,
    });
    await gateway.applyConfiguration({ tunnelName: 'first', publicUrl: 'https://first.example.com' });
    await gateway.start();
    await gateway.connectSession();

    const result = await gateway.applyConfiguration({ tunnelName: 'second', publicUrl: 'https://second.example.com' });

    expect(result.ok).toBe(true);
    expect(gateway.status()).toMatchObject({ state: 'SESSION_CONNECTED', tunnelUrl: 'https://second.example.com' });
    await gateway.stop();
  });

  it('keeps an established ChatGPT Web session connected indefinitely by default', async () => {
    vi.useFakeTimers();
    try {
      const gateway = new GatewayService({
        tunnelProvider: async (): Promise<TunnelHandle> => tunnel(),
        healthProbe: async (): Promise<number> => 200,
      });
      await gateway.start();
      await gateway.connectSession();

      await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);

      expect(gateway.status().state).toBe('SESSION_CONNECTED');
      await gateway.disconnectSession();
      expect(gateway.status().state).toBe('BRIDGE_HEALTHY');
      await gateway.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('supports an explicitly configured finite session lease TTL', async () => {
    vi.useFakeTimers();
    try {
      const gateway = new GatewayService({
        sessionLeaseTtlMs: 10,
        tunnelProvider: async (): Promise<TunnelHandle> => tunnel(),
        healthProbe: async (): Promise<number> => 200,
      });
      await gateway.start();
      await gateway.connectSession();

      await vi.advanceTimersByTimeAsync(11);

      expect(gateway.status().state).toBe('BRIDGE_HEALTHY');
      await gateway.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('self-heals a failed bridge and restores the connected ChatGPT Web session', async () => {
    let starts = 0;
    let stops = 0;
    let probes = 0;
    const gateway = new GatewayService({
      healthMonitorIntervalMs: 10,
      healthFailureThreshold: 1,
      reconnectBaseDelayMs: 5,
      reconnectMaxDelayMs: 20,
      reconnectJitterRatio: 0,
      tunnelProviderFactory: () => async (): Promise<TunnelHandle> => {
        starts += 1;
        return {
          url: 'https://chatgpt.example.trycloudflare.com',
          stop: async (): Promise<void> => { stops += 1; },
        };
      },
      healthProbe: async (): Promise<number> => {
        probes += 1;
        return probes === 2 ? 503 : 200;
      },
    });

    await gateway.start();
    await gateway.connectSession();

    await expect.poll(() => starts, { timeout: 500 }).toBeGreaterThanOrEqual(2);
    await expect.poll(() => gateway.status().state, { timeout: 500 }).toBe('SESSION_CONNECTED');
    expect(stops).toBeGreaterThanOrEqual(1);
    await gateway.stop();
  });

  it('reports connector recovery as stale after a backend restart', async () => {
    let starts = 0;
    let probes = 0;
    const gateway = new GatewayService({
      healthMonitorIntervalMs: 10,
      healthFailureThreshold: 1,
      reconnectBaseDelayMs: 5,
      reconnectMaxDelayMs: 20,
      reconnectJitterRatio: 0,
      tunnelProviderFactory: () => async (): Promise<TunnelHandle> => {
        starts += 1;
        return tunnel();
      },
      healthProbe: async (): Promise<number> => {
        probes += 1;
        return probes === 2 ? 503 : 200;
      },
    });

    await gateway.start();
    await gateway.connectSession();
    await expect.poll(() => starts, { timeout: 500 }).toBeGreaterThanOrEqual(2);
    await expect.poll(() => gateway.status().state, { timeout: 500 }).toBe('SESSION_CONNECTED');

    expect(gateway.status()).toMatchObject({
      sessionState: 'leased',
      connectorRegistration: {
        state: 'stale',
        reason: 'backend_restart',
        action: 'reconnect_chatgpt_session',
      },
      endToEndState: 'unverified',
    });
    await gateway.stop();
  });

  it('honors an explicit disconnect while bridge recovery is reconnecting', async () => {
    let starts = 0;
    let probes = 0;
    let releaseReconnect: (() => void) | undefined;
    const reconnectGate = new Promise<void>((resolve) => { releaseReconnect = resolve; });
    const gateway = new GatewayService({
      healthMonitorIntervalMs: 5,
      healthFailureThreshold: 1,
      reconnectBaseDelayMs: 5,
      reconnectMaxDelayMs: 20,
      reconnectJitterRatio: 0,
      tunnelProviderFactory: () => async (): Promise<TunnelHandle> => {
        starts += 1;
        if (starts > 1) await reconnectGate;
        return tunnel();
      },
      healthProbe: async (): Promise<number> => {
        probes += 1;
        return probes === 2 ? 503 : 200;
      },
    });

    await gateway.start();
    await gateway.connectSession();
    await expect.poll(() => starts, { timeout: 500 }).toBeGreaterThanOrEqual(2);

    await gateway.disconnectSession();
    releaseReconnect?.();

    await expect.poll(() => gateway.status().state, { timeout: 500 }).toBe('BRIDGE_HEALTHY');
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(gateway.status().state).toBe('BRIDGE_HEALTHY');
    await gateway.stop();
  });

  it('does not resurrect after an explicit stop races an in-flight health check', async () => {
    let starts = 0;
    let probes = 0;
    let releaseMonitor: ((status: number) => void) | undefined;
    const monitorResult = new Promise<number>((resolve) => { releaseMonitor = resolve; });
    const gateway = new GatewayService({
      healthMonitorIntervalMs: 5,
      healthFailureThreshold: 1,
      reconnectBaseDelayMs: 5,
      reconnectMaxDelayMs: 20,
      reconnectJitterRatio: 0,
      tunnelProviderFactory: () => async (): Promise<TunnelHandle> => {
        starts += 1;
        return tunnel();
      },
      healthProbe: async (): Promise<number> => {
        probes += 1;
        return probes === 1 ? 200 : monitorResult;
      },
    });

    await gateway.start();
    await gateway.connectSession();
    await expect.poll(() => probes, { timeout: 500 }).toBeGreaterThanOrEqual(2);
    await gateway.stop();
    releaseMonitor?.(503);
    await new Promise<void>((resolve) => setTimeout(resolve, 30));

    expect(gateway.status().state).toBe('STOPPED');
    expect(starts).toBe(1);
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

