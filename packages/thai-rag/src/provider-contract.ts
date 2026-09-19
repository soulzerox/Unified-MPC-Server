import { appError, err, ok, type Result } from '@unified-mpc/domain';
import { THAI_RAG_PROVIDER_ID, type CanonicalWorkspaceId } from './canonical-workspace.js';

/** Bumped whenever the structured health contract changes shape for consumers (#3). */
export const THAI_RAG_PROVIDER_SCHEMA_VERSION = 1;
export const THAI_RAG_CONTRACT_VERSION = '1.0';
export const THAI_RAG_INDEX_JOB_CONTRACT_VERSION = '1.0';
export const THAI_RAG_CONTRACT_FINGERPRINT = 'c271073944e379a4932a3377a351dc7d45f421f4866e404eda277ec0f0bfa1bc';
export const THAI_RAG_PRODUCTION_BRIDGE = 'thai-rag-provider-1.0-production-bridge';
export const THAI_RAG_CONFORMANCE_FIXTURE_VERSION = '1.0';
export const THAI_RAG_EMBEDDING_PROFILE = 'nomic-embed-text-v2-moe';
export const THAI_RAG_CONFORMANCE_OPERATIONS = [
  'remember', 'recall', 'record_event', 'forget', 'pre_edit_context', 'code_search',
  'code_context', 'code_blast_radius', 'code_index', 'index_status', 'health', 'version',
] as const;
export const THAI_RAG_REQUIRED_CAPABILITIES = THAI_RAG_CONFORMANCE_OPERATIONS;

export interface ThaiRagProviderHandshake {
  readonly providerId: typeof THAI_RAG_PROVIDER_ID;
  readonly providerVersion: string;
  readonly contractVersion: string;
  readonly compatibilityRange: { readonly min: string; readonly max: string };
  readonly contractFingerprint: string;
  readonly indexJobContractVersion: string;
  readonly capabilities: readonly string[];
  readonly workspaceScopeModel: 'explicit_workspace_id' | string;
  readonly health: 'ready' | 'degraded' | 'unavailable' | string;
  readonly embedding: {
    readonly profile: string;
    readonly model: string;
    readonly dimension: number;
    readonly preprocessingVersion?: string;
  };
  readonly generation: {
    readonly contract: string;
    readonly embedding: string;
    readonly index: string;
    readonly storage: string;
  };
  readonly workspaceId?: string;
  readonly workspaceReady?: boolean;
  readonly embeddingIndexGeneration: number;
  readonly components?: ThaiRagProviderComponents;
  readonly legacyAdapter?: string;
}

export interface ThaiRagHandshakeValidationOptions {
  readonly workspaceId?: string;
  readonly embeddingIndexGeneration?: number;
  readonly allowLegacyAdapter?: boolean;
  readonly expectedEmbeddingProfile?: string;
  readonly expectedEmbeddingModel?: string;
  readonly expectedPreprocessingVersion?: string;
}

export type ThaiRagProviderLifecycleState = 'stopped' | 'starting' | 'ready' | 'degraded' | 'stopping';

const ALLOWED_LIFECYCLE_TRANSITIONS: Readonly<
  Record<ThaiRagProviderLifecycleState, readonly ThaiRagProviderLifecycleState[]>
> = {
  stopped: ['starting'],
  starting: ['ready', 'degraded', 'stopped'],
  ready: ['degraded', 'stopping', 'starting'],
  degraded: ['ready', 'stopping', 'starting'],
  stopping: ['stopped'],
};

export interface ThaiRagWorkspaceScopeHealth {
  readonly workspaceId: CanonicalWorkspaceId;
  readonly indexGeneration: number;
  readonly ready: boolean;
  readonly reason?: string;
}

export interface ThaiRagProviderComponents {
  readonly workerReachable: boolean;
  readonly sqliteAvailable: boolean;
  readonly ftsAvailable: boolean;
  readonly vectorStoreAvailable: boolean;
  readonly embedderAvailable: boolean;
  readonly lexicalRetrievalAvailable: boolean;
  readonly semanticRetrievalAvailable: boolean;
  readonly activeJobs: readonly string[];
}

