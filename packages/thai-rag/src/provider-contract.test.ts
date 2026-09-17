import { describe, expect, it } from 'vitest';
import { THAI_RAG_PROVIDER_ID } from './canonical-workspace.js';
import {
  THAI_RAG_PROVIDER_SCHEMA_VERSION,
  createProviderHealth,
  isEmbeddingIndexGenerationCompatible,
  isProviderHealthReady,
  transitionProviderState,
} from './provider-contract.js';

describe('provider health contract', () => {
  it('exposes the versioned provider identity consumed by observability', () => {
    expect(THAI_RAG_PROVIDER_ID).toBe('thai-rag');
    expect(THAI_RAG_PROVIDER_SCHEMA_VERSION).toBe(1);
    const health = createProviderHealth('4.61.0', 3);
    expect(health.schemaVersion).toBe(1);
    expect(health.providerId).toBe('thai-rag');
    expect(health.providerVersion).toBe('4.61.0');
    expect(health.state).toBe('stopped');
    expect(health.embeddingIndexGeneration).toBe(3);
    expect(isProviderHealthReady(health)).toBe(false);
  });

  it('reports readiness only when the provider is ready without unresolved degradation', () => {
    const health = { ...createProviderHealth('4.61.0', 3), state: 'ready' as const };
    expect(isProviderHealthReady(health)).toBe(true);
    expect(isProviderHealthReady({ ...health, state: 'degraded', degradation: ['embedder-offline'] })).toBe(false);
    expect(isProviderHealthReady({ ...health, degradation: ['embedder-offline'] })).toBe(false);
  });
});

describe('provider lifecycle transitions', () => {
  it('follows deterministic startup/readiness/restart/shutdown transitions', () => {
    expect(transitionProviderState('stopped', 'starting').ok).toBe(true);
    expect(transitionProviderState('starting', 'ready').ok).toBe(true);
    expect(transitionProviderState('starting', 'degraded').ok).toBe(true);
    expect(transitionProviderState('degraded', 'ready').ok).toBe(true);
    expect(transitionProviderState('ready', 'starting').ok).toBe(true);
    expect(transitionProviderState('ready', 'degraded').ok).toBe(true);
    expect(transitionProviderState('ready', 'stopping').ok).toBe(true);
    expect(transitionProviderState('stopping', 'stopped').ok).toBe(true);
    expect(transitionProviderState('starting', 'stopped').ok).toBe(true);
    expect(transitionProviderState('degraded', 'stopping').ok).toBe(true);
  });

  it('rejects skipping lifecycle states', () => {
    expect(transitionProviderState('stopped', 'ready').ok).toBe(false);
    expect(transitionProviderState('stopped', 'stopping').ok).toBe(false);
    expect(transitionProviderState('stopping', 'ready').ok).toBe(false);
    expect(transitionProviderState('stopping', 'starting').ok).toBe(false);
    expect(transitionProviderState('ready', 'ready').ok).toBe(false);
  });
});

describe('embedding/index generation compatibility', () => {
  it('accepts matching generations', () => {
    expect(isEmbeddingIndexGenerationCompatible(3, 3)).toBe(true);
  });

  it('detects incompatible generations instead of mixing them', () => {
    expect(isEmbeddingIndexGenerationCompatible(3, 2)).toBe(false);
    expect(isEmbeddingIndexGenerationCompatible(2, 3)).toBe(false);
  });

  it('rejects missing or malformed generations', () => {
    expect(isEmbeddingIndexGenerationCompatible(0, 0)).toBe(false);
    expect(isEmbeddingIndexGenerationCompatible(2.5, 2.5)).toBe(false);
    expect(isEmbeddingIndexGenerationCompatible(Number.NaN, 1)).toBe(false);
  });
});
