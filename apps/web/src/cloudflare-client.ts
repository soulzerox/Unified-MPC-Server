import { randomBytes } from 'node:crypto';

export interface CloudflareTunnelSetup {
  readonly accountId: string;
  readonly zoneName: string;
  readonly tunnelName: string;
  readonly publicUrl: string;
  readonly originUrl: string;
}

export interface CloudflareTunnelResult {
  readonly tunnelId: string;
  readonly tunnelToken: string;
  readonly zoneId: string;
  readonly hostname: string;
}

export interface CloudflareTunnelReconcilerOptions {
  readonly fetch?: typeof fetch;
}

type CloudflareResponse<T> = {
  readonly success?: boolean;
  readonly result?: T;
};

type Zone = { readonly id?: string; readonly name?: string };
type Tunnel = { readonly id?: string; readonly name?: string };
type DnsRecord = { readonly id?: string; readonly type?: string; readonly name?: string };

const API_ROOT = 'https://api.cloudflare.com/client/v4';

export class CloudflareTunnelReconciler {
  private readonly fetchImpl: typeof fetch;

  public constructor(options: CloudflareTunnelReconcilerOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  public async reconcile(apiToken: string, setup: CloudflareTunnelSetup): Promise<CloudflareTunnelResult> {
    const token = requireNonEmpty(apiToken, 'Cloudflare API token');
    const normalized = normalizeSetup(setup);
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };

    const zone = await this.findZone(headers, normalized.zoneName);
    const tunnel = await this.findOrCreateTunnel(headers, normalized.accountId, normalized.tunnelName);
    const tunnelToken = await this.requestTunnelToken(headers, normalized.accountId, tunnel.id);
    await this.configureTunnel(headers, normalized.accountId, tunnel.id, normalized.publicUrl, normalized.originUrl);
    await this.upsertDnsRecord(headers, zone.id, normalized.publicUrl, `${tunnel.id}.cfargotunnel.com`);

    return {
      tunnelId: tunnel.id,
      tunnelToken,
      zoneId: zone.id,
      hostname: new URL(normalized.publicUrl).hostname,
    };
  }

  private async findZone(headers: Record<string, string>, zoneName: string): Promise<{ readonly id: string }> {
    const response = await this.request<readonly Zone[]>(
      `/zones?name=${encodeURIComponent(zoneName)}&status=active&per_page=1`,
      'resolve zone',
      headers,
    );
    const zone = response.result?.[0];
    if (zone?.id === undefined) throw new Error('Cloudflare zone was not found or is not active');
    return { id: zone.id };
  }

  private async findOrCreateTunnel(headers: Record<string, string>, accountId: string, name: string): Promise<{ readonly id: string }> {
    const query = await this.request<readonly Tunnel[]>(
      `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel?name=${encodeURIComponent(name)}&per_page=100`,
      'find tunnel',
      headers,
    );
    const existing = query.result?.find((tunnel) => tunnel.name === name && typeof tunnel.id === 'string');
    if (existing?.id !== undefined) return { id: existing.id };

    const created = await this.request<Tunnel>(
      `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel`,
      'create tunnel',
      headers,
      'POST',
      {
        name,
        config_src: 'cloudflare',
        tunnel_secret: randomBytes(32).toString('base64'),
      },
    );
    if (created.result?.id === undefined) throw new Error('Cloudflare tunnel creation returned no tunnel ID');
    return { id: created.result.id };
  }

  private async requestTunnelToken(headers: Record<string, string>, accountId: string, tunnelId: string): Promise<string> {
    const response = await this.request<string>(
      `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/token`,
      'get tunnel token',
      headers,
    );
    return requireNonEmpty(response.result, 'Cloudflare tunnel token');
  }

  private async configureTunnel(
    headers: Record<string, string>,
    accountId: string,
    tunnelId: string,
    publicUrl: string,
    originUrl: string,
  ): Promise<void> {
    await this.request(
      `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/configurations`,
      'configure tunnel ingress',
      headers,
      'PUT',
      {
        config: {
          ingress: [
            { hostname: new URL(publicUrl).hostname, service: originUrl },
            { service: 'http_status:404' },
          ],
        },
      },
    );
  }

