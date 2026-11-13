import { appError, err, ok, type Result } from '@unified-mpc/domain';
import { THAI_RAG_PROVIDER_ID, type CanonicalWorkspaceId } from './canonical-workspace.js';

/** Bumped whenever the structured health contract changes shape for consumers (#3). */
export const THAI_RAG_PROVIDER_SCHEMA_VERSION = 1;
export const THAI_RAG_CONTRACT_VERSION = '1.0';
export const THAI_RAG_INDEX_JOB_CONTRACT_VERSION = '1.0';
export const THAI_RAG_CANCEL_INDEX_JOB_CONTRACT_VERSION = '1.1';
export const THAI_RAG_CONTRACT_FINGERPRINT = 'c271073944e379a4932a3377a351dc7d45f421f4866e404eda277ec0f0bfa1bc';
export const THAI_RAG_CANCEL_CONTRACT_FINGERPRINT = 'e9861eb3df0176f7843860448b37899b04edb50a12d51c10c09cd5186a742afe';
export const THAI_RAG_LEGACY_ADOPTION_CONTRACT_FINGERPRINT = 'e12fb2cd03ea12fea28b623c83982c84ccbf579deb40714755df4fd1f34e341e';
/**
 * thai-rag-mcp issue #395 adds `resolve_event` and the `constraint_resolution`
 * capability flag: a recorded `constraint` can be closed with an audit trail
 * instead of blocking `pre_edit_context` forever. The provider advertises the
 * new operation, so its `_CONTRACT_SHAPE` fingerprint moves; both fingerprints
 * are accepted here so a rolling upgrade can update either side first.
 */
export const THAI_RAG_CONSTRAINT_RESOLUTION_CONTRACT_FINGERPRINT = '579a2884795d39b837e54ee16a7680414a821bf9d81e8a5e53b213a0c20f653f';
export const THAI_RAG_PRODUCTION_BRIDGE = 'thai-rag-provider-1.0-production-bridge';
export const THAI_RAG_LEGACY_ADAPTERS = {
  [THAI_RAG_PRODUCTION_BRIDGE]: { sourceContractVersion: '0.9', targetContractVersion: THAI_RAG_CONTRACT_VERSION },
} as const;
export const THAI_RAG_CONFORMANCE_FIXTURE_VERSION = '1.0';
export const THAI_RAG_CONFORMANCE_OPERATIONS = [
  'remember', 'recall', 'record_event', 'forget', 'pre_edit_context', 'code_search',
  'code_context', 'code_blast_radius', 'code_index', 'index_status', 'health', 'version',
] as const;
/** Local llama.cpp deployment embeds with Gemma 2; declared by thai-rag providers built for this environment (#404-followup). */
export const THAI_RAG_DEPLOYMENT_EMBEDDING_PROFILE = 'embeddinggemma-2-Q8_0';
/**
 * The embedding identity contract 1.0 attests (#786).
 *
 * thai-rag-mcp removed the Ollama/Nomic runtime in #238 Phase B, so llama.cpp
 * EmbeddingGemma is the only backend a 1.0 provider can serve. The profile is
 * therefore the deployment artifact, which is exactly what `attestedDeployment`
 * checks; naming a retired backend here left the map describing a provider that
 * cannot exist and silently accepted a 1.0 handshake claiming that identity.
 */
export const THAI_RAG_EMBEDDING_PROFILE = THAI_RAG_DEPLOYMENT_EMBEDDING_PROFILE;
export const THAI_RAG_EMBEDDING_MODEL = THAI_RAG_EMBEDDING_PROFILE;
/**
 * The retired Ollama/Nomic identity, kept only as the 0.9 production-bridge
 * metadata: a pre-Phase-B provider can still answer 0.9 during a rolling
 * upgrade and stays readable until it is replaced (#786).
 */
