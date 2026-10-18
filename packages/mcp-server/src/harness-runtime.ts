import { createHash } from 'node:crypto';
import { classifyWorkspaceSourceEvidence, type WorkspaceSourceEvidenceIdentity } from '@unified-mpc/domain';
import type { MandatoryMcpBootstrapResult, MandatoryMcpServerStatus } from '@unified-mpc/extensions';

export interface HarnessActivationContext {
  readonly sessionId: string;
  readonly workspaceId: string;
}

/**
 * #346 behaviour 8: the bounded exact inputs a prepared path was authorized on.
 *
 * The ledger keeps this next to the prepared path so an authorization cannot
 * outlive the view, target content or harness it was granted for. It carries
 * fixed-shape metadata only, and is dropped whenever the admitted source view
 * changes, the path is consumed by a mutation, or the harness is invalidated.
 *
 * ponytail: in-process, per session — enough for the current enforcement seam.
 * Persist it through the #142 durable gate engine when that lands.
 */
export interface PreparationReceipt {
  readonly path: string;
  readonly workspaceId: string;
  readonly targetContentHash: string;
  readonly sourceIdentity?: WorkspaceSourceEvidenceIdentity;
  readonly evidenceProviderId?: string;
  readonly evidenceIndexGeneration?: number;
  readonly evidenceState: string;
  readonly checks: readonly string[];
  readonly preparedAt: string;
}

export interface HarnessActivationState {
  readonly harnessFingerprint: string;
  readonly agentsMdHash: string;
  readonly mandatoryMcp: MandatoryMcpBootstrapResult;
  readonly preparedPaths: ReadonlySet<string>;
  readonly preparations: ReadonlyMap<string, PreparationReceipt>;
  readonly sourceIdentity?: WorkspaceSourceEvidenceIdentity;
}

export class HarnessActivationLedger {
  private readonly states = new Map<string, HarnessActivationState>();

  public state(context: HarnessActivationContext): HarnessActivationState | undefined {
    return this.states.get(key(context));
  }

  public markBootstrapped(
    context: HarnessActivationContext,
    agentsMdHash: string,
    mandatoryMcp: MandatoryMcpBootstrapResult,
    sourceIdentity?: WorkspaceSourceEvidenceIdentity,
  ): HarnessActivationState {
    const state: HarnessActivationState = {
      harnessFingerprint: fingerprintHarness(agentsMdHash, mandatoryMcp.servers),
      agentsMdHash,
      mandatoryMcp,
      preparedPaths: new Set<string>(),
      preparations: new Map<string, PreparationReceipt>(),
      ...(sourceIdentity === undefined ? {} : { sourceIdentity }),
    };
    this.states.set(key(context), state);
    return state;
  }

  public preparePath(context: HarnessActivationContext, path: string, receipt?: PreparationReceipt): HarnessActivationState | undefined {
    const current = this.state(context);
    if (current === undefined) return undefined;
    const preparedPaths = new Set(current.preparedPaths);
    preparedPaths.add(normalizePath(path));
    const preparations = new Map(current.preparations);
    if (receipt !== undefined) preparations.set(normalizePath(path), receipt);
    const next = { ...current, preparedPaths, preparations };
    this.states.set(key(context), next);
    return next;
  }

  public preparation(context: HarnessActivationContext, path: string): PreparationReceipt | undefined {
    return this.state(context)?.preparations.get(normalizePath(path));
  }

  public isPathPrepared(context: HarnessActivationContext, path: string): boolean {
    return this.state(context)?.preparedPaths.has(normalizePath(path)) === true;
  }

  public synchronizeSource(context: HarnessActivationContext, sourceIdentity: WorkspaceSourceEvidenceIdentity): boolean {
    const current = this.state(context);
    if (current === undefined) return false;
    if (classifyWorkspaceSourceEvidence(current.sourceIdentity, sourceIdentity) === 'fresh') return false;
    // A new view invalidates every authorization and receipt granted for the old one.
    this.states.set(key(context), {
      ...current,
      sourceIdentity,
      preparedPaths: new Set<string>(),
      preparations: new Map<string, PreparationReceipt>(),
    });
    return true;
  }

  public consumePath(context: HarnessActivationContext, path: string): void {
    const current = this.state(context);
    if (current === undefined) return;
    const preparedPaths = new Set(current.preparedPaths);
    preparedPaths.delete(normalizePath(path));
    const preparations = new Map(current.preparations);
    preparations.delete(normalizePath(path));
    this.states.set(key(context), { ...current, preparedPaths, preparations });
  }

  public invalidate(context: HarnessActivationContext): void {
    this.states.delete(key(context));
  }

  public invalidateSession(sessionId: string): void {
    const prefix = `${sessionId}\u0000`;
    for (const stateKey of this.states.keys()) {
      if (stateKey.startsWith(prefix)) this.states.delete(stateKey);
    }
  }
}

export function hashHarnessText(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function fingerprintHarness(agentsMdHash: string, servers: readonly MandatoryMcpServerStatus[]): string {
  const contracts = [...servers]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((server) => [server.name, server.connected, server.pinned, server.descriptorFingerprint ?? '', server.catalogFingerprint ?? '']);
  return createHash('sha256').update(JSON.stringify({ agentsMdHash, contracts }), 'utf8').digest('hex');
}

export function codeMutationPaths(toolName: string, input: unknown): readonly string[] {
  if (!isRecord(input)) return [];
  const paths: string[] = [];
  const push = (value: unknown): void => { if (typeof value === 'string' && value.trim().length > 0) paths.push(value.trim()); };
  if (toolName === 'write_file' || toolName === 'edit_file' || toolName === 'delete_file') push(input.path);
  else if (toolName === 'move_file' || toolName === 'copy_file') { push(input.sourcePath); push(input.destinationPath); }
  else if (toolName === 'apply_patch' && Array.isArray(input.files)) {
    for (const entry of input.files) if (isRecord(entry)) push(entry.path);
  } else if (toolName === 'lsp_rename') push(input.file);
  return paths.filter(isDevelopmentArtifactPath);
}

function isDevelopmentArtifactPath(value: string): boolean {
  const basename = normalizePath(value).split('/').at(-1) ?? '';
  if (/\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|kts|cs|c|cc|cpp|h|hpp|swift|rb|php|vue|svelte|sql|proto|graphql|gql)$/.test(basename)) return true;
  if (['package.json', 'dockerfile', 'makefile', 'cargo.toml'].includes(basename)) return true;
  if (/^tsconfig(?:\.[^.]+)?\.json$/.test(basename)) return true;
  return /^[^.]+\.config\.(?:js|cjs|mjs|ts|json|ya?ml|toml)$/.test(basename);
}

function normalizePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase();
}

function key(context: HarnessActivationContext): string {
  return `${context.sessionId}\u0000${context.workspaceId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
