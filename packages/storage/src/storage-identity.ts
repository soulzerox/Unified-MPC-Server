import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { DataPathEnvironment } from '@unified-mpc/shared';

export const GATEWAY_PERSISTED_SETTING_KEYS = [
  'cloudflare_tunnel_name',
  'cloudflare_public_url',
  'mcp_allowed_hostnames',
  'mcp_allowed_origins',
  'cloudflare_tunnel_token_configured',
  'cloudflare_account_id',
  'cloudflare_zone_name',
  'cloudflare_origin_url',
  'cloudflare_remote_tunnel_id',
  'cloudflare_api_token_configured',
  'cloudflare_gateway_desired_state',
] as const;

export interface StorageIdentityOptions {
  readonly environment?: DataPathEnvironment;
  readonly platform?: NodeJS.Platform;
  /** Test seam and the historical Web fallback source before canonical data-path pinning. */
  readonly systemHome?: string;
}

export interface SqliteStorageLocation {
  readonly dataRoot: string;
  readonly sqlitePath: string;
  readonly exists: boolean;
  readonly readable: boolean;
  readonly schemaVersion: string | null;
  readonly settingsRowCount: number | null;
  readonly gatewaySettingCount: number | null;
}

export interface StorageIdentityInspection {
  readonly canonical: SqliteStorageLocation;
  readonly historical: readonly SqliteStorageLocation[];
  readonly recoveryRequired: boolean;
  readonly recoverySourcePath: string | null;
}

export class StorageIdentityError extends Error {
  public constructor(
    public readonly code: 'STORAGE_IDENTITY_DRIFT' | 'STORAGE_IDENTITY_UNAVAILABLE',
    message: string,
    public readonly inspection: StorageIdentityInspection,
  ) {
    super(`${code}: ${message}`);
    this.name = 'StorageIdentityError';
  }
}

/**
 * Inspect the canonical SQLite identity without creating or migrating any database.
 * Historical candidates cover the pre-pinning HOME/XDG split that could select a
 * different unified-mpc.sqlite for the same user.
 */
export function inspectStorageIdentity(
  canonicalDataRoot: string,
  options: StorageIdentityOptions = {},
): StorageIdentityInspection {
  const pathApi = path.posix;
  const canonicalRoot = pathApi.normalize(canonicalDataRoot);
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const systemHome = options.systemHome ?? os.homedir();
  const canonical = inspectSqliteLocation(canonicalRoot);
  const historical = historicalDataRoots(environment, platform, systemHome)
    .filter((candidate) => candidate !== canonicalRoot)
    .map((candidate) => inspectSqliteLocation(candidate))
    .filter((candidate) => candidate.exists);

  const canonicalHasGatewaySettings = canonical.readable && (canonical.gatewaySettingCount ?? 0) > 0;
  const recoveryCandidate = canonicalHasGatewaySettings
    ? undefined
    : historical.find((candidate) => !candidate.readable || (candidate.gatewaySettingCount ?? 0) > 0);

  return {
    canonical,
    historical,
    recoveryRequired: recoveryCandidate !== undefined,
    recoverySourcePath: recoveryCandidate?.sqlitePath ?? null,
  };
}

/**
 * Fail closed before opening SQLite when startup would otherwise create/use a
 * fresh canonical DB while a historical DB contains persisted gateway state.
 */
export function assertStorageIdentitySafe(
  canonicalDataRoot: string,
  options: StorageIdentityOptions = {},
): StorageIdentityInspection {
  const inspection = inspectStorageIdentity(canonicalDataRoot, options);
  if (inspection.canonical.exists && !inspection.canonical.readable) {
    throw new StorageIdentityError(
      'STORAGE_IDENTITY_UNAVAILABLE',
      `canonical SQLite database cannot be inspected: ${inspection.canonical.sqlitePath}`,
      inspection,
    );
  }
  if (inspection.recoveryRequired) {
    throw new StorageIdentityError(
      'STORAGE_IDENTITY_DRIFT',
      `canonical storage has no persisted gateway settings while historical database exists at ${inspection.recoverySourcePath ?? 'unknown'}; recovery is required before startup`,
      inspection,
    );
  }
  return inspection;
}

