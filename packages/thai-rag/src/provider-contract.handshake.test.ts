import { describe, expect, it } from 'vitest';
import {
  THAI_RAG_CONTRACT_FINGERPRINT,
  THAI_RAG_CONTRACT_VERSION,
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
    profile: 'nomic-embed-text-v2-moe',
    model: 'nomic-embed-text-v2-moe@sha256:abc',
    dimension: 768,
    preprocessingVersion: '1',
  },
  generation: {
    contract: THAI_RAG_CONTRACT_FINGERPRINT,
    embedding: 'nomic-embed-text-v2-moe',
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

  it.each([
    ['contract version mismatch', { contractVersion: '2.0' }],
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

  it('accepts production bridge metadata with unknown index and omitted preprocessing', () => {
    const production = {
      ...baseHandshake,
      health: 'degraded',
      embedding: { ...baseHandshake.embedding, preprocessingVersion: undefined },
      generation: { ...baseHandshake.generation, index: 'unknown' },
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
      legacyAdapter: 'thai-rag-provider-1.0-production-bridge',
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
      { embedding: { ...baseHandshake.embedding, model: 'other@sha256:abc' } },
      { embedding: { ...baseHandshake.embedding, model: 'nomic-embed-text-v2-moe@sha256:bad digest' } },
      { embedding: { ...baseHandshake.embedding, preprocessingVersion: '2' } },
      { embedding: { ...baseHandshake.embedding, preprocessingVersion: undefined } },
      { generation: { ...baseHandshake.generation, embedding: 'other-profile' } },
    ]) {
      const result = validateThaiRagHandshake({ ...baseHandshake, ...change }, { expectedEmbeddingModel: 'nomic-embed-text-v2-moe', expectedPreprocessingVersion: '1' });
      expect(result.ok).toBe(false);
    }
  });

  it('accepts model-family metadata without requiring a digest', () => {
    expect(validateThaiRagHandshake({ ...baseHandshake, embedding: { ...baseHandshake.embedding, model: 'nomic-embed-text-v2-moe' } }, { expectedEmbeddingModel: 'nomic-embed-text-v2-moe', expectedPreprocessingVersion: '1' }).ok).toBe(true);
  });

  it('enforces digest only when expected model publishes trusted digest', () => {
    const matching = validateThaiRagHandshake(baseHandshake, { expectedEmbeddingModel: 'nomic-embed-text-v2-moe@sha256:abc', expectedPreprocessingVersion: '1' });
    const drifted = validateThaiRagHandshake(baseHandshake, { expectedEmbeddingModel: 'nomic-embed-text-v2-moe@sha256:def', expectedPreprocessingVersion: '1' });
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
      capabilities: [...baseHandshake.capabilities],
      legacyAdapter: 'thai-rag-provider-1.0-production-bridge',
    }, { allowLegacyAdapter: true });
    expect(legacy.ok).toBe(true);
  });
});