/**
 * Structured provider health contract: startup/readiness/restart/shutdown state,
 * provider and index generation identity, and per-workspace scope readiness.
 * Observability (#3) consumes this contract instead of a static connected flag.
 */
export interface ThaiRagProviderHealth {
  readonly schemaVersion: typeof THAI_RAG_PROVIDER_SCHEMA_VERSION;
  readonly providerId: typeof THAI_RAG_PROVIDER_ID;
  readonly providerVersion: string;
  readonly state: ThaiRagProviderLifecycleState;
  readonly embeddingIndexGeneration: number;
  readonly startedAt?: string;
  readonly readyAt?: string;
  /** Holder of the single-owner provider lease when one is enforced. */
  readonly ownerId?: string;
  readonly degradation?: readonly string[];
  readonly components?: ThaiRagProviderComponents;
  readonly workspaces?: readonly ThaiRagWorkspaceScopeHealth[];
}

export function transitionProviderState(
  from: ThaiRagProviderLifecycleState,
  to: ThaiRagProviderLifecycleState,
): Result<ThaiRagProviderLifecycleState> {
  if (ALLOWED_LIFECYCLE_TRANSITIONS[from].includes(to)) return ok(to);
  return err(appError(
    'CONFLICT',
    `Unsupported Thai-RAG provider lifecycle transition: ${from} -> ${to}`,
    true,
  ));
}

export function createProviderHealth(
  providerVersion: string,
  embeddingIndexGeneration: number,
): ThaiRagProviderHealth {
  return {
    schemaVersion: THAI_RAG_PROVIDER_SCHEMA_VERSION,
    providerId: THAI_RAG_PROVIDER_ID,
    providerVersion,
    state: 'stopped',
    embeddingIndexGeneration,
  };
}

export function isProviderHealthReady(health: ThaiRagProviderHealth): boolean {
  return health.state === 'ready' && (health.degradation ?? []).length === 0;
}