function historicalDataRoots(
  environment: DataPathEnvironment,
  platform: NodeJS.Platform,
  systemHome: string,
): readonly string[] {
  const pathApi = path.posix;
  const roots: string[] = [];
  const push = (candidate: string | undefined): void => {
    const normalized = absolutePath(candidate, pathApi);
    if (normalized !== undefined && !roots.includes(normalized)) roots.push(normalized);
  };
  const environmentHome = absolutePath(environment.HOME, pathApi);
  const normalizedSystemHome = absolutePath(systemHome, pathApi);

  if (platform === 'darwin') {
    if (environmentHome !== undefined) {
      push(pathApi.join(environmentHome, 'Library', 'Application Support', 'unified-mpc'));
      push(pathApi.join(environmentHome, '.local', 'share', 'unified-mpc'));
    }
    if (normalizedSystemHome !== undefined) {
      push(pathApi.join(normalizedSystemHome, 'Library', 'Application Support', 'unified-mpc'));
      push(pathApi.join(normalizedSystemHome, '.local', 'share', 'unified-mpc'));
    }
    return roots;
  }

  const xdg = absolutePath(environment.XDG_DATA_HOME, pathApi);
  if (xdg !== undefined) push(pathApi.join(xdg, 'unified-mpc'));
  if (environmentHome !== undefined) push(pathApi.join(environmentHome, '.local', 'share', 'unified-mpc'));
  if (normalizedSystemHome !== undefined) push(pathApi.join(normalizedSystemHome, '.local', 'share', 'unified-mpc'));
  return roots;
}

function inspectSqliteLocation(dataRoot: string): SqliteStorageLocation {
  const sqlitePath = path.posix.join(dataRoot, 'unified-mpc.sqlite');
  if (!existsSync(sqlitePath)) {
    return {
      dataRoot,
      sqlitePath,
      exists: false,
      readable: false,
      schemaVersion: null,
      settingsRowCount: null,
      gatewaySettingCount: null,
    };
  }

  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(sqlitePath, { readOnly: true, timeout: 1_000 });
    const settingsTable = database.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'settings' LIMIT 1",
    ).get();
    const migrationsTable = database.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations' LIMIT 1",
    ).get();
    const settingsPresent = objectField(settingsTable, 'present') === 1;
    const migrationsPresent = objectField(migrationsTable, 'present') === 1;
    const settingsRowCount = settingsPresent
      ? numericField(database.prepare('SELECT COUNT(*) AS count FROM settings').get(), 'count')
      : 0;
    const placeholders = GATEWAY_PERSISTED_SETTING_KEYS.map(() => '?').join(', ');
    const gatewaySettingCount = settingsPresent
      ? numericField(
          database.prepare(`SELECT COUNT(*) AS count FROM settings WHERE key IN (${placeholders})`)
            .get(...GATEWAY_PERSISTED_SETTING_KEYS),
          'count',
        )
      : 0;
    const schemaVersion = migrationsPresent
      ? stringField(database.prepare('SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1').get(), 'id')
      : null;
    return {
      dataRoot,
      sqlitePath,
      exists: true,
      readable: true,
      schemaVersion,
      settingsRowCount,
      gatewaySettingCount,
    };
  } catch {
    return {
      dataRoot,
      sqlitePath,
      exists: true,
      readable: false,
      schemaVersion: null,
      settingsRowCount: null,
      gatewaySettingCount: null,
    };
  } finally {
    database?.close();
  }
}

function absolutePath(value: string | undefined, pathApi: typeof path.posix): string | undefined {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0 || !pathApi.isAbsolute(trimmed)) return undefined;
  return pathApi.normalize(trimmed);
}

function objectField(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function numericField(value: unknown, key: string): number {
  const field = objectField(value, key);
  if (typeof field === 'number') return field;
  if (typeof field === 'bigint') return Number(field);
  return 0;
}

function stringField(value: unknown, key: string): string | null {
  const field = objectField(value, key);
  return typeof field === 'string' ? field : null;
}
