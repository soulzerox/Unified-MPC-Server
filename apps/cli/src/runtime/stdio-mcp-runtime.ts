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
  HeavyJobQueueRecoveryService,
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
  type GoalRelocationHostFence,
  GoalWorkspaceCustodyAttestationService,
  GoalWorkspaceRelocationOrchestrator,
  type GoalRelocationCustodyPin,
  GoalWorkspaceRetentionEvidenceSealingService,
  createGoalWorktreeReconciliationPort,
  type GoalCanonicalAdmissionOutcome,
  type GoalWorktreeClassificationReport,
} from '@unified-mpc/application';
import { GitAdapter, type GitPublishCredentialDeployment } from '@unified-mpc/git';
import { AuditService, decodeActivityTargetReference } from '@unified-mpc/audit';
import {
  createPlatformCapabilitySet,
  type LocalCapabilityService,
  type ShellCapabilityBackend,
} from '@unified-mpc/capabilities';
import { ALLOW_AI_DELETE_SETTING_KEY, DESTRUCTIVE_AUTO_APPROVAL_SETTING_KEY, DEFAULT_CODEX_TOOLS_ENABLED, DEFAULT_MCP_CALL_TIMEOUT_MS, DEFAULT_MCP_IDLE_TIMEOUT_MS, DEFAULT_PROCESS_TIMEOUT_MS, DEFAULT_MCP_POLL_WAIT_SECONDS, DEFAULT_PONYTAIL_MODE, DEFAULT_SHELL_SYNCHRONOUS_WAIT_SECONDS, MAX_CONFIGURABLE_WAIT_SECONDS, MIN_CONFIGURABLE_WAIT_SECONDS, USER_SETTING_KEYS, parseBooleanSetting, parseCustomPermissionSettings, parseDestructiveAutoApprovalPolicy, parseIntegerSetting, parsePathList, parsePonytailMode, parseStringRecordSetting, type DestructiveAutoApprovalPolicy, type PonytailMode } from '@unified-mpc/shared';
import {
  EXTENSIONS_SETTINGS_KEY,
  IdeSyncService,
  InstallerService,
  createLocalExtensionsService,
  ensureExtensionsSettingsMigrated,
  parseExtensionsSettings,
  type ExtensionsService,
  type ManagedPolicyRepairReport,
} from '@unified-mpc/extensions';
import { ActivityTracker, RuntimeGoalManagedTaskStateReader, SharedActivitySnapshotLease, composeActivitySinks, createFileActivitySink, createGoalWorktreeLedgerReader, currentSharedActivityOwner, mcpActivityLogPath, type ActivitySink, type ActivitySinkEvent, type McpApplicationServices, type WorkspaceScope, type WorkspaceScopeUnavailable } from '@unified-mpc/mcp-server';
import { permissionProfiles, type PermissionProfile, type PermissionProfileName } from '@unified-mpc/permissions';
import {
  ThaiRagIndexJobStore,
  ThaiRagProviderCoordinator,
  THAI_RAG_DEPLOYMENT_EMBEDDING_PROFILE,
  type ThaiRagProviderDriver,
} from '@unified-mpc/thai-rag';
import {
  AesGcmCheckpointCipher,
  SecretToolSecretStore,
  SqliteAgentSwarmRepository,
  SqliteAuditRepository,
  SqliteCheckpointRepository,
  SqliteDatabase,
  SqliteGoalRepository,
  SqliteGoalRelocationApprovalRepository,
  SqliteGoalWorkspaceRetentionCustodyRepository,
  SqliteGoalWorkspaceRetentionEvidenceRepository,
  SqliteGoalWorkspaceTransferRepository,
  SqliteGoalRuntimeEventRepository,
  SqliteGoalRuntimeSnapshotRepository,
  SqliteHeavyJobQueueRepository,
  SqliteManagedResourceBindingRepository,
  SqliteMergeReconciliationRepository,
  SqliteMergeVerificationAttemptRepository,
  SqliteMergeVerificationReceiptRepository,
  SqlitePublishApprovalRepository,
  SqlitePublishCredentialRepository,
  SqliteSettingsRepository,
  SqliteWorkspaceRepository,
  assertStorageIdentitySafe,
} from '@unified-mpc/storage';
import { ArtifactQuarantineStore, CanonicalManifestStore, CanonicalRefStore, GcLeaseStore, GoalOverlayStore, IndexJobLedger, ProviderGenerationLedger, RevisionPinRegistry, SecretPolicy, WorkspacePathGuard, WorkspaceService, boundCanonicalStatusReport, canonicalRevisionList, canonicalStatus, gcStatus, pinGoalBaseAtCommit, sharedProcessResourceAdmissionController, type Workspace } from '@unified-mpc/workspace';
import { appError, err, ok, type GoalRecord, type RepositoryMergePolicy, type Result, type WorkspaceAdmissionReceipt, type WorkspaceSourceEvidenceIdentity } from '@unified-mpc/domain';
import {
  DEFAULT_INDEX_STATUS_TIMEOUT_MS,
  DEFAULT_INDEX_STATUS_TIMEOUT_POLLS,
  NativeThaiRagProviderDriver,
  codeIndexVectorsFromEnv,
  type NativeThaiRagWorkspace,
} from './native-thai-rag-provider.js';
import { createStrictThaiRagGoalAdmissionProvider } from './native-thai-rag-goal-admission.js';
import { DEFAULT_THAI_RAG_CONNECT_BUDGET_SECONDS, DEFAULT_THAI_RAG_RESPONSE_BUDGET_SECONDS } from './thai-rag-call-budget.js';
import { resolveGoalBaseBranch, resolveGoalRepositoryIds } from './canonical-git-source.js';
import { CrossProcessWorkspaceAuthorityWatcher, LocalWorkspaceAuthorityEpoch } from './workspace-authority-epoch.js';
import { StrictWorkspaceRepository } from './strict-workspace-repository.js';
import {
  createBuiltinGuardedMergeDispatchPort,
  createGitHubMergeApi,
  createGuardedMergeDispatchPort,
  resolveGuardedMergeProviderServer,
  type GitHubMergeApi,
} from './guarded-merge-provider.js';
import { createGitHubApiReader, createGitHubMergeObservationPort, type GitHubApiReader } from './github-merge-observer.js';
import { canonicalRefForBranch, createCanonicalMergeAdvance } from './canonical-merge-advance.js';
import { createMergeVerificationRunPort } from './merge-verification-runner.js';
import { createMergeVerificationStatusPort } from './merge-verification-status.js';
import { projectIndexJobHistory } from './index-job-history-projection.js';
import { createRuntimePromotionTaskReconciliation } from './runtime-promotion-task-reconciliation.js';
import {
  createShellHeavyAdmissionPort,
  resolveShellHeavyAdmissionPerWorkspaceLimit,
} from './shell-heavy-admission.js';
import {
  createGitHubClosedPullRequestFeed,
  createSettingsMergeReconciliationPollStateStore,
  GitHubMergeReconciliationPoller,
} from './github-merge-reconciliation-poller.js';
import { parseRepositoryMergePoliciesSetting, parseRepositoryMergePolicySetting } from './merge-policy-settings.js';
import { startPublishCredentialSweep } from './publish-credential-sweep.js';
import { resolvePublishCredentialDeployment } from '../commands/publish-credential.js';
import type { AuthorizationMode, UnifiedRuntimeAdmissionIdentity, HostMutationApprovalRequest } from '@unified-mpc/mcp-server';
import { createTrustedGoalRelocationHostFence, type TrustedGoalRelocationHostActor } from './goal-relocation-host-fence.js';

