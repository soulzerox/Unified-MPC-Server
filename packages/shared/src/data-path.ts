import os from 'node:os';
import path from 'node:path';

export interface DataPathEnvironment {
  readonly UNIFIED_MPC_DATA_PATH?: string;
  readonly HOME?: string;
  readonly XDG_DATA_HOME?: string;
}

/** Resolve the per-user unified-mpc data directory on Linux/POSIX without embedding a developer profile path. */
export function resolveDataPath(
  environment: DataPathEnvironment = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const pathApi = path.posix;
  const configured = absolutePathOrUndefined(environment.UNIFIED_MPC_DATA_PATH, pathApi);
  if (configured !== undefined) return configured;

  const home = absolutePathOrUndefined(environment.HOME, pathApi)
    ?? absolutePathOrUndefined(os.homedir(), pathApi);

  if (platform === 'darwin') {
    const appData = firstAbsolutePath(
      pathApi,
      home ? pathApi.join(home, 'Library', 'Application Support') : undefined,
      pathApi.join(os.homedir(), 'Library', 'Application Support'),
    );
    return pathApi.join(appData, 'unified-mpc');
  }

  const appData = firstAbsolutePath(
    pathApi,
    environment.XDG_DATA_HOME,
    home ? pathApi.join(home, '.local', 'share') : undefined,
    pathApi.join(os.homedir(), '.local', 'share'),
  );
  return pathApi.join(appData, 'unified-mpc');
}

/** @deprecated Alias for clean migration */
export const resolveLnwjudDataPath = resolveDataPath;

function absolutePathOrUndefined(value: string | undefined, pathApi: typeof path.posix): string | undefined {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0 || !pathApi.isAbsolute(trimmed)) return undefined;
  return pathApi.normalize(trimmed);
}

function firstAbsolutePath(pathApi: typeof path.posix, ...values: readonly (string | undefined)[]): string {
  for (const value of values) {
    const absolute = absolutePathOrUndefined(value, pathApi);
    if (absolute !== undefined) return absolute;
  }
  throw new Error('Unable to resolve an absolute unified-mpc data directory');
}
