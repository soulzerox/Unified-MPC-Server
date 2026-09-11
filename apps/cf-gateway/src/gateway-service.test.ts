import { describe, expect, it } from 'vitest';
import { GatewayService } from './gateway-service.js';

describe('GatewayService - ChatGPT Web Bridge State Machine', () => {
  it('starts in STOPPED state where session connection is disallowed', () => {
    const gateway = new GatewayService({ localPort: 18765 });
    const status = gateway.status();

    expect(status.state).toBe('STOPPED');
    expect(gateway.canConnectSession()).toBe(false);
    expect(status.tunnelUrl).toBeUndefined();
  });

  it('transitions STOPPED -> INITIALIZING -> BRIDGE_HEALTHY on start', async () => {
    const gateway = new GatewayService({ localPort: 18765 });
    const startResult = await gateway.start();

    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;

    const status = gateway.status();
    expect(status.state).toBe('BRIDGE_HEALTHY');
    expect(gateway.canConnectSession()).toBe(true);
    expect(status.tunnelUrl).toContain('https://');
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
    const gateway = new GatewayService({ localPort: 18765 });
    await gateway.start();

    const connectResult = await gateway.connectSession();
    expect(connectResult.ok).toBe(true);
    if (!connectResult.ok) return;

    expect(connectResult.value.leaseToken).toBeDefined();
    expect(connectResult.value.tunnelUrl).toBeDefined();
    expect(gateway.status().state).toBe('SESSION_CONNECTED');
  });

  it('stops cleanly and returns to STOPPED state', async () => {
    const gateway = new GatewayService({ localPort: 18765 });
    await gateway.start();
    await gateway.connectSession();

    await gateway.stop();
    const status = gateway.status();
    expect(status.state).toBe('STOPPED');
    expect(gateway.canConnectSession()).toBe(false);
  });
});

