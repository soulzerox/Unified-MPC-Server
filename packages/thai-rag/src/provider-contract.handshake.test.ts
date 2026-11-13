import { describe, expect, it } from 'vitest';
import {
  THAI_RAG_CANCEL_CAPABILITY,
  THAI_RAG_CANCEL_CONTRACT_FINGERPRINT,
  THAI_RAG_CANCEL_INDEX_JOB_CONTRACT_VERSION,
  THAI_RAG_CONTRACT_FINGERPRINT,
  THAI_RAG_CONTRACT_VERSION,
  THAI_RAG_CONSTRAINT_RESOLUTION_CAPABILITY,
  THAI_RAG_CONSTRAINT_RESOLUTION_CONTRACT_FINGERPRINT,
  THAI_RAG_DEPLOYMENT_EMBEDDING_PROFILE,
  THAI_RAG_EMBEDDING_COMPATIBILITY,
  THAI_RAG_EMBEDDING_MODEL,
  THAI_RAG_EMBEDDING_PROFILE,
  THAI_RAG_LEGACY_ADOPTION_CAPABILITY,
  THAI_RAG_LEGACY_ADOPTION_CONTRACT_FINGERPRINT,
  THAI_RAG_LEGACY_EMBEDDING_PROFILE,
  THAI_RAG_PRODUCTION_BRIDGE,
  THAI_RAG_REQUIRED_CAPABILITIES,
  validateThaiRagHandshake,
  type ThaiRagProviderHandshake,
} from './provider-contract.js';

const baseHandshake: ThaiRagProviderHandshake = {
  providerId: 'thai-rag',
  providerVersion: '0.1.0',
  contractVersion: '1.0',
  compatibilityRange: { min: '1.0', max: '1.x' },
  contractFingerprint: THAI_RAG_CONTRACT_FINGERPRINT,
  indexJobContractVersion: '1.0',
  capabilities: [...THAI_RAG_REQUIRED_CAPABILITIES],
  workspaceScopeModel: 'explicit_workspace_id',
  health: 'ready',
  embedding: {
    profile: THAI_RAG_DEPLOYMENT_EMBEDDING_PROFILE,
    model: `${THAI_RAG_DEPLOYMENT_EMBEDDING_PROFILE}@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef`,
    dimension: 768,
    preprocessingVersion: '1',
  },
  generation: {
    contract: THAI_RAG_CONTRACT_FINGERPRINT,
    embedding: THAI_RAG_DEPLOYMENT_EMBEDDING_PROFILE,
    index: '1',
    storage: 'sqlite',
  },
  workspaceId: '11111111-1111-4111-8111-111111111111',
  workspaceReady: true,
  embeddingIndexGeneration: 1,
};

