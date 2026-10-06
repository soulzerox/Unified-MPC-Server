import path from 'node:path';
import { appError, err, ok, type Result, type ResultBudget } from '@unified-mpc/domain';
import { McpConfigLoader } from './mcp-config-loader.js';
import { fingerprintExternalMcpValue, McpSessionManager, type McpClientFactory } from './mcp-session-manager.js';
import { configuredPolicies, reconcileRuntimePolicies } from './runtime-policy.js';
import { CanonicalSkillMigrationCutoverStateStore } from './canonical-skill-migration-cutover-state.js';
import { CanonicalMcpMigrationCutoverStateStore } from './canonical-mcp-migration-cutover-state.js';
import { CanonicalExtensionRegistry } from './canonical-extension-registry.js';
import { fingerprintCanonicalSkillDirectory } from './canonical-skill-migration-stager.js';
import { InstallerService } from './installer.js';
import { SkillCatalog } from './skill-catalog.js';
import type {
  DiscoveredMcpServer,
  ExtensionsService,
  ExtensionsSettings,
  MandatoryMcpBootstrapResult,
  McpServerListItem,
  RuntimePolicySnapshot,
  SkillContent,
  SkillSummary,
} from './types.js';

export interface LocalExtensionsServiceOptions {
  readonly settings: ExtensionsSettings;
  readonly settingsProvider?: () => ExtensionsSettings;
  readonly homeDir?: string;
  readonly appDataDir?: string;
  readonly dataDir?: string;
  readonly workspaceRootProvider?: () => Promise<string | undefined>;
  readonly bundledSkillRoots?: readonly string[];
  readonly clientFactory?: McpClientFactory;
  readonly callTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
}

export class LocalExtensionsService implements ExtensionsService {
  private readonly settingsProvider: () => ExtensionsSettings;
  private readonly homeDir: string | undefined;
  private readonly appDataDir: string | undefined;
  private readonly dataDir: string | undefined;
  private readonly workspaceRootProvider: () => Promise<string | undefined>;
  private readonly bundledSkillRoots: readonly string[];
  private readonly sessions: McpSessionManager;
  private bundledSkillReconciliation: Promise<Result<undefined>> | undefined;
  private mandatoryMcpLastResult: MandatoryMcpBootstrapResult | undefined;
  private mandatoryMcpLastCheckedAt: string | undefined;
  private closed = false;

  public constructor(options: LocalExtensionsServiceOptions) {
    this.settingsProvider = options.settingsProvider ?? ((): ExtensionsSettings => options.settings);
    this.homeDir = options.homeDir;
    this.appDataDir = options.appDataDir;
    this.dataDir = options.dataDir;
    this.workspaceRootProvider = options.workspaceRootProvider ?? (async (): Promise<undefined> => undefined);
    this.bundledSkillRoots = options.bundledSkillRoots ?? [];
    this.sessions = new McpSessionManager({
      ...(options.clientFactory === undefined ? {} : { clientFactory: options.clientFactory }),
      ...(options.callTimeoutMs === undefined ? {} : { callTimeoutMs: options.callTimeoutMs }),
      ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
    });
  }

  public async listSkills(input: { readonly query?: string; readonly source?: string }): Promise<Result<{ readonly skills: readonly SkillSummary[] }>> {
    const catalog = await this.skillCatalog();
    if (!catalog.ok) return err(catalog.error);
    return catalog.value.list(input);
  }

  public async readSkill(input: { readonly skillId: string; readonly relativePath?: string }): Promise<Result<SkillContent>> {
    const catalog = await this.skillCatalog();
    if (!catalog.ok) return err(catalog.error);
    return catalog.value.read(input);
  }

  public async runtimePolicySnapshot(): Promise<Result<RuntimePolicySnapshot>> {
    try {
      const settings = this.settingsProvider();
      const [discovered, catalog] = await Promise.all([
        this.discoverMcpServers(),
        this.skillCatalog(),
      ]);
      if (!discovered.ok) return err(discovered.error);
      if (!catalog.ok) return err(catalog.error);
      const skills = await catalog.value.list({});
      if (!skills.ok) return err(skills.error);
      return ok(reconcileRuntimePolicies(settings, discovered.value, skills.value.skills));
    } catch (error: unknown) {
      return err(appError('INTERNAL_ERROR', `Failed to resolve runtime policy: ${error instanceof Error ? error.message : String(error)}`, true));
    }
  }

