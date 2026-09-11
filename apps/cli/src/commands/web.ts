import { ok, err, appError, type Result } from '@unified-mpc/domain';
import { ControlPlaneServer, type ControlPlaneServerOptions } from '@unified-mpc/web';
import type { CliServerHandle } from '../index.js';

export interface WebCommand {
  readonly kind: 'web';
  readonly host: string;
  readonly port: number;
}

export interface WebRunResult {
  readonly handle: CliServerHandle;
  readonly url: string;
}

export function parseWebArgs(args: readonly string[]): Result<WebCommand> {
  let host = '127.0.0.1';
  let port = 18765;

  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (flag === '--port' && args[i + 1] !== undefined) {
      const parsedPort = Number.parseInt(args[i + 1]!, 10);
      if (Number.isNaN(parsedPort) || parsedPort < 0 || parsedPort > 65535) {
        return err(appError('INVALID_INPUT', 'Port must be a valid number between 0 and 65535'));
      }
      port = parsedPort;
      i += 1;
    } else if (flag === '--host' && args[i + 1] !== undefined) {
      host = args[i + 1]!.trim();
      i += 1;
    }
  }

  return ok({
    kind: 'web',
    host,
    port,
  });
}

export async function runWeb(
  options: { port?: number; host?: string } = {},
  serverOptions?: ControlPlaneServerOptions,
): Promise<Result<WebRunResult>> {
  try {
    const server = new ControlPlaneServer({
      ...serverOptions,
      port: options.port ?? 18765,
    });
    await server.listen();
    const url = `http://${options.host ?? '127.0.0.1'}:${server.port}`;
    return ok({
      handle: server,
      url,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(appError('INTERNAL_ERROR', `Failed to start control plane server: ${message}`));
  }
}

