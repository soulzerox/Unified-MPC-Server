import fs from 'node:fs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {
  AgentSwarmService,
  CheckpointService,
  CodexService,
  FileService,
  GitService,
  AutomaticMergeReconciliationService,
  GuardedMergeService,
  MergeReconciliationService,
  ObservedMergeReconciliationService,
  GoalContinuationService,
  GoalRequestCancellationService,
  GoalTaskCancellationService,
  GoalMutationFenceService,
  GoalRuntimeControlPlaneService,
  GoalRuntimeReconciliationService,
  GoalWorkspaceService,
  GoalWorkspaceTruthReader,
  ManagedResourceRecoveryService,
  ScheduledContinuationService,
  ProcessService,
  ProjectService,
  ProjectSnapshotService,
  SearchService,
  WorkspaceInfoService,
  WorkspaceSelectionService,
  JsonWorkspaceIndexStore,
  WorkspaceIndexService,
  WorkspaceQueryService,
  ToolAvailabilityService,
  type FileActor,
} from '@unified-mpc/application';
import { AuditService, decodeActivityTargetReference } from '@unified-mpc/audit';
import {
  createPlatformCapabilitySet,
  type LocalCapabilityService,
  type ShellCapabilityBackend,
} from '@unified-mpc/capabilities';
import { ALLOW_AI_DELETE_SETTING_KEY, DESTRUCTIVE_AUTO_APPROVAL_SETTING_KEY, DEFAULT_CODEX_TOOLS_ENABLED, DEFAULT_MCP_CALL_TIMEOUT_MS, DEFAULT_MCP_IDLE_TIMEOUT_MS, DEFAULT_PROCESS_TIMEOUT_MS, DEFAULT_MCP_POLL_WAIT_SECONDS, DEFAULT_PONYTAIL_MODE, DEFAULT_SHELL_SYNCHRONOUS_WAIT_SECONDS, MAX_CONFIGURABLE_WAIT_SECONDS, MIN_CONFIGURABLE_WAIT_SECONDS, USER_SETTING_KEYS, parseBooleanSetting, parseCustomPermissionSettings, parseDestructiveAutoApprovalPolicy, parseIntegerSetting, parsePathList, parsePonytailMode, parseStringRecordSetting, type DestructiveAutoApprovalPolicy, type PonytailMode } from '@unified-mpc/shared';
import {
  EXTENSIONS_SETTINGS_KEY,
  InstallerService,
  createLocalExtensionsService,
  type ExtensionsService,
} from '@unified-mpc/extensions';
import { ActivityTracker, RuntimeGoalManagedTaskStateReader, SharedActivitySnapshotLease, composeActivitySinks, createFileActivitySink, currentSharedActivityOwner, mcpActivityLogPath, type ActivitySink, type ActivitySinkEvent, type McpApplicationServices, type WorkspaceScope } from '@unified-mpc/mcp-server';
import { permissionProfiles, type PermissionProfile, type PermissionProfileName } from '@unified-mpc/permissions';
import { ThaiRagProviderCoordinator, type ThaiRagProviderDriver } from '@unified-mpc/thai-rag';
import {
  AesGcmCheckpointCipher,
  SqliteAgentSwarmRepository,
  SqliteAuditRepository,
  SqliteCheckpointRepository,
  SqliteDatabase,
  SqliteGoalRepository,
  SqliteGoalRuntimeEventRepository,
  SqliteGoalRuntimeSnapshotRepository,
  SqliteManagedResourceBindingRepository,
  SqliteMergeReconciliationRepository,
  SqliteMergeVerificationReceiptRepository,
  SqliteSettingsRepository,
  SqliteWorkspaceRepository,
} from '@unified-mpc/storage';
import { SecretPolicy, WorkspacePathGuard, WorkspaceService, sharedProcessResourceAdmissionController, type Workspace } from '@unified-mpc/workspace';
import { appError, err, ok, type RepositoryMergePolicy, type WorkspaceAdmissionReceipt } from '@unified-mpc/domain';
import { NativeThaiRagProviderDriver } from './native-thai-rag-provider.js';
import { StrictWorkspaceRepository } from './strict-workspace-repository.js';
import { createGuardedMergeDispatchPort } from './guarded-merge-provider.js';
import { createGitHubApiReader, createGitHubMergeObservationPort } from './github-merge-observer.js';
import { createMergeVerificationRunPort } from './merge-verification-runner.js';
import { createRuntimePromotionTaskReconciliation } from './runtime-promotion-task-reconciliation.js';
import {
  createGitHubClosedPullRequestFeed,
  createSettingsMergeReconciliationPollStateStore,
  GitHubMergeReconciliationPoller,
} from './github-merge-reconciliation-poller.js';
import { parseRepositoryMergePoliciesSetting, parseRepositoryMergePolicySetting } from './merge-policy-settings.js';
import type { AuthorizationMode, UnifiedRuntimeAdmissionIdentity } from '@unified-mpc/mcp-server';

export interface StdioMcpRuntime {
  readonly runtimeAdmissionIdentity?: UnifiedRuntimeAdmissionIdentity;
  readonly services: McpApplicationServices;
  readonly actor: FileActor;
  readonly extensions: ExtensionsService;
  readonly activityTracker: ActivityTracker;
  readonly activityReady: Promise<void>;
  readonly recoveryReady: Promise<void>;
  readonly profileProvider: () => PermissionProfile;
  readonly authorizationModeProvider: () => AuthorizationMode;
  readonly allowAiDeleteProvider: () => boolean;
  readonly destructivePolicyProvider: () => DestructiveAutoApprovalPolicy;
  readonly activeWorkspaceScopeProvider: () => Promise<WorkspaceScope | null>;
  readonly activeWorkspaceScopesProvider: () => Promise<readonly WorkspaceScope[]>;
  readonly codexToolsEnabled: boolean;
  readonly ponytailMode: PonytailMode;
  readonly toolAvailabilityService: ToolAvailabilityService;
  readonly mergeReconciliationPoller: Pick<GitHubMergeReconciliationPoller, 'start' | 'close' | 'reconcileOnce'>;
  initializeThaiRag(): Promise<void>;
  close(): Promise<void>;
}

/** Builds stdio/CLI MCP services. Defaults stay full/unrestricted unless an explicit stdio policy constrains them. */
export interface StdioMcpRuntimeOptions {
  readonly runtimeAdmissionIdentity?: UnifiedRuntimeAdmissionIdentity;
  readonly permissionProfile?: PermissionProfileName;
  readonly strictAllowedRoots?: readonly string[];
  readonly fullBypassAll?: boolean;
  /** Live host setting for Trusted Full Bypass. When present it supersedes the static startup flag. */
  readonly fullBypassAllProvider?: () => boolean;
  /** Persist the HTTP active-project profile so WebUI/CLI changes are visible without restart. */
  readonly persistWorkspaceSelection?: boolean;
  /** Unified-owned Thai-RAG install root; repository MCP configs never supply this path. */
  readonly thaiRagProviderPath?: string;
  /** Test seam for the parent-owned provider worker. */
  readonly thaiRagDriver?: ThaiRagProviderDriver;
  readonly extensions?: ExtensionsService;
  /** Pure Node development only; packaged STDIO is hosted by Electron. */
  readonly checkpointEncryptionKey?: Uint8Array;
}

export function createStdioMcpRuntime(
  dataPath: string,
  workspace: Workspace,
  unrestricted: boolean = false,
  options: StdioMcpRuntimeOptions = {},
): StdioMcpRuntime {
  const databaseFilename = path.join(dataPath, 'unified-mpc.sqlite');
  const database = new SqliteDatabase(databaseFilename, { backupDirectory: path.join(dataPath, 'backups') });
  const resourceAdmissionController = sharedProcessResourceAdmissionController();
  const managedResourceBindings = new SqliteManagedResourceBindingRepository(database);
  const managedResourceRecovery = new ManagedResourceRecoveryService(
    managedResourceBindings,
    resourceAdmissionController,
  );
  const rawWorkspaceRepository = new SqliteWorkspaceRepository(database);
  const workspaceRepository = options.strictAllowedRoots === undefined
    ? rawWorkspaceRepository
    : new StrictWorkspaceRepository(rawWorkspaceRepository, options.strictAllowedRoots);
  const goalRepository = new SqliteGoalRepository(database);
  const workspaceIndex = new WorkspaceIndexService(workspaceRepository, new JsonWorkspaceIndexStore(path.join(dataPath, 'workspace-index')));
  const settingsRepository = new SqliteSettingsRepository(database);
  const workspaceSelection = new WorkspaceSelectionService(
    workspaceRepository,
    workspace.id,
    options.persistWorkspaceSelection === true
      ? {
          get: (): string | null => settingsRepository.get(USER_SETTING_KEYS.httpWorkspaceSelection),
          set: (value): void => settingsRepository.set(USER_SETTING_KEYS.httpWorkspaceSelection, value),
        }
      : undefined,
  );
  const activeWorkspaces = async (): Promise<readonly Workspace[]> => {
    const selected = await workspaceSelection.activeWorkspaces();
    if (selected.ok) return selected.value;
    if (selected.error.code === 'WORKSPACE_NOT_FOUND') return [];
    throw new Error(selected.error.message);
  };
  const primaryWorkspaceRoot = async (): Promise<string> => {
    const primary = (await activeWorkspaces())[0];
    if (primary === undefined) throw new Error('No active project workspace is available');
    return primary.realRootPath;
  };
  const thaiRagInstallRoot = path.resolve(
    options.thaiRagProviderPath?.trim()
      || settingsRepository.get(USER_SETTING_KEYS.thaiRagProviderPath)?.trim()
      || process.env.UNIFIED_MPC_THAI_RAG_PROVIDER_PATH?.trim()
      || path.join(os.homedir(), 'thai-rag-mcp'),
  );
  const thaiRagDriver = options.thaiRagDriver ?? new NativeThaiRagProviderDriver({
    dataRoot: dataPath,
    launchConfig: {
      command: process.platform === 'win32'
        ? path.join(thaiRagInstallRoot, 'venv', 'Scripts', 'python.exe')
        : path.join(thaiRagInstallRoot, 'venv', 'bin', 'python3'),
      args: [path.join(thaiRagInstallRoot, 'thai_rag_context_mcp.py')],
    },
    workspacesProvider: async (): Promise<readonly { id: string; rootPath: string; realRootPath: string }[]> => (await rawWorkspaceRepository.list())
      .map((entry) => ({ id: entry.id, rootPath: entry.rootPath, realRootPath: entry.realRootPath })),
    callTimeoutMs: parseIntegerSetting(settingsRepository.get(USER_SETTING_KEYS.mcpCallTimeoutMs), DEFAULT_MCP_CALL_TIMEOUT_MS, 1_000, 60 * 60_000),
  });
  const thaiRagCoordinator = new ThaiRagProviderCoordinator({
    dataRoot: dataPath,
    ownerId: `unified-mpc:${process.pid}`,
    providerVersion: '4.61.0',
    embeddingIndexGeneration: 1,
    driver: thaiRagDriver,
  });
  let thaiRagStart: ReturnType<ThaiRagProviderCoordinator['start']> | undefined;
  const ensureThaiRagStarted = (): ReturnType<ThaiRagProviderCoordinator['start']> => {
    thaiRagStart ??= thaiRagCoordinator.start();
    return thaiRagStart;
  };
  const thaiRagPort: NonNullable<McpApplicationServices['thaiRag']> = {
    async health(signal) {
      const started = await ensureThaiRagStarted();
      if (!started.ok) return { ok: false, error: started.error };
      return thaiRagCoordinator.health(signal);
    },
    async call(tool, args, signal, budget) {
      const started = await ensureThaiRagStarted();
      if (!started.ok) return { ok: false, error: started.error };
      return thaiRagCoordinator.call(tool, args, signal, budget);
    },
  };
  const initializeThaiRag = async (): Promise<void> => {
    const started = await ensureThaiRagStarted();
    if (!started.ok) throw new Error(started.error.message);
  };
  const toolAvailabilityService = new ToolAvailabilityService(settingsRepository);
  const stopToolAvailabilityWatch = toolAvailabilityService.watch(250);
  const auditRepository = new SqliteAuditRepository(database);
  const auditService = new AuditService(auditRepository);
  const checkpointKey = resolveStdioCheckpointKey(options.checkpointEncryptionKey, dataPath);
  const checkpointRepository = new SqliteCheckpointRepository(database, new AesGcmCheckpointCipher(checkpointKey));
  const workspaceService = new WorkspaceService(workspaceRepository);
  const profileName = options.permissionProfile ?? 'full';
  const activeProfile = profileName === 'custom' ? customPermissionProfile(settingsRepository) : permissionProfiles[profileName];
  const fullBypassAllProvider = (): boolean => profileName === 'full'
    && (options.fullBypassAllProvider?.() ?? options.fullBypassAll === true);
  const fullBypassAllAtStartup = fullBypassAllProvider();
  const strictRoots = options.strictAllowedRoots !== undefined && !fullBypassAllAtStartup;
  const effectiveUnrestricted = strictRoots ? false : unrestricted || fullBypassAllAtStartup;
  const profileProvider = (): PermissionProfile => activeProfile;
  const authorizationModeProvider = (): AuthorizationMode => fullBypassAllProvider() ? 'full_bypass' : 'standard';
  const destructivePolicyProvider = (): DestructiveAutoApprovalPolicy => parseDestructiveAutoApprovalPolicy(
    settingsRepository.get(DESTRUCTIVE_AUTO_APPROVAL_SETTING_KEY),
    parseBooleanSetting(settingsRepository.get(ALLOW_AI_DELETE_SETTING_KEY), false),
  );
  const allowAiDeleteProvider = (): boolean => fullBypassAllProvider() || destructivePolicyProvider().approvals.delete_file;

  const projectService = new ProjectService(workspaceRepository);
  const processService = new ProcessService(workspaceRepository, {
    projectService,
    profileProvider,
    defaultTimeoutMsProvider: (): number => parseIntegerSetting(settingsRepository.get(USER_SETTING_KEYS.processTimeoutMs), DEFAULT_PROCESS_TIMEOUT_MS, 1_000, 4 * 60 * 60_000),
    unrestricted: effectiveUnrestricted,
    authorizationBypassProvider: fullBypassAllProvider,
  });
  const checkpointService = new CheckpointService(workspaceRepository, checkpointRepository, {
    profile: activeProfile,
    platform: process.platform,
  });
  const pathGuard = new WorkspacePathGuard(new SecretPolicy(), { unrestricted: effectiveUnrestricted, trustedWorkspaceAccess: !strictRoots });
  const fileService = new FileService(workspaceRepository, pathGuard, undefined, {
    checkpointService,
    profileProvider,
    unrestricted: effectiveUnrestricted,
    trustedWorkspaceAccess: !strictRoots,
    allowDeleteWithoutConfirmation: allowAiDeleteProvider,
    protectCriticalFiles: (): boolean => !fullBypassAllProvider() && destructivePolicyProvider().protectCriticalFiles,
    recoverableDelete: (): boolean => destructivePolicyProvider().recoverableDelete,
    recoveryTrashRoot: path.join(dataPath, 'recovery-trash'),
  });
  const fileRecoveryReady = fileService.reconcileRecoveryItemsForWorkspace(workspace).then((result) => {
    if (!result.ok) throw new Error(result.error.message);
    const unsafe = result.value.entries.filter((entry) => entry.state !== 'moved');
    if (unsafe.length > 0) throw new Error(`Recovery reconciliation found unsafe entries: ${unsafe.length}`);
  });
  const gitService = new GitService(workspaceRepository);
  const workspaceQuery = new WorkspaceQueryService(workspaceRepository, pathGuard);
  const extensions = options.extensions ?? createLocalExtensionsService({
    settingsJsonProvider: (): string | null => settingsRepository.get(EXTENSIONS_SETTINGS_KEY),
    dataDir: dataPath,
    workspaceRootProvider: primaryWorkspaceRoot,
    callTimeoutMs: parseIntegerSetting(settingsRepository.get(USER_SETTING_KEYS.mcpCallTimeoutMs), DEFAULT_MCP_CALL_TIMEOUT_MS, 1_000, 60 * 60_000),
    idleTimeoutMs: parseIntegerSetting(settingsRepository.get(USER_SETTING_KEYS.mcpIdleTimeoutMs), DEFAULT_MCP_IDLE_TIMEOUT_MS, 30_000, 24 * 60 * 60_000),
  });
  const mergeReceiptRepository = new SqliteMergeVerificationReceiptRepository(database);
  const mergeReconciliationRepository = new SqliteMergeReconciliationRepository(database);
  const githubApi = createGitHubApiReader();
  const mergeObserver = createGitHubMergeObservationPort(githubApi);
  const mergeVerificationRun = createMergeVerificationRunPort({
    github: githubApi,
    receipts: mergeReceiptRepository,
    workspaces: workspaceRepository,
  });
  const mergeReconciliationCore = new MergeReconciliationService(
    mergeReceiptRepository,
    mergeReconciliationRepository,
  );
  const mergePolicy = {
    async getByRepository(repository: string): Promise<RepositoryMergePolicy | undefined> {
      return parseRepositoryMergePolicySetting(
        settingsRepository.get(USER_SETTING_KEYS.repositoryMergePolicies),
        repository,
      );
    },
  };
  const guardedMerge = new GuardedMergeService(
    mergeReceiptRepository,
    createGuardedMergeDispatchPort(
      extensions,
      () => settingsRepository.get(USER_SETTING_KEYS.guardedMergeProviderServer)?.trim() || 'github',
    ),
  );
  const mergeReconciliation = new ObservedMergeReconciliationService(
    mergeObserver,
    mergeReconciliationCore,
  );
  const automaticMergeReconciliation = new AutomaticMergeReconciliationService(
    mergeObserver,
    mergeReceiptRepository,
    mergeReconciliationCore,
  );
  const mergeReconciliationPoller = new GitHubMergeReconciliationPoller(
    () => {
      const configured = settingsRepository.get(USER_SETTING_KEYS.repositoryMergePolicies);
      if (configured === null || configured.trim().length === 0) return [];
      const policies = parseRepositoryMergePoliciesSetting(configured);
      if (policies === undefined) throw new Error('Configured repository merge policies are invalid');
      return policies;
    },
    createGitHubClosedPullRequestFeed(githubApi),
    createSettingsMergeReconciliationPollStateStore(settingsRepository),
    automaticMergeReconciliation,
  );
  const codexService = new CodexService(workspaceRepository, {
    auditService,
    profileProvider,
  });
  const capabilityRuntime = createStdioCapabilityService(dataPath, async () => (await activeWorkspaces()).map((entry) => entry.realRootPath), effectiveUnrestricted, options.strictAllowedRoots, () => parsePathList(settingsRepository.get(USER_SETTING_KEYS.capabilityRoots)),
  () => parseIntegerSetting(settingsRepository.get(USER_SETTING_KEYS.shellSynchronousWaitSeconds), DEFAULT_SHELL_SYNCHRONOUS_WAIT_SECONDS, MIN_CONFIGURABLE_WAIT_SECONDS, MAX_CONFIGURABLE_WAIT_SECONDS),
  createRuntimePromotionTaskReconciliation());
  const requestCancellation = new GoalRequestCancellationService();
  const goalRuntimeSnapshots = new SqliteGoalRuntimeSnapshotRepository(database);
  const goalRuntimeEvents = new SqliteGoalRuntimeEventRepository(database);
  const goalWorkspaceTruth = new GoalWorkspaceTruthReader(workspaceRepository, gitService);
  const goalRuntimeControlPlane = new GoalRuntimeControlPlaneService(
    goalRepository,
    goalRuntimeSnapshots,
    goalRuntimeEvents,
    {
      workspaceTruth: goalWorkspaceTruth,
      workspaceAdmission: goalWorkspaceTruth,
      workspaceAdmissionReceipts: {
        getAdmissionReceipt: async (workspaceId: string): Promise<WorkspaceAdmissionReceipt | null> => {
          if (await workspaceRepository.get(workspaceId) === null) return null;
          return rawWorkspaceRepository.getAdmissionReceipt(workspaceId);
        },
        compareAndSwapAdmissionReceipt: async (workspaceId, expectedGeneration, leaseGeneration, receipt): Promise<boolean> => {
          if (await workspaceRepository.get(workspaceId) === null) return false;
          return rawWorkspaceRepository.compareAndSwapAdmissionReceipt(workspaceId, expectedGeneration, leaseGeneration, receipt);
        },
      },
      ...(options.runtimeAdmissionIdentity === undefined ? {} : { runtimeAdmissionIdentity: options.runtimeAdmissionIdentity }),
    },
  );
  const goalWorkspaceService = new GoalWorkspaceService(workspaceRepository);
  const goalRunWorkspace: NonNullable<McpApplicationServices['goalRunWorkspace']> = {
    async resolveRunWorkspace(runActor, request) {
      const parent = await workspaceRepository.get(request.workspaceId);
      if (parent === null) return err(appError('WORKSPACE_NOT_FOUND', 'run_goal workspace was not found'));
      if (parent.lifecycleKind === 'goal') {
        if (parent.goalId === undefined) {
          return err(appError('CONFLICT', 'Goal Workspace registration is missing its goal identity', true));
        }
        return ok({ workspaceId: parent.id });
      }
      if (parent.lifecycleKind !== undefined && parent.lifecycleKind !== 'project') {
        return err(appError('INVALID_INPUT', 'run_goal requires a project or Goal Workspace'));
      }
      const legacy = await goalRepository.getByKey(parent.id, request.goalKey);
      if (legacy !== null) {
        return err(appError(
          'CONFLICT',
          'Existing durable goal is bound directly to the project workspace; reconcile or finish that legacy goal before starting a Goal Workspace run',
          true,
          { reason: 'legacy-project-goal-requires-reconciliation' },
        ));
      }
      const goalId = `goal-${createHash('sha256')
        .update([parent.id, request.goalKey].join('\0'))
        .digest('hex')
        .slice(0, 40)}`;
      const existing = (await workspaceRepository.list())
        .find((entry) => entry.lifecycleKind === 'goal'
          && entry.goalId === goalId
          && entry.parentWorkspaceId === parent.id);
      if (existing !== undefined) return ok({ workspaceId: existing.id });

      // A selected feature/detached worktree may contain commits not on origin/main.
      // Pin its exact committed head; only new goals on main use fresh origin/main.
      const currentBranch = await gitService.run(runActor, {
        workspaceId: parent.id,
        args: ['branch', '--show-current'],
      });
      if (!currentBranch.ok) return currentBranch;
      if (currentBranch.value.exitCode !== 0) {
        return err(appError('CONFLICT', 'Cannot identify project branch for Goal Workspace admission', true));
      }
      const branchName = currentBranch.value.stdout.trim();
      let baseRevision: string | undefined;
      if (branchName !== 'main' && branchName !== 'master') {
        const history = await gitService.log(runActor, parent.id, { maxCommits: 1 });
        if (!history.ok) return history;
        const head = history.value.entries[0]?.hash;
        if (head === undefined || !/^[0-9a-f]{40}$/.test(head)) {
          return err(appError('CONFLICT', 'Cannot pin the selected feature branch commit', true));
        }
        baseRevision = head;
      }
      const created = await goalWorkspaceService.create({
        goalId,
        parentWorkspaceId: parent.id,
        branchName: `goal/${goalId}`,
        ...(baseRevision === undefined ? {} : { baseRevision }),
        ...(runActor.sessionId === undefined ? {} : { ownerSessionId: runActor.sessionId }),
      });
      if (created.ok) return ok({ workspaceId: created.value.workspace.id });

      const raced = (await workspaceRepository.list())
        .find((entry) => entry.lifecycleKind === 'goal'
          && entry.goalId === goalId
          && entry.parentWorkspaceId === parent.id);
      return raced === undefined ? created : ok({ workspaceId: raced.id });
    },
    async admitRunWorkspace(runActor, request) {
      const goalWorkspace = await workspaceRepository.get(request.workspaceId);
      if (goalWorkspace === null
        || goalWorkspace.lifecycleKind !== 'goal'
        || goalWorkspace.goalId !== request.goalId) {
        return err(appError('WORKSPACE_ADMISSION_STALE', 'Durable goal does not own the requested Goal Workspace', true));
      }
      const ownerId = `${runActor.clientId}:${runActor.sessionId ?? 'sessionless'}`;
      const writer = await goalWorkspaceService.synchronizeWriterLease(
        request.goalId,
        ownerId,
        request.leaseGeneration,
        request.leaseExpiresAt,
      );
      if (!writer.ok) return writer;

      const bootstrapped = await goalRuntimeControlPlane.bootstrapWorkspace(request.workspaceId);
      if (bootstrapped.admission?.status !== 'ADMITTED'
        || bootstrapped.admission.admissionGeneration === undefined) {
        return err(appError(
          'WORKSPACE_ADMISSION_STALE',
          `Goal Workspace admission could not be established: ${bootstrapped.admission?.reason ?? 'admission-unavailable'}`,
          true,
        ));
      }
      return ok({ admissionGeneration: bootstrapped.admission.admissionGeneration });
    },
    async recoverRunWorkspace(runActor, request) {
      const goal = await goalRepository.getById(request.goalId);
      const actualDigest = createHash('sha256').update(request.leaseToken).digest();
      const expectedDigest = Buffer.from(goal?.leaseTokenHash ?? '', 'hex');
      if (goal === null
        || goal.status !== 'active'
        || goal.workspaceId !== request.workspaceId
        || goal.leaseGeneration !== request.leaseGeneration
        || goal.leaseOwnerClientId !== runActor.clientId
        || goal.leaseOwnerSessionId !== (runActor.sessionId?.trim() || runActor.clientId)
        || goal.leaseExpiresAt === undefined
        || Date.parse(goal.leaseExpiresAt) <= Date.now()
        || expectedDigest.length !== actualDigest.length
        || !timingSafeEqual(expectedDigest, actualDigest)) {
        return err(appError('PERMISSION_DENIED', 'Stale or invalid goal lease proof; admission retry rejected'));
      }
      const stagedRecovery = request.stagedRecovery;
      const unstagedRecovery = request.unstagedRecovery;
      if (stagedRecovery === undefined && unstagedRecovery === undefined) {
        return goalRunWorkspace.admitRunWorkspace(runActor, {
          workspaceId: request.workspaceId,
          goalId: request.goalId,
          leaseGeneration: request.leaseGeneration,
          leaseExpiresAt: goal.leaseExpiresAt ?? '',
        });
      }
      if (stagedRecovery !== undefined && unstagedRecovery !== undefined) {
        return err(appError('INVALID_INPUT', 'Use stagedRecovery or unstagedRecovery, not both'));
      }

      const recoveryKind = stagedRecovery !== undefined ? 'staged' : 'unstaged';
      const recovery = stagedRecovery ?? unstagedRecovery!;
      const goalWorkspace = await workspaceRepository.get(request.workspaceId);
      if (goalWorkspace === null || goalWorkspace.lifecycleKind !== 'goal'
        || goalWorkspace.goalId !== request.goalId || goalWorkspace.goalWorkspaceKind !== 'git_worktree') {
        return err(appError('WORKSPACE_ADMISSION_STALE', `${recoveryKind === 'staged' ? 'Staged' : 'Unstaged'} admission recovery requires the exact owned Git Goal Workspace`, true));
      }
      const ownerId = `${runActor.clientId}:${runActor.sessionId ?? 'sessionless'}`;
      const writer = await goalWorkspaceService.synchronizeWriterLease(
        request.goalId,
        ownerId,
        request.leaseGeneration,
        goal.leaseExpiresAt ?? '',
      );
      if (!writer.ok) return writer;

      const receipt = await rawWorkspaceRepository.getAdmissionReceipt(request.workspaceId);
      if (receipt === null
        || receipt.admissionGeneration !== recovery.expectedAdmissionGeneration
        || receipt.expectedWorkspaceHead !== recovery.expectedWorkspaceHead
        || receipt.observedWorkspaceHead !== recovery.expectedWorkspaceHead
        || receipt.goalId !== request.goalId
        || receipt.writeLeaseGeneration > request.leaseGeneration
        || receipt.invalidatedAt !== undefined) {
        return err(appError('WORKSPACE_ADMISSION_STALE', `${recoveryKind === 'staged' ? 'Staged' : 'Unstaged'} admission recovery no longer matches the prior owner admission receipt`, true));
      }

      const observed = await goalWorkspaceTruth.readAdmission(request.workspaceId);
      if (observed.workspaceKind !== 'git'
        || observed.workspaceHead !== recovery.expectedWorkspaceHead
        || observed.goalId !== request.goalId
        || observed.projectId !== receipt.projectId
        || observed.repositoryIdentity !== receipt.repositoryIdentity
        || observed.gitCommonDirIdentity !== receipt.gitCommonDirIdentity
        || observed.worktreeIdentity !== receipt.worktreeIdentity
        || observed.branchName !== receipt.branchName
        || observed.baseRef !== receipt.baseRef
        || observed.baseSha !== receipt.resolvedBaseSha
        || observed.mergeBaseSha !== receipt.mergeBaseSha
        || (observed.remoteGoalSha ?? undefined) !== receipt.remoteGoalSha
        || observed.writerLeaseGeneration !== request.leaseGeneration) {
        return err(appError('WORKSPACE_ADMISSION_STALE', `${recoveryKind === 'staged' ? 'Staged' : 'Unstaged'} admission recovery detected repository, branch, HEAD, base, or lease drift`, true));
      }

      const status = await gitService.status(runActor, request.workspaceId);
      if (!status.ok) return status;
      const changedEntries = recoveryKind === 'staged'
        ? status.value.entries.filter((entry) => entry.indexStatus !== ' ' && entry.indexStatus !== '?' && entry.indexStatus !== '!')
        : status.value.entries.filter((entry) => entry.worktreeStatus !== ' ' && entry.worktreeStatus !== '?' && entry.worktreeStatus !== '!');
      const expectedPathInput = recoveryKind === 'staged'
        ? stagedRecovery!.expectedStagedPaths
        : unstagedRecovery!.expectedUnstagedPaths;
      const exactModeOnly = changedEntries.length === status.value.entries.length
        && changedEntries.length > 0
        && changedEntries.every((entry) => recoveryKind === 'staged'
          ? entry.worktreeStatus === ' '
          : entry.indexStatus === ' ');
      const expectedPaths = [...new Set(expectedPathInput.map((entry) => entry.replaceAll('\\', '/')))].sort();
      const observedPaths = changedEntries.map((entry) => entry.path.replaceAll('\\', '/')).sort();
      if (!exactModeOnly || expectedPaths.length !== expectedPathInput.length
        || expectedPaths.length !== observedPaths.length
        || expectedPaths.some((entry, index) => entry !== observedPaths[index])) {
        return err(appError('WORKSPACE_ADMISSION_STALE',
          `${recoveryKind === 'staged' ? 'Staged' : 'Unstaged'} admission recovery paths do not exactly match the approved ${recoveryKind}-only delta`, true));
      }

      const diff = await gitService.diff(runActor, request.workspaceId, {
        ...(recoveryKind === 'staged' ? { staged: true } : {}),
        maxBytes: 1024 * 1024,
      });
      if (!diff.ok) return diff;
      if (diff.value.truncated) {
        return err(appError('WORKSPACE_ADMISSION_STALE',
          `${recoveryKind === 'staged' ? 'Staged' : 'Unstaged'} admission recovery diff exceeded the bounded verification budget`, true));
      }
      const diffSha256 = createHash('sha256').update(diff.value.patch).digest('hex');
      const expectedDiffSha256 = recoveryKind === 'staged'
        ? stagedRecovery!.expectedStagedDiffSha256
        : unstagedRecovery!.expectedUnstagedDiffSha256;
      if (!timingSafeEqual(
        Buffer.from(diffSha256, 'hex'),
        Buffer.from(expectedDiffSha256.toLowerCase(), 'hex'),
      )) {
        return err(appError('WORKSPACE_ADMISSION_STALE',
          `${recoveryKind === 'staged' ? 'Staged' : 'Unstaged'} admission recovery diff hash does not match the approved delta`, true));
      }

      let recoveredGeneration: number;
      try {
        recoveredGeneration = recoveryKind === 'staged'
          ? await goalRuntimeControlPlane.recoverStagedWorkspaceAdmission({
              callId: `staged-recovery:${diffSha256}`,
              workspaceId: request.workspaceId,
              goalId: request.goalId,
              leaseGeneration: request.leaseGeneration,
              admissionGeneration: recovery.expectedAdmissionGeneration,
              expectedWorkspaceHead: recovery.expectedWorkspaceHead,
              expectedStagedFingerprint: observed.stagedFingerprint ?? '',
            })
          : await goalRuntimeControlPlane.recoverUnstagedWorkspaceAdmission({
              callId: `unstaged-recovery:${diffSha256}`,
              workspaceId: request.workspaceId,
              goalId: request.goalId,
              leaseGeneration: request.leaseGeneration,
              admissionGeneration: recovery.expectedAdmissionGeneration,
              expectedWorkspaceHead: recovery.expectedWorkspaceHead,
              expectedDirtyFingerprint: observed.dirtyFingerprint ?? '',
              expectedStagedFingerprint: observed.stagedFingerprint ?? '',
            });
      } catch {
        return err(appError('WORKSPACE_ADMISSION_STALE',
          `${recoveryKind === 'staged' ? 'Staged' : 'Unstaged'} admission recovery lost its exact owner/source proof or durable compare-and-swap`, true));
      }
      const recoveredReceipt = await rawWorkspaceRepository.getAdmissionReceipt(request.workspaceId);
      const recoveredFingerprintMatches = recoveryKind === 'staged'
        ? recoveredReceipt?.stagedFingerprint === observed.stagedFingerprint
        : recoveredReceipt?.dirtyFingerprint === observed.dirtyFingerprint
          && recoveredReceipt?.stagedFingerprint === observed.stagedFingerprint;
      if (recoveredReceipt === null
        || recoveredReceipt.admissionGeneration !== recoveredGeneration
        || recoveredGeneration !== recovery.expectedAdmissionGeneration + 1
        || recoveredReceipt.expectedWorkspaceHead !== recovery.expectedWorkspaceHead
        || !recoveredFingerprintMatches
        || recoveredReceipt.writeLeaseGeneration !== request.leaseGeneration
        || recoveredReceipt.runtimeGeneration !== options.runtimeAdmissionIdentity?.runtimeGeneration) {
        return err(appError('WORKSPACE_ADMISSION_STALE',
          `${recoveryKind === 'staged' ? 'Staged' : 'Unstaged'} admission recovery receipt could not be verified after capture`, true));
      }
      return ok({ admissionGeneration: recoveredGeneration });
    },
  };

  const agentSwarmService = new AgentSwarmService(
    new SqliteAgentSwarmRepository(database),
    codexService,
    undefined,
    undefined,
    {
      resourceAdmissionController,
      managedResourceBindings,
      workspaceAdmissionProjection: goalRuntimeControlPlane,
    },
  );
  const taskCancellation = new GoalTaskCancellationService([
    { provider: 'process', cancelForGoal: processService.cancelForGoal.bind(processService) },
    { provider: 'codex', cancelForGoal: codexService.cancelForGoal.bind(codexService) },
    { provider: 'shell', cancelForGoal: capabilityRuntime.shell.cancelForGoal.bind(capabilityRuntime.shell) },
    { provider: 'agent_swarm', cancelForGoal: agentSwarmService.cancelForGoal.bind(agentSwarmService) },
  ]);
  const goalMutationFence = new GoalMutationFenceService(goalRepository, {
    taskStateReader: new RuntimeGoalManagedTaskStateReader({
      process: processService,
      codex: codexService,
      shell: capabilityRuntime.shell,
      agentSwarm: agentSwarmService,
    }),
    runtimeEvents: goalRuntimeControlPlane,
    validateAdmission: goalRuntimeControlPlane.validateWorkspaceAdmission.bind(goalRuntimeControlPlane),
    recordSuccessfulMutation: goalRuntimeControlPlane.recordSuccessfulWorkspaceMutation.bind(goalRuntimeControlPlane),
  });
  const goalService = new GoalContinuationService(workspaceRepository, goalRepository, {
    scheduledContinuations: goalRepository,
    workerLiveness: goalMutationFence,
    taskCancellation,
    requestCancellation,
    goalExecutions: goalRepository,
    executionCancellation: goalRepository,
    runtimeEvents: goalRuntimeControlPlane,
  });
  const scheduledContinuationService = new ScheduledContinuationService(goalRepository, {
    workerLiveness: goalMutationFence,
    workspaceIsActive: async (workspaceId: string): Promise<boolean> => (await workspaceRepository.get(workspaceId)) !== null,
  });
  const goalRuntimeReconciliation = new GoalRuntimeReconciliationService(
    goalRepository,
    goalRuntimeSnapshots,
    goalRuntimeEvents,
    goalRepository,
    goalMutationFence,
  );
  const goalRuntimeRecoveryReady = (async (): Promise<void> => {
    // Runtime reconciliation is registration-scoped, never Web selection/default scoped.
    // A project may keep durable work running while it is outside the current UI context.
    for (const registeredWorkspace of await rawWorkspaceRepository.list()) {
      await goalRuntimeControlPlane.bootstrapWorkspace(registeredWorkspace.id);
      await goalRuntimeReconciliation.reconcileWorkspace(registeredWorkspace.id);
    }
  })();
  const managedResourceRecoveryReady = managedResourceRecovery.start().then(() => undefined);
  const recoveryReady = Promise.all([
    fileRecoveryReady,
    goalRuntimeRecoveryReady,
    managedResourceRecoveryReady,
  ]).then(() => undefined);
  const actor: FileActor = { clientId: 'cli-mcp-stdio', clientName: 'Unified-MPC-Server CLI' };
  const sharedActivityLease = createSharedActivityLease(process.env.TUNNEL_CLIENT_PROFILE_DIR);
  const activityReady = sharedActivityLease.then(async (lease) => lease?.initialize());
  const sharedActivitySink: ActivitySink = {
    async record(event: ActivitySinkEvent): Promise<void> {
      await (await sharedActivityLease)?.record(event);
    },
  };
  const durableActivitySink = createFileActivitySink(mcpActivityLogPath(dataPath));
  const activityTracker = new ActivityTracker({
    async record(event: ActivitySinkEvent): Promise<void> {
      // Publish starts before slower durable evidence so updater quiet-time
      // cannot overlap a newly accepted remote call. Publish completion last.
      await composeActivitySinks(event.phase === 'started'
        ? [sharedActivitySink, durableActivitySink]
        : [durableActivitySink, sharedActivitySink]).record(event);
    },
  }, undefined, {
    async record(event: ActivitySinkEvent, detail): Promise<void> {
      await auditService.recordMcpTool({
        actorId: actor.clientId,
        actorName: actor.clientName,
        ...(event.workspaceId === undefined ? {} : { workspaceId: event.workspaceId }),
        ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
        toolName: event.toolName,
        callId: event.callId,
        phase: event.phase,
        ...(event.targetSummary === undefined ? {} : { targetSummary: event.targetSummary }),
        targetDetail: event.targetDetail ?? decodeActivityTargetReference(undefined, event.targetSummary),
        ...(detail === undefined ? {} : { activityTargetDetail: detail }),
        resultCode: event.resultCode,
        ...(event.resultMessage === undefined ? {} : { resultMessage: event.resultMessage }),
        ...(event.traceId === undefined ? {} : { traceId: event.traceId }),
        ...(event.traceParent === undefined ? {} : { traceParent: event.traceParent }),
        ...(event.authorizationMode === undefined ? {} : { authorizationMode: event.authorizationMode }),
        durationMs: event.durationMs,
        timestamp: event.timestamp,
      });
    },
  });
  const services: McpApplicationServices = {
    platform: process.platform,
    runtimeStatePath: path.join(dataPath, 'upgrade-runtime.json'),
    runtimeTiming: () => ({
      mcpPollWaitSeconds: parseIntegerSetting(settingsRepository.get(USER_SETTING_KEYS.mcpPollWaitSeconds), DEFAULT_MCP_POLL_WAIT_SECONDS, MIN_CONFIGURABLE_WAIT_SECONDS, MAX_CONFIGURABLE_WAIT_SECONDS),
    }),
    runtimeDiagnostics: () => ({ toolAvailabilitySubscriptions: toolAvailabilityService.listenerCount() }),
    localProviders: () => ({
      ...(settingsRepository.get(USER_SETTING_KEYS.pdfProviderPath)?.trim() ? { pdfProvider: settingsRepository.get(USER_SETTING_KEYS.pdfProviderPath)!.trim() } : {}),
      lspCommands: parseStringRecordSetting(settingsRepository.get(USER_SETTING_KEYS.lspCommands)),
    }),
    capabilities: capabilityRuntime.service,
    extensions,
    mergePolicy,
    mergeVerificationRun,
    guardedMerge,
    mergeReconciliation,
    thaiRag: thaiRagPort,
    installer: {
      installSkill: async (input) => new InstallerService({ workspaceRoot: await primaryWorkspaceRoot(), dataDir: dataPath }).installSkill(input),
      installServer: async (input) => new InstallerService({ workspaceRoot: await primaryWorkspaceRoot(), dataDir: dataPath }).installServer(input),
    },
    workspaceInfo: new WorkspaceInfoService(workspaceRepository, workspaceService, effectiveUnrestricted),
    workspaceAdmissionProjection: goalRuntimeControlPlane,
    goalRunWorkspace,
    workspaceSelection,
    preferredGoal: {
      get: async (workspaceId) => {
        const goalId = parseStringRecordSetting(settingsRepository.get(USER_SETTING_KEYS.preferredWorkspaceGoals))[workspaceId.toLowerCase()];
        if (goalId === undefined) return null;
        const goal = await goalRepository.getById(goalId);
        if (goal === null || goal.workspaceId !== workspaceId || goal.status !== 'active') return null;
        return {
          goalId: goal.id,
          goalKey: goal.goalKey,
          objective: goal.objective,
          currentPhase: goal.currentPhase,
          updatedAt: goal.updatedAt,
        };
      },
    },
    workspaceQuery,
    projectSnapshot: new ProjectSnapshotService(workspaceRepository, {
      projectService,
      gitService,
      workspaceQuery,
      processService,
    }),
    project: projectService,
    file: fileService,
    checkpoint: checkpointService,
    managedResourceBindings,
    goals: goalService,
    goalRequestCancellation: requestCancellation,
    scheduledContinuations: scheduledContinuationService,
    goalMutationFence,
    search: new SearchService(workspaceRepository),
    workspaceIndex,
    git: gitService,
    process: processService,
    codex: codexService,
    agentSwarm: agentSwarmService,
  };

  return {
    ...(options.runtimeAdmissionIdentity === undefined ? {} : { runtimeAdmissionIdentity: options.runtimeAdmissionIdentity }),
    services,
    actor,
    extensions,
    activityTracker,
    activityReady,
    recoveryReady,
    profileProvider,
    authorizationModeProvider,
    allowAiDeleteProvider,
    destructivePolicyProvider,
    activeWorkspaceScopeProvider: async (): Promise<WorkspaceScope | null> => {
      const selected = (await activeWorkspaces())[0];
      if (selected === undefined) return null;
      const current = rawWorkspaceRepository.getAny === undefined
        ? await rawWorkspaceRepository.get(selected.id)
        : await rawWorkspaceRepository.getAny(selected.id);
      if (current === null) return null;
      if (current.archivedAt !== undefined && current.archivedAt !== null) return null;
      return { workspaceId: current.id, rootPath: current.rootPath };
    },
    activeWorkspaceScopesProvider: async (): Promise<readonly WorkspaceScope[]> => (await activeWorkspaces())
      .map((selected) => ({ workspaceId: selected.id, rootPath: selected.rootPath })),
    codexToolsEnabled: parseBooleanSetting(settingsRepository.get(USER_SETTING_KEYS.codexToolsEnabled), DEFAULT_CODEX_TOOLS_ENABLED),
    ponytailMode: parsePonytailMode(settingsRepository.get(USER_SETTING_KEYS.ponytailMode), DEFAULT_PONYTAIL_MODE),
    toolAvailabilityService,
    mergeReconciliationPoller,
    initializeThaiRag,
    close: async (): Promise<void> => {
      stopToolAvailabilityWatch();
      await recoveryReady.catch(() => undefined);
      managedResourceRecovery.close();
      mergeReconciliationPoller.close();
      await thaiRagCoordinator.close().catch(() => undefined);
      await (await sharedActivityLease)?.close();
      await extensions.close().catch(() => undefined);
      await workspaceIndex.close().catch(() => undefined);
      database.close();
    },
  };
}

