import {
  ok,
  err,
  appError,
  type GoalRecord,
  type GoalRuntimeProjection,
  type Result,
  type WorkspaceAdmissionReceipt,
} from '@unified-mpc/domain';
import {
  GitService,
  GoalRuntimeControlPlaneService,
  GoalWorkspaceTruthReader,
  JsonWorkspaceIndexStore,
  WorkspaceIndexService,
  WorkspaceSelectionService,
  workspaceSelectionReferences,
} from '@unified-mpc/application';
import {
  CANONICAL_LIFECYCLE_MAX_LIMIT,
  CANONICAL_STATUS_MAX_LIMIT,
  ControlPlaneServer,
  type CanonicalLifecycleProbe,
  type CanonicalStatusProbe,
  type ControlPlaneServerOptions,
  type GoalControlPort,
  type GoalRuntimeReadPort,
  type StorageDiagnosticsProbe,
  type WebGoalSummary,
  type WebWorkspaceCleanupEvaluation,
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
  type SecretStore,
  assertStorageIdentitySafe,
  SqliteDatabase,
  SqliteGoalRepository,
  SqliteGoalRuntimeEventRepository,
  SqliteGoalRuntimeSnapshotRepository,
  SqliteSettingsRepository,
  SqliteWorkspaceRepository,
} from '@unified-mpc/storage';
import {
  ArtifactQuarantineStore,
  CanonicalManifestStore,
  CanonicalRefStore,
  GcLeaseStore,
  GoalOverlayStore,
  IndexJobLedger,
  ProviderGenerationLedger,
  RevisionPinRegistry,
  WorkspaceService,
  boundCanonicalStatusReport,
  canonicalRevisionList,
  canonicalStatus,
  gcStatus,
  isMachineRootPath,
  isProjectWorkspace,
  workspaceLifecycleKind,
} from '@unified-mpc/workspace';
import { EXTENSIONS_SETTINGS_KEY, IdeSyncService, ensureExtensionsSettingsMigrated, parseExtensionsSettings, type ManagedPolicyRepairReport } from '@unified-mpc/extensions';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { CliServerHandle } from '../index.js';
import { reconcileProviderGenerations } from '../runtime/provider-generation-reconcile.js';
import { missingOptionValue, unexpectedOption } from './options.js';

export interface WebCommand {
  readonly kind: 'web';
  readonly port: number;
}

export interface WebRunResult {
  readonly handle: CliServerHandle;
  readonly url: string;
  /** Present when startup policy repair was requested; per-file failures are inside the report. */
  readonly policyRepair?: ManagedPolicyRepairReport;
  /**
   * Set when the repair pass itself could not run (for example a lock timeout).
   * The control plane still starts; the CLI reports this instead of dropping it.
   */
  readonly policyRepairError?: string;
}

/** `repairManagedPolicies` is opt-in so an embedded host never rewrites user files implicitly. */
export interface WebRunOptions {
  readonly port?: number;
  readonly repairManagedPolicies?: boolean;
}

export function parseWebArgs(args: readonly string[]): Result<WebCommand> {
  let port = 3000;

  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i]!;
    const value = args[i + 1];
    if (flag === '--port') {
      if (value === undefined) return missingOptionValue(flag);
      const parsedPort = Number.parseInt(value, 10);
      if (Number.isNaN(parsedPort) || parsedPort < 0 || parsedPort > 65535) {
        return err(appError('INVALID_INPUT', 'Port must be a valid number between 0 and 65535'));
      }
      port = parsedPort;
      i += 1;
    } else if (flag === '--host') {
      return err(appError('INVALID_INPUT', 'Web control plane binds to 127.0.0.1; --host is not supported'));
    } else {
      return unexpectedOption(flag);
    }
  }

  return ok({
    kind: 'web',
    port,
  });
}