export interface StdioMcpRuntime {
  readonly runtimeAdmissionIdentity?: UnifiedRuntimeAdmissionIdentity;
  readonly services: McpApplicationServices;
  readonly goalRelocationHostFence: GoalRelocationHostFence;
  /** Not installed without trusted native-host actor and exact-action approval. */
  readonly goalCustodyAttestation?: GoalWorkspaceCustodyAttestationService;
  readonly goalWorkspaceRelocation?: GoalWorkspaceRelocationOrchestrator;
  readonly goalRetentionEvidenceSealing?: GoalWorkspaceRetentionEvidenceSealingService;
  readonly actor: FileActor;
  readonly extensions: ExtensionsService;
  /**
   * #4 §4: one-shot repair of generated workspace policy artifacts that still
   * describe the retired mandatory child topology. Global instruction files are
   * never touched here; the long-lived control plane owns those. `close()`
   * awaits the same promise, so a host can also observe the report directly.
   */
  readonly managedPolicyRepairReady: Promise<ManagedPolicyRepairReport | undefined>;
  readonly activityTracker: ActivityTracker;
  readonly activityReady: Promise<void>;
  readonly recoveryReady: Promise<void>;
  readonly profileProvider: () => PermissionProfile;
  readonly authorizationModeProvider: () => AuthorizationMode;
  readonly allowAiDeleteProvider: () => boolean;
  readonly destructivePolicyProvider: () => DestructiveAutoApprovalPolicy;
  readonly activeWorkspaceScopeProvider: () => Promise<WorkspaceScope | null>;
  readonly activeWorkspaceScopeUnavailableProvider: () => Promise<WorkspaceScopeUnavailable | null>;
  readonly activeWorkspaceScopesProvider: () => Promise<readonly WorkspaceScope[]>;
  readonly codexToolsEnabled: boolean;
  readonly ponytailMode: PonytailMode;
  readonly toolAvailabilityService: ToolAvailabilityService;
  readonly mergeReconciliationPoller: Pick<GitHubMergeReconciliationPoller, 'start' | 'close' | 'reconcileOnce'>;
  initializeThaiRag(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Default cooldown before a failed Thai-RAG provider start is retried.
 *
 * A failed start stays pinned for the cooldown, so every tool call in that
 * window returns the cached error in ~1-4 ms. That amplification is what turned
 * one missed follower attach into multi-minute catalog blackouts in #418, so the
 * cooldown stays short enough to re-attach during the next owner boot.
 */
const DEFAULT_THAI_RAG_START_RETRY_MS = 5_000;

/**
 * How often a live owner re-reconciles durable heavy-job queue state (#145 U5).
 *
 * Startup recovery alone cannot distinguish "this process restarted 5 s ago"
 * from "another process is still alive", so the 90 s heartbeat grace keeps a
 * freshly dead owner's rows retained on the first sweep. Re-running the sweep
 * on a bounded cadence guarantees those rows are eventually orphaned or
 * interrupted instead of holding queue capacity forever.
 */
const HEAVY_JOB_QUEUE_RECOVERY_INTERVAL_MS = 60_000;

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
  /** #766: destination for one line per failed provider child call; defaults to stderr. */
  readonly thaiRagDiagnostics?: (line: string) => void;
  /** Cooldown before re-attempting a failed Thai-RAG provider start so one transient failure does not outlive the process. */
  readonly thaiRagStartRetryMs?: number;
  /** Steady-state follower retry budget while the owner socket is being recreated (#418). */
  readonly thaiRagFollowerRequestRetryMs?: number;
  /** Startup-attach budget for a verified live owner that holds the lock before it listens (#418). */
  readonly thaiRagOwnerBootWaitMs?: number;
  /**
   * Default for a client-facing stdio peer: follow the designated HTTP host
   * instead of electing ownership when no host is running (#407 single-host).
   * `UNIFIED_THAI_RAG_FORWARD_ONLY` still wins: `0`/`false`/`no`/`off`
   * restores local election for standalone deployments without an HTTP host.
   */
  readonly thaiRagForwardOnlyDefault?: boolean;
  readonly extensions?: ExtensionsService;
  /** Supplied by the first-party host transport, never by request parameters. */
  readonly trustedGoalRelocationActorProvider?: () => TrustedGoalRelocationHostActor | null;
  readonly goalRelocationExactActionApproval?: (request: HostMutationApprovalRequest) => Promise<boolean> | boolean;
  /** Pure Node development only; packaged STDIO is hosted by Electron. */
  readonly checkpointEncryptionKey?: Uint8Array;
  /** Test seam for the read-only GitHub surface; production uses the credential-backed CLI reader. */
  readonly githubApi?: GitHubApiReader;
  /** Test seam for the built-in exact-head merge executor; production uses the authenticated `gh` CLI. */
  readonly githubMergeApi?: GitHubMergeApi;
}

export function createStdioMcpRuntime(
  dataPath: string,
  workspace: Workspace,
  unrestricted: boolean = false,
  options: StdioMcpRuntimeOptions = {},
): StdioMcpRuntime {
  const goalRelocationHostFence = createTrustedGoalRelocationHostFence({
    currentHostActor: options.trustedGoalRelocationActorProvider ?? ((): null => null),
    ...(options.goalRelocationExactActionApproval === undefined ? {}
      : { approveExactAction: options.goalRelocationExactActionApproval }),
    // Single-use authority: the capability exists only once the durable ledger
    // holds it, because storage spends that exact row inside the transfer CAS.
    recordApproval: async (approval): Promise<boolean> =>
      new SqliteGoalRelocationApprovalRepository(database).record(approval),
  });
  const databaseFilename = path.join(dataPath, 'unified-mpc.sqlite');
  const database = new SqliteDatabase(databaseFilename, { backupDirectory: path.join(dataPath, 'backups') });
  const resourceAdmissionController = sharedProcessResourceAdmissionController();
  const managedResourceBindings = new SqliteManagedResourceBindingRepository(database);
  const managedResourceRecovery = new ManagedResourceRecoveryService(
    managedResourceBindings,
    resourceAdmissionController,
  );
  // Local-process pre-write revocation fence. Other host processes require
  // a separate durable cross-process authority epoch boundary (Issue #2).
  const workspaceAuthorityEpoch = new LocalWorkspaceAuthorityEpoch();
  const rawWorkspaceRepository = new SqliteWorkspaceRepository(database, {
    onBeforeAuthorityMutation: workspaceAuthorityEpoch.revokeBeforeMutation,
  });
  // Created eagerly, but polls only after a strict worker requests a signal.
  const workspaceAuthorityWatcher = new CrossProcessWorkspaceAuthorityWatcher(
    (): number => rawWorkspaceRepository.readAuthorityGeneration(), workspaceAuthorityEpoch,
  );
  const workspaceRepository = options.strictAllowedRoots === undefined
    ? rawWorkspaceRepository
    : new StrictWorkspaceRepository(rawWorkspaceRepository, options.strictAllowedRoots);
  const goalRepository = new SqliteGoalRepository(database);
  const workspaceIndex = new WorkspaceIndexService(workspaceRepository, new JsonWorkspaceIndexStore(path.join(dataPath, 'workspace-index')));
  const settingsRepository = new SqliteSettingsRepository(database);
  // #4: reconcile the persisted extensions document before any catalog, policy
  // snapshot or generated client block reads it. Deterministic, so concurrent
  // starts converge on the same bytes instead of racing.
  ensureExtensionsSettingsMigrated(settingsRepository, EXTENSIONS_SETTINGS_KEY);
  // #4 §4: an upgraded install keeps the managed policy block it generated
  // before the native-capability topology existed. Repair the active workspace
  // once, in the background, so a session start converges the block without the
  // user pressing "Sync Policies". Repair only rewrites an existing managed
  // block and never creates or appends one, and global instruction files are
  // deliberately out of scope: a per-session child process must not rewrite
  // instructions that belong to every project. That is the control plane's job.
  const managedPolicyRepairReady: Promise<ManagedPolicyRepairReport | undefined> = new IdeSyncService({
    workspaceRoot: workspace.realRootPath || workspace.rootPath,
    settings: parseExtensionsSettings(settingsRepository.get(EXTENSIONS_SETTINGS_KEY)),
  }).repairManagedBlocks({ includeGlobalTargets: false }).then(
    (result): ManagedPolicyRepairReport | undefined => {
      if (result.ok) return result.value;
      // A failed pass has no per-file report, so the whole-run reason would
      // otherwise disappear. stdout carries the MCP protocol; stderr is the
      // only safe diagnostics channel for this process.
      process.stderr.write(`Unified-MPC managed policy repair failed: ${result.error.message}\n`);
      return undefined;
    },
    (error: unknown): undefined => {
      // A best-effort upgrade must never take the session host down. A thrown
      // pass is still surfaced on stderr instead of becoming an unhandled
      // rejection or disappearing.
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Unified-MPC managed policy repair failed: ${message}\n`);
      return undefined;
    },
  );
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
  // #428: one resolution shared by the scope provider and its failure reason, so
  // callers can distinguish "nothing selected" from "the row is gone" and "the
  // row is archived" instead of collapsing all three into a bare null.
  const resolveActiveScope = async (): Promise<{ readonly scope: WorkspaceScope } | { readonly unavailable: WorkspaceScopeUnavailable }> => {
    const selected = (await activeWorkspaces())[0];
    if (selected === undefined) {
      // No active selection is not the same as no workspace: an archived or
      // deleted primary disappears from the selection, so inspect its row to
      // name the cause instead of reporting a bare "nothing active".
      const primary = rawWorkspaceRepository.getAny === undefined
        ? await rawWorkspaceRepository.get(workspace.id)
        : await rawWorkspaceRepository.getAny(workspace.id);
      if (primary === null) return { unavailable: { reason: 'workspace-row-missing', workspaceId: workspace.id } };
      if (primary.archivedAt !== undefined && primary.archivedAt !== null) {
        return { unavailable: { reason: 'workspace-archived', workspaceId: primary.id } };
      }
      return { unavailable: { reason: 'no-active-selection' } };
    }
    const current = rawWorkspaceRepository.getAny === undefined
      ? await rawWorkspaceRepository.get(selected.id)
      : await rawWorkspaceRepository.getAny(selected.id);
    if (current === null) return { unavailable: { reason: 'workspace-row-missing', workspaceId: selected.id } };
    if (current.archivedAt !== undefined && current.archivedAt !== null) {
      return { unavailable: { reason: 'workspace-archived', workspaceId: current.id } };
    }
    return { scope: { workspaceId: current.id, rootPath: current.rootPath } };
  };
  // #297 S2d: one audit sink for the publish spend and the expiry sweep. It
  // must exist before `GitService` so a spend can always name its lease and
  // outcome. The credential CLI runs in its own process and builds a second
  // `AuditService` over the same SQLite ledger.
  const auditRepository = new SqliteAuditRepository(database);
  const auditService = new AuditService(auditRepository);
  const publishApprovals = new SqlitePublishApprovalRepository(database);
  // #297 S2c: the same lease ledger backs the publish path and the expiry sweep.
  const publishCredentials = new SqlitePublishCredentialRepository({
    database,
    secretStore: new SecretToolSecretStore(),
  });
  // The adapter proves the helper belongs to the running promoted release; a
  // canonical checkout or an unset runtime root keeps every credential path
  // closed. The service passes only the opened material, never a tool value.
  const gitAdapter = new GitAdapter(undefined, {
    resolvePublishCredentialDeployment: async (): Promise<GitPublishCredentialDeployment> => {
      const deployment = await resolvePublishCredentialDeployment();
      return { root: deployment.root, promoted: deployment.promoted };
    },
  });
  const gitService = new GitService(workspaceRepository, undefined, gitAdapter, {
    publishApprovals,
    publishApprovalAuthority: publishApprovals,
    publishCredentials,
    publishAudit: auditService,
  });
  const custodyActor: FileActor = {
    clientId: 'trusted-goal-custody-runtime', clientName: 'Unified Goal Custody Runtime',
  };
  const thaiRagInstallRoot = path.resolve(
    options.thaiRagProviderPath?.trim()
      || settingsRepository.get(USER_SETTING_KEYS.thaiRagProviderPath)?.trim()
      || process.env.UNIFIED_MPC_THAI_RAG_PROVIDER_PATH?.trim()
      || path.join(os.homedir(), 'thai-rag-mcp'),
  );
  // #210 §1: admission, Goal base pinning and the `code_index` identity port
  // must all read the same base branch, so the policy is built before the
  // provider driver that now needs it.
  const mergePolicy = {
    async getByRepository(repository: string): Promise<RepositoryMergePolicy | undefined> {
      return parseRepositoryMergePolicySetting(
        settingsRepository.get(USER_SETTING_KEYS.repositoryMergePolicies),
        repository,
      );
    },
  };
  const thaiRagDriver = options.thaiRagDriver ?? new NativeThaiRagProviderDriver({
    dataRoot: dataPath,
    // #766: stderr is this process's diagnostics channel, and the client never
    // sees the transport failure behind a generic `INTERNAL_ERROR`.
    diagnostics: options.thaiRagDiagnostics ?? ((line: string): void => { process.stderr.write(`${line}\n`); }),
    launchConfig: {
      command: process.platform === 'win32'
        ? path.join(thaiRagInstallRoot, 'venv', 'Scripts', 'python.exe')
        : path.join(thaiRagInstallRoot, 'venv', 'bin', 'python3'),
      args: [path.join(thaiRagInstallRoot, 'thai_rag_context_mcp.py')],
      env: thaiRagProviderLaunchEnv(),
    },
    canonicalRoot: path.join(dataPath, 'canonical'),
    workspacesProvider: async (): Promise<readonly NativeThaiRagWorkspace[]> => (await rawWorkspaceRepository.list())
      .map((entry) => ({
        id: entry.id,
        rootPath: entry.rootPath,
        realRootPath: entry.realRootPath,
        ...(entry.lifecycleKind === undefined ? {} : { lifecycleKind: entry.lifecycleKind }),
        ...(entry.goalId === undefined ? {} : { goalId: entry.goalId }),
      })),
    workspaceSourceIdentityProvider: async (workspace): Promise<WorkspaceSourceEvidenceIdentity | null> => {
      // Admission verification must be idempotent for the exact source the
      // provider already admitted (issue #422). Git identity is cheap to read
      // and changes whenever tracked or untracked source content changes.
      try {
        const observed = await gitService.observeWorkspace(custodyActor, workspace.id);
        if (!observed.ok) return null;
        const source = observed.value;
        return {
          repositoryIdentity: source.repositoryIdentity,
          gitCommonDirIdentity: source.gitCommonDirIdentity,
          worktreeIdentity: source.worktreeIdentity,
          ...(source.branch === null ? {} : { branchName: source.branch }),
          workspaceHead: source.head,
          dirtyFingerprint: source.dirtyFingerprint,
          stagedFingerprint: source.stagedFingerprint,
          // #210 §13: a plain checkout binds only when the worktree is clean
          // and exactly on the manifest commit; deletions are declared to the
          // provider instead of being fenced as expectations.
          dirtyState: source.statusEntries.length === 0 ? 'clean' : 'dirty',
          deletedPaths: source.statusEntries
            .filter((entry) => entry.kind === 'deleted')
            .map((entry) => entry.path),
          // The additions counterpart: the fence cannot see a Goal path the
          // overlay never recorded, so the binding check needs the full set.
          changedPaths: Array.from(new Set(source.statusEntries.map((entry) => entry.path))).sort(),
        };
      } catch {
        return null;
      }
    },
    // #210 §13: the driver owns no branch or merge-policy port, so resolve the
    // exact ref where that state already lives. A checkout without a branch or
    // origin returns null and indexes `absent`; a corrupt store throws and the
    // driver refuses instead of dropping the claim.
    codeIndexSourceProvider: async (workspace): Promise<{
      readonly canonicalRef: string;
      readonly expectedRepositoryIds: readonly string[] | null;
    } | null> => {
      const registered = rawWorkspaceRepository.getAny === undefined
        ? await rawWorkspaceRepository.get(workspace.id)
        : await rawWorkspaceRepository.getAny(workspace.id);
      if (registered === null) return null;
      const branchName = registered.branchName?.trim() ?? '';
      if (branchName.length === 0) return null;
      const baseBranch = await resolveGoalBaseBranch(registered.realRootPath, branchName, mergePolicy);
      return {
        canonicalRef: canonicalRefForBranch(baseBranch),
        expectedRepositoryIds: await resolveGoalRepositoryIds(registered.realRootPath),
      };
    },
    strictWorkerAuthorizedWorkspacesProvider: createStrictThaiRagGoalAdmissionProvider(rawWorkspaceRepository),
    strictWorkerRevocationSignalProvider: workspaceAuthorityWatcher.signal,
    strictWorkerAuthorityGenerationProvider: workspaceAuthorityEpoch.currentGeneration,
    strictWorkerRegistryGenerationProvider: (): number => rawWorkspaceRepository.readAuthorityGeneration(),
    callTimeoutMs: parseIntegerSetting(settingsRepository.get(USER_SETTING_KEYS.mcpCallTimeoutMs), DEFAULT_MCP_CALL_TIMEOUT_MS, 1_000, 60 * 60_000),
    // #407 deadline: status polls get their own bounded call timeout instead
    // of the one-hour index-session budget, so `polls * timeout` is the real
    // upper bound on how long a wedged worker can hold the read gate.
    indexStatusTimeoutMs: parseIntegerSetting(
      process.env.UNIFIED_MPC_THAI_RAG_INDEX_STATUS_TIMEOUT_MS,
      DEFAULT_INDEX_STATUS_TIMEOUT_MS,
      1_000,
      60 * 60_000,
    ),
    indexStatusTimeoutCap: parseIntegerSetting(
      process.env.UNIFIED_MPC_THAI_RAG_INDEX_STATUS_TIMEOUT_POLLS,
      DEFAULT_INDEX_STATUS_TIMEOUT_POLLS,
      1,
      600,
    ),
    // #463 keeps code indexing FTS5-first. Enabling vectors is a deliberate
    // per-deployment opt-in: on a CPU-only host it is a multi-hour baseline
    // pass (issue #445 option 4), so it must never be implicit.
    codeIndexVectors: codeIndexVectorsFromEnv(process.env.UNIFIED_MPC_THAI_RAG_CODE_INDEX_VECTORS),
  });
  // Designated forward-only mode (#407 req 3): a peer never runs the owner
  // election; it follows the designated owner straight or fails with the
  // machine-readable forward-host-unreachable reason (locked hosts stay
  // untouched). The shipped stdio entry defaults to this; the env var still
  // opts a standalone stdio deployment back into election.
  const thaiRagForwardOnly = parseBooleanSetting(
    process.env.UNIFIED_THAI_RAG_FORWARD_ONLY,
    options.thaiRagForwardOnlyDefault === true,
  );
  const thaiRagCoordinator = new ThaiRagProviderCoordinator({
    dataRoot: dataPath,
    ownerId: `unified-mpc:${process.pid}`,
    providerVersion: '4.61.0',
    embeddingIndexGeneration: 1,
    driver: thaiRagDriver,
    ...(thaiRagForwardOnly ? { forwardOnly: true } : {}),
    ...(options.thaiRagFollowerRequestRetryMs === undefined ? {} : { followerRequestRetryMs: options.thaiRagFollowerRequestRetryMs }),
    ...(options.thaiRagOwnerBootWaitMs === undefined ? {} : { ownerBootWaitMs: options.thaiRagOwnerBootWaitMs }),
  });
  const thaiRagStartRetryMs = options.thaiRagStartRetryMs ?? DEFAULT_THAI_RAG_START_RETRY_MS;
  let thaiRagStart: ReturnType<ThaiRagProviderCoordinator['start']> | undefined;
  let thaiRagStartSettled = false;
  let thaiRagStartOk = false;
  let thaiRagStartFailedAtMs = 0;
  const ensureThaiRagStarted = (): ReturnType<ThaiRagProviderCoordinator['start']> => {
    if (thaiRagStart !== undefined) {
      const canRetry = thaiRagStartSettled
        && !thaiRagStartOk
        && Date.now() - thaiRagStartFailedAtMs >= thaiRagStartRetryMs;
      if (!canRetry) return thaiRagStart;
      // A failed start may only outlive the retry window if nothing retried it:
      // pinning the very first failure for the whole process lifetime kept
      // callers offline forever when a mcp-stdio spawned before the provider
      // owner was created and the follower connect window expired.
      void thaiRagStart.catch(() => undefined);
    }
    thaiRagStartSettled = false;
    thaiRagStartOk = false;
    const attempt = thaiRagCoordinator.start();
    thaiRagStart = attempt;
    void attempt.then((start) => {
      thaiRagStartSettled = true;
      thaiRagStartOk = start.ok;
      if (!start.ok) thaiRagStartFailedAtMs = Date.now();
    }, () => {
      thaiRagStartSettled = true;
      thaiRagStartFailedAtMs = Date.now();
    });
    return attempt;
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
  const evidenceLedger = new SqliteGoalWorkspaceRetentionEvidenceRepository(database);
  const getRegisteredGoal = async (rootPath: string): Promise<Workspace | null> =>
    (await workspaceRepository.list()).find((entry) =>
      entry.realRootPath === rootPath && entry.lifecycleKind === 'goal') ?? null;
  const observeRegisteredGoal = async (rootPath: string): ReturnType<GitService['observeWorkspace']> => {
    const registered = await getRegisteredGoal(rootPath);
    if (registered === null) {
      return err(appError('WORKSPACE_NOT_FOUND', 'Goal retention Git observation requires a registered Goal workspace'));
    }
    return gitService.observeWorkspace(custodyActor, registered.id);
  };
// The relocation target is a clean temporary workspace, not a Goal one.
  const observeRegisteredReplacement = async (rootPath: string): ReturnType<GitService['observeWorkspace']> => {
    const registered = (await workspaceRepository.list()).find((entry) =>
      entry.realRootPath === rootPath && entry.lifecycleKind === 'temporary') ?? null;
    if (registered === null) {
      return err(appError('WORKSPACE_NOT_FOUND', 'Goal relocation requires a registered replacement workspace'));
    }
    return gitService.observeWorkspace(custodyActor, registered.id);
  };
  // Relocation observes both sides: the Goal source and the clean temporary
  // replacement that becomes the Goal.
  const observeRegisteredRelocation = async (rootPath: string): ReturnType<GitService['observeWorkspace']> => {
    const registered = (await workspaceRepository.list()).find((entry) =>
      entry.realRootPath === rootPath
      && (entry.lifecycleKind === 'goal' || entry.lifecycleKind === 'temporary')) ?? null;
    if (registered === null) {
      return err(appError('WORKSPACE_NOT_FOUND', 'Goal relocation requires a registered Goal or replacement workspace'));
    }
    // Carry the REGISTERED base proof into the observation. Without it the
    // replacement snapshot has no base/merge-base, so the admission receipt
    // cannot be re-verified against the canonical Goal afterwards.
    const baseRef = registered.baseRef ?? registered.baseRevision;
    return gitService.observeWorkspace(custodyActor, registered.id,
      baseRef === undefined ? {} : { baseRef });
  };
  const registeredGitSeal = {
    status: async (rootPath: string): ReturnType<GitService['status']> => {
      const registered = await getRegisteredGoal(rootPath);
      return registered === null
        ? err(appError('WORKSPACE_NOT_FOUND', 'Goal retention Git status requires a registered Goal workspace'))
        : gitService.status(custodyActor, registered.id);
    },
    run: async (rootPath: string, args: readonly string[]): ReturnType<GitService['run']> => {
      const registered = await getRegisteredGoal(rootPath);
      return registered === null
        ? err(appError('WORKSPACE_NOT_FOUND', 'Goal retention Git command requires a registered Goal workspace'))
        : gitService.run(custodyActor, { workspaceId: registered.id, args: [...args] });
    },
  };
  const goalWorkspacePorts = {
    get: async (workspaceId: string): Promise<Workspace | null> => workspaceRepository.get(workspaceId),
    getAdmissionReceipt: async (workspaceId: string): Promise<WorkspaceAdmissionReceipt | null> => {
      if (await workspaceRepository.get(workspaceId) === null) return null;
      return rawWorkspaceRepository.getAdmissionReceipt(workspaceId);
    },
  };
  // A native host must supply BOTH its trusted current actor and exact-action
  // approval; generic Full Bypass never enables the transfer pipeline.
  const trustedGoalHostReady = options.goalRelocationExactActionApproval !== undefined
    && options.trustedGoalRelocationActorProvider !== undefined;
  const goalRetentionEvidenceSealing = trustedGoalHostReady
    ? new GoalWorkspaceRetentionEvidenceSealingService({
        host: goalRelocationHostFence,
        goals: goalRepository,
        workspaces: goalWorkspacePorts,
        git: { observeWorkspace: observeRegisteredGoal, seal: registeredGitSeal },
        evidence: evidenceLedger,
        retentionRoot: path.join(dataPath, 'goal-retention-evidence'),
      })
    : undefined;
  const goalCustodyPins = new SqliteGoalWorkspaceRetentionCustodyRepository(database);
  const goalCustodyAttestation = trustedGoalHostReady
    ? new GoalWorkspaceCustodyAttestationService({
        host: goalRelocationHostFence,
        trustedEvidence: evidenceLedger,
        goals: goalRepository,
        workspaces: goalWorkspacePorts,
        git: { observeWorkspace: observeRegisteredGoal, observeReplacement: observeRegisteredReplacement },
        custody: goalCustodyPins,
      })
    : undefined;
  const workspaceQuery = new WorkspaceQueryService(workspaceRepository, pathGuard);
  const extensions = options.extensions ?? createLocalExtensionsService({
    settingsJsonProvider: (): string | null => settingsRepository.get(EXTENSIONS_SETTINGS_KEY),
    dataDir: dataPath,
    workspaceRootProvider: primaryWorkspaceRoot,
    callTimeoutMs: parseIntegerSetting(settingsRepository.get(USER_SETTING_KEYS.mcpCallTimeoutMs), DEFAULT_MCP_CALL_TIMEOUT_MS, 1_000, 60 * 60_000),
    idleTimeoutMs: parseIntegerSetting(settingsRepository.get(USER_SETTING_KEYS.mcpIdleTimeoutMs), DEFAULT_MCP_IDLE_TIMEOUT_MS, 30_000, 24 * 60 * 60_000),
  });
  const mergeReceiptRepository = new SqliteMergeVerificationReceiptRepository(database);
  const mergeAttemptRepository = new SqliteMergeVerificationAttemptRepository(database);
  const mergeReconciliationRepository = new SqliteMergeReconciliationRepository(database);
  const githubApi = options.githubApi ?? createGitHubApiReader();
  const mergeObserver = createGitHubMergeObservationPort(githubApi);
  const mergeVerificationRun = createMergeVerificationRunPort({
    github: githubApi,
    receipts: mergeReceiptRepository,
    workspaces: workspaceRepository,
    attempts: mergeAttemptRepository,
    admission: resourceAdmissionController,
  });
  const mergeReconciliationCore = new MergeReconciliationService(
    mergeReceiptRepository,
    mergeReconciliationRepository,
  );
  const mergeVerificationStatus = createMergeVerificationStatusPort({
    attempts: mergeAttemptRepository,
    receipts: mergeReceiptRepository,
    policy: mergePolicy,
  });
  const guardedMerge = new GuardedMergeService(
    mergeReceiptRepository,
    createGuardedMergeDispatchPort(
      extensions,
      () => resolveGuardedMergeProviderServer(
        settingsRepository.get(USER_SETTING_KEYS.guardedMergeProviderServer),
      ),
      createBuiltinGuardedMergeDispatchPort(options.githubMergeApi ?? createGitHubMergeApi()),
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
    {
      // #210 §3: a reconciled merge is the runtime event that advances the
      // canonical ref. Policies without `checkoutPath` still reconcile; they
      // report `refused` instead of advancing a checkout nobody named.
      canonicalAdvance: createCanonicalMergeAdvance({ canonicalRoot: path.join(dataPath, 'canonical') }),
      // The scheduled pass has no caller reading its summary, so a refused
      // advance is surfaced here or not at all.
      onSummary: (summary): void => {
        for (const entry of summary.repositories) {
          if (entry.canonicalAdvance.status === 'refused') {
            process.stderr.write(
              `Unified-MPC canonical advance refused repository=${entry.repository} reason=${entry.canonicalAdvance.reason}\n`,
            );
            continue;
          }
          // The ref moved, so this is not a refusal — but a registration gap
          // would otherwise leave no trace in an unattended pass.
          if (entry.canonicalAdvance.status !== 'skipped'
            && entry.canonicalAdvance.artifacts.status === 'refused') {
            process.stderr.write(
              `Unified-MPC canonical advance registered no artifacts repository=${entry.repository} reason=${entry.canonicalAdvance.artifacts.reason ?? 'unknown'}\n`,
            );
          }
        }
      },
    },
  );
  const codexService = new CodexService(workspaceRepository, {
    auditService,
    profileProvider,
  });
  // #145 step 3: keep the port reference so diagnostics can project the same
  // fair order the shell queue actually drains, not a second reconstruction.
  const shellHeavyAdmission = createShellHeavyAdmissionPort(
    () => resourceAdmissionController,
    () => heavyJobQueue,
    resolveShellHeavyAdmissionPerWorkspaceLimit(),
  );
  const capabilityRuntime = createStdioCapabilityService(dataPath, async () => (await activeWorkspaces()).map((entry) => entry.realRootPath), effectiveUnrestricted, options.strictAllowedRoots, () => parsePathList(settingsRepository.get(USER_SETTING_KEYS.capabilityRoots)),
  () => parseIntegerSetting(settingsRepository.get(USER_SETTING_KEYS.shellSynchronousWaitSeconds), DEFAULT_SHELL_SYNCHRONOUS_WAIT_SECONDS, MIN_CONFIGURABLE_WAIT_SECONDS, MAX_CONFIGURABLE_WAIT_SECONDS),
  createRuntimePromotionTaskReconciliation(),
  shellHeavyAdmission);
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
  const transferRepository = new SqliteGoalWorkspaceTransferRepository(database);
  const goalWorkspaceRelocation = trustedGoalHostReady && options.runtimeAdmissionIdentity !== undefined
    ? new GoalWorkspaceRelocationOrchestrator({
        host: goalRelocationHostFence,
        goals: { getById: (goalId: string): Promise<GoalRecord | null> => goalRepository.getById(goalId) },
        workspaces: goalWorkspacePorts,
        git: { observeWorkspace: observeRegisteredRelocation },
        custody: { readPinned: (operationId: string): Promise<GoalRelocationCustodyPin | null> =>
          goalCustodyPins.readPinned(operationId) },
        transfer: transferRepository,
        runtimeIdentity: options.runtimeAdmissionIdentity,
        validateAdmission: goalRuntimeControlPlane.validateWorkspaceAdmission.bind(goalRuntimeControlPlane),
      })
    : undefined;
  // #210 §4: a Goal admitted from the live canonical commit pins its overlay
  // base there. The merge reconciliation above owns advancing that ref, so an
  // admission pins only what the ref already verifiably contains; a Goal
  // admitted from a historical or feature base is skipped, not failed.
  const goalCanonicalRoot = path.join(dataPath, 'canonical');
  const goalCanonicalRefs = new CanonicalRefStore(goalCanonicalRoot);
  const goalCanonicalOverlays = new GoalOverlayStore(goalCanonicalRoot);
  const goalCanonicalManifests = new CanonicalManifestStore(goalCanonicalRoot, { strictReads: true });
  const goalWorkspaceService = new GoalWorkspaceService(workspaceRepository, new GitAdapter(), {
    canonicalAdmission: {
      pinBaseAtCommit: async (input): Promise<GoalCanonicalAdmissionOutcome> => {
        // Refs are store-wide; only the Goal worktree itself proves which
        // repository the live manifest it names must belong to (#210 §1).
        const repositoryIds = await resolveGoalRepositoryIds(input.worktreePath);
        if (repositoryIds === null) {
          const detail = `no origin remote in ${input.worktreePath}`;
          process.stderr.write(
            `Unified-MPC Goal canonical pin skipped goal=${input.goalWorkspaceId} reason=repository_unknown detail=${detail}\n`,
          );
          return {
            status: 'skipped',
            reason: 'repository_unknown',
            detail,
          };
        }
        const outcome = await pinGoalBaseAtCommit(goalCanonicalRefs, goalCanonicalOverlays, {
          goalWorkspaceId: input.goalWorkspaceId,
          canonicalRef: canonicalRefForBranch(input.baseBranch),
          commitSha: input.commitSha,
        }, {
          manifests: goalCanonicalManifests,
          expectedRepositoryIds: repositoryIds,
        });
        // A skip is expected without canonical data or on a feature base; a
        // repository mismatch is not, and no client may be watching the create
        // result that also carries it (#210 §11).
        if (outcome.status === 'failed') {
          process.stderr.write(
            `Unified-MPC Goal canonical pin failed goal=${input.goalWorkspaceId} reason=${outcome.reason}\n`,
          );
        } else if (outcome.status === 'skipped' && outcome.reason === 'repository_mismatch') {
          process.stderr.write(
            `Unified-MPC Goal canonical pin skipped goal=${input.goalWorkspaceId} reason=${outcome.reason} detail=${outcome.detail}\n`,
          );
        }
        return outcome;
      },
      releaseBase: async (goalWorkspaceId): Promise<void> => {
        try {
          await goalCanonicalOverlays.delete(goalWorkspaceId);
        } catch (error) {
          // The overlay base is a GC root: a real unlink failure would retain
          // the removed Goal's manifest and artifacts, so surface it here.
          process.stderr.write(
            `Unified-MPC Goal canonical overlay release failed goal=${goalWorkspaceId} `
            + `reason=${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
      },
    },
  });

  /**
   * Shared proof for every operation that acts on a live Goal Workspace under
   * the durable goal lease. Same MCP session identity is not ownership proof:
   * the token hash, generation, owner client/session and expiry must all match.
   */
  const requireGoalLeaseProof = async (
    runActor: { readonly clientId: string; readonly sessionId?: string },
    request: {
      readonly workspaceId: string;
      readonly goalId: string;
      readonly leaseToken: string;
      readonly leaseGeneration: number;
    },
    rejectionMessage: string,
  ): Promise<Result<{ readonly leaseExpiresAt: string }>> => {
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
      return err(appError('PERMISSION_DENIED', rejectionMessage));
    }
    return ok({ leaseExpiresAt: goal.leaseExpiresAt });
  };
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

      // A selected feature/detached worktree may contain commits not on the
      // repository base branch. Pin its exact committed head; only a checkout
      // already on the base branch uses the freshly fetched remote commit.
      const currentBranch = await gitService.run(runActor, {
        workspaceId: parent.id,
        args: ['branch', '--show-current'],
      });
      if (!currentBranch.ok) return currentBranch;
      if (currentBranch.value.exitCode !== 0) {
        return err(appError('CONFLICT', 'Cannot identify project branch for Goal Workspace admission', true));
      }
      const branchName = currentBranch.value.stdout.trim();
      const baseBranch = await resolveGoalBaseBranch(parent.realRootPath, branchName, mergePolicy);
      let baseRevision: string | undefined;
      if (branchName !== baseBranch) {
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
        baseBranch,
        ...(baseRevision === undefined ? {} : { baseRevision }),
        ...(runActor.sessionId === undefined ? {} : { ownerSessionId: runActor.sessionId }),
      });
      if (created.ok) {
        const canonicalAdmission = created.value.canonicalAdmission;
        return ok({
          workspaceId: created.value.workspace.id,
          ...(canonicalAdmission === undefined ? {} : { canonicalAdmission }),
        });
      }

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
      const proof = await requireGoalLeaseProof(
        runActor,
        request,
        'Stale or invalid goal lease proof; admission retry rejected',
      );
      if (!proof.ok) return proof;
      const leaseExpiresAt = proof.value.leaseExpiresAt;
      const stagedRecovery = request.stagedRecovery;
      const unstagedRecovery = request.unstagedRecovery;
      if (stagedRecovery === undefined && unstagedRecovery === undefined) {
        return goalRunWorkspace.admitRunWorkspace(runActor, {
          workspaceId: request.workspaceId,
          goalId: request.goalId,
          leaseGeneration: request.leaseGeneration,
          leaseExpiresAt,
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
        leaseExpiresAt,
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
    async rebaseRunWorkspace(runActor, request) {
      const proof = await requireGoalLeaseProof(
        runActor,
        request,
        'Stale or invalid goal lease proof; guarded rebase rejected',
      );
      if (!proof.ok) return proof;
      const goal = await goalRepository.getById(request.goalId);
      const checkpoint = goal?.checkpoints.at(-1);
      if (goal === null || checkpoint === undefined) {
        return ok({
          status: 'RECOVERY_REQUIRED' as const,
          reason: 'durable_checkpoint_missing',
        });
      }
      const goalWorkspace = await workspaceRepository.get(request.workspaceId);
      if (goalWorkspace === null || goalWorkspace.lifecycleKind !== 'goal'
        || goalWorkspace.goalId !== request.goalId) {
        return err(appError('WORKSPACE_ADMISSION_STALE', 'Guarded rebase requires the exact owned Goal Workspace', true));
      }
      const ownerId = `${runActor.clientId}:${runActor.sessionId ?? 'sessionless'}`;
      const writer = await goalWorkspaceService.synchronizeWriterLease(
        request.goalId,
        ownerId,
        request.leaseGeneration,
        proof.value.leaseExpiresAt,
      );
      if (!writer.ok) return writer;
      const lease = { leaseId: writer.value.leaseId, generation: writer.value.generation };

      const observed = await goalWorkspaceTruth.readAdmission(request.workspaceId);
      if (observed.workspaceKind !== 'git' || observed.workspaceHead === undefined) {
        return ok({
          status: 'RECOVERY_REQUIRED' as const,
          reason: 'workspace_head_unavailable',
        });
      }
      const existing = await rawWorkspaceRepository.getAdmissionReceipt(request.workspaceId);
      if (existing === null) {
        return ok({
          status: 'RECOVERY_REQUIRED' as const,
          reason: 'admission_receipt_missing',
        });
      }
      if (existing.invalidatedAt !== undefined) {
        return ok({
          status: 'RECOVERY_REQUIRED' as const,
          reason: 'admission_receipt_invalidated',
        });
      }
      if (existing.admissionGeneration !== request.expectedAdmissionGeneration) {
        return ok({
          status: 'RECOVERY_REQUIRED' as const,
          reason: 'admission_generation_mismatch',
        });
      }

      // The live admission pass never records checkpoint evidence, while the
      // guarded rebase requires it. Bind the exact durable checkpoint and the
      // observed HEAD into the receipt the rebase consumes; the rebase then
      // re-validates every field before moving any history.
      const recorded = await goalWorkspaceService.recordCheckpoint(request.goalId, checkpoint.id, lease);
      if (!recorded.ok) return recorded;
      let admissionGeneration = existing.admissionGeneration;
      const alreadyBound = existing.checkpointId === checkpoint.id
        && existing.checkpointRevision === checkpoint.revision
        && existing.expectedWorkspaceHead === observed.workspaceHead;
      if (!alreadyBound) {
        const runtime = options.runtimeAdmissionIdentity;
        if (runtime === undefined) {
          return ok({
            status: 'RECOVERY_REQUIRED' as const,
            reason: 'runtime_admission_identity_missing',
          });
        }
        const captured = await goalWorkspaceService.captureAdmission({
          workspaceId: request.workspaceId,
          checkpointId: checkpoint.id,
          checkpointRevision: checkpoint.revision,
          checkpointHead: observed.workspaceHead,
          workflowVersion: 1,
          runtime,
        });
        if (!captured.ok) {
          return ok({
            status: 'RECOVERY_REQUIRED' as const,
            reason: 'admission_capture_conflict',
          });
        }
        admissionGeneration = captured.value.admissionGeneration;
      }

      return goalWorkspaceService.rebaseStaleBase({
        goalId: request.goalId,
        expectedAdmissionGeneration: admissionGeneration,
        lease,
      });
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
  const goalWorktreeClassifier: { current?: NonNullable<McpApplicationServices['goalWorktrees']> } = {};
  const goalService = new GoalContinuationService(workspaceRepository, goalRepository, {
    scheduledContinuations: goalRepository,
    workerLiveness: goalMutationFence,
    taskCancellation,
    requestCancellation,
    goalExecutions: goalRepository,
    executionCancellation: goalRepository,
    runtimeEvents: goalRuntimeControlPlane,
    // The reconciler is constructed below with the full runtime services; the
    // delegate keeps this seam typed without reordering the runtime graph.
    goalWorktrees: {
      async classify(request): Promise<Result<GoalWorktreeClassificationReport>> {
        const classifier = goalWorktreeClassifier.current;
        return classifier === undefined
          ? err(appError('INTERNAL_ERROR', 'Goal worktree classification is unavailable'))
          : classifier.classify(request);
      },
    },
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
  // #145 U5: durable heavy-job queue state. This process owns its rows through
  // a per-process owner id, proves liveness with heartbeats, and reconciles
  // stale rows so a dead owner can never hold queue capacity forever.
  const heavyJobQueue = new SqliteHeavyJobQueueRepository(database);
  const heavyJobQueueRecovery = new HeavyJobQueueRecoveryService(heavyJobQueue, {
    currentOwnerId: heavyJobQueue.ownerId,
  });
  heavyJobQueue.startHeartbeat();
  const heavyJobQueueRecoveryTimer = setInterval(() => {
    try {
      heavyJobQueueRecovery.reconcileOnce();
      // Parked declared shell runs follow the same sweep: once a dead owner's
      // queue row is orphaned, this runtime adopts it and starts the reserved
      // worker without a caller retry (#145 restart re-attachment).
      void capabilityRuntime.shell.recoverParkedHeavy().catch(() => undefined);
    } catch {
      // A failed sweep must not take the runtime down; the next sweep retries.
    }
  }, HEAVY_JOB_QUEUE_RECOVERY_INTERVAL_MS);
  heavyJobQueueRecoveryTimer.unref?.();
  const heavyJobQueueRecoveryReady = (async (): Promise<void> => {
    heavyJobQueueRecovery.reconcileOnce();
    await capabilityRuntime.shell.recoverParkedHeavy().catch(() => undefined);
  })();
  // #297 S2a: reclaim publish credential leases whose TTL passed. `open` already
  // refuses an expired lease, so this timer is what actually deletes an abandoned
  // `publish-<leaseId>` secret. It runs on start and hourly, never blocks boot,
  // and never rejects: a Secret Service outage must not take the runtime down.
  const publishCredentialSweep = startPublishCredentialSweep({
    leases: publishCredentials,
    audit: auditService,
  });
  const recoveryReady = Promise.all([
    fileRecoveryReady,
    goalRuntimeRecoveryReady,
    managedResourceRecoveryReady,
    heavyJobQueueRecoveryReady,
  ]).then(() => undefined);
  // Callers await this to learn whether recovery succeeded, but a stdio host can
  // also be torn down (or lose its client) before it ever awaits. Mark the
  // rejection handled so a failed recovery stays observable through the same
  // promise instead of terminating the process as an unhandled rejection.
  void recoveryReady.catch(() => undefined);
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
  // #80 slice 3: read-only worktree lifecycle inspection. The ownership ledger
  // is shared runtime state (read lazily, never cached twice), and a workspace
  // that still holds a live goal lease can never be reported cleanable, so a
  // failing lease probe fails the whole call closed.
  let goalWorktreeLedgerReader: ReturnType<typeof createGoalWorktreeLedgerReader> | undefined;
  const goalWorktrees: NonNullable<McpApplicationServices['goalWorktrees']> = createGoalWorktreeReconciliationPort({
    listLedgerEntries: async () => {
      goalWorktreeLedgerReader ??= createGoalWorktreeLedgerReader({ services, actor });
      return goalWorktreeLedgerReader();
    },
    listActivelyLeasedWorkspaceIds: async () => {
      const goals = await goalRepository.list({ status: 'active', limit: 200 });
      const now = new Date().toISOString();
      return [...new Set(goals
        .filter((goal) => goal.leaseExpiresAt === undefined || goal.leaseExpiresAt > now)
        .map((goal) => goal.workspaceId))];
    },
  });
  goalWorktreeClassifier.current = goalWorktrees;
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
    heavyJobQueue,
    heavyJobFairness: shellHeavyAdmission,
    canonicalIndexStatus: async (options) => {
      assertStorageIdentitySafe(dataPath);
      const canonicalRoot = path.join(dataPath, 'canonical');
      const report = await canonicalStatus({
        refs: new CanonicalRefStore(canonicalRoot),
        manifests: new CanonicalManifestStore(canonicalRoot),
        pins: new RevisionPinRegistry(canonicalRoot),
        overlays: new GoalOverlayStore(canonicalRoot),
        quarantine: new ArtifactQuarantineStore(canonicalRoot),
        jobs: new IndexJobLedger(canonicalRoot),
      });
      // The MCP tool bounds again; this keeps the bound true for every caller of
      // the service, including a future one that does not re-slice.
      return options?.limit === undefined ? report : boundCanonicalStatusReport(report, options.limit);
    },
    canonicalRevisionList: async (options) => {
      assertStorageIdentitySafe(dataPath);
      const canonicalRoot = path.join(dataPath, 'canonical');
      return canonicalRevisionList({
        refs: new CanonicalRefStore(canonicalRoot),
        manifests: new CanonicalManifestStore(canonicalRoot),
        pins: new RevisionPinRegistry(canonicalRoot),
        overlays: new GoalOverlayStore(canonicalRoot),
        jobs: new IndexJobLedger(canonicalRoot),
        providerGenerations: new ProviderGenerationLedger(canonicalRoot),
      }, options);
    },
    canonicalGcStatus: async () => {
      assertStorageIdentitySafe(dataPath);
      const canonicalRoot = path.join(dataPath, 'canonical');
      return gcStatus(
        { quarantine: new ArtifactQuarantineStore(canonicalRoot), lease: new GcLeaseStore(canonicalRoot) },
        { now: new Date() },
      );
    },
    ragIndexJobList: async (input) => {
      assertStorageIdentitySafe(dataPath);
      // Read-only: a live runtime owner may be writing progress right now, so
      // the operator listing must not migrate, reap or persist a snapshot.
      return projectIndexJobHistory(await new ThaiRagIndexJobStore(dataPath).listForOperator({
        ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      }));
    },
    mergePolicy,
    mergeVerificationRun,
    mergeVerificationStatus,
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
    goalWorktrees,
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
    goalRelocationHostFence,
    ...(goalWorkspaceRelocation === undefined ? {} : { goalWorkspaceRelocation }),
    ...(goalCustodyAttestation === undefined ? {} : { goalCustodyAttestation }),
    ...(goalRetentionEvidenceSealing === undefined ? {} : { goalRetentionEvidenceSealing }),
    actor,
    extensions,
    managedPolicyRepairReady,
    activityTracker,
    activityReady,
    recoveryReady,
    profileProvider,
    authorizationModeProvider,
    allowAiDeleteProvider,
    destructivePolicyProvider,
    activeWorkspaceScopeProvider: async (): Promise<WorkspaceScope | null> => {
      const resolved = await resolveActiveScope();
      return 'scope' in resolved ? resolved.scope : null;
    },
    activeWorkspaceScopeUnavailableProvider: async (): Promise<WorkspaceScopeUnavailable | null> => {
      const resolved = await resolveActiveScope();
      return 'scope' in resolved ? null : resolved.unavailable;
    },
    activeWorkspaceScopesProvider: async (): Promise<readonly WorkspaceScope[]> => (await activeWorkspaces())
      .map((selected) => ({ workspaceId: selected.id, rootPath: selected.rootPath })),
    codexToolsEnabled: parseBooleanSetting(settingsRepository.get(USER_SETTING_KEYS.codexToolsEnabled), DEFAULT_CODEX_TOOLS_ENABLED),
    ponytailMode: parsePonytailMode(settingsRepository.get(USER_SETTING_KEYS.ponytailMode), DEFAULT_PONYTAIL_MODE),
    toolAvailabilityService,
    mergeReconciliationPoller,
    initializeThaiRag,
    close: async (): Promise<void> => {
      workspaceAuthorityWatcher.close();
      stopToolAvailabilityWatch();
      await recoveryReady.catch(() => undefined);
      await managedPolicyRepairReady;
      managedResourceRecovery.close();
      clearInterval(heavyJobQueueRecoveryTimer);
      heavyJobQueue.close();
      publishCredentialSweep.stop();
      mergeReconciliationPoller.close();
      await thaiRagCoordinator.close().catch(() => undefined);
      await (await sharedActivityLease)?.close();
      await extensions.close().catch(() => undefined);
      await workspaceIndex.close().catch(() => undefined);
      database.close();
    },
  };
}

/**
 * Environment forwarded into every Thai-RAG data-owner launch (#413).
 *
 * The MCP session manager only passes the safe environment subset
 * (PATH/HOME/TMP/LANG, see `isSafeExternalEnvironmentKey`), so anything the
 * provider must know about this node's deployment has to be listed here
 * explicitly. The node contract attests the deployment embedding profile
 * (`THAI_RAG_DEPLOYMENT_EMBEDDING_PROFILE` via llama.cpp); a host booted
 * without a backend falls back to the thai-rag ollama/nomic defaults, which can
 * never satisfy that attestation and keeps every rag/memory call behind
 * CONFLICT. An explicitly configured host environment stays authoritative.
 */
export function thaiRagProviderLaunchEnv(processEnv: NodeJS.ProcessEnv = process.env): Record<string, string> {
  // Empty-string values are treated as unset: Python treats ``""`` for
  // THAI_RAG_LLAMACPP_BASE_URL as a real override, which breaks requests,
  // so only non-blank host environment stays authoritative.
  const authoritative = (key: string): string | undefined => {
    const value = processEnv[key];
    return value !== undefined && value.trim().length > 0 ? value : undefined;
  };
  return {
    // The provider reuses this as the response budget of an ordinary call, and
    // the driver derives its request deadline from it together with the
    // long-running response budget, so the two sides cannot disagree (#770,
    // see `thai-rag-call-budget.ts`).
    THAI_RAG_DATA_OWNER_CONNECT_TIMEOUT: authoritative('THAI_RAG_DATA_OWNER_CONNECT_TIMEOUT') ?? String(DEFAULT_THAI_RAG_CONNECT_BUDGET_SECONDS),
    // Long-running forwarded methods (`code_index`, the reconciles, base
    // attach/detach) are budgeted separately from the connect/retry deadline
    // above (`THAI_RAG_DATA_OWNER_RESPONSE_TIMEOUT`, soulzerox/thai-rag-mcp#431).
    // The driver derives its request deadline from this env too, so it is
    // attested here rather than left to the provider's own default: otherwise an
    // unset value would make the driver rely on an assumption about the
    // installed provider, and a provider default change would silently
    // reintroduce the undercut this pair of budgets removes (#770). An explicit
    // host value stays authoritative.
    THAI_RAG_DATA_OWNER_RESPONSE_TIMEOUT: authoritative('THAI_RAG_DATA_OWNER_RESPONSE_TIMEOUT') ?? String(DEFAULT_THAI_RAG_RESPONSE_BUDGET_SECONDS),
    // One code-index batch embeds every chunk of a single file in one
    // `embed_documents` request, so the deadline has to cover the largest file
    // of a real repository, not one average chunk. The provider's own 60s
    // default abandons those requests (`AbandonedRequest: embedding request
    // exceeded 60s`), the index job then fails as a whole, no semantic
    // generation is published, and the mandatory pre-edit gate stays shut
    // (issue #439). 300s was still short: measured on a CPU-only host at
    // ~5.9s per chunk, a 1874-line file needs ~660s and a 3195-line file
    // ~1120s, so a 300s deadline failed the largest files of the very
    // workspace this default exists for. 1800s covers ~300 chunks (~12k
    // lines) at that rate; a hung batch is still bounded by the monitor's
    // consecutive index_status timeout cap, not by this deadline.
    // An explicitly configured host environment stays authoritative.
    THAI_RAG_LLAMACPP_REQUEST_TIMEOUT: authoritative('THAI_RAG_LLAMACPP_REQUEST_TIMEOUT') ?? '1800',
    THAI_RAG_EMBEDDING_BACKEND: authoritative('THAI_RAG_EMBEDDING_BACKEND') ?? 'llamacpp',
    THAI_RAG_LLAMACPP_MODEL: authoritative('THAI_RAG_LLAMACPP_MODEL') ?? THAI_RAG_DEPLOYMENT_EMBEDDING_PROFILE,
    // The Python provider already defaults the llama.cpp base URL; the launcher
    // only passes these through when the host configured them explicitly.
    ...(authoritative('THAI_RAG_LLAMACPP_BASE_URL') === undefined ? {} : { THAI_RAG_LLAMACPP_BASE_URL: authoritative('THAI_RAG_LLAMACPP_BASE_URL') as string }),
    ...(authoritative('THAI_RAG_LLAMACPP_MODEL_PATH') === undefined ? {} : { THAI_RAG_LLAMACPP_MODEL_PATH: authoritative('THAI_RAG_LLAMACPP_MODEL_PATH') as string }),
    // llama.cpp's own `-b`/`-ub` defaults (512) are a deployment property: a
    // chunk longer than the physical batch is rejected with HTTP 500
    // ("input (1600 tokens) is too large to process ... current batch size:
    // 512"), the adapter raises, the coordinator falls back to an embedding
    // backend that is not running, the vector channel degrades to zero vectors
    // and the pre-edit gate stays shut (issue #438). The provider hands this
    // verbatim to the llama-server it launches, so a tuned host must reach it
    // or every cold start silently regresses to the unusable default.
    ...(authoritative('THAI_RAG_LLAMACPP_SERVER_ARGS') === undefined ? {} : { THAI_RAG_LLAMACPP_SERVER_ARGS: authoritative('THAI_RAG_LLAMACPP_SERVER_ARGS') as string }),
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
  heavyAdmission?: import('@unified-mpc/capabilities').ShellHeavyAdmissionPort,
): StdioCapabilityRuntime {
  const runtime = createPlatformCapabilitySet({
    platform: process.platform,
    dataPath,
    workspaceRootsProvider,
    unrestricted,
    configuredRootsProvider: () => strictAllowedRoots ?? [...readCapabilityRoots(process.env.UNIFIED_MPC_CAPABILITY_ROOTS), ...configuredRootsProvider()],
    synchronousWaitSecondsProvider,
    durableTaskReconciliation,
    ...(heavyAdmission === undefined ? {} : { heavyAdmission }),
  });
  return { service: runtime.service, shell: runtime.shell };
}

function readCapabilityRoots(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim().length === 0) return [];
  return value.split(path.delimiter).map((root) => root.trim()).filter((root) => root.length > 0).map((root) => path.resolve(root));
}
