import { ok, err, appError, type GoalRecord, type Result } from '@unified-mpc/domain';
import { WorkspaceSelectionService } from '@unified-mpc/application';
import {
  ControlPlaneServer,
  type ControlPlaneServerOptions,
  type GoalControlPort,
  type WebGoalSummary,
  type WebWorkspaceSelectionSnapshot,
  type WebWorkspaceSummary,
  type WorkspaceControlPort,
} from '@unified-mpc/web';
import {
  USER_SETTING_KEYS,
  parseStringRecordSetting,
  resolveDataPath,
  serializeStringRecordSetting,
} from '@unified-mpc/shared';
import {
  SecretToolSecretStore,
  SqliteDatabase,
  SqliteGoalRepository,
  SqliteSettingsRepository,
  SqliteWorkspaceRepository,
} from '@unified-mpc/storage';
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
    const goalRepository = new SqliteGoalRepository(database);
    bootstrapNonSecretSettings(settings);
    const workspaceControl = createWorkspaceControl(workspaceRepository, workspaceService, settings);
    const goalControl = createGoalControl(goalRepository, settings);
    const server = new ControlPlaneServer({
      ...serverOptions,
      port: options.port ?? 3000,
      dataDir: serverOptions?.dataDir ?? dataPath,
      settingsRepository: serverOptions?.settingsRepository ?? settings,
      secretStore: serverOptions?.secretStore ?? new SecretToolSecretStore(),
      workspaceControl: serverOptions?.workspaceControl ?? workspaceControl,
      goalControl: serverOptions?.goalControl ?? goalControl,
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

export function createGoalControl(
  goals: Pick<SqliteGoalRepository, 'countWorkspaceGoalsForHost' | 'listWorkspaceGoalsForHost' | 'getById'>,
  settings: Pick<SqliteSettingsRepository, 'get' | 'set'>,
): GoalControlPort {
  const preferredMap = (): Readonly<Record<string, string>> => parseStringRecordSetting(
    settings.get(USER_SETTING_KEYS.preferredWorkspaceGoals),
  );
  const validPreferred = async (workspaceId: string): Promise<string | null> => {
    const goalId = preferredMap()[workspaceId.toLowerCase()];
    if (goalId === undefined) return null;
    const goal = await goals.getById(goalId);
    return goal !== null && goal.workspaceId === workspaceId && goal.status === 'active' ? goal.id : null;
  };

  return {
    countOpen: async (workspaceId: string): Promise<number> => goals.countWorkspaceGoalsForHost(workspaceId),
    preferred: validPreferred,
    listOpen: async (workspaceId: string): Promise<readonly WebGoalSummary[]> => (await goals.listWorkspaceGoalsForHost(workspaceId, 100)).map(toWebGoalSummary),
    continue: async (workspaceId: string, goalId: string): Promise<WebGoalSummary> => {
      const goal = await goals.getById(goalId);
      if (goal === null || goal.workspaceId !== workspaceId || goal.status !== 'active') {
        throw new Error('Open goal was not found in this workspace');
      }
      settings.set(USER_SETTING_KEYS.preferredWorkspaceGoals, serializeStringRecordSetting({
        ...preferredMap(),
        [workspaceId]: goal.id,
      }));
      return toWebGoalSummary(goal);
    },
  };
}

function toWebGoalSummary(goal: GoalRecord): WebGoalSummary {
  const completed = goal.plan.steps.filter((step) => step.status === 'completed').length;
  return {
    goalId: goal.id,
    goalKey: goal.goalKey,
    objective: goal.objective,
    status: 'active',
    currentPhase: goal.currentPhase,
    progress: { completed, total: goal.plan.steps.length },
    blockers: [...goal.blockers],
    nextAction: goal.nextAction,
    steps: goal.plan.steps.map((step) => ({ id: step.id, title: step.title, status: step.status })),
    updatedAt: goal.updatedAt,
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