  private async upsertDnsRecord(headers: Record<string, string>, zoneId: string, publicUrl: string, target: string): Promise<void> {
    const hostname = new URL(publicUrl).hostname;
    const records = await this.request<readonly DnsRecord[]>(
      `/zones/${encodeURIComponent(zoneId)}/dns_records?name=${encodeURIComponent(hostname)}&per_page=100`,
      'find DNS record',
      headers,
    );
    const matches = records.result ?? [];
    if (matches.length > 1 || matches.some((record) => record.type !== 'CNAME' || record.id === undefined)) {
      throw new Error('Cloudflare hostname has conflicting DNS records');
    }
    const body = { type: 'CNAME', name: hostname, content: target, ttl: 1, proxied: true };
    if (matches[0]?.id !== undefined) {
      await this.request(`/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(matches[0].id)}`, 'update DNS record', headers, 'PUT', body);
    } else {
      await this.request(`/zones/${encodeURIComponent(zoneId)}/dns_records`, 'create DNS record', headers, 'POST', body);
    }
  }

  private async request<T>(
    path: string,
    operation: string,
    headers: Record<string, string>,
    method = 'GET',
    body?: unknown,
  ): Promise<CloudflareResponse<T>> {
    const response = await this.fetchImpl(`${API_ROOT}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Cloudflare API failed while attempting to ${operation} (HTTP ${response.status})`);
    let parsed: CloudflareResponse<T>;
    try {
      parsed = await response.json() as CloudflareResponse<T>;
    } catch {
      throw new Error(`Cloudflare API returned invalid JSON while attempting to ${operation}`);
    }
    if (parsed.success !== true) throw new Error(`Cloudflare API rejected request while attempting to ${operation}`);
    return parsed;
  }
}

function normalizeSetup(setup: CloudflareTunnelSetup): CloudflareTunnelSetup {
  const accountId = requireNonEmpty(setup.accountId, 'Cloudflare account ID');
  if (!/^[a-f0-9]{32}$/iu.test(accountId)) throw new Error('Cloudflare account ID must be a 32-character hexadecimal ID');
  const zoneName = normalizeHostname(setup.zoneName, 'Cloudflare zone name');
  const tunnelName = requireNonEmpty(setup.tunnelName, 'Tunnel name');
  if (tunnelName.length > 100) throw new Error('Tunnel name must not exceed 100 characters');
  if (!/^[\p{L}\p{N}][\p{L}\p{N}._ -]*$/u.test(tunnelName)) throw new Error('Tunnel name contains invalid characters');
  const publicUrl = normalizePublicUrl(setup.publicUrl);
  const hostname = new URL(publicUrl).hostname;
  if (hostname !== zoneName && !hostname.endsWith(`.${zoneName}`)) throw new Error('Public URL hostname must belong to configured zone');
  const originUrl = normalizeOriginUrl(setup.originUrl);
  return { accountId, zoneName, tunnelName, publicUrl, originUrl };
}

function normalizeHostname(value: string, field: string): string {
  const hostname = requireNonEmpty(value, field).toLowerCase().replace(/\.$/u, '');
  if (hostname.length > 253 || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(hostname)) {
    throw new Error(`${field} must be a valid DNS name`);
  }
  return hostname;
}

function normalizePublicUrl(value: string): string {
  let url: URL;
  try { url = new URL(requireNonEmpty(value, 'Public URL')); } catch { throw new Error('Public URL must be a valid HTTPS URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Public URL must be an HTTPS origin without path, query, or credentials');
  normalizeHostname(url.hostname, 'Public URL hostname');
  return url.toString();
}

function normalizeOriginUrl(value: string): string {
  let url: URL;
  try { url = new URL(requireNonEmpty(value, 'Local MCP origin')); } catch { throw new Error('Local MCP origin must be a valid HTTP(S) URL'); }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash || !isLoopback(url.hostname)) {
    throw new Error('Local MCP origin must be an HTTP(S) loopback URL without credentials or query data');
  }
  return url.toString();
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

function requireNonEmpty(value: string | undefined, field: string): string {
  const normalized = value?.trim();
  if (normalized === undefined || normalized.length === 0) throw new Error(`${field} is required`);
  return normalized;
}