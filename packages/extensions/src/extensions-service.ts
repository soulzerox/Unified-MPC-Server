import { appError, err, ok, type Result } from '@unified-mpc/domain';
import { McpConfigLoader } from './mcp-config-loader.js';
import { fingerprintExternalMcpValue, McpSessionManager, type McpClientFactory } from './mcp-session-manager.js';
import { SkillCatalog } from './skill-catalog.js';
import type {
  ExtensionsService,
  ExtensionsSettings,
  McpServerListItem,
  SkillContent,
  SkillSummary,
} from './types.js';

export interface LocalExtensionsServiceOptions {
  readonly settings: ExtensionsSettings;
  readonly settingsProvider?: () => ExtensionsSettings;
  readonly homeDir?: string;
  readonly appDataDir?: string;
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
  private readonly workspaceRootProvider: () => Promise<string | undefined>;
  private readonly bundledSkillRoots: readonly string[];
  private readonly sessions: McpSessionManager;

  public constructor(options: LocalExtensionsServiceOptions) {
    this.settingsProvider = options.settingsProvider ?? ((): ExtensionsSettings => options.settings);
    this.homeDir = options.homeDir;
    this.appDataDir = options.appDataDir;
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
    return catalog.list(input);
  }

  public async readSkill(input: { readonly skillId: string; readonly relativePath?: string }): Promise<Result<SkillContent>> {
    const catalog = await this.skillCatalog();
    return catalog.read(input);
  }

  public async listMcpServers(): Promise<Result<{ readonly servers: readonly McpServerListItem[] }>> {
    const discovered = await this.loader().then((loader) => loader.discover());
    const required = new Set(this.settingsProvider().mandatoryMcpServers.map((name) => name.trim().toLowerCase()));
    return ok({
      servers: discovered.map((server) => ({
        name: server.name,
        source: server.source,
        enabled: server.enabled,
        connected: this.sessions.isConnected(server.name),
        pinned: this.sessions.isPinned(server.name),
        required: required.has(server.name.toLowerCase()),
        excluded: server.excluded,
        ...(server.exclusionReason === undefined ? {} : { exclusionReason: server.exclusionReason }),
        command: server.config.command,
      })),
    });
  }

  public async bootstrapMandatoryMcpServers(signal?: AbortSignal): Promise<Result<import('./types.js').MandatoryMcpBootstrapResult>> {
    const names = [...new Set(this.settingsProvider().mandatoryMcpServers.map((name) => name.trim()).filter(Boolean))];
    const requiredNames = new Set(names.map((name) => name.toLowerCase()));
    const discovered = await this.loader().then((loader) => loader.discover());
    for (const server of discovered) {
      if (!requiredNames.has(server.name.toLowerCase())) this.sessions.unpin(server.name);
    }
    const servers = await Promise.all(names.map(async (name) => {
      if (isAborted(signal)) return { name, required: true as const, connected: false, pinned: false, tools: [], error: 'cancelled' };
      const server = await this.findServer(name);
      if (!server.ok) return { name, required: true as const, connected: false, pinned: false, tools: [], error: server.error.message };
      if (!server.value.enabled || server.value.excluded) {
        return {
          name,
          required: true as const,
          connected: false,
          pinned: false,
          tools: [],
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
          error: `Refusing to promote workspace-scoped MCP server into the mandatory native harness: ${server.value.name}`,
        };
      }
      const described = await this.sessions.describe(server.value.name, server.value.config, signal);
      if (!described.ok) return { name, required: true as const, connected: false, pinned: false, tools: [], error: described.error.message };
      this.sessions.pin(server.value.name);
      return {
        name: server.value.name,
        required: true as const,
        connected: true,
        pinned: true,
        descriptorFingerprint: fingerprintExternalMcpValue({ source: server.value.source, config: server.value.config }),
        catalogFingerprint: described.value.catalogFingerprint,
        tools: described.value.tools.map((tool) => tool.name),
      };
    }));
    return ok({ ready: servers.every((server) => server.connected && server.pinned), servers });
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
  }, signal?: AbortSignal): Promise<Result<unknown>> {
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
    );
  }

  public close(): Promise<void> {
    return this.sessions.close();
  }

  private async skillCatalog(): Promise<SkillCatalog> {
    const workspaceRoot = await this.workspaceRootProvider();
    return new SkillCatalog({
      settings: this.settingsProvider(),
      ...(this.homeDir === undefined ? {} : { homeDir: this.homeDir }),
      ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
      bundledRoots: this.bundledSkillRoots,
    });
  }

  private async loader(): Promise<McpConfigLoader> {
    const workspaceRoot = await this.workspaceRootProvider();
    return new McpConfigLoader({
      settings: this.settingsProvider(),
      ...(this.homeDir === undefined ? {} : { homeDir: this.homeDir }),
      ...(this.appDataDir === undefined ? {} : { appDataDir: this.appDataDir }),
      ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
    });
  }

  private async findServer(name: string): Promise<Result<Awaited<ReturnType<McpConfigLoader['discover']>>[number]>> {
    const discovered = await this.loader().then((loader) => loader.discover());
    const normalized = name.trim().toLowerCase();
    const server = discovered.find((entry) => entry.name.toLowerCase() === normalized);
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
