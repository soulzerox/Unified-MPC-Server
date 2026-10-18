import { describe, expect, it } from 'vitest';
import {
  semanticArtifactId,
  type SemanticArtifactIdentityInput,
} from './semantic-artifact-identity.js';

const base: SemanticArtifactIdentityInput = {
  trustBoundaryKey: 'b'.repeat(64),
  chunkContentSha256: 'c'.repeat(64),
  embeddingProfile: 'nomic-embed/embed-v1',
  dimension: 768,
  normalizationFingerprint: 'norm:l2:trunc-1',
  chunkerFingerprint: 'chunker:v2:token-512-overlap-64',
  representationVersion: 'v1',
};

describe('semantic chunk artifact identity (#210 §1)', () => {
  it('derives a stable trust-scoped semantic key', () => {
    expect(semanticArtifactId(base)).toMatch(/^chunk:v1:[0-9a-f]{64}$/);
    expect(semanticArtifactId(base)).toBe(semanticArtifactId({ ...base }));
  });

  it('changes when any representation-bearing field changes', () => {
    expect(semanticArtifactId(base)).not.toBe(semanticArtifactId({ ...base, trustBoundaryKey: 'd'.repeat(64) }));
    expect(semanticArtifactId(base)).not.toBe(semanticArtifactId({ ...base, chunkContentSha256: 'e'.repeat(64) }));
    expect(semanticArtifactId(base)).not.toBe(semanticArtifactId({ ...base, embeddingProfile: 'other-embed/embed-v2' }));
    expect(semanticArtifactId(base)).not.toBe(semanticArtifactId({ ...base, dimension: 1024 }));
    expect(semanticArtifactId(base)).not.toBe(semanticArtifactId({ ...base, normalizationFingerprint: 'norm:l2:none' }));
    expect(semanticArtifactId(base)).not.toBe(semanticArtifactId({ ...base, chunkerFingerprint: 'chunker:v3:token-256-overlap-0' }));
    expect(semanticArtifactId(base)).not.toBe(semanticArtifactId({ ...base, representationVersion: 'v2' }));
  });

  it('is a content+configuration identity — no path, no commit', () => {
    // §1: reuse goes below file level, keyed by content + fingerprints; §8/§16
    // keep path and commit provenance out of artifact keys entirely, so there
    // is no field for them here to begin with.
    expect(semanticArtifactId(base)).toBe(semanticArtifactId({
      ...base,
      embeddingProfile: base.embeddingProfile,
      dimension: base.dimension,
      normalizationFingerprint: base.normalizationFingerprint,
      chunkerFingerprint: base.chunkerFingerprint,
      representationVersion: base.representationVersion,
      trustBoundaryKey: base.trustBoundaryKey,
      chunkContentSha256: base.chunkContentSha256,
    }));
  });

  it('rejects non-exact identity inputs', () => {
    expect(() => semanticArtifactId({ ...base, trustBoundaryKey: '' })).toThrow(TypeError);
    expect(() => semanticArtifactId({ ...base, chunkContentSha256: 'nothex' })).toThrow(TypeError);
    expect(() => semanticArtifactId({ ...base, embeddingProfile: '' })).toThrow(TypeError);
    expect(() => semanticArtifactId({ ...base, dimension: 0 })).toThrow(TypeError);
    expect(() => semanticArtifactId({ ...base, dimension: 1.5 })).toThrow(TypeError);
    expect(() => semanticArtifactId({ ...base, normalizationFingerprint: '' })).toThrow(TypeError);
    expect(() => semanticArtifactId({ ...base, chunkerFingerprint: '' })).toThrow(TypeError);
    expect(() => semanticArtifactId({ ...base, representationVersion: '' })).toThrow(TypeError);
    expect(() => semanticArtifactId({ ...base, chunkContentSha256: 'c'.repeat(63) })).toThrow(TypeError);
    expect(() => semanticArtifactId({
      ...base,
      embeddingProfile: 'embed\u0000v1',
    })).toThrow(TypeError);
  });
});