export function resolveStdioCheckpointKey(configured: Uint8Array | undefined = undefined, dataPath?: string): Buffer {
  if (configured !== undefined) {
    if (configured.byteLength !== 32) throw new Error('Stdio checkpoint encryption key must be 32 bytes');
    return Buffer.from(configured);
  }
  const encoded = process.env.UNIFIED_MPC_CHECKPOINT_KEY_BASE64?.trim()
    ?? process.env.UNIFIED_MPC_CHECKPOINT_KEY_BASE64?.trim();
  if (encoded !== undefined && encoded.length > 0) {
    const key = Buffer.from(encoded, 'base64');
    if (key.byteLength !== 32 || key.toString('base64') !== encoded) throw new Error('UNIFIED_MPC_CHECKPOINT_KEY_BASE64 must decode to 32 bytes');
    return key;
  }
  // Pure Node Linux headless execution: auto-generate or load key from dataPath/.checkpoint-key
  if (dataPath !== undefined) {
    const keyFilePath = path.join(dataPath, '.checkpoint-key');
    try {
      if (fs.existsSync(keyFilePath)) {
        const existing = fs.readFileSync(keyFilePath);
        if (existing.byteLength === 32) return existing;
      }
      const generated = randomBytes(32);
      fs.mkdirSync(dataPath, { recursive: true });
      fs.writeFileSync(keyFilePath, generated, { mode: 0o600 });
      return generated;
    } catch {
      return randomBytes(32);
    }
  }
  return randomBytes(32);
}