export const THAI_RAG_LEGACY_EMBEDDING_PROFILE = 'nomic-embed-text-v2-moe';
export const THAI_RAG_EMBEDDING_PREPROCESSING_VERSION = '1';
export const THAI_RAG_EMBEDDING_DIMENSION = 768;
export const THAI_RAG_EMBEDDING_COMPATIBILITY = {
  '0.9': { profile: `${THAI_RAG_LEGACY_EMBEDDING_PROFILE}:latest`, model: `${THAI_RAG_LEGACY_EMBEDDING_PROFILE}:latest`, dimension: THAI_RAG_EMBEDDING_DIMENSION },
  '1.0': { profile: THAI_RAG_EMBEDDING_PROFILE, model: THAI_RAG_EMBEDDING_MODEL, dimension: THAI_RAG_EMBEDDING_DIMENSION, preprocessingVersion: THAI_RAG_EMBEDDING_PREPROCESSING_VERSION },
} as const;
export const THAI_RAG_ALLOWED_DEGRADED_CAPABILITIES = ['vector_store', 'embedder', 'semantic_retrieval'] as const;
export const THAI_RAG_CONFORMANCE_FIXTURE = {
  version: THAI_RAG_CONFORMANCE_FIXTURE_VERSION,
  workspaceScope: { field: 'workspace_id', canonical: true },
  errors: ['INVALID_INPUT', 'PERMISSION_DENIED', 'CONFLICT', 'FILE_NOT_FOUND'],
  operations: {
    remember: { scope: 'workspace_id', required: ['workspace_id'], errors: ['INVALID_INPUT', 'PERMISSION_DENIED'] },
    recall: { scope: 'workspace_id', required: ['workspace_id'], errors: ['INVALID_INPUT', 'PERMISSION_DENIED'] },
    record_event: { scope: 'workspace_id', required: ['workspace_id', 'event_type', 'content'], errors: ['INVALID_INPUT', 'PERMISSION_DENIED'] },
    forget: { scope: 'workspace_id', required: ['workspace_id'], errors: ['INVALID_INPUT', 'PERMISSION_DENIED'] },
    pre_edit_context: { scope: 'workspace_id', required: ['workspace_id'], errors: ['INVALID_INPUT', 'PERMISSION_DENIED', 'CONFLICT'] },
    code_search: { scope: 'workspace_id', required: ['workspace_id'], errors: ['INVALID_INPUT', 'PERMISSION_DENIED'] },
    code_context: { scope: 'workspace_id', required: ['workspace_id'], errors: ['INVALID_INPUT', 'PERMISSION_DENIED', 'FILE_NOT_FOUND'] },
    code_blast_radius: { scope: 'workspace_id', required: ['workspace_id'], errors: ['INVALID_INPUT', 'PERMISSION_DENIED'] },
    code_index: { scope: 'workspace_id', required: ['workspace_id'], errors: ['INVALID_INPUT', 'PERMISSION_DENIED', 'CONFLICT'] },
    index_status: { scope: 'workspace_id', required: ['workspace_id'], errors: ['INVALID_INPUT', 'FILE_NOT_FOUND'] },
    health: { scope: 'provider', errors: ['CONFLICT'] },
    version: { scope: 'provider', errors: ['CONFLICT'] },
  },
} as const;
export const THAI_RAG_REQUIRED_CAPABILITIES = [...THAI_RAG_CONFORMANCE_OPERATIONS];
export const THAI_RAG_CANCEL_CAPABILITY = 'cancel_index';
export const THAI_RAG_LEGACY_ADOPTION_CAPABILITY = 'adopt_legacy_index';
export const THAI_RAG_CONSTRAINT_RESOLUTION_CAPABILITY = 'resolve_event';