  public async listMcpServers(): Promise<Result<{ readonly servers: readonly McpServerListItem[] }>> {
    const discovered = await this.discoverMcpServers();
    if (!discovered.ok) return err(discovered.error);
    const required = new Set(configuredPolicies(this.settingsProvider())
      .filter((policy) => policy.resourceType === 'server' && policy.mandatory)
      .map((policy) => policy.resourceId.trim().toLowerCase()));
    const lastStatus = new Map((this.mandatoryMcpLastResult?.servers ?? []).map((server) => [server.name.toLowerCase(), server] as const));
    return ok({
      servers: discovered.value.map((server) => {
        const requiredServer = required.has(server.name.toLowerCase());
        const connected = this.sessions.isConnected(server.name);
        const pinned = this.sessions.isPinned(server.name);
        const mandatoryStatus = lastStatus.get(server.name.toLowerCase());
        const state = connected && (!requiredServer || pinned)
          ? 'connected' as const
          : requiredServer && server.enabled && !server.excluded
            ? 'degraded' as const
            : 'offline' as const;
        return {
          name: server.name,
          source: server.source,
          enabled: server.enabled,
          connected,
          pinned,
          required: requiredServer,
          state,
          ...(requiredServer && this.mandatoryMcpLastCheckedAt !== undefined ? { lastCheckedAt: this.mandatoryMcpLastCheckedAt } : {}),
          ...(mandatoryStatus?.error === undefined ? {} : { lastError: mandatoryStatus.error }),
          excluded: server.excluded,
          ...(server.exclusionReason === undefined ? {} : { exclusionReason: server.exclusionReason }),
          command: server.config.command,
        };
      }),
    });
  }

  public async bootstrapMandatoryMcpServers(signal?: AbortSignal): Promise<Result<import('./types.js').MandatoryMcpBootstrapResult>> {
    const requirements = new Map<string, { readonly name: string; readonly requiredTools: Set<string> }>();
    for (const policy of configuredPolicies(this.settingsProvider())) {
      if (policy.resourceType !== 'server' || !policy.mandatory) continue;
      const name = policy.resourceId.trim();
      if (name.length === 0) continue;
      const key = name.toLowerCase();
      const existing = requirements.get(key);
      if (existing === undefined) {
        requirements.set(key, { name, requiredTools: new Set(policy.requiredTools ?? []) });
      } else {
        for (const tool of policy.requiredTools ?? []) existing.requiredTools.add(tool);
      }
    }
    const requiredNames = new Set(requirements.keys());
    const discovered = await this.discoverMcpServers();
    if (!discovered.ok) return err(discovered.error);
    for (const server of discovered.value) {
      if (!requiredNames.has(server.name.toLowerCase())) this.sessions.unpin(server.name);
    }
    const servers = await Promise.all([...requirements.values()].map(async ({ name, requiredTools }) => {
      const requiredToolList = [...requiredTools];
      if (isAborted(signal)) return { name, required: true as const, connected: false, pinned: false, tools: [], requiredTools: requiredToolList, error: 'cancelled' };
      const server = await this.findServer(name);
      if (!server.ok) return { name, required: true as const, connected: false, pinned: false, tools: [], requiredTools: requiredToolList, error: server.error.message };
      if (!server.value.enabled || server.value.excluded) {
        return {
          name,
          required: true as const,
          connected: false,
          pinned: false,
          tools: [],
          requiredTools: requiredToolList,
          error: server.value.exclusionReason ?? 'required MCP server is disabled',
        };
      }
      if (server.value.source.startsWith('workspace-')) {
        return {
          name: server.value.name,
          required: true as const,
          connected: false,
          pinned: false,
          tools: [],
          requiredTools: requiredToolList,
          error: `Refusing to promote workspace-scoped MCP server into the mandatory native harness: ${server.value.name}`,
        };
      }
      const described = await this.sessions.describe(server.value.name, server.value.config, signal);
      if (!described.ok) return { name, required: true as const, connected: false, pinned: false, tools: [], requiredTools: requiredToolList, error: described.error.message };
      this.sessions.pin(server.value.name);
      return {
        name: server.value.name,
        required: true as const,
        connected: true,
        pinned: true,
        descriptorFingerprint: fingerprintExternalMcpValue({ source: server.value.source, config: server.value.config }),
        catalogFingerprint: described.value.catalogFingerprint,
        tools: described.value.tools.map((tool) => tool.name),
        requiredTools: requiredToolList,
      };
    }));
    const result = { ready: servers.every((server) => server.connected && server.pinned), servers };
    this.mandatoryMcpLastResult = result;
    this.mandatoryMcpLastCheckedAt = new Date().toISOString();
    return ok(result);
  }