export async function runWeb(
  options: WebRunOptions = {},
  serverOptions?: ControlPlaneServerOptions,
): Promise<Result<WebRunResult>> {
  try {
    const dataPath = resolveDataPath();
    assertStorageIdentitySafe(dataPath);
    const database = new SqliteDatabase(path.join(dataPath, 'unified-mpc.sqlite'));
    const settings = new SqliteSettingsRepository(database);
    const secretStore = serverOptions?.secretStore ?? new SecretToolSecretStore();
    const workspaceRepository = new SqliteWorkspaceRepository(database);
    const workspaceService = new WorkspaceService(workspaceRepository);
    const workspaceIndex = new WorkspaceIndexService(workspaceRepository, new JsonWorkspaceIndexStore(path.join(dataPath, 'workspace-index')));
    const providerGenerations = new ProviderGenerationLedger(path.join(dataPath, 'canonical'));
    const goalRepository = new SqliteGoalRepository(database);
    const goalRuntimeEvents = new SqliteGoalRuntimeEventRepository(database);
    const goalRuntimeSnapshots = new SqliteGoalRuntimeSnapshotRepository(database);
    const goalRuntimeRead: GoalRuntimeReadPort = serverOptions?.goalRuntimeRead ?? ((): GoalRuntimeReadPort => {
      const goalRuntimeProjection = createWebGoalRuntimeProjection(
        goalRepository,
        goalRuntimeSnapshots,
        goalRuntimeEvents,
        workspaceRepository,
      );
      return {
        listWorkspaceGoalRuntimeSnapshots: async (request) => goalRuntimeSnapshots.listWorkspaceGoalRuntimeSnapshots(request),
        replayWorkspaceGoalRuntimeEvents: async (request) => goalRuntimeEvents.replayWorkspaceGoalRuntimeEvents(request),
        replayGoalRuntimeEvents: async (request) => goalRuntimeEvents.replayGoalRuntimeEvents(request),
        readWorkspaceAdmissionProjection: async (workspaceId) => goalRuntimeProjection.readWorkspaceAdmissionProjection(workspaceId),
      };
    })();
    bootstrapNonSecretSettings(settings);
    // #4: the control plane rewrites and renders the persisted extensions
    // document, so reconcile the same store the server will read before it
    // exposes any policy surface.
    ensureExtensionsSettingsMigrated(serverOptions?.settingsRepository ?? settings, EXTENSIONS_SETTINGS_KEY);
    // #4 §4: an upgrade must not leave generated client policy artifacts
    // describing the retired mandatory child topology until someone presses
    // "Sync Policies". The control plane is the only entry point allowed to
    // repair host-global instruction files; per-session stdio hosts repair
    // their own workspace. Repair only rewrites an existing managed block and
    // never creates or appends one, so it cannot start instructing a client the
    // user never configured. A failed target is reported in the result, never
    // fatal: the control plane still starts.
    let policyRepair: ManagedPolicyRepairReport | undefined;
    let policyRepairError: string | undefined;
    if (options.repairManagedPolicies === true) {
      const repairSettings = parseExtensionsSettings((serverOptions?.settingsRepository ?? settings).get(EXTENSIONS_SETTINGS_KEY));
      // The control plane serves one configured root at a time, matching the
      // manual sync endpoint; other workspaces converge through their own
      // session startup repair. `ControlPlaneServer` defaults a missing root set
      // to `process.cwd()`, so mirror that instead of silently repairing no
      // workspace artifact at all.
      const repairWorkspaceRoot = serverOptions?.workspaceRoots?.[0] ?? process.cwd();
      const repaired = await new IdeSyncService({
        settings: repairSettings,
        workspaceRoot: repairWorkspaceRoot,
      }).repairManagedBlocks({ includeGlobalTargets: true });
      if (repaired.ok) policyRepair = repaired.value;
      else policyRepairError = repaired.error.message;
    }
    const lifecycleCandidates = await workspaceService.list();
    const protectedByOpenGoal: string[] = [];
    const goalRuntimeProjections = new Map<string, GoalRuntimeProjection>();
    for (const workspace of lifecycleCandidates) {
      if (await goalRepository.countWorkspaceGoalsForHost(workspace.id) > 0) protectedByOpenGoal.push(workspace.id);
      if (workspaceLifecycleKind(workspace) !== 'goal' || workspace.goalId === undefined) continue;
      const snapshot = await goalRuntimeSnapshots.getGoalRuntimeSnapshot(workspace.goalId);
      if (snapshot !== null) goalRuntimeProjections.set(workspace.goalId, snapshot.projection);
    }
    const lifecycle = await workspaceService.reconcileLifecycle({
      protectedWorkspaceIds: [
        ...workspaceSelectionReferences(settings.get(USER_SETTING_KEYS.httpWorkspaceSelection)),
        ...protectedByOpenGoal,
      ],
      goalRuntimeProjections,
    });
    if (!lifecycle.ok) throw new Error(lifecycle.error.message);
    // A registration can be archived outside the removal adapter (lifecycle
    // cleanup, --reset-workspaces, a crash between archive and release), and a
    // row left behind keeps pinning a manifest no workspace can use. A stale
    // pin is safe and the next start retries, so a cleanup failure must not
    // take the control plane down.
    const reconciled = await reconcileProviderGenerations(providerGenerations, workspaceService);
    if (reconciled.error !== undefined) {
      process.stderr.write(
        `Unified-MPC web: could not release orphaned provider generations: ${reconciled.error}\n`,
      );
    }
    const workspaceControl = createWorkspaceControl(
      workspaceRepository,
      workspaceService,
      settings,
      workspaceIndex,
      goalRuntimeSnapshots,
      providerGenerations,
    );
    const goalControl = createGoalControl(goalRepository, settings, workspaceControl.activate);
    const canonicalStatusProbe = serverOptions?.canonicalStatusProbe
      ?? createCanonicalStatusProbe(dataPath);
    const canonicalLifecycleProbe = serverOptions?.canonicalLifecycleProbe
      ?? createCanonicalLifecycleProbe(dataPath);
    const server = new ControlPlaneServer({
      ...serverOptions,
      port: options.port ?? 3000,
      dataDir: serverOptions?.dataDir ?? dataPath,
      settingsRepository: serverOptions?.settingsRepository ?? settings,
      secretStore,
      storageDiagnosticsProbe: serverOptions?.storageDiagnosticsProbe
        ?? createStorageDiagnosticsProbe(dataPath, database, settings, secretStore),
      canonicalStatusProbe,
      canonicalLifecycleProbe,
      workspaceControl: serverOptions?.workspaceControl ?? workspaceControl,
      goalControl: serverOptions?.goalControl ?? goalControl,
      goalRuntimeRead,
      closeSettings: (): void => {
        void workspaceIndex.close();
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
      ...(policyRepair === undefined ? {} : { policyRepair }),
      ...(policyRepairError === undefined ? {} : { policyRepairError }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(appError('INTERNAL_ERROR', `Failed to start control plane server: ${message}`));
  }
}

export function createWebGoalRuntimeProjection(
  goals: SqliteGoalRepository,
  snapshots: SqliteGoalRuntimeSnapshotRepository,
  events: SqliteGoalRuntimeEventRepository,
  workspaces: SqliteWorkspaceRepository,
): GoalRuntimeControlPlaneService {
  const workspaceTruth = new GoalWorkspaceTruthReader(workspaces, new GitService(workspaces));
  return new GoalRuntimeControlPlaneService(goals, snapshots, events, {
    workspaceTruth,
    workspaceAdmission: workspaceTruth,
    workspaceAdmissionReceipts: {
      getAdmissionReceipt: async (workspaceId): Promise<WorkspaceAdmissionReceipt | null> => {
        if (await workspaces.get(workspaceId) === null) return null;
        return workspaces.getAdmissionReceipt(workspaceId);
      },
    },
  });
}

export function createWorkspaceControl(
  workspaceRepository: SqliteWorkspaceRepository,
  workspaceService: WorkspaceService,
  settings: SqliteSettingsRepository,
  workspaceIndex: Pick<WorkspaceIndexService, 'forgetWorkspace'>,
  goalRuntimeSnapshots: Pick<SqliteGoalRuntimeSnapshotRepository, 'getGoalRuntimeSnapshot'>,
  providerGenerations: Pick<ProviderGenerationLedger, 'release'>,
): WorkspaceControlPort {
  const projectList = async (): Promise<readonly WebWorkspaceSummary[]> => (await workspaceService.list())
    .filter((workspace) => isProjectWorkspace(workspace)
      && !isMachineRootPath(workspace.realRootPath)
      && !isMachineRootPath(workspace.rootPath));
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
    cleanupEvaluations: async (): Promise<readonly WebWorkspaceCleanupEvaluation[]> => {
      const goalRuntimeProjections = new Map<string, GoalRuntimeProjection>();
      for (const workspace of await workspaceService.list()) {
        if (workspaceLifecycleKind(workspace) !== 'goal' || workspace.goalId === undefined) continue;
        const snapshot = await goalRuntimeSnapshots.getGoalRuntimeSnapshot(workspace.goalId);
        if (snapshot !== null) goalRuntimeProjections.set(workspace.goalId, snapshot.projection);
      }
      return unwrap(workspaceService.evaluateGoalWorkspaceCleanup({ goalRuntimeProjections }));
    },
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
      const existing = await workspaceRepository.get(workspaceId);
      if (existing === null) throw new Error('Workspace is not a registered project');
      const removed = await workspaceService.unregister(workspaceId);
      if (!removed.ok) throw new Error(removed.error.message);
      try {
        await workspaceIndex.forgetWorkspace(workspaceId);
        // A removed registration has no live provider generation, so releasing
        // its ledger row lets revision GC prune the manifest that generation was
        // built from. A failure restores the registration instead of reporting a
        // removal whose pin silently leaked.
        await providerGenerations.release(workspaceId);
      } catch (error: unknown) {
        await workspaceRepository.restore(existing.id, existing).catch(() => undefined);
        throw error;
      }
      const service = await selection();
      return service === null ? null : unwrap(service.list());
    },
  };
}

export function createGoalControl(
  goals: Pick<SqliteGoalRepository, 'countWorkspaceGoalsForHost' | 'listWorkspaceGoalsForHost' | 'getById'>,
  settings: Pick<SqliteSettingsRepository, 'get' | 'set'>,
  activateWorkspace?: (workspaceId: string) => Promise<WebWorkspaceSelectionSnapshot>,
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
      await activateWorkspace?.(workspaceId);
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

const STORAGE_DIAGNOSTIC_SETTING_KEYS = [
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

const STORAGE_DIAGNOSTIC_SECRET_KEYS = [
  'cloudflare_tunnel_token',
  'cloudflare_api_token',
] as const;

export const DEFAULT_CANONICAL_STATUS_LIMIT = 50;

/**
 * Defense in depth: the route validates too, but an embedded caller must not be
 * able to turn the card into an unbounded store read. Omitted, non-finite and
 * fractional values all resolve to a bounded integer inside 1..MAX.
 */
export function resolveCanonicalStatusLimit(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_CANONICAL_STATUS_LIMIT;
  return Math.min(Math.max(1, Math.trunc(requested)), CANONICAL_STATUS_MAX_LIMIT);
}

/**
 * Read-only canonical store projection for the dashboard (§11).
 *
 * The CLI owns the canonical stores; the control plane only projects the
 * report. Rooted at `<dataPath>/canonical`, the same layout `index status`
 * reads, so the dashboard and the CLI can never disagree about which store
 * they describe. The row projections are windowed so a long Goal history cannot
 * turn the card into an unbounded response; every count stays a full-store
 * count.
 */
export function createCanonicalStatusProbe(dataPath: string): CanonicalStatusProbe {
  const canonicalRoot = path.join(dataPath, 'canonical');
  return async (options) => {
    const limit = resolveCanonicalStatusLimit(options?.limit);
    const report = await canonicalStatus({
      refs: new CanonicalRefStore(canonicalRoot),
      manifests: new CanonicalManifestStore(canonicalRoot),
      pins: new RevisionPinRegistry(canonicalRoot),
      overlays: new GoalOverlayStore(canonicalRoot),
      quarantine: new ArtifactQuarantineStore(canonicalRoot),
      jobs: new IndexJobLedger(canonicalRoot),
    });
    return boundCanonicalStatusReport(report, limit);
  };
}

/**
 * Read-only canonical revision history and GC snapshot for the dashboard
 * (#210 §7).
 *
 * Same roots as `createCanonicalStatusProbe`, so the card and `index revision
 * list` / `index gc status` describe one store. `runWeb` already refuses to
 * start when `assertStorageIdentitySafe` throws, so this probe cannot run
 * against a drifted identity. Nothing here takes the GC lease, releases a
 * quarantine row or judges reachability; a due row is reported as due, never as
 * garbage.
 */
export const DEFAULT_CANONICAL_LIFECYCLE_LIMIT = 50;

/**
 * Defense in depth: the route validates too, but an embedded caller must not be
 * able to turn the card into an unbounded store read. Omitted, non-finite and
 * fractional values all resolve to a bounded integer inside 1..MAX.
 */
export function resolveCanonicalLifecycleLimit(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_CANONICAL_LIFECYCLE_LIMIT;
  return Math.min(Math.max(1, Math.trunc(requested)), CANONICAL_LIFECYCLE_MAX_LIMIT);
}

export function createCanonicalLifecycleProbe(dataPath: string): CanonicalLifecycleProbe {
  const canonicalRoot = path.join(dataPath, 'canonical');
  return async (options) => {
    const limit = resolveCanonicalLifecycleLimit(options?.limit);
    const [revisions, gc] = await Promise.all([
      canonicalRevisionList({
        refs: new CanonicalRefStore(canonicalRoot),
        manifests: new CanonicalManifestStore(canonicalRoot),
        pins: new RevisionPinRegistry(canonicalRoot),
        overlays: new GoalOverlayStore(canonicalRoot),
        jobs: new IndexJobLedger(canonicalRoot),
        providerGenerations: new ProviderGenerationLedger(canonicalRoot),
      }, { limit }),
      gcStatus(
        { quarantine: new ArtifactQuarantineStore(canonicalRoot), lease: new GcLeaseStore(canonicalRoot) },
        { now: new Date() },
      ),
    ]);
    return {
      revisions,
      gc: {
        ...gc,
        quarantine: {
          ...gc.quarantine,
          returned: Math.min(gc.quarantine.rows.length, limit),
          rows: gc.quarantine.rows.slice(0, limit),
        },
      },
    };
  };
}

function createStorageDiagnosticsProbe(
  dataPath: string,
  database: SqliteDatabase,
  settings: SqliteSettingsRepository,
  secretStore: SecretStore,
): StorageDiagnosticsProbe {
  const sqlitePath = path.join(dataPath, 'unified-mpc.sqlite');
  return async () => {
    const schemaRow = database.connection.prepare(
      'SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1',
    ).get();
    const schemaField = objectField(schemaRow, 'id');
    const schemaVersion = typeof schemaField === 'string' ? schemaField : null;
    const settingsCountRow = database.connection.prepare('SELECT COUNT(*) AS count FROM settings').get();
    const settingsCountField = objectField(settingsCountRow, 'count');
    const settingsRowCount = typeof settingsCountField === 'number'
      ? settingsCountField
      : typeof settingsCountField === 'bigint' ? Number(settingsCountField) : 0;
    const keyPresence = Object.fromEntries(
      STORAGE_DIAGNOSTIC_SETTING_KEYS.map((key) => [key, settings.get(key) !== null]),
    ) as Readonly<Record<string, boolean>>;
    const identity = secretStore.describe?.() ?? { provider: 'unknown', service: null };
    const secretPresence: Record<string, boolean | null> = Object.fromEntries(
      STORAGE_DIAGNOSTIC_SECRET_KEYS.map((key) => [key, null]),
    );
    let secretServiceAvailable = true;
    let secretServiceError: 'lookup_failed' | undefined;
    for (const key of STORAGE_DIAGNOSTIC_SECRET_KEYS) {
      try {
        secretPresence[key] = await secretStore.get(key) !== null;
      } catch {
        secretServiceAvailable = false;
        secretServiceError = 'lookup_failed';
      }
    }
    return {
      dataRoot: dataPath,
      sqlite: {
        path: sqlitePath,
        exists: existsSync(sqlitePath),
        schemaVersion,
        settingsRowCount,
        keyPresence,
      },
      secretService: {
        provider: identity.provider,
        service: identity.service,
        available: secretServiceAvailable,
        secretPresence,
        ...(secretServiceError === undefined ? {} : { error: secretServiceError }),
      },
    };
  };
}

function objectField(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;
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