function customPermissionProfile(settingsRepository: SqliteSettingsRepository): PermissionProfile {
  const custom = parseCustomPermissionSettings(settingsRepository.get(USER_SETTING_KEYS.customPermissionProfile));
  return {
    name: 'custom',
    defaults: { READ: custom.read, WRITE: custom.write, EXECUTE: custom.execute, DANGEROUS: custom.dangerous },
    allowedProjectExecutables: [...new Set([...permissionProfiles.custom.allowedProjectExecutables, ...custom.allowedExecutables])],
  };
}

async function createSharedActivityLease(profileDirectory: string | undefined): Promise<SharedActivitySnapshotLease | null> {
  if (profileDirectory === undefined || profileDirectory.trim().length === 0) return null;
  return new SharedActivitySnapshotLease({ profileDirectory: path.resolve(profileDirectory), owner: await currentSharedActivityOwner() });
}

interface StdioCapabilityRuntime {
  readonly service: LocalCapabilityService;
  readonly shell: ShellCapabilityBackend;
}

function createStdioCapabilityService(
  dataPath: string,
  workspaceRootsProvider: () => Promise<readonly string[]>,
  unrestricted: boolean,
  strictAllowedRoots?: readonly string[],
  configuredRootsProvider: () => readonly string[] = () => [],
  synchronousWaitSecondsProvider: () => number = () => DEFAULT_SHELL_SYNCHRONOUS_WAIT_SECONDS,
  durableTaskReconciliation = createRuntimePromotionTaskReconciliation(),
): StdioCapabilityRuntime {
  const runtime = createPlatformCapabilitySet({
    platform: process.platform,
    dataPath,
    workspaceRootsProvider,
    unrestricted,
    configuredRootsProvider: () => strictAllowedRoots ?? [...readCapabilityRoots(process.env.UNIFIED_MPC_CAPABILITY_ROOTS), ...configuredRootsProvider()],
    synchronousWaitSecondsProvider,
    durableTaskReconciliation,
  });
  return { service: runtime.service, shell: runtime.shell };
}

function readCapabilityRoots(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim().length === 0) return [];
  return value.split(path.delimiter).map((root) => root.trim()).filter((root) => root.length > 0).map((root) => path.resolve(root));
}