  public async describeMcpServer(input: { readonly server: string }, signal?: AbortSignal): Promise<Result<{
    readonly server: string;
    readonly enabled: boolean;
    readonly connected: boolean;
    readonly provenance: {
      readonly source: string;
      readonly trustTier: 'external';
      readonly namespace: string;
      readonly descriptorFingerprint: string;
      readonly catalogFingerprint: string;
      readonly drift: import('./types.js').ExternalMcpContractDrift;
    };
    readonly tools: readonly { readonly name: string; readonly qualifiedName: string; readonly description: string; readonly inputSchema?: unknown; readonly outputSchema?: unknown }[];
  }>> {
    if (isAborted(signal)) return cancelledMcpCall();
    const server = await this.findServer(input.server);
    if (isAborted(signal)) return cancelledMcpCall();
    if (!server.ok) return server;
    if (!server.value.enabled) {
      return err(appError('PERMISSION_DENIED', `MCP server is disabled: ${input.server}`));
    }
    if (server.value.excluded) {
      return err(appError('PERMISSION_DENIED', server.value.exclusionReason ?? `MCP server is excluded: ${input.server}`));
    }
    const described = await this.sessions.describe(server.value.name, server.value.config, signal);
    if (!described.ok) return described;
    return ok({
      server: server.value.name,
      enabled: true,
      connected: described.value.connected,
      provenance: {
        source: server.value.source,
        trustTier: 'external',
        namespace: `mcp:${server.value.name}`,
        descriptorFingerprint: fingerprintExternalMcpValue({ source: server.value.source, config: server.value.config }),
        catalogFingerprint: described.value.catalogFingerprint,
        drift: described.value.drift,
      },
      tools: described.value.tools.map((tool) => ({ ...tool, qualifiedName: `mcp:${server.value.name}/${tool.name}` })),
    });
  }

  public async listMcpResources(input: { readonly server: string }, signal?: AbortSignal): Promise<Result<{
    readonly server: string;
    readonly enabled: boolean;
    readonly connected: boolean;
    readonly resources: readonly import('./types.js').McpResourceSummary[];
  }>> {
    if (isAborted(signal)) return cancelledMcpCall();
    const server = await this.findServer(input.server);
    if (isAborted(signal)) return cancelledMcpCall();
    if (!server.ok) return server;
    if (!server.value.enabled) return err(appError('PERMISSION_DENIED', `MCP server is disabled: ${input.server}`));
    if (server.value.excluded) return err(appError('PERMISSION_DENIED', server.value.exclusionReason ?? `MCP server is excluded: ${input.server}`));
    const listed = await this.sessions.listResources(server.value.name, server.value.config, signal);
    if (!listed.ok) return listed;
    return ok({ server: server.value.name, enabled: true, connected: listed.value.connected, resources: listed.value.resources });
  }

