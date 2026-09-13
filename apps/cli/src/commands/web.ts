import { ok, err, appError, type Result } from '@unified-mpc/domain';
import { ControlPlaneServer, type ControlPlaneServerOptions } from '@unified-mpc/web';
import { resolveDataPath } from '@unified-mpc/shared';
import { SecretToolSecretStore, SqliteDatabase, SqliteSettingsRepository } from '@unified-mpc/storage';
import path from 'node:path';
import type { CliServerHandle } from '../index.js';

export interface WebCommand {
  readonly kind: 'web';
  readonly port: number;
}

export interface WebRunResult {
  readonly handle: CliServerHandle;
  readonly url: string;
}

export function parseWebArgs(args: readonly string[]): Result<WebCommand> {
  let port = 3000;

  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (flag === '--port' && args[i + 1] !== undefined) {
      const parsedPort = Number.parseInt(args[i + 1]!, 10);
      if (Number.isNaN(parsedPort) || parsedPort < 0 || parsedPort > 65535) {
        return err(appError('INVALID_INPUT', 'Port must be a valid number between 0 and 65535'));
      }
      port = parsedPort;
      i += 1;
    } else if (flag === '--host') {
      return err(appError('INVALID_INPUT', 'Web control plane binds to 127.0.0.1; --host is not supported'));
    }
  }

  return ok({
    kind: 'web',
    port,
  });
}

export async function runWeb(
  options: { port?: number } = {},
  serverOptions?: ControlPlaneServerOptions,
): Promise<Result<WebRunResult>> {
  try {
    const dataPath = resolveDataPath();
    const database = new SqliteDatabase(path.join(dataPath, 'unified-mpc.sqlite'));
    const settings = new SqliteSettingsRepository(database);
    bootstrapNonSecretSettings(settings);
    const server = new ControlPlaneServer({
      ...serverOptions,
      port: options.port ?? 3000,
      settingsRepository: serverOptions?.settingsRepository ?? settings,
      secretStore: serverOptions?.secretStore ?? new SecretToolSecretStore(),
      closeSettings: (): void => {
        if (serverOptions?.closeSettings === undefined) database.close();
        serverOptions?.closeSettings?.();
      },
    });
    try {
      await server.listen();
    } catch (error) {
      database.close();
      throw error;
    }
    const url = `http://127.0.0.1:${server.port}`;
    return ok({
      handle: server,
      url,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(appError('INTERNAL_ERROR', `Failed to start control plane server: ${message}`));
  }
}

function bootstrapNonSecretSettings(settings: SqliteSettingsRepository): void {
  const imports: readonly [string, string][] = [
    ['cloudflare_tunnel_name', 'UNIFIED_MPC_CLOUDFLARE_TUNNEL_NAME'],
    ['cloudflare_public_url', 'UNIFIED_MPC_CLOUDFLARE_PUBLIC_URL'],
    ['mcp_allowed_hostnames', 'UNIFIED_MPC_MCP_ALLOWED_HOSTNAMES'],
    ['mcp_allowed_origins', 'UNIFIED_MPC_MCP_ALLOWED_ORIGINS'],
  ];
  for (const [key, envName] of imports) {
    if (settings.get(key) !== null) continue;
    const value = process.env[envName]?.trim();
    if (value) settings.set(key, value);
  }
}

