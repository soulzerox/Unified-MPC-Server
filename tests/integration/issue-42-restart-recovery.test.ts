import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { GatewayService, type GatewayStatus } from '../../apps/cf-gateway/src/index.js';
import type { McpHttpServerHandle } from '@unified-mpc/mcp-server';
import { ControlPlaneServer } from '../../apps/web/src/index.js';
import { startMcpHttpBeforeProvider, type McpHttpProviderStartup } from '../../apps/cli/src/commands/mcp-http.js';

interface IdentityRuntime {
  readonly startup: McpHttpProviderStartup;
  readonly port: number;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).reverse().map((cleanup) => cleanup()));
});

describe('Issue #42 restart recovery', () => {
  it('keeps MCP health truthful while Thai-RAG starts and marks connector projection stale after backend recovery', async () => {
    let releaseFirstProvider!: () => void;
    const firstProvider = new Promise<void>((resolve) => { releaseFirstProvider = resolve; });
    const first = await startIdentityRuntime(0, () => firstProvider);
    cleanups.push(() => first.startup.handle.close());

    expect(first.startup.state()).toEqual({ phase: 'starting' });
    const initialIdentity = await fetch(new URL('/_unified-mpc/identity', first.startup.handle.endpoint));
    expect(initialIdentity.status).toBe(200);

    let backendPort = first.port;
    let tunnelStarts = 0;
    const gateway = new GatewayService({
      healthAttempts: 1,
      healthTimeoutMs: 100,
      healthMonitorIntervalMs: 10,
      healthFailureThreshold: 1,
      reconnectBaseDelayMs: 5,
      reconnectMaxDelayMs: 20,
      reconnectJitterRatio: 0,
      tunnelProviderFactory: () => async () => {
        tunnelStarts += 1;
        return { url: 'https://mcp.issue-42.test', stop: async () => {} };
      },
      healthProbe: async (_url, timeoutMs) => {
        try {
          const response = await fetch(`http://127.0.0.1:${backendPort}/_unified-mpc/identity`, {
            signal: AbortSignal.timeout(timeoutMs),
          });
          return response.status;
        } catch {
          return 0;
        }
      },
    });
    cleanups.push(async () => { await gateway.stop(); });

    const capabilityToken = 'issue-42-runtime-proof';
    const web = new ControlPlaneServer({ port: 0, gateway, capabilityToken });
    await web.listen();
    cleanups.push(() => web.close());

    const mutationHeaders = {
      Origin: `http://127.0.0.1:${web.port}`,
      'x-unified-mpc-capability': capabilityToken,
    };
    const startGateway = await fetch(`http://127.0.0.1:${web.port}/api/chatgpt-gateway/start`, {
      method: 'POST',
      headers: mutationHeaders,
    });
    expect(startGateway.status).toBe(200);

    const connect = await fetch(`http://127.0.0.1:${web.port}/api/chatgpt-web/connect`, {
      method: 'POST',
      headers: mutationHeaders,
    });
    expect(connect.status).toBe(200);

    expect(await gatewayStatus(web.port)).toMatchObject({
      state: 'SESSION_CONNECTED',
      sessionState: 'leased',
      connectorRegistration: {
        state: 'unverified',
        reason: 'host_projection_unavailable',
        action: 'reconnect_chatgpt_session',
      },
      endToEndState: 'unverified',
    });

    await first.startup.handle.close();
    releaseFirstProvider();
    await expect(first.startup.providerReady).resolves.toBeUndefined();

    await expect.poll(() => gateway.status().connectorRegistration.state, { timeout: 1_000 }).toBe('stale');
    expect(gateway.status()).toMatchObject({
      state: 'ERROR',
      connectorRegistration: {
        state: 'stale',
        reason: 'backend_restart',
        action: 'reconnect_chatgpt_session',
      },
      endToEndState: 'unverified',
    });

    const second = await startIdentityRuntime(first.port, async () => {
      throw new Error('Thai-RAG deliberately unavailable during restart proof');
    });
    cleanups.push(() => second.startup.handle.close());
    backendPort = second.port;

    await expect(second.startup.providerReady).rejects.toThrow('Thai-RAG deliberately unavailable');
    expect(second.startup.state()).toMatchObject({ phase: 'degraded' });

    await expect.poll(() => gateway.status().state, { timeout: 2_000 }).toBe('SESSION_CONNECTED');
    expect(tunnelStarts).toBeGreaterThanOrEqual(2);
    expect(await gatewayStatus(web.port)).toMatchObject({
      state: 'SESSION_CONNECTED',
      sessionState: 'leased',
      connectorRegistration: {
        state: 'stale',
        reason: 'backend_restart',
        action: 'reconnect_chatgpt_session',
      },
      endToEndState: 'unverified',
    });

    const disconnect = await fetch(`http://127.0.0.1:${web.port}/api/chatgpt-web/disconnect`, {
      method: 'POST',
      headers: mutationHeaders,
    });
    expect(disconnect.status).toBe(200);
    const reconnect = await fetch(`http://127.0.0.1:${web.port}/api/chatgpt-web/connect`, {
      method: 'POST',
      headers: mutationHeaders,
    });
    expect(reconnect.status).toBe(200);
    expect(await gatewayStatus(web.port)).toMatchObject({
      state: 'SESSION_CONNECTED',
      connectorRegistration: {
        state: 'unverified',
        reason: 'host_projection_unavailable',
        action: 'reconnect_chatgpt_session',
      },
      endToEndState: 'unverified',
    });
  });
});

async function startIdentityRuntime(
  port: number,
  initializeProvider: () => Promise<void>,
): Promise<IdentityRuntime> {
  let handle!: McpHttpServerHandle;
  const startup = await startMcpHttpBeforeProvider({
    start: async () => {
      handle = await startIdentityServer(port);
      return handle;
    },
    initializeProvider,
  });
  return { startup, port: handle.address.port };
}

async function startIdentityServer(port: number): Promise<McpHttpServerHandle> {
  const server = createServer((request, response) => {
    if (request.url !== '/_unified-mpc/identity') {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ product: 'Unified-MPC-Server', service: 'desktop-mcp', protocol: 1, version: 'test' }));
  });
  await listen(server, port);
  const address = server.address() as AddressInfo;
  return {
    address: { host: '127.0.0.1', port: address.port },
    endpoint: new URL(`http://127.0.0.1:${address.port}/mcp`),
    close: async () => close(server),
  };
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
}

function close(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function gatewayStatus(port: number): Promise<GatewayStatus> {
  const response = await fetch(`http://127.0.0.1:${port}/api/chatgpt-gateway/status`);
  expect(response.status).toBe(200);
  return response.json() as Promise<GatewayStatus>;
}