  public async callMcpTool(input: {
    readonly server: string;
    readonly tool: string;
    readonly arguments?: Readonly<Record<string, unknown>>;
    readonly descriptorFingerprint?: string;
    readonly catalogFingerprint?: string;
  }, signal?: AbortSignal, budget?: ResultBudget): Promise<Result<unknown>> {
    if (isAborted(signal)) return cancelledMcpCall();
    const server = await this.findServer(input.server);
    if (isAborted(signal)) return cancelledMcpCall();
    if (!server.ok) return server;
    if (!server.value.enabled) {
      return err(appError('PERMISSION_DENIED', `MCP server is disabled: ${input.server}`));
    }
    if (server.value.excluded) {
      return err(appError('PERMISSION_DENIED', server.value.exclusionReason ?? `MCP server is excluded: ${input.server}`));
    }
    if (input.descriptorFingerprint === undefined || input.catalogFingerprint === undefined) {
      return err(appError('PERMISSION_REQUIRED', 'Describe external MCP server and provide current contract fingerprints before calling it'));
    }
    const descriptorFingerprint = fingerprintExternalMcpValue({ source: server.value.source, config: server.value.config });
    if (input.descriptorFingerprint !== descriptorFingerprint) {
      return err(appError('CONFLICT', `External MCP contract fingerprint changed for ${server.value.name}; describe the server again before calling it`));
    }
    const expected = input.catalogFingerprint === undefined ? {} : { catalogFingerprint: input.catalogFingerprint };
    return this.sessions.call(
      server.value.name,
      server.value.config,
      input.tool,
      input.arguments ?? {},
      signal,
      expected,
      budget,
    );
  }

  public async close(): Promise<void> {
    this.closed = true;
    await this.sessions.close();
  }

  private async skillCatalog(): Promise<Result<SkillCatalog>> {
    const workspaceRoot = await this.workspaceRootProvider();
    let managedRoot: string | undefined;
    let managedRootMode: 'exclusive' | undefined;

    if (this.dataDir !== undefined) {
      const active = await new CanonicalSkillMigrationCutoverStateStore({ dataDir: this.dataDir })
        .resolveActiveGeneration();
      if (!active.ok) return err(active.error);
      if (active.value === undefined) {
        const reconciledBundled = await this.reconcileBundledSkillsIntoDirectStore();
        if (!reconciledBundled.ok) return err(reconciledBundled.error);
      }
      managedRoot = active.value?.managedRoot ?? path.join(this.dataDir, 'extensions', 'skills');
      managedRootMode = 'exclusive';
    }

    return ok(new SkillCatalog({
      settings: this.settingsProvider(),
      ...(this.homeDir === undefined ? {} : { homeDir: this.homeDir }),
      ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
      bundledRoots: this.bundledSkillRoots,
      ...(managedRoot === undefined ? {} : { managedRoot }),
      ...(managedRootMode === undefined ? {} : { managedRootMode }),
    }));
  }

  private async reconcileBundledSkillsIntoDirectStore(): Promise<Result<undefined>> {
    if (this.dataDir === undefined || this.bundledSkillRoots.length === 0) return ok(undefined);
    this.bundledSkillReconciliation ??= this.performBundledSkillReconciliation();
    return this.bundledSkillReconciliation;
  }

