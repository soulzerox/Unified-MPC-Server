import { createHash } from 'node:crypto';
import { classifyWorkspaceSourceEvidence, type WorkspaceSourceEvidenceIdentity } from '@unified-mpc/domain';
import type { MandatoryMcpBootstrapResult, MandatoryMcpServerStatus } from '@unified-mpc/extensions';
import type { MutationPolicyDecision } from './mutation-policy.js';

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
  readonly evidenceSemantic?: string;
  readonly evidenceChannels?: Readonly<Record<string, string>>;
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
    preparedPaths.add(normalizeHarnessPath(path));
    const preparations = new Map(current.preparations);
    if (receipt !== undefined) preparations.set(normalizeHarnessPath(path), receipt);
    const next = { ...current, preparedPaths, preparations };
    this.states.set(key(context), next);
    return next;
  }

  public preparation(context: HarnessActivationContext, path: string): PreparationReceipt | undefined {
    return this.state(context)?.preparations.get(normalizeHarnessPath(path));
  }

  public isPathPrepared(context: HarnessActivationContext, path: string): boolean {
    return this.state(context)?.preparedPaths.has(normalizeHarnessPath(path)) === true;
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
    preparedPaths.delete(normalizeHarnessPath(path));
    const preparations = new Map(current.preparations);
    preparations.delete(normalizeHarnessPath(path));
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

/**
 * The tools whose request spells the artifact paths. One table, because the
 * mutate gate decides from this list whether a request names its own subject:
 * a tool that extracts a path here and resolves to `opaque` in
 * `mutation-subject.ts` would keep its mutation ungated, so the list cannot be
 * duplicated on the other side of that seam.
 */
const PATH_EXTRACTORS: Readonly<Record<string, (input: Record<string, unknown>, push: (value: unknown) => void) => void>> = {
  write_file: (input, push) => push(input.path),
  edit_file: (input, push) => push(input.path),
  delete_file: (input, push) => push(input.path),
  move_file: (input, push) => { push(input.sourcePath); push(input.destinationPath); },
  copy_file: (input, push) => { push(input.sourcePath); push(input.destinationPath); },
  apply_patch: (input, push) => {
    if (!Array.isArray(input.files)) return;
    for (const entry of input.files) if (isRecord(entry)) push(entry.path);
  },
  lsp_rename: (input, push) => push(input.file),
};

export function isPathExtractorTool(toolName: string): boolean {
  return Object.hasOwn(PATH_EXTRACTORS, toolName);
}

/**
 * Why a mutation has no subject the gate can prepare. `shape` says the phase's
 * extractor table cannot turn this request into an artifact — a command, a
 * document action it does not model, a host scheduler entry. `unresolved` says
 * the request did name a subject (`recoveryId`, `checkpointId`) that no store
 * could answer for. The two are recorded differently because they are fixed
 * differently: the first is a limit of the tool shape, the second is a store
 * that could not answer.
 */
export type OpaqueMutationReason = 'shape' | 'unresolved';

/**
 * The tools whose request names a stored subject instead of an artifact path.
 * They live next to the path extractors because the mutate gate needs one
 * answer to "does this request name its own subject?" and the two halves of
 * that answer must not drift apart.
 */
export const RECOVERY_MUTATION_TOOLS: ReadonlySet<string> = new Set(['restore_deleted_file', 'restore_recovery_item']);
export const CHECKPOINT_MUTATION_TOOLS: ReadonlySet<string> = new Set(['restore_checkpoint']);

export function isRestoreMutationTool(toolName: string): boolean {
  return RECOVERY_MUTATION_TOOLS.has(toolName) || CHECKPOINT_MUTATION_TOOLS.has(toolName);
}

/**
 * The tools the registry scopes to the active workspace because they mutate
 * local state. `requiresActiveWorkspaceScope` asks this same set, so "a local
 * mutation" has one definition: the set a mutating call is scoped by is also
 * the set the mutate phase decides.
 */
export const LOCAL_MUTATION_TOOLS: ReadonlySet<string> = new Set(['write_file', 'apply_patch', 'edit_file', 'move_file', 'copy_file', 'delete_file', 'restore_deleted_file', 'restore_recovery_item', 'restore_checkpoint', 'git', 'publish_approve', 'git_publish', 'shell', 'wsl_exec', 'process_start', 'process_stop', 'codex_run', 'codex_stop', 'agent_swarm_run', 'office', 'office_ppt', 'docx_merge', 'git_worktree_spawn', 'git_worktree_remove', 'self_heal_apply']);

/**
 * Tools that mutate host state instead of a workspace. They belong in the mutate
 * phase's reach for the same reason a command does, but not in
 * `LOCAL_MUTATION_TOOLS`: that set is also the registry's answer to "must this
 * call be scoped to an Active Project?", and a scheduled task names no
 * workspace. Scoping it to one would invent a `workspaceId` its request cannot
 * carry.
 */
export const HOST_MUTATION_TOOLS: ReadonlySet<string> = new Set(['scheduler']);

/**
 * Output media the registry scopes only when the policy says the call replaces a
 * target. They are also an input to the mutate phase's reach: a recording writes
 * a workspace file through `output_path`, a field the extractor table does not
 * name, so a `refuse` workspace would otherwise admit a write it says it refuses.
 */
export const LOCAL_OUTPUT_REPLACEMENT_TOOLS: ReadonlySet<string> = new Set(['audio', 'screen_record']);

/**
 * Tools that run caller-supplied work under a name of their own: a durable
 * background shell task and its cancellation, and an agent delegation and its
 * cancellation. They are the same effect as `process_start`, `process_stop` and
 * `agent_swarm_run` under a second spelling, so leaving them out would let the
 * strict posture be bypassed by a rename rather than by a decision. They are not
 * in `LOCAL_MUTATION_TOOLS` because that set also answers "must this call be
 * scoped to an Active Project?", and a background task names no workspace.
 */
export const ALIASED_WORK_MUTATION_TOOLS: ReadonlySet<string> = new Set([
  'task_create', 'task_cancel', 'delegate', 'parallel_delegate', 'delegate_cancel',
]);

export function requiresActiveWorkspaceScope(toolName: string, decision: MutationPolicyDecision): boolean {
  return decision.kind !== 'read' && (LOCAL_MUTATION_TOOLS.has(toolName) || (decision.kind === 'replace' && LOCAL_OUTPUT_REPLACEMENT_TOOLS.has(toolName)));
}

/**
 * The mutate phase's reach: every workspace, host-task, media or aliased-work
 * mutation the phase cannot turn into a path — no extractor table answers for
 * its request, and no store names its subject. It is derived rather than listed,
 * so adding a tool to any of the four input sets extends the phase and there is
 * no second list to forget.
 *
 * The line is deliberate: gateway-mediated calls and desktop effects
 * (`mcp_call`, `computer_use`, `web_fetch`, `dom_cdp`, the UI tools) are not
 * workspace mutations, so their refusal stays with the mutation policy's own
 * `opaque_mutation` vocabulary instead of becoming a second gate that would also
 * refuse reads.
 */
export const OPAQUE_MUTATION_TOOL_NAMES: readonly string[] = [
  ...LOCAL_MUTATION_TOOLS,
  ...HOST_MUTATION_TOOLS,
  ...LOCAL_OUTPUT_REPLACEMENT_TOOLS,
  ...ALIASED_WORK_MUTATION_TOOLS,
]
  .filter((tool) => !isPathExtractorTool(tool) && !isRestoreMutationTool(tool))
  .sort();
const OPAQUE_MUTATION_TOOLS = new Set(OPAQUE_MUTATION_TOOL_NAMES);

export function isOpaqueMutationTool(toolName: string): boolean {
  return OPAQUE_MUTATION_TOOLS.has(toolName);
}

export function codeMutationPaths(toolName: string, input: unknown): readonly string[] {
  if (!isRecord(input)) return [];
  const extract = isPathExtractorTool(toolName) ? PATH_EXTRACTORS[toolName] : undefined;
  if (extract === undefined) return [];
  const paths: string[] = [];
  const push = (value: unknown): void => { if (typeof value === 'string' && value.trim().length > 0) paths.push(value.trim()); };
  extract(input, push);
  return paths.filter(isDevelopmentArtifactPath);
}

export function isDevelopmentArtifactPath(value: string): boolean {
  // Classification is about what the file *is*, so it is case-insensitive on
  // every platform: `Dockerfile`, `Makefile` and `Cargo.toml` are the same
  // artifact whatever case the author used. Identity is separate — see
  // normalizeHarnessPath — and stays case-preserving outside win32.
  const basename = normalizeHarnessPath(value).split('/').at(-1)?.toLowerCase() ?? '';
  if (/\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|kts|cs|c|cc|cpp|h|hpp|swift|rb|php|vue|svelte|sql|proto|graphql|gql)$/.test(basename)) return true;
  if (['package.json', 'dockerfile', 'makefile', 'cargo.toml'].includes(basename)) return true;
  if (/^tsconfig(?:\.[^.]+)?\.json$/.test(basename)) return true;
  return /^[^.]+\.config\.(?:js|cjs|mjs|ts|json|ya?ml|toml)$/.test(basename);
}

/**
 * One spelling for a workspace-relative path: forward slashes and no leading
 * `./`. Prepared evidence, the ledger and the mutate gate all compare through
 * this, so the same file written two ways is one preparation.
 *
 * Case is folded only where the filesystem folds it. On a case-sensitive
 * workspace `src/App.ts` and `src/app.ts` are two files, and treating them as
 * one would let a preparation for either authorize a mutation of the other
 * with no pre-edit evidence for the file actually written.
 */
export function normalizeHarnessPath(value: string): string {
  // `\` is a separator only where the platform says it is; on POSIX it is a
  // legal filename character, and folding it would alias two different files
  // the way case folding did. Case is folded only on win32: darwin is usually
  // case-insensitive too, but guessing that here would refuse a preparation
  // for `src/App.ts` when the file is `src/app.ts` — an extra refusal, never a
  // bypass, so the conservative direction is to keep what the caller typed.
  const unified = process.platform === 'win32' ? value.replaceAll('\\', '/') : value;
  const trimmed = unified.startsWith('./') ? unified.slice(2) : unified;
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
}

function key(context: HarnessActivationContext): string {
  return `${context.sessionId}\u0000${context.workspaceId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
