import { appError, err, ok, type Result } from '@unified-mpc/domain';
import { THAI_RAG_PROVIDER_ID, type CanonicalWorkspaceId } from './canonical-workspace.js';

/** Bumped whenever the structured health contract changes shape for consumers (#3). */
export const THAI_RAG_PROVIDER_SCHEMA_VERSION = 1;
export const THAI_RAG_CONTRACT_VERSION = '1.0';
export const THAI_RAG_INDEX_JOB_CONTRACT_VERSION = '1.0';
export const THAI_RAG_CONTRACT_FINGERPRINT = 'c271073944e379a4932a3377a351dc7d45f421f4866e404eda277ec0f0bfa1bc';
export const THAI_RAG_REQUIRED_CAPABILITIES = [
  'remember',
  'recall',
  'forget',
  'record_event',
  'pre_edit_context',
  'code_search',
  'code_context',
  'code_blast_radius',
  'code_index',
  'index_status',
  'health',
  'version',
] as const;

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
    readonly preprocessingVersion: string;
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
  if (legacy && !(options.allowLegacyAdapter === true && handshake.legacyAdapter !== undefined)) {
    return fail('contract-version-mismatch', `unsupported contract version ${handshake.contractVersion}`);
  }
  if (handshake.providerId !== THAI_RAG_PROVIDER_ID) return fail('provider-id-mismatch', `unexpected provider ${handshake.providerId}`);
  if (handshake.contractFingerprint !== THAI_RAG_CONTRACT_FINGERPRINT) return fail('fingerprint-mismatch', 'contract fingerprint does not match supported conformance fixture');
  if (handshake.indexJobContractVersion !== THAI_RAG_INDEX_JOB_CONTRACT_VERSION) return fail('index-job-contract-mismatch', 'index job contract version is unsupported');
  if (handshake.workspaceScopeModel !== 'explicit_workspace_id') return fail('workspace-scope-model-mismatch', 'canonical workspace_id scope is required');
  const missing = THAI_RAG_REQUIRED_CAPABILITIES.filter((capability) => !handshake.capabilities.includes(capability));
  const legacyAdapterMissingOnlyRecordEvent = legacy
    && options.allowLegacyAdapter === true
    && missing.length === 1
    && missing[0] === 'record_event';
  if (missing.length > 0 && !legacyAdapterMissingOnlyRecordEvent) return fail('missing-capability', `required capabilities missing: ${missing.join(', ')}`);
  if (handshake.health === 'unavailable') return fail('health-unavailable', 'provider health is unavailable');
  if (handshake.health !== 'ready') return fail('health-degraded', `provider health is ${handshake.health}`);
  if (handshake.workspaceId !== undefined && handshake.workspaceReady !== true) return fail('workspace-scope-unavailable', `provider did not confirm workspace ${handshake.workspaceId}`);
  if (options.workspaceId !== undefined && (handshake.workspaceId !== options.workspaceId || handshake.workspaceReady !== true)) {
    return fail('workspace-scope-unavailable', `provider did not confirm workspace ${options.workspaceId}`);
  }
  if (options.embeddingIndexGeneration !== undefined && handshake.embeddingIndexGeneration !== options.embeddingIndexGeneration) {
    return fail('generation-drift', `provider generation ${handshake.embeddingIndexGeneration} does not match expected ${options.embeddingIndexGeneration}`);
  }
  if (handshake.generation.contract !== THAI_RAG_CONTRACT_FINGERPRINT || handshake.generation.embedding !== handshake.embedding.profile || handshake.generation.index !== String(handshake.embeddingIndexGeneration)) {
    return fail('generation-drift', 'active generation metadata does not match handshake embedding or contract identity');
  }
  if (!Number.isSafeInteger(handshake.embedding.dimension) || handshake.embedding.dimension <= 0) return fail('embedding-metadata-invalid', 'embedding dimension is invalid');
  return ok(handshake);
}

/**
 * Incompatible embedding/index generations must be detected rather than mixed:
 * a workspace index may only be served when its generation matches the
 * provider's active embedding index generation.
 */
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
