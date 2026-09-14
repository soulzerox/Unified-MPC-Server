import type { Result } from '@unified-mpc/domain';

export type ExtensionsMode = 'enable_all' | 'allowlist';

export interface McpServerLaunchConfig {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly type?: string;
}

export interface ExtensionsSettings {
  readonly mode: ExtensionsMode;
  readonly disabledServers: readonly string[];
  readonly enabledServers: readonly string[];
  readonly disabledSkillRoots: readonly string[];
  readonly extraSkillRoots: readonly string[];
  readonly extraMcpServers: Readonly<Record<string, McpServerLaunchConfig>>;
  readonly mandatoryMcpServers: readonly string[];
}

export interface MandatoryMcpServerStatus {
  readonly name: string;
  readonly required: true;
  readonly connected: boolean;
  readonly pinned: boolean;
  readonly descriptorFingerprint?: string;
  readonly catalogFingerprint?: string;
  readonly tools: readonly string[];
  readonly error?: string;
}

export interface MandatoryMcpBootstrapResult {
  readonly ready: boolean;
  readonly servers: readonly MandatoryMcpServerStatus[];
}

export type ExtensionTrustTier = 'bundled' | 'workspace' | 'user' | 'external';

export interface SkillSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly source: string;
  readonly trustTier: ExtensionTrustTier;
  readonly rootPath: string;
  readonly skillPath: string;
  readonly canonicalSkillPath?: string;
}

export interface SkillContent {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly source: string;
  readonly trustTier: ExtensionTrustTier;
  readonly path: string;
  readonly canonicalPath?: string;
  readonly content: string;
}

export interface DiscoveredMcpServer {
  readonly name: string;
  readonly source: string;
  readonly enabled: boolean;
  readonly excluded: boolean;
  readonly exclusionReason?: string;
  readonly config: McpServerLaunchConfig;
}

export interface McpToolSummary {
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
}

export interface ExternalMcpContractDrift {
  readonly detected: boolean;
  readonly reasons: readonly ('launch_config' | 'tool_catalog')[];
  readonly previousCatalogFingerprint?: string;
}

export interface ExternalMcpProvenance {
  readonly source: string;
  readonly trustTier: 'external';
  readonly namespace: string;
  readonly descriptorFingerprint: string;
  readonly catalogFingerprint: string;
  readonly drift: ExternalMcpContractDrift;
}

export interface McpResourceSummary {
  readonly uri: string;
  readonly name?: string;
  readonly description?: string;
  readonly mimeType?: string;
}

export interface ExtensionsService {
  listSkills(input: { readonly query?: string; readonly source?: string }): Promise<Result<{ readonly skills: readonly SkillSummary[] }>>;
  readSkill(input: { readonly skillId: string; readonly relativePath?: string }): Promise<Result<SkillContent>>;
  listMcpServers(): Promise<Result<{ readonly servers: readonly McpServerListItem[] }>>;
  bootstrapMandatoryMcpServers(signal?: AbortSignal): Promise<Result<MandatoryMcpBootstrapResult>>;
  describeMcpServer(input: { readonly server: string }, signal?: AbortSignal): Promise<Result<{
    readonly server: string;
    readonly enabled: boolean;
    readonly connected: boolean;
    readonly provenance: ExternalMcpProvenance;
    readonly tools: readonly (McpToolSummary & { readonly qualifiedName: string })[];
  }>>;
  listMcpResources(input: { readonly server: string }, signal?: AbortSignal): Promise<Result<{
    readonly server: string;
    readonly enabled: boolean;
    readonly connected: boolean;
    readonly resources: readonly McpResourceSummary[];
  }>>;
  callMcpTool(input: {
    readonly server: string;
    readonly tool: string;
    readonly arguments?: Readonly<Record<string, unknown>>;
    readonly descriptorFingerprint?: string;
    readonly catalogFingerprint?: string;
  }, signal?: AbortSignal): Promise<Result<unknown>>;
  close(): Promise<void>;
}

export interface McpServerListItem {
  readonly name: string;
  readonly source: string;
  readonly enabled: boolean;
  readonly connected: boolean;
  readonly pinned: boolean;
  readonly required: boolean;
  readonly excluded: boolean;
  readonly exclusionReason?: string;
  readonly command: string;
}

export const DEFAULT_MANDATORY_MCP_SERVERS = Object.freeze(['memory', 'thai-rag-mcp', 'godkiller'] as const);

export const DEFAULT_EXTENSIONS_SETTINGS: ExtensionsSettings = Object.freeze({
  mode: 'enable_all',
  disabledServers: Object.freeze([]),
  enabledServers: Object.freeze([]),
  disabledSkillRoots: Object.freeze([]),
  extraSkillRoots: Object.freeze([]),
  extraMcpServers: Object.freeze({}),
  mandatoryMcpServers: DEFAULT_MANDATORY_MCP_SERVERS,
});