const SUPPORTED_INDEX_JOB_CONTRACTS = new Map<string, {
  readonly indexJobContractVersion: string;
  readonly requiredCapabilities: readonly string[];
}>([
  [THAI_RAG_CONTRACT_FINGERPRINT, {
    indexJobContractVersion: THAI_RAG_INDEX_JOB_CONTRACT_VERSION,
    requiredCapabilities: THAI_RAG_REQUIRED_CAPABILITIES,
  }],
  [THAI_RAG_CANCEL_CONTRACT_FINGERPRINT, {
    indexJobContractVersion: THAI_RAG_CANCEL_INDEX_JOB_CONTRACT_VERSION,
    requiredCapabilities: [...THAI_RAG_REQUIRED_CAPABILITIES, THAI_RAG_CANCEL_CAPABILITY],
  }],
  [THAI_RAG_LEGACY_ADOPTION_CONTRACT_FINGERPRINT, {
    indexJobContractVersion: THAI_RAG_CANCEL_INDEX_JOB_CONTRACT_VERSION,
    requiredCapabilities: [
      ...THAI_RAG_REQUIRED_CAPABILITIES,
      THAI_RAG_CANCEL_CAPABILITY,
      THAI_RAG_LEGACY_ADOPTION_CAPABILITY,
    ],
  }],
  [THAI_RAG_CONSTRAINT_RESOLUTION_CONTRACT_FINGERPRINT, {
    indexJobContractVersion: THAI_RAG_CANCEL_INDEX_JOB_CONTRACT_VERSION,
    requiredCapabilities: [
      ...THAI_RAG_REQUIRED_CAPABILITIES,
      THAI_RAG_CANCEL_CAPABILITY,
      THAI_RAG_LEGACY_ADOPTION_CAPABILITY,
      THAI_RAG_CONSTRAINT_RESOLUTION_CAPABILITY,
    ],
  }],
]);

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
  readonly degradedReasons?: readonly string[];
  /** Provider capability flag: `revision_manifest` source identity is supported. */
  readonly revisionManifest?: boolean;
  /** Provider capability flag: `expected_hash_fence` verification is supported. */
  readonly expectedHashFence?: boolean;
  readonly components?: ThaiRagProviderComponents;
  readonly legacyAdapter?: string;
}