describe('Thai-RAG provider handshake', () => {
  it('accepts compatible structured metadata', () => {
    expect(validateThaiRagHandshake(baseHandshake)).toEqual({ ok: true, value: baseHandshake });
    expect(THAI_RAG_CONTRACT_VERSION).toBe('1.0');
  });

  it('accepts a compatible minor contract when the provider range includes Unified’s contract', () => {
    const providerMinor = {
      ...baseHandshake,
      contractVersion: '1.1',
      compatibilityRange: { min: '1.0', max: '1.x' },
    };

    expect(validateThaiRagHandshake(providerMinor)).toEqual({ ok: true, value: providerMinor });
  });


  it('accepts the additive cancellable index-job contract during rolling upgrades', () => {
    const cancellable = {
      ...baseHandshake,
      contractFingerprint: THAI_RAG_CANCEL_CONTRACT_FINGERPRINT,
      indexJobContractVersion: THAI_RAG_CANCEL_INDEX_JOB_CONTRACT_VERSION,
      capabilities: [...baseHandshake.capabilities, THAI_RAG_CANCEL_CAPABILITY],
      generation: {
        ...baseHandshake.generation,
        contract: THAI_RAG_CANCEL_CONTRACT_FINGERPRINT,
      },
    };

    expect(validateThaiRagHandshake(cancellable)).toEqual({ ok: true, value: cancellable });
  });

  it('accepts the additive legacy-adoption contract during rolling upgrades', () => {
    const adoption = {
      ...baseHandshake,
      contractFingerprint: THAI_RAG_LEGACY_ADOPTION_CONTRACT_FINGERPRINT,
      indexJobContractVersion: THAI_RAG_CANCEL_INDEX_JOB_CONTRACT_VERSION,
      capabilities: [
        ...baseHandshake.capabilities,
        THAI_RAG_CANCEL_CAPABILITY,
        THAI_RAG_LEGACY_ADOPTION_CAPABILITY,
      ],
      generation: {
        ...baseHandshake.generation,
        contract: THAI_RAG_LEGACY_ADOPTION_CONTRACT_FINGERPRINT,
      },
    };

    expect(validateThaiRagHandshake(adoption)).toEqual({ ok: true, value: adoption });
  });

  it('accepts the additive constraint-resolution contract during rolling upgrades', () => {
    const resolution = {
      ...baseHandshake,
      contractFingerprint: THAI_RAG_CONSTRAINT_RESOLUTION_CONTRACT_FINGERPRINT,
      indexJobContractVersion: THAI_RAG_CANCEL_INDEX_JOB_CONTRACT_VERSION,
      capabilities: [
        ...baseHandshake.capabilities,
        THAI_RAG_CANCEL_CAPABILITY,
        THAI_RAG_LEGACY_ADOPTION_CAPABILITY,
        THAI_RAG_CONSTRAINT_RESOLUTION_CAPABILITY,
      ],
      generation: {
        ...baseHandshake.generation,
        contract: THAI_RAG_CONSTRAINT_RESOLUTION_CONTRACT_FINGERPRINT,
      },
    };

    expect(validateThaiRagHandshake(resolution)).toEqual({ ok: true, value: resolution });
  });

  it('rejects the constraint-resolution fingerprint when resolve_event is missing', () => {
    const result = validateThaiRagHandshake({
      ...baseHandshake,
      contractFingerprint: THAI_RAG_CONSTRAINT_RESOLUTION_CONTRACT_FINGERPRINT,
      indexJobContractVersion: THAI_RAG_CANCEL_INDEX_JOB_CONTRACT_VERSION,
      capabilities: [
        ...baseHandshake.capabilities,
        THAI_RAG_CANCEL_CAPABILITY,
        THAI_RAG_LEGACY_ADOPTION_CAPABILITY,
      ],
      generation: {
        ...baseHandshake.generation,
        contract: THAI_RAG_CONSTRAINT_RESOLUTION_CONTRACT_FINGERPRINT,
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details?.reason).toBe('missing-capability');
  });

  it('rejects the legacy-adoption fingerprint when adopt_legacy_index is missing', () => {
    const result = validateThaiRagHandshake({
      ...baseHandshake,
      contractFingerprint: THAI_RAG_LEGACY_ADOPTION_CONTRACT_FINGERPRINT,
      indexJobContractVersion: THAI_RAG_CANCEL_INDEX_JOB_CONTRACT_VERSION,
      capabilities: [...baseHandshake.capabilities, THAI_RAG_CANCEL_CAPABILITY],
      generation: {
        ...baseHandshake.generation,
        contract: THAI_RAG_LEGACY_ADOPTION_CONTRACT_FINGERPRINT,
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details?.reason).toBe('missing-capability');
  });

  it('rejects a cancellable fingerprint that omits the cancel capability', () => {
    const result = validateThaiRagHandshake({
      ...baseHandshake,
      contractFingerprint: THAI_RAG_CANCEL_CONTRACT_FINGERPRINT,
      indexJobContractVersion: THAI_RAG_CANCEL_INDEX_JOB_CONTRACT_VERSION,
      generation: {
        ...baseHandshake.generation,
        contract: THAI_RAG_CANCEL_CONTRACT_FINGERPRINT,
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details?.reason).toBe('missing-capability');
  });

  it('rejects an index-job version that does not match its attested fingerprint', () => {
    const result = validateThaiRagHandshake({
      ...baseHandshake,
      indexJobContractVersion: THAI_RAG_CANCEL_INDEX_JOB_CONTRACT_VERSION,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details?.reason).toBe('index-job-contract-mismatch');
  });

  it('rejects a current-contract handshake when preprocessing version is missing by default', () => {
    const result = validateThaiRagHandshake({
      ...baseHandshake,
      embedding: { ...baseHandshake.embedding, preprocessingVersion: undefined },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details?.reason).toBe('embedding-metadata-invalid');
  });

  it('accepts missing preprocessing version only with the transition option', () => {
    const result = validateThaiRagHandshake({
      ...baseHandshake,
      embedding: { ...baseHandshake.embedding, preprocessingVersion: undefined },
    }, { allowMissingPreprocessingVersion: true });

    expect(result.ok).toBe(true);
  });

  it('rejects a wrong non-empty preprocessing version even with the transition option', () => {
    const result = validateThaiRagHandshake({
      ...baseHandshake,
      embedding: { ...baseHandshake.embedding, preprocessingVersion: '2' },
    }, { allowMissingPreprocessingVersion: true });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details?.reason).toBe('embedding-metadata-invalid');
  });

  it.each([
    ['incompatible major contract', { contractVersion: '2.0', compatibilityRange: { min: '2.0', max: '2.x' } }],
    ['provider range excludes Unified contract', { contractVersion: '1.1', compatibilityRange: { min: '1.1', max: '1.x' } }],
    ['fingerprint mismatch', { contractFingerprint: 'different' }],
    ['embedding generation fingerprint mismatch', { generation: { ...baseHandshake.generation, embedding: 'other-profile' } }],
    ['generation drift', { embeddingIndexGeneration: 2 }],
  ])('rejects %s', (_name, change) => {
    const result = validateThaiRagHandshake({ ...baseHandshake, ...change });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('CONFLICT');
  });

  it('rejects legacy metadata without producer-attested adapter mapping', () => {
    const result = validateThaiRagHandshake({ ...baseHandshake, contractVersion: '0.9' }, { allowLegacyAdapter: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details).toMatchObject({ reason: 'contract-version-mismatch', expected: '1.0', actual: '0.9' });
  });

  it('rejects production bridge metadata when current-contract embedding drifts', () => {
    const result = validateThaiRagHandshake({
      ...baseHandshake,
      embedding: { ...baseHandshake.embedding, dimension: 1024 },
      legacyAdapter: THAI_RAG_PRODUCTION_BRIDGE,
    }, { allowLegacyAdapter: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details?.reason).toBe('embedding-metadata-invalid');
  });

  it('accepts production bridge metadata with mapped legacy embedding metadata', () => {
    const production = {
      ...baseHandshake,
      contractVersion: '0.9',
      compatibilityRange: { min: '0.9', max: '1.x' },
      embedding: { ...baseHandshake.embedding, profile: `${THAI_RAG_LEGACY_EMBEDDING_PROFILE}:latest`, model: `${THAI_RAG_LEGACY_EMBEDDING_PROFILE}:latest`, preprocessingVersion: undefined },
      generation: { ...baseHandshake.generation, embedding: `${THAI_RAG_LEGACY_EMBEDDING_PROFILE}:latest`, index: 'unknown' },
      health: 'degraded',
      components: {
        workerReachable: true,
        sqliteAvailable: true,
        ftsAvailable: true,
        vectorStoreAvailable: false,
        embedderAvailable: false,
        lexicalRetrievalAvailable: true,
        semanticRetrievalAvailable: false,
        activeJobs: [],
      },
      legacyAdapter: THAI_RAG_PRODUCTION_BRIDGE,
    };
    expect(validateThaiRagHandshake(production, { embeddingIndexGeneration: 1, allowLegacyAdapter: true, allowedDegradedCapabilities: ['vector_store', 'embedder', 'semantic_retrieval'] })).toMatchObject({ ok: true });
  });

  it('accepts production bridge metadata with unknown index and omitted preprocessing', () => {
    const production = {
      ...baseHandshake,
      contractVersion: '0.9',
      compatibilityRange: { min: '0.9', max: '1.x' },
      health: 'degraded',
      embedding: { ...baseHandshake.embedding, profile: `${THAI_RAG_LEGACY_EMBEDDING_PROFILE}:latest`, model: `${THAI_RAG_LEGACY_EMBEDDING_PROFILE}:latest`, preprocessingVersion: undefined },
      generation: { ...baseHandshake.generation, embedding: `${THAI_RAG_LEGACY_EMBEDDING_PROFILE}:latest`, index: 'unknown' },
      components: {
        workerReachable: true,
        sqliteAvailable: true,
        ftsAvailable: true,
        vectorStoreAvailable: false,
        embedderAvailable: false,
        lexicalRetrievalAvailable: true,
        semanticRetrievalAvailable: false,
        activeJobs: [],
      },
      legacyAdapter: THAI_RAG_PRODUCTION_BRIDGE,
    };
    expect(validateThaiRagHandshake(production, { embeddingIndexGeneration: 1, allowLegacyAdapter: true, allowedDegradedCapabilities: ['vector_store', 'embedder', 'semantic_retrieval'] })).toEqual({ ok: true, value: production });
  });

  it('rejects production bridge when native capabilities are unavailable', () => {
    const result = validateThaiRagHandshake({
      ...baseHandshake,
      health: 'degraded',
      components: { ...baseHandshake.components, lexicalRetrievalAvailable: false },
      legacyAdapter: 'thai-rag-provider-1.0-production-bridge',
    }, { allowLegacyAdapter: true, allowedDegradedCapabilities: ['vector_store', 'embedder', 'semantic_retrieval'] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details?.reason).toBe('health-degraded');
  });

  it('validates compatibility range and supplied embedding metadata', () => {
    for (const change of [
      { compatibilityRange: { min: '2.0', max: '2.x' } },
      { embedding: { ...baseHandshake.embedding, model: 'other@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' } },
      { embedding: { ...baseHandshake.embedding, model: `${THAI_RAG_DEPLOYMENT_EMBEDDING_PROFILE}@sha256:bad-digest` } },
      { embedding: { ...baseHandshake.embedding, preprocessingVersion: '2' } },
      { embedding: { ...baseHandshake.embedding, preprocessingVersion: undefined } },
      { generation: { ...baseHandshake.generation, embedding: 'other-profile' } },
    ]) {
      const result = validateThaiRagHandshake({ ...baseHandshake, ...change }, { expectedEmbeddingModel: THAI_RAG_EMBEDDING_MODEL, expectedPreprocessingVersion: '1' });
      expect(result.ok).toBe(false);
    }
  });

  // The deployment attestation owns the 1.0 identity and a bridged 0.9 producer
  // is trusted through its adapter, so the digest options are exercised on a
  // forward-compatible minor contract: the shape a future provider would use
  // when it is not yet covered by `THAI_RAG_EMBEDDING_COMPATIBILITY` (#786).
  const futureMinor: ThaiRagProviderHandshake = { ...baseHandshake, contractVersion: '1.1' };

  it('accepts model-family metadata without requiring a digest', () => {
    const undigested = { ...futureMinor, embedding: { ...futureMinor.embedding, model: THAI_RAG_EMBEDDING_MODEL } };
    expect(validateThaiRagHandshake(undigested, { expectedEmbeddingModel: THAI_RAG_EMBEDDING_MODEL }).ok).toBe(true);
  });

  it('normalizes supported provider model tags', () => {
    const tagged = {
      ...baseHandshake,
      embedding: { ...baseHandshake.embedding, profile: `${THAI_RAG_EMBEDDING_PROFILE}:latest`, model: `${THAI_RAG_EMBEDDING_MODEL}:latest` },
      generation: { ...baseHandshake.generation, embedding: `${THAI_RAG_EMBEDDING_PROFILE}:latest` },
    };
    expect(validateThaiRagHandshake(tagged)).toMatchObject({ ok: true, value: {
      embedding: { profile: THAI_RAG_EMBEDDING_PROFILE, model: THAI_RAG_EMBEDDING_MODEL },
      generation: { embedding: THAI_RAG_EMBEDDING_PROFILE },
    } });
  });

  it.each([
    ['unsupported dimension', { embedding: { ...baseHandshake.embedding, dimension: 1024 } }],
    ['profile drift', { embedding: { ...baseHandshake.embedding, profile: 'other-profile', model: 'other-profile' }, generation: { ...baseHandshake.generation, embedding: 'other-profile' } }],
    ['preprocessing drift', { embedding: { ...baseHandshake.embedding, preprocessingVersion: '2' } }],
  ])('rejects same-contract embedding %s', (_name, change) => {
    const result = validateThaiRagHandshake({ ...baseHandshake, ...change });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details?.reason).toBe('embedding-metadata-invalid');
  });

  it('rejects model drift even when dimension stays compatible', () => {
    const result = validateThaiRagHandshake({
      ...baseHandshake,
      embedding: { ...baseHandshake.embedding, profile: 'other-profile', model: 'other-profile' },
      generation: { ...baseHandshake.generation, embedding: 'other-profile' },
    }, { expectedEmbeddingProfile: THAI_RAG_EMBEDDING_PROFILE, expectedEmbeddingModel: THAI_RAG_EMBEDDING_MODEL, expectedPreprocessingVersion: '1' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details?.reason).toBe('embedding-metadata-invalid');
  });

  it('enforces digest only when expected model publishes trusted digest', () => {
    const matching = validateThaiRagHandshake(futureMinor, { expectedEmbeddingModel: `${THAI_RAG_EMBEDDING_MODEL}@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef` });
    const drifted = validateThaiRagHandshake(futureMinor, { expectedEmbeddingModel: `${THAI_RAG_EMBEDDING_MODEL}@sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210` });
    expect(matching.ok).toBe(true);
    expect(drifted.ok).toBe(false);
  });

  it('requires explicit degraded capability allowlist', () => {
    const result = validateThaiRagHandshake({
      ...baseHandshake,
      health: 'degraded',
      components: { ...baseHandshake.components, vectorStoreAvailable: false, embedderAvailable: false, semanticRetrievalAvailable: false },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details).toMatchObject({ reason: 'health-degraded', disallowed: ['vector_store', 'embedder', 'semantic_retrieval'] });
  });

  it('rejects unavailable health and workspace scope mismatch', () => {
    const unavailable = validateThaiRagHandshake({ ...baseHandshake, health: 'unavailable' });
    const degraded = validateThaiRagHandshake({ ...baseHandshake, health: 'degraded' });
    const mismatchedScope = validateThaiRagHandshake({ ...baseHandshake, workspaceId: '22222222-2222-4222-8222-222222222222', workspaceReady: false });
    const requestedScope = validateThaiRagHandshake(baseHandshake, { workspaceId: '22222222-2222-4222-8222-222222222222' });
    expect(unavailable.ok).toBe(false);
    expect(degraded.ok).toBe(false);
    expect(mismatchedScope.ok).toBe(false);
    expect(requestedScope.ok).toBe(false);
    if (!unavailable.ok) expect(unavailable.error.details?.reason).toBe('health-unavailable');
    if (!degraded.ok) expect(degraded.error.details?.reason).toBe('health-degraded');
    if (!mismatchedScope.ok) expect(mismatchedScope.error.details?.reason).toBe('workspace-scope-unavailable');
    if (!requestedScope.ok) expect(requestedScope.error.details?.reason).toBe('workspace-scope-unavailable');
  });

  it('requires canonical capabilities for selective events and index jobs', () => {
    const missingEvent = validateThaiRagHandshake({
      ...baseHandshake,
      capabilities: baseHandshake.capabilities.filter((capability) => capability !== 'record_event'),
    });
    const missingIndexStatus = validateThaiRagHandshake({
      ...baseHandshake,
      capabilities: baseHandshake.capabilities.filter((capability) => capability !== 'index_status'),
    });
    expect(missingEvent.ok).toBe(false);
    expect(missingIndexStatus.ok).toBe(false);
    if (!missingEvent.ok) expect(missingEvent.error.details?.reason).toBe('missing-capability');
    if (!missingIndexStatus.ok) expect(missingIndexStatus.error.details?.reason).toBe('missing-capability');
  });

  it('allows explicitly supported legacy adapter metadata without category coupling', () => {
    const legacy = validateThaiRagHandshake({
      ...baseHandshake,
      contractVersion: '0.9',
      compatibilityRange: { min: '0.9', max: '1.x' },
      embedding: { ...baseHandshake.embedding, profile: `${THAI_RAG_LEGACY_EMBEDDING_PROFILE}:latest`, model: `${THAI_RAG_LEGACY_EMBEDDING_PROFILE}:latest`, preprocessingVersion: undefined },
      generation: { ...baseHandshake.generation, embedding: `${THAI_RAG_LEGACY_EMBEDDING_PROFILE}:latest` },
      capabilities: [...baseHandshake.capabilities],
      legacyAdapter: THAI_RAG_PRODUCTION_BRIDGE,
    }, { allowLegacyAdapter: true });
    expect(legacy.ok).toBe(true);
  });
});

describe('Thai-RAG producer handshake shape (issue #332)', () => {
  // Captured from the live provider `version` result on thai-rag main
  // (bec781f): the embedding identity is the llama.cpp deployment artifact that
  // `THAI_RAG_DEPLOYMENT_EMBEDDING_PROFILE` attests, and generation.index is
  // 'unknown' until an index run publishes a generation. Pinned so the contract
  // cannot start rejecting the shape the producer actually emits (#786).
  const liveShape: ThaiRagProviderHandshake = {
    ...baseHandshake,
    embedding: {
      ...baseHandshake.embedding,
      profile: THAI_RAG_DEPLOYMENT_EMBEDDING_PROFILE,
      model: THAI_RAG_DEPLOYMENT_EMBEDDING_PROFILE,
    },
    generation: {
      contract: THAI_RAG_CONTRACT_FINGERPRINT,
      embedding: THAI_RAG_DEPLOYMENT_EMBEDDING_PROFILE,
      index: 'unknown',
      storage: 'sqlite',
    },
  };

  it('accepts the exact shape the producer emits today', () => {
    const validated = validateThaiRagHandshake(liveShape);
    expect(validated.ok).toBe(true);
    if (validated.ok) expect(validated.value.embedding.profile).toBe(THAI_RAG_DEPLOYMENT_EMBEDDING_PROFILE);
  });

  it('canonicalizes a tagged deployment identity instead of reporting drift', () => {
    const tagged = validateThaiRagHandshake({
      ...liveShape,
      embedding: { ...liveShape.embedding, profile: `${THAI_RAG_DEPLOYMENT_EMBEDDING_PROFILE}:latest` },
    });
    expect(tagged.ok).toBe(true);
    if (tagged.ok) expect(tagged.value.embedding.profile).toBe(THAI_RAG_DEPLOYMENT_EMBEDDING_PROFILE);
  });

  it('still fails closed when the generation names a different embedding', () => {
    const drifted = validateThaiRagHandshake({
      ...liveShape,
      generation: { ...liveShape.generation, embedding: 'some-other-embedder:latest' },
    });
    expect(drifted.ok).toBe(false);
    if (!drifted.ok) expect(drifted.error.details?.reason).toBe('generation-drift');
  });
});

describe('Thai-RAG supported embedding identity (#786)', () => {
  it('attests the deployed llama.cpp artifact as the contract 1.0 profile', () => {
    expect(THAI_RAG_EMBEDDING_PROFILE).toBe(THAI_RAG_DEPLOYMENT_EMBEDDING_PROFILE);
    expect(THAI_RAG_EMBEDDING_COMPATIBILITY['1.0'].profile).toBe(THAI_RAG_DEPLOYMENT_EMBEDDING_PROFILE);
    expect(THAI_RAG_EMBEDDING_COMPATIBILITY['1.0'].model).toBe(THAI_RAG_EMBEDDING_PROFILE);
  });

  it('refuses a contract 1.0 handshake that still claims the retired Ollama/Nomic identity', () => {
    // A literal, not the constant: this pins the identity a pre-Phase-B provider
    // used to emit, which the 1.0 contract must no longer accept.
    const retiredIdentity = 'nomic-embed-text-v2-moe';
    const retired = {
      ...baseHandshake,
      embedding: {
        ...baseHandshake.embedding,
        profile: retiredIdentity,
        model: retiredIdentity,
      },
      generation: { ...baseHandshake.generation, embedding: retiredIdentity },
    };
    const result = validateThaiRagHandshake(retired);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details?.reason).toBe('embedding-metadata-invalid');
  });
});
