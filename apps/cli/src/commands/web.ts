import { ok, err, appError, type Result } from '@unified-mpc/domain';
import { WorkspaceSelectionService } from '@unified-mpc/application';
import { ControlPlaneServer, type ControlPlaneServerOptions, type WebWorkspaceSelectionSnapshot, type WebWorkspaceSummary, type WorkspaceControlPort } from '@unified-mpc/web';
import { USER_SETTING_KEYS, resolveDataPath } from '@unified-mpc/shared';
import { SecretToolSecretStore, SqliteDatabase, SqliteSettingsRepository, SqliteWorkspaceRepository } from '@unified-mpc/storage';
import { WorkspaceService, isMachineRootPath } from '@unified-mpc/workspace';
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
    const workspaceRepository = new SqliteWorkspaceRepository(database);
    const workspaceService = new WorkspaceService(workspaceRepository);
    bootstrapNonSecretSettings(settings);
    const workspaceControl = createWorkspaceControl(workspaceRepository, workspaceService, settings);
    const server = new ControlPlaneServer({
      ...serverOptions,
      port: options.port ?? 3000,
      dataDir: serverOptions?.dataDir ?? dataPath,
      settingsRepository: serverOptions?.settingsRepository ?? settings,
      secretStore: serverOptions?.secretStore ?? new SecretToolSecretStore(),
      workspaceControl: serverOptions?.workspaceControl ?? workspaceControl,
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

function createWorkspaceControl(
  workspaceRepository: SqliteWorkspaceRepository,
  workspaceService: WorkspaceService,
  settings: SqliteSettingsRepository,
): WorkspaceControlPort {
  const projectList = async (): Promise<readonly WebWorkspaceSummary[]> => (await workspaceService.list())
    .filter((workspace) => !isMachineRootPath(workspace.realRootPath) && !isMachineRootPath(workspace.rootPath));
  const selection = async (): Promise<WorkspaceSelectionService | null> => {
    const projects = await projectList();
    const initial = projects[0];
    if (initial === undefined) return null;
    return new WorkspaceSelectionService(workspaceRepository, initial.id, {
      get: () => settings.get(USER_SETTING_KEYS.httpWorkspaceSelection),
      set: (value) => settings.set(USER_SETTING_KEYS.httpWorkspaceSelection, value),
    });
  };
  const requireSelection = async (): Promise<WorkspaceSelectionService> => {
    const service = await selection();
    if (service === null) throw new Error('No registered project workspace is available');
    return service;
  };
  const unwrap = async <T>(result: Promise<Result<T>>): Promise<T> => {
    const resolved = await result;
    if (!resolved.ok) throw new Error(resolved.error.message);
    return resolved.value;
  };

  return {
    list: projectList,
    selection: async (): Promise<WebWorkspaceSelectionSnapshot | null> => {
      const service = await selection();
      return service === null ? null : unwrap(service.list());
    },
    activate: async (workspaceId) => unwrap((await requireSelection()).activate(workspaceId)),
    deactivate: async (workspaceId) => unwrap((await requireSelection()).deactivate(workspaceId)),
    setPrimary: async (workspaceId) => unwrap((await requireSelection()).setPrimary(workspaceId)),
    remove: async (workspaceId): Promise<WebWorkspaceSelectionSnapshot | null> => {
      const projects = await projectList();
      if (!projects.some((project) => project.id === workspaceId)) throw new Error('Workspace is not a registered project');
      await workspaceService.delete(workspaceId);
      const service = await selection();
      return service === null ? null : unwrap(service.list());
    },
  };
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