export interface ThaiRagHandshakeValidationOptions {
  readonly workspaceId?: string;
  readonly embeddingIndexGeneration?: number;
  readonly allowLegacyAdapter?: boolean;
  /** Native-consumer-only transition for PR25 providers that omit this field. */
  readonly allowMissingPreprocessingVersion?: boolean;
  readonly expectedEmbeddingProfile?: string;
  readonly expectedEmbeddingModel?: string;
  readonly expectedPreprocessingVersion?: string;
  readonly allowedDegradedCapabilities?: readonly string[];
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
  readonly indexJobContractVersion: string;
  readonly contractVersion?: string;
  readonly capabilities?: readonly string[];
  readonly workspaceScopeModel?: string;
  readonly embedding?: ThaiRagProviderHandshake['embedding'];
  readonly state: ThaiRagProviderLifecycleState;
  readonly compatibilityRange?: ThaiRagProviderHandshake['compatibilityRange'];
  readonly contractFingerprint?: string;
  readonly generation?: ThaiRagProviderHandshake['generation'];
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
    indexJobContractVersion: THAI_RAG_INDEX_JOB_CONTRACT_VERSION,
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
  handshake = normalizeSupportedEmbeddingMetadata(handshake);
  const fail = (reason: string, message: string, details: Readonly<Record<string, unknown>> = {}): Result<ThaiRagProviderHandshake> => err(appError(
    'CONFLICT',
    `Thai-RAG provider handshake rejected: ${message}`,
    true,
    { reason, providerId: handshake.providerId, contractVersion: handshake.contractVersion, ...details },
  ));
  const legacy = handshake.contractVersion !== THAI_RAG_CONTRACT_VERSION;
  const adapter = handshake.legacyAdapter === undefined ? undefined : THAI_RAG_LEGACY_ADAPTERS[handshake.legacyAdapter as keyof typeof THAI_RAG_LEGACY_ADAPTERS];
  const compatible = isCompatibleContractVersion(handshake.contractVersion, handshake.compatibilityRange);
  if (legacy && !(compatible || (options.allowLegacyAdapter === true && adapter !== undefined && adapter.sourceContractVersion === handshake.contractVersion))) {
    return fail('contract-version-mismatch', `unsupported contract version ${handshake.contractVersion}`, { expected: THAI_RAG_CONTRACT_VERSION, actual: handshake.contractVersion, legacyAdapter: handshake.legacyAdapter });
  }
  if (handshake.providerId !== THAI_RAG_PROVIDER_ID) return fail('provider-id-mismatch', `unexpected provider ${handshake.providerId}`, { expected: THAI_RAG_PROVIDER_ID, actual: handshake.providerId });
  const supportedJobContract = SUPPORTED_INDEX_JOB_CONTRACTS.get(handshake.contractFingerprint);
  if (supportedJobContract === undefined) {
    return fail('fingerprint-mismatch', 'contract fingerprint does not match a supported conformance fixture', {
      expected: [...SUPPORTED_INDEX_JOB_CONTRACTS.keys()],
      actual: handshake.contractFingerprint,
    });
  }
  if (handshake.indexJobContractVersion !== supportedJobContract.indexJobContractVersion) {
    return fail('index-job-contract-mismatch', 'index job contract version does not match the attested fingerprint', {
      expected: supportedJobContract.indexJobContractVersion,
      actual: handshake.indexJobContractVersion,
    });
  }
  if (!isCompatibleRange(handshake.compatibilityRange)) return fail('compatibility-range-invalid', 'compatibility range does not include supported contract version', { expected: THAI_RAG_CONTRACT_VERSION, actual: handshake.compatibilityRange });
  if (handshake.workspaceScopeModel !== 'explicit_workspace_id') return fail('workspace-scope-model-mismatch', 'canonical workspace_id scope is required');
  const missing = supportedJobContract.requiredCapabilities.filter((capability) => !handshake.capabilities.includes(capability));
  if (missing.length > 0) return fail('missing-capability', `required capabilities missing: ${missing.join(', ')}`);
  if (handshake.health === 'unavailable') return fail('health-unavailable', 'provider health is unavailable');
  if (handshake.health === 'degraded') {
    const components = handshake.components;
    const allowed = new Set(options.allowedDegradedCapabilities ?? []);
    const degradedCapabilities = components === undefined ? ['components'] : [
      ...(components.vectorStoreAvailable ? [] : ['vector_store']),
      ...(components.embedderAvailable ? [] : ['embedder']),
      ...(components.semanticRetrievalAvailable ? [] : ['semantic_retrieval']),
    ];
    const disallowed = degradedCapabilities.filter((capability) => !allowed.has(capability));
    if (components === undefined || !components.workerReachable || !components.sqliteAvailable || !components.ftsAvailable || !components.lexicalRetrievalAvailable || disallowed.length > 0) {
      return fail('health-degraded', 'degraded provider lacks required native capabilities', { allowed: [...allowed], actual: degradedCapabilities, disallowed });
    }
  } else if (handshake.health !== 'ready') return fail('health-degraded', `provider health is ${handshake.health}`);
  if (handshake.workspaceId !== undefined && handshake.workspaceReady !== true) return fail('workspace-scope-unavailable', `provider did not confirm workspace ${handshake.workspaceId}`);
  if (options.workspaceId !== undefined && (handshake.workspaceId !== options.workspaceId || handshake.workspaceReady !== true)) {
    return fail('workspace-scope-unavailable', `provider did not confirm workspace ${options.workspaceId}`);
  }
  if (options.embeddingIndexGeneration !== undefined && handshake.embeddingIndexGeneration !== options.embeddingIndexGeneration) {
    return fail('generation-drift', `provider generation ${handshake.embeddingIndexGeneration} does not match expected ${options.embeddingIndexGeneration}`, { expected: options.embeddingIndexGeneration, actual: handshake.embeddingIndexGeneration });
  }
  if (handshake.generation.contract !== handshake.contractFingerprint || handshake.generation.embedding !== handshake.embedding.profile || (handshake.generation.index !== 'unknown' && handshake.generation.index !== String(handshake.embeddingIndexGeneration))) {
    return fail('generation-drift', 'active generation metadata does not match handshake embedding or contract identity', { expected: { contract: handshake.contractFingerprint, embedding: handshake.embedding.profile, index: String(handshake.embeddingIndexGeneration) }, actual: handshake.generation });
  }
  if (!Number.isSafeInteger(handshake.embedding.dimension) || handshake.embedding.dimension <= 0) return fail('embedding-metadata-invalid', 'embedding dimension is invalid');
  if (handshake.embedding.preprocessingVersion !== undefined && handshake.embedding.preprocessingVersion.trim().length === 0) return fail('embedding-metadata-invalid', 'embedding preprocessing version is invalid');
  const attestedLegacy = legacy && adapter !== undefined && options.allowLegacyAdapter === true;
  const missingPreprocessingVersionAllowed = options.allowMissingPreprocessingVersion === true
    && handshake.embedding.preprocessingVersion === undefined;
  const expectedEmbedding = THAI_RAG_EMBEDDING_COMPATIBILITY[handshake.contractVersion as keyof typeof THAI_RAG_EMBEDDING_COMPATIBILITY];
  const attestedDeployment = expectedEmbedding !== undefined
    && expectedEmbedding.dimension === handshake.embedding.dimension
    && (handshake.embedding.profile === THAI_RAG_DEPLOYMENT_EMBEDDING_PROFILE || handshake.embedding.profile.startsWith(`${THAI_RAG_DEPLOYMENT_EMBEDDING_PROFILE}:`));
  if (expectedEmbedding !== undefined && handshake.embedding.dimension !== expectedEmbedding.dimension) return fail('embedding-metadata-invalid', 'embedding dimension is unsupported', { expected: expectedEmbedding.dimension, actual: handshake.embedding.dimension });
  if (options.expectedEmbeddingProfile !== undefined && !attestedDeployment && handshake.embedding.profile !== options.expectedEmbeddingProfile && !handshake.embedding.profile.startsWith(`${options.expectedEmbeddingProfile}:`)) return fail('embedding-metadata-invalid', 'embedding profile is unsupported', { expected: options.expectedEmbeddingProfile, actual: handshake.embedding.profile });
  if (options.expectedEmbeddingModel !== undefined && !attestedLegacy && !attestedDeployment && !isExpectedEmbeddingModel(handshake.embedding.model, options.expectedEmbeddingModel)) return fail('embedding-metadata-invalid', 'embedding model is unsupported', { expected: options.expectedEmbeddingModel, actual: handshake.embedding.model });
  if (options.expectedPreprocessingVersion !== undefined && handshake.embedding.preprocessingVersion !== options.expectedPreprocessingVersion && !attestedLegacy && !missingPreprocessingVersionAllowed) return fail('embedding-metadata-invalid', 'embedding preprocessing version is unsupported', { expected: options.expectedPreprocessingVersion, actual: handshake.embedding.preprocessingVersion });
  if (!isEmbeddingModelMetadataValid(handshake.embedding.profile, handshake.embedding.model, attestedLegacy)) return fail('embedding-metadata-invalid', 'embedding model does not match embedding profile');
  const normalized = normalizeSupportedEmbeddingMetadata(handshake);
  const effectiveExpected = attestedDeployment
    ? { profile: THAI_RAG_DEPLOYMENT_EMBEDDING_PROFILE, model: THAI_RAG_DEPLOYMENT_EMBEDDING_PROFILE, dimension: handshake.embedding.dimension, preprocessingVersion: THAI_RAG_EMBEDDING_PREPROCESSING_VERSION }
    : expectedEmbedding;
  if (effectiveExpected !== undefined && (normalized.embedding.profile !== effectiveExpected.profile || normalized.embedding.model.split('@sha256:')[0] !== effectiveExpected.model || ('preprocessingVersion' in effectiveExpected && normalized.embedding.preprocessingVersion !== effectiveExpected.preprocessingVersion && !missingPreprocessingVersionAllowed))) return fail('embedding-metadata-invalid', 'embedding metadata drifts from supported contract profile', { expected: effectiveExpected, actual: handshake.embedding });
  return ok(normalized);
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

function isCompatibleContractVersion(
  providerContractVersion: string,
  range: ThaiRagProviderHandshake['compatibilityRange'],
): boolean {
  const provider = parseVersion(providerContractVersion);
  const supported = parseVersion(THAI_RAG_CONTRACT_VERSION);
  const min = parseVersion(range.min);
  const max = range.max.endsWith('.x') ? [Number(range.max.slice(0, -2)), Number.POSITIVE_INFINITY] : parseVersion(range.max);
  if (provider === undefined || supported === undefined || min === undefined || max === undefined) return false;
  if (provider[0] !== supported[0]) return false;
  const providerInRange = provider[0] > min[0] || (provider[0] === min[0] && provider[1] >= min[1]);
  const providerBelowMax = provider[0] < max[0] || (provider[0] === max[0] && provider[1] <= max[1]);
  return isCompatibleRange(range) && providerInRange && providerBelowMax;
}

function parseVersion(value: string): readonly [number, number] | undefined {
  const match = /^(\d+)\.(\d+)$/.exec(value);
  return match === null ? undefined : [Number(match[1]), Number(match[2])];
}

function normalizeSupportedEmbeddingMetadata(handshake: ThaiRagProviderHandshake): ThaiRagProviderHandshake {
  if (handshake.contractVersion !== THAI_RAG_CONTRACT_VERSION) return handshake;
  // `attestedDeployment` already tolerates a `:`-suffixed deployment profile, so
  // the canonical form has to tolerate it too; otherwise a tagged identity passes
  // the attestation gate and then fails the final profile comparison (#786).
  const canonical = (value: string, identity: string): string => value === `${identity}:latest` ? identity : value;
  const profile = canonical(handshake.embedding.profile, THAI_RAG_EMBEDDING_PROFILE);
  const model = canonical(handshake.embedding.model, THAI_RAG_EMBEDDING_MODEL);
  const generationEmbedding = canonical(handshake.generation.embedding, THAI_RAG_EMBEDDING_PROFILE);
  return profile === handshake.embedding.profile && model === handshake.embedding.model && generationEmbedding === handshake.generation.embedding
    ? handshake
    : { ...handshake, embedding: { ...handshake.embedding, profile, model }, generation: { ...handshake.generation, embedding: generationEmbedding } };
}

function isExpectedEmbeddingModel(model: string, expected: string): boolean {
  const [expectedName, expectedDigest] = expected.split('@sha256:');
  const [modelName, modelDigest] = model.split('@sha256:');
  if (modelName !== expectedName || (expectedDigest !== undefined && !isEmbeddingDigestValid(expectedDigest))) return false;
  if (expectedDigest !== undefined) return modelDigest === expectedDigest && isEmbeddingDigestValid(modelDigest);
  return modelDigest === undefined || isEmbeddingDigestValid(modelDigest);
}

function isEmbeddingModelMetadataValid(profile: string, model: string, allowLegacyMetadata = false): boolean {
  if (profile.trim().length === 0 || model.trim().length === 0) return false;
  const [modelName, digest] = model.split('@sha256:');
  return (modelName === profile || allowLegacyMetadata) && (digest === undefined || isEmbeddingDigestValid(digest));
}

function isEmbeddingDigestValid(digest: string | undefined): boolean {
  return digest !== undefined && /^[a-f0-9]{64}$/i.test(digest);
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

/**
 * Read the transport-independent handshake payload that every provider result
 * carries in `data` (or `metadata`, which omits `provider_id`).
 *
 * This is a shape reader, not a policy decision: `validateThaiRagHandshake`
 * still owns compatibility, capability, generation and embedding policy. It
 * accepts the wrapping `{ data: ... }` envelope so the same function reads a
 * tool result and a vendored contract fixture.
 */
export function parseThaiRagHandshakePayload(value: unknown): Result<ThaiRagProviderHandshake> {
  const outer = isRecord(value) && isRecord(value.data) ? value.data : value;
  const data = isRecord(outer) && isRecord(outer.data) && typeof outer.data.provider_id === 'string' ? outer.data : outer;
  if (!isRecord(data)
    || typeof data.provider_id !== 'string'
    || typeof data.provider_version !== 'string'
    || typeof data.contract_version !== 'string'
    || !isRecord(data.compatibility_range)
    || typeof data.compatibility_range.min !== 'string'
    || typeof data.compatibility_range.max !== 'string'
    || typeof data.contract_fingerprint !== 'string'
    || typeof data.index_job_contract_version !== 'string'
    || !Array.isArray(data.capabilities)
    || !data.capabilities.every((capability) => typeof capability === 'string')
    || typeof data.workspace_scope_model !== 'string'
    || typeof data.state !== 'string'
    || !isRecord(data.embedding)
    || typeof data.embedding.profile !== 'string'
    || typeof data.embedding.model !== 'string'
    || typeof data.embedding.dimension !== 'number'
    || (data.embedding.preprocessing_version !== undefined && typeof data.embedding.preprocessing_version !== 'string')
    || !isRecord(data.generation)
    || typeof data.generation.contract !== 'string'
    || typeof data.generation.embedding !== 'string'
    || typeof data.generation.index !== 'string'
    || typeof data.generation.storage !== 'string'
    || typeof data.embedding_index_generation !== 'number'
    || (data.revision_manifest !== undefined && typeof data.revision_manifest !== 'boolean')
    || (data.expected_hash_fence !== undefined && typeof data.expected_hash_fence !== 'boolean')
    || (data.degraded_reasons !== undefined && (!Array.isArray(data.degraded_reasons) || !data.degraded_reasons.every((reason) => typeof reason === 'string')))) {
    return err(appError('CONFLICT', 'Native Thai-RAG worker returned malformed handshake metadata', true, { reason: 'malformed-handshake' }));
  }
  const components = isRecord(data.components) ? parseThaiRagProviderComponents(data.components) : undefined;
  return ok({
    providerId: data.provider_id as ThaiRagProviderHandshake['providerId'],
    providerVersion: data.provider_version,
    contractVersion: data.contract_version,
    compatibilityRange: { min: data.compatibility_range.min, max: data.compatibility_range.max },
    contractFingerprint: data.contract_fingerprint,
    indexJobContractVersion: data.index_job_contract_version,
    capabilities: data.capabilities,
    workspaceScopeModel: data.workspace_scope_model,
    health: data.state,
    embedding: {
      profile: data.embedding.profile,
      model: data.embedding.model,
      dimension: data.embedding.dimension,
      ...(data.embedding.preprocessing_version === undefined ? {} : { preprocessingVersion: data.embedding.preprocessing_version }),
    },
    generation: {
      contract: data.generation.contract,
      embedding: data.generation.embedding,
      index: data.generation.index,
      storage: data.generation.storage,
    },
    ...(typeof data.workspace_id === 'string' ? { workspaceId: data.workspace_id } : {}),
    ...(typeof data.workspace_ready === 'boolean' ? { workspaceReady: data.workspace_ready } : {}),
    ...(data.degraded_reasons === undefined ? {} : { degradedReasons: data.degraded_reasons }),
    ...(components === undefined ? {} : { components }),
    embeddingIndexGeneration: data.embedding_index_generation,
    ...(typeof data.revision_manifest === 'boolean' ? { revisionManifest: data.revision_manifest } : {}),
    ...(typeof data.expected_hash_fence === 'boolean' ? { expectedHashFence: data.expected_hash_fence } : {}),
    ...(typeof data.legacy_adapter === 'string' ? { legacyAdapter: data.legacy_adapter } : {}),
  });
}

function parseThaiRagProviderComponents(value: Record<string, unknown>): ThaiRagProviderComponents | undefined {
  if (typeof value.worker_reachable !== 'boolean'
    || typeof value.sqlite_available !== 'boolean'
    || typeof value.fts_available !== 'boolean'
    || typeof value.vector_store_available !== 'boolean'
    || typeof value.embedder_available !== 'boolean'
    || typeof value.lexical_retrieval_available !== 'boolean'
    || typeof value.semantic_retrieval_available !== 'boolean'
    || !Array.isArray(value.active_jobs)
    || !value.active_jobs.every((job) => typeof job === 'string')) return undefined;
  return {
    workerReachable: value.worker_reachable,
    sqliteAvailable: value.sqlite_available,
    ftsAvailable: value.fts_available,
    vectorStoreAvailable: value.vector_store_available,
    embedderAvailable: value.embedder_available,
    lexicalRetrievalAvailable: value.lexical_retrieval_available,
    semanticRetrievalAvailable: value.semantic_retrieval_available,
    activeJobs: value.active_jobs,
  };
}

export type ThaiRagUnifiedProviderErrorCode = 'INVALID_INPUT' | 'PERMISSION_DENIED' | 'FILE_NOT_FOUND' | 'CONFLICT';

/**
 * Every `ErrorCode` in contract v1 and the Unified error it becomes.
 *
 * The provider contract declares the vocabulary open for addition within v1
 * (`contract/README.md` §2): a new code names a state the provider could
 * already reach, and it does not move `contract_fingerprint`, so this table is
 * the only place an addition becomes visible here. An unrecognised code is
 * therefore terminal rather than a retryable `CONFLICT` — retrying something
 * understood only as "some error" is how a permanent failure becomes a loop.
 *
 * `provider-contract.corpus.test.ts` refuses a vendored schema code that is
 * missing here.
 */
export const THAI_RAG_PROVIDER_ERROR_CODE_MAP: ReadonlyMap<string, ThaiRagUnifiedProviderErrorCode> = new Map<string, ThaiRagUnifiedProviderErrorCode>([
  ['invalid_input', 'INVALID_INPUT'],
  ['workspace_scope_required', 'INVALID_INPUT'],
  ['scope_denied', 'PERMISSION_DENIED'],
  ['permission_denied', 'PERMISSION_DENIED'],
  ['workspace_not_found', 'FILE_NOT_FOUND'],
  ['file_not_found', 'FILE_NOT_FOUND'],
  ['index_job_not_found', 'FILE_NOT_FOUND'],
  ['memory_not_found', 'FILE_NOT_FOUND'],
  ['storage_unavailable', 'CONFLICT'],
  ['lexical_retrieval_unavailable', 'CONFLICT'],
  ['vector_retrieval_degraded', 'CONFLICT'],
  ['memory_reconciliation_pending', 'CONFLICT'],
  ['embedding_unavailable', 'CONFLICT'],
  ['stale_index', 'CONFLICT'],
  ['incompatible_index', 'CONFLICT'],
  ['indexing_conflict', 'CONFLICT'],
  ['cancellation', 'CONFLICT'],
  ['internal_failure', 'CONFLICT'],
]);

export function isThaiRagProviderErrorCode(code: string): boolean {
  return THAI_RAG_PROVIDER_ERROR_CODE_MAP.has(code);
}

export function mapThaiRagProviderErrorCode(code: string): ThaiRagUnifiedProviderErrorCode {
  // A Map lookup, not an object index: `constructor`, `__proto__` and
  // `toString` are absent from a Map, while an object literal would inherit
  // them and hand `appError` a non-string code for an unknown provider value.
  return THAI_RAG_PROVIDER_ERROR_CODE_MAP.get(code) ?? 'CONFLICT';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
