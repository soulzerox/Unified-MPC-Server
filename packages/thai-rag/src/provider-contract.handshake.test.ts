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
      capabilities: baseHandshake.capabilities.filter((capability) => capability !== 'record_event'),
      legacyAdapter: 'category-memory-scope',
    }, { allowLegacyAdapter: true });
    expect(legacy.ok).toBe(true);
  });
});