  private async performBundledSkillReconciliation(): Promise<Result<undefined>> {
    if (this.dataDir === undefined) return ok(undefined);

    const settings = this.settingsProvider();
    const bundledCatalog = new SkillCatalog({
      homeDir: path.join(this.dataDir, 'extensions', 'state', 'bundled-scan-home'),
      settings: { ...settings, extraSkillRoots: [] },
      bundledRoots: this.bundledSkillRoots,
    });
    const listed = await bundledCatalog.list({ source: 'bundled:agent-skills' });
    if (!listed.ok) return err(listed.error);

    const selectedByName = new Map<string, SkillSummary>();
    for (const skill of listed.value.skills) {
      if (!selectedByName.has(skill.name)) selectedByName.set(skill.name, skill);
    }
    if (selectedByName.size === 0) return ok(undefined);

    const registry = new CanonicalExtensionRegistry({ dataDir: this.dataDir });
    const registrySnapshot = await registry.load();
    if (!registrySnapshot.ok) return err(registrySnapshot.error);

    const installer = new InstallerService({
      dataDir: this.dataDir,
      ...(this.homeDir === undefined ? {} : { homeDir: this.homeDir }),
      ...(this.appDataDir === undefined ? {} : { appDataDir: this.appDataDir }),
    });

    for (const skill of selectedByName.values()) {
      const bundledDirectory = path.dirname(skill.skillPath);
      const bundledFingerprint = await fingerprintCanonicalSkillDirectory(bundledDirectory);
      if (!bundledFingerprint.ok) return err(bundledFingerprint.error);

      const canonicalId = `skill:${skill.name}`;
      const registryEntry = registrySnapshot.value.entries.find((entry) => (
        entry.kind === 'skill' && entry.id === canonicalId
      ));
      const managedDirectory = path.join(this.dataDir, 'extensions', 'skills', skill.name);
      const managedFingerprint = await fingerprintCanonicalSkillDirectory(managedDirectory);

      let shouldMaterialize = false;
      if (managedFingerprint.ok) {
        if (managedFingerprint.value === bundledFingerprint.value) {
          shouldMaterialize = registryEntry === undefined
            || registryEntry.provenance.some((source) => source.originType === 'bundled');
        } else {
          shouldMaterialize = registryEntry !== undefined
            && !registryEntry.conflict
            && registryEntry.fingerprint === managedFingerprint.value
            && registryEntry.provenance.some((source) => source.originType === 'bundled');
        }
      } else if (managedFingerprint.error.code === 'FILE_NOT_FOUND') {
        shouldMaterialize = registryEntry === undefined
          || registryEntry.provenance.some((source) => source.originType === 'bundled');
      } else {
        return err(managedFingerprint.error);
      }

      if (!shouldMaterialize) continue;
      const installed = await installer.installBundledSkill({
        name: skill.name,
        source: bundledDirectory,
      });
      if (!installed.ok) {
        if (installed.error.code === 'UNSUPPORTED_PLATFORM' || installed.error.code === 'EXECUTABLE_NOT_FOUND') {
          continue;
        }
        return err(installed.error);
      }
    }

    return ok(undefined);
  }

  private async loader(): Promise<Result<McpConfigLoader>> {
    const workspaceRoot = await this.workspaceRootProvider();
    let managedRegistryMode: 'exclusive' | undefined;
    let managedServers: readonly { readonly name: string; readonly config: import('./types.js').McpServerLaunchConfig }[] | undefined;

    if (this.dataDir !== undefined) {
      const active = await new CanonicalMcpMigrationCutoverStateStore({ dataDir: this.dataDir })
        .resolveActiveGeneration();
      if (!active.ok) return err(active.error);
      managedRegistryMode = 'exclusive';
      if (active.value !== undefined) {
        managedServers = active.value.stagedServers.map((server) => ({
          name: server.name,
          config: server.config,
        }));
      }
    }

    return ok(new McpConfigLoader({
      settings: this.settingsProvider(),
      ...(this.homeDir === undefined ? {} : { homeDir: this.homeDir }),
      ...(this.appDataDir === undefined ? {} : { appDataDir: this.appDataDir }),
      ...(this.dataDir === undefined ? {} : { dataDir: this.dataDir }),
      ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
      ...(managedRegistryMode === undefined ? {} : { managedRegistryMode }),
      ...(managedServers === undefined ? {} : { managedServers }),
    }));
  }

  private async discoverMcpServers(): Promise<Result<readonly DiscoveredMcpServer[]>> {
    const loader = await this.loader();
    if (!loader.ok) return err(loader.error);
    const discovered = await loader.value.discover();
    await this.sessions.reconcile(discovered);
    return ok(discovered);
  }

  private async findServer(name: string): Promise<Result<Awaited<ReturnType<McpConfigLoader['discover']>>[number]>> {
    const discovered = await this.discoverMcpServers();
    if (!discovered.ok) return err(discovered.error);
    const normalized = name.trim().toLowerCase();
    const server = discovered.value.find((entry) => entry.name.toLowerCase() === normalized);
    if (server === undefined) return err(appError('INVALID_INPUT', `Unknown MCP server: ${name}`));
    return ok(server);
  }
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function cancelledMcpCall(): Result<never> {
  return err(appError('PROCESS_TIMEOUT', 'Child MCP operation was cancelled before dispatch', true));
}
