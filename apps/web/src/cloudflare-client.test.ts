import { describe, expect, it } from 'vitest';
import { CloudflareTunnelReconciler } from './cloudflare-client.js';

describe('CloudflareTunnelReconciler', () => {
  it('finds or creates tunnel, configures ingress, and upserts DNS without exposing token', async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const apiToken = 'api-token-must-not-appear-in-errors';
    const fetchMock: typeof fetch = async (input, init = {}): Promise<Response> => {
      const url = String(input);
      calls.push({ url, init });
      const body = calls.length === 1
        ? { success: true, result: [{ id: 'zone-id', name: 'example.com' }] }
        : calls.length === 2
          ? { success: true, result: [] }
          : calls.length === 3
            ? { success: true, result: { id: 'tunnel-id', name: 'user-tunnel' } }
            : calls.length === 4
              ? { success: true, result: 'runtime-tunnel-token' }
              : calls.length === 5
                ? { success: true, result: {} }
                : calls.length === 6
                  ? { success: true, result: [] }
                  : { success: true, result: {} };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const result = await new CloudflareTunnelReconciler({ fetch: fetchMock }).reconcile(apiToken, {
      accountId: '0123456789abcdef0123456789abcdef',
      zoneName: 'example.com',
      tunnelName: 'user-tunnel',
      publicUrl: 'https://mcp.example.com',
      originUrl: 'http://127.0.0.1:18765',
    });

    expect(result).toEqual({ tunnelId: 'tunnel-id', tunnelToken: 'runtime-tunnel-token', zoneId: 'zone-id', hostname: 'mcp.example.com' });
    expect(calls).toHaveLength(7);
    expect(calls[0]?.url).toContain('/zones?name=example.com');
    expect(calls[1]?.url).toContain('/accounts/0123456789abcdef0123456789abcdef/cfd_tunnel?name=user-tunnel');
    expect(calls[2]?.init.method).toBe('POST');
    expect(String(calls[2]?.init.body)).toContain('"config_src":"cloudflare"');
    expect(calls[3]?.url).toContain('/cfd_tunnel/tunnel-id/token');
    expect(calls[4]?.init.method).toBe('PUT');
    expect(String(calls[4]?.init.body)).toContain('"service":"http://127.0.0.1:18765"');
    expect(String(calls[4]?.init.body)).not.toContain('http://127.0.0.1:18765/');
    expect(calls[5]?.url).toContain('/dns_records?name=mcp.example.com');
    expect(calls[6]?.init.method).toBe('POST');
    expect(String(calls[6]?.init.body)).toContain('tunnel-id.cfargotunnel.com');
    expect(JSON.stringify(result)).not.toContain(apiToken);
  });

  it('rejects public URLs outside configured zone and non-loopback origins', async () => {
    const reconciler = new CloudflareTunnelReconciler({ fetch: async (): Promise<Response> => new Response() });
    const input = {
      accountId: '0123456789abcdef0123456789abcdef',
      zoneName: 'example.com',
      tunnelName: 'user-tunnel',
      publicUrl: 'https://not-example.net',
      originUrl: 'http://192.0.2.1:18765',
    };
    await expect(reconciler.reconcile('api-token', input)).rejects.toThrow('Public URL hostname must belong to configured zone');
  });

  it('rejects origin URLs with a path because Cloudflare ingress forbids origin paths', async () => {
    const reconciler = new CloudflareTunnelReconciler({ fetch: async (): Promise<Response> => new Response() });
    const input = {
      accountId: '0123456789abcdef0123456789abcdef',
      zoneName: 'example.com',
      tunnelName: 'user-tunnel',
      publicUrl: 'https://mcp.example.com',
      originUrl: 'http://127.0.0.1:18765/mcp',
    };
    await expect(reconciler.reconcile('api-token', input)).rejects.toThrow(/must not include a path/);
  });

  it('normalizes pasted Bearer-prefixed API tokens', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const response = (): Response => Response.json({ success: true, result: [] }) as unknown as Response;
    const reconciler = new CloudflareTunnelReconciler({
      fetch: async (url, init): Promise<Response> => {
        calls.push({ url: String(url), ...(init === undefined ? {} : { init }) });
        return response();
      },
    });
    const input = {
      accountId: '0123456789abcdef0123456789abcdef',
      zoneName: 'example.com',
      tunnelName: 'user-tunnel',
      publicUrl: 'https://mcp.example.com',
      originUrl: 'http://127.0.0.1:18765',
    };
    await expect(reconciler.reconcile('Bearer  api-token-123 ', input)).rejects.toThrow('Cloudflare zone was not found or is not active');
    const headers = new Headers(calls[0]?.init?.headers as HeadersInit);
    expect(headers.get('Authorization')).toBe('Bearer api-token-123');
  });
});