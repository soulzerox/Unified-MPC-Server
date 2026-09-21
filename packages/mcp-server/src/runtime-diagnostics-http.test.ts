import { request as httpRequest } from 'node:http';
import { describe, expect, it } from 'vitest';
import { startMcpHttp } from './http.js';

describe('MCP runtime diagnostics HTTP boundary', () => {
  it('serves authoritative diagnostics only to loopback callers', async () => {
    const diagnostics = {
      source: 'activity-tracker',
      processMemory: {
        rssBytes: 512 * 1024 * 1024,
        heapTotalBytes: 256 * 1024 * 1024,
        heapUsedBytes: 128 * 1024 * 1024,
        externalBytes: 16 * 1024 * 1024,
        arrayBuffersBytes: 8 * 1024 * 1024,
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
    const handle = await startMcpHttp({
      port: 0,
      services: {},
      actor: { clientId: 'runtime-diagnostics-test', clientName: 'runtime-diagnostics-test' },
      runtimeDiagnosticsProvider: async () => diagnostics,
      allowedHostnames: ['mcp.example.com'],
      allowedOrigins: ['https://mcp.example.com'],
    });
    try {
      const local = await fetch(new URL('/_unified-mpc/runtime-diagnostics', handle.endpoint));
      expect(local.status).toBe(200);
      expect(local.headers.get('cache-control')).toBe('no-store');
      await expect(local.json()).resolves.toEqual(diagnostics);

      const publicStatus = await new Promise<number>((resolve, reject) => {
        const request = httpRequest({
          hostname: '127.0.0.1',
          port: handle.address.port,
          path: '/_unified-mpc/runtime-diagnostics',
          headers: { Host: `mcp.example.com:${handle.address.port}`, Origin: 'https://mcp.example.com' },
        }, (response) => {
          response.resume();
          response.once('end', () => resolve(response.statusCode ?? 0));
        });
        request.once('error', reject);
        request.end();
      });
      expect(publicStatus).toBe(403);
    } finally {
      await handle.close();
    }
  });
});
