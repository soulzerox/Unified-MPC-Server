import { describe, expect, it } from 'vitest';
import { GatewayService } from '@unified-mpc/cf-gateway';
import { ControlPlaneServer } from './web-server.js';

describe('WebUI runtime diagnostics proxy', () => {
  it('proxies authoritative MCP telemetry without relabeling it as project health', async () => {
    const diagnostics = {
      source: 'activity-tracker',
      processMemory: {
        rssBytes: 536_870_912,
        heapTotalBytes: 268_435_456,
        heapUsedBytes: 134_217_728,
        externalBytes: 16_777_216,
        arrayBuffersBytes: 8_388_608,
      },
      runtimeRetention: {
        tasks: 1,
        checkpoints: 2,
        hooks: 0,
        plugins: 0,
        sessionEntries: 3,
        worktrees: 1,
        activityInflight: 1,
        activityCompletedEntries: 42,
        activityCompletedEntryLimit: 2000,
        incrementalVerificationEntries: 4,
        contextLedgerEntries: 5,
        toolAvailabilitySubscriptions: 1,
      },
    };
    const gateway = new GatewayService({
      localPort: 18765,
      tunnelProvider: async (): Promise<{ readonly url: string; readonly stop: () => Promise<void> }> => ({ url: 'https://fixture.example.trycloudflare.com', stop: async (): Promise<void> => {} }),
      healthProbe: async (): Promise<number> => 200,
    });
    const server = new ControlPlaneServer({
      port: 0,
      gateway,
      mcpRuntimeDiagnosticsProbe: async (): Promise<typeof diagnostics> => diagnostics,
    });
    await server.listen();
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/runtime-diagnostics`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        available: true,
        scope: 'control-plane-process',
        diagnostics,
      });
    } finally {
      await server.close();
    }
  });

  it('reports diagnostics unavailable instead of fabricating zero values', async () => {
    const gateway = new GatewayService({
      localPort: 18765,
      tunnelProvider: async (): Promise<{ readonly url: string; readonly stop: () => Promise<void> }> => ({ url: 'https://fixture.example.trycloudflare.com', stop: async (): Promise<void> => {} }),
      healthProbe: async (): Promise<number> => 200,
    });
    const server = new ControlPlaneServer({
      port: 0,
      gateway,
      mcpRuntimeDiagnosticsProbe: async (): Promise<null> => null,
    });
    await server.listen();
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/runtime-diagnostics`);
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        available: false,
        scope: 'control-plane-process',
      });
    } finally {
      await server.close();
    }
  });
});
