import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ControlPlaneServer } from './web-server.js';
import { GatewayService } from '@unified-mpc/cf-gateway';
import {
  InstallerService,
  PrunerService,
  IdeSyncService,
  SkillCatalog,
  DEFAULT_EXTENSIONS_SETTINGS,
} from '@unified-mpc/extensions';

describe('Milestone 5 - Stress Test & Edge Case Audit (ChatGPT Web Gateway & Web Control Plane)', () => {
  const capabilityToken = 'stress-capability-token';
  let server: ControlPlaneServer;
  let gateway: GatewayService;
  let port: number;

  beforeEach(async () => {
    gateway = new GatewayService({ localPort: 0, tunnelProvider: async (): Promise<{ url: string; stop(): Promise<void> }> => ({ url: 'https://fixture.example.trycloudflare.com', stop: async (): Promise<void> => {} }), healthProbe: async (): Promise<number> => 200 });
    const installer = new InstallerService();
    const pruner = new PrunerService();
    const ideSync = new IdeSyncService();
    const skillCatalog = new SkillCatalog({ settings: DEFAULT_EXTENSIONS_SETTINGS });

    server = new ControlPlaneServer({
      port: 0,
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

  describe('Origin Header Fuzzing & Security Guards', () => {
    const maliciousOrigins = [
      'https://malicious.com',
      'http://127.0.0.1.attacker.com',
      'http://localhost.attacker.com',
      'http://attacker.com?origin=localhost',
      'null',
      'not-a-valid-origin-format',
      'ftp://localhost',
    ];

    for (const badOrigin of maliciousOrigins) {
      it(`strictly blocks malicious origin: ${badOrigin} with 403 Forbidden`, async () => {
        const res = await fetch(`http://127.0.0.1:${port}/api/status`, {
          headers: { Origin: badOrigin },
        });
        expect(res.status).toBe(403);
        const body = await res.json();
        expect(body.error).toBeDefined();
      });
    }

    it('allows valid loopback origins with different ports', async () => {
      const validOrigins = [
        `http://127.0.0.1:${port}`,
        'http://localhost:3000',
        'http://localhost:5173',
        'http://127.0.0.1:8080',
      ];

      for (const goodOrigin of validOrigins) {
        const res = await fetch(`http://127.0.0.1:${port}/api/status`, {
          headers: { Origin: goodOrigin },
        });
        expect(res.status).toBe(200);
      }
    });

    it('blocks oversized request bodies with 413 Payload Too Large', async () => {
      // Create a payload larger than 1MB
      const hugeData = 'x'.repeat(1024 * 1024 + 100);
      const res = await fetch(`http://127.0.0.1:${port}/api/policies/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: `http://127.0.0.1:${port}`,
          'x-unified-mpc-capability': capabilityToken,
        },
        body: JSON.stringify({ hugeData }),
      });
      expect(res.status).toBe(413);
      const body = await res.json();
      expect(body.error).toContain('Payload Too Large');
    });
  });

  describe('Hard Gating Invariant on /api/chatgpt-web/connect', () => {
    it('enforces 412 in STOPPED, transitions to 200 in BRIDGE_HEALTHY, and returns 412 once SESSION_CONNECTED', async () => {
      // 1. Initially STOPPED -> must be 412
      expect(gateway.status().state).toBe('STOPPED');
      const authHeaders = { Origin: `http://127.0.0.1:${port}`, 'x-unified-mpc-capability': capabilityToken };
      const resStopped = await fetch(`http://127.0.0.1:${port}/api/chatgpt-web/connect`, { method: 'POST', headers: authHeaders });
      expect(resStopped.status).toBe(412);

      // 2. Start bridge -> transitions to BRIDGE_HEALTHY -> connect succeeds with 200
      await gateway.start();
      expect(gateway.status().state).toBe('BRIDGE_HEALTHY');

      const resConnected = await fetch(`http://127.0.0.1:${port}/api/chatgpt-web/connect`, { method: 'POST', headers: authHeaders });
      expect(resConnected.status).toBe(200);
      const connData = await resConnected.json();
      expect(connData.leaseToken).toBeDefined();
      expect(connData.leaseToken).toMatch(/^lease_/);

      // 3. Once connected, state is SESSION_CONNECTED -> subsequent connect must return 412!
      expect(gateway.status().state).toBe('SESSION_CONNECTED');
      const resSecond = await fetch(`http://127.0.0.1:${port}/api/chatgpt-web/connect`, { method: 'POST', headers: authHeaders });
      expect(resSecond.status).toBe(412);
      const secondBody = await resSecond.json();
      expect(secondBody.state).toBe('SESSION_CONNECTED');

      // 4. Stop bridge -> state returns to STOPPED -> connect must return 412
      await gateway.stop();
      expect(gateway.status().state).toBe('STOPPED');
      const resStoppedAgain = await fetch(`http://127.0.0.1:${port}/api/chatgpt-web/connect`, { method: 'POST', headers: authHeaders });
      expect(resStoppedAgain.status).toBe(412);
    });
  });

  describe('High Concurrency Load', () => {
    it('handles 50 concurrent requests to /api/chatgpt-gateway/status smoothly', async () => {
      await gateway.start();

      const requests = Array.from({ length: 50 }, () =>
        fetch(`http://127.0.0.1:${port}/api/chatgpt-gateway/status`, { headers: { 'x-unified-mpc-capability': capabilityToken } })
      );

      const responses = await Promise.all(requests);
      for (const res of responses) {
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.state).toBe('BRIDGE_HEALTHY');
        expect(data.localPort).toBeDefined();
      }
    });

    it('handles 30 concurrent mixed requests across endpoints without failure', async () => {
      const endpoints = [
        '/',
        '/api/status',
        '/api/policies',
        '/api/chatgpt-gateway/status',
      ];

      const mixedRequests = Array.from({ length: 30 }, (_, i) => {
        const endpoint = endpoints[i % endpoints.length];
        return fetch(`http://127.0.0.1:${port}${endpoint}`, { headers: { 'x-unified-mpc-capability': capabilityToken } });
      });

      const responses = await Promise.all(mixedRequests);
      for (const res of responses) {
        expect(res.status).toBe(200);
      }
    });
  });
});