export function validateThaiRagHandshake(
  handshake: ThaiRagProviderHandshake,
  options: ThaiRagHandshakeValidationOptions = {},
): Result<ThaiRagProviderHandshake> {
  const fail = (reason: string, message: string): Result<ThaiRagProviderHandshake> => err(appError(
    'CONFLICT',
    `Thai-RAG provider handshake rejected: ${message}`,
    true,
    { reason, providerId: handshake.providerId, contractVersion: handshake.contractVersion },
  ));
  const legacy = handshake.contractVersion !== THAI_RAG_CONTRACT_VERSION;
  const productionBridge = options.allowLegacyAdapter === true && handshake.legacyAdapter === THAI_RAG_PRODUCTION_BRIDGE;
  if (legacy && !productionBridge) {
    return fail('contract-version-mismatch', `unsupported contract version ${handshake.contractVersion}`);
  }
  if (handshake.providerId !== THAI_RAG_PROVIDER_ID) return fail('provider-id-mismatch', `unexpected provider ${handshake.providerId}`);
  if (handshake.contractFingerprint !== THAI_RAG_CONTRACT_FINGERPRINT) return fail('fingerprint-mismatch', 'contract fingerprint does not match supported conformance fixture');
  if (handshake.indexJobContractVersion !== THAI_RAG_INDEX_JOB_CONTRACT_VERSION) return fail('index-job-contract-mismatch', 'index job contract version is unsupported');
  if (!isCompatibleRange(handshake.compatibilityRange)) return fail('compatibility-range-invalid', 'compatibility range does not include supported contract version');
  if (handshake.workspaceScopeModel !== 'explicit_workspace_id') return fail('workspace-scope-model-mismatch', 'canonical workspace_id scope is required');
  const missing = THAI_RAG_REQUIRED_CAPABILITIES.filter((capability) => !handshake.capabilities.includes(capability));
  if (missing.length > 0) return fail('missing-capability', `required capabilities missing: ${missing.join(', ')}`);
  if (handshake.health === 'unavailable') return fail('health-unavailable', 'provider health is unavailable');
  if (handshake.health === 'degraded') {
    const components = handshake.components;
    if (components === undefined || !components.workerReachable || !components.sqliteAvailable || !components.ftsAvailable || !components.lexicalRetrievalAvailable) {
      return fail('health-degraded', 'degraded provider lacks required native capabilities');
    }
  } else if (handshake.health !== 'ready') return fail('health-degraded', `provider health is ${handshake.health}`);
  if (handshake.workspaceId !== undefined && handshake.workspaceReady !== true) return fail('workspace-scope-unavailable', `provider did not confirm workspace ${handshake.workspaceId}`);
  if (options.workspaceId !== undefined && (handshake.workspaceId !== options.workspaceId || handshake.workspaceReady !== true)) {
    return fail('workspace-scope-unavailable', `provider did not confirm workspace ${options.workspaceId}`);
  }
  if (options.embeddingIndexGeneration !== undefined && handshake.embeddingIndexGeneration !== options.embeddingIndexGeneration) {
    return fail('generation-drift', `provider generation ${handshake.embeddingIndexGeneration} does not match expected ${options.embeddingIndexGeneration}`);
  }
  if (handshake.generation.contract !== THAI_RAG_CONTRACT_FINGERPRINT || handshake.generation.embedding !== handshake.embedding.profile || (handshake.generation.index !== 'unknown' && handshake.generation.index !== String(handshake.embeddingIndexGeneration))) {
    return fail('generation-drift', 'active generation metadata does not match handshake embedding or contract identity');
  }
  if (!Number.isSafeInteger(handshake.embedding.dimension) || handshake.embedding.dimension <= 0) return fail('embedding-metadata-invalid', 'embedding dimension is invalid');
  if (handshake.embedding.preprocessingVersion !== undefined && handshake.embedding.preprocessingVersion.trim().length === 0) return fail('embedding-metadata-invalid', 'embedding preprocessing version is invalid');
  if (options.expectedEmbeddingProfile !== undefined && handshake.embedding.profile !== options.expectedEmbeddingProfile && !handshake.embedding.profile.startsWith(`${options.expectedEmbeddingProfile}:`)) return fail('embedding-metadata-invalid', 'embedding profile is unsupported');
  if (options.expectedEmbeddingModel !== undefined && handshake.embedding.model !== options.expectedEmbeddingModel) return fail('embedding-metadata-invalid', 'embedding model is unsupported');
  if (options.expectedPreprocessingVersion !== undefined && handshake.embedding.preprocessingVersion !== undefined && handshake.embedding.preprocessingVersion !== options.expectedPreprocessingVersion) return fail('embedding-metadata-invalid', 'embedding preprocessing version is unsupported');
  if (!isEmbeddingModelMetadataValid(handshake.embedding.profile, handshake.embedding.model)) return fail('embedding-metadata-invalid', 'embedding model does not match embedding profile');
  return ok(handshake);
}

/**
 * Incompatible embedding/index generations must be detected rather than mixed:
 * a workspace index may only be served when its generation matches the
 * provider's active embedding index generation.
 */
function isCompatibleRange(range: ThaiRagProviderHandshake['compatibilityRange']): boolean {
  const version = parseVersion(THAI_RAG_CONTRACT_VERSION);
  const min = parseVersion(range.min);
  const max = range.max.endsWith('.x') ? [Number(range.max.slice(0, -2)), Number.POSITIVE_INFINITY] : parseVersion(range.max);
  return version !== undefined && min !== undefined && max !== undefined
    && min[0] <= version[0] && (min[0] < version[0] || min[1] <= version[1])
    && (max[0] > version[0] || (max[0] === version[0] && max[1] >= version[1]));
}

function parseVersion(value: string): readonly [number, number] | undefined {
  const match = /^(\d+)\.(\d+)$/.exec(value);
  return match === null ? undefined : [Number(match[1]), Number(match[2])];
}

function isEmbeddingModelMetadataValid(profile: string, model: string): boolean {
  if (profile.trim().length === 0 || model.trim().length === 0) return false;
  const [modelName, digest] = model.split('@sha256:');
  return modelName === profile && (digest === undefined || /^[a-f0-9]{3,}$/i.test(digest));
}

export function isEmbeddingIndexGenerationCompatible(
  providerGeneration: number,
  workspaceGeneration: number,
): boolean {
  return Number.isInteger(providerGeneration)
    && providerGeneration >= 1
    && Number.isInteger(workspaceGeneration)
    && workspaceGeneration >= 1
    && providerGeneration === workspaceGeneration;
}
