import { describe, expect, it } from 'vitest';
import {
  canonicalManifestId,
  type CanonicalManifestIdentityInput,
} from './canonical-manifest.js';

const base: CanonicalManifestIdentityInput = {
  repositoryId: 'repo_abc123',
  revisionId: 'rev:v1:deadbeef',
  entries: [
    { path: 'b.ts', contentHash: 'b'.repeat(64) },
    { path: 'a.ts', contentHash: 'a'.repeat(64) },
  ],
};

describe('canonical manifest identity (#210 U2)', () => {
  it('derives a stable manifest id independent of entry order', () => {
    const reordered: CanonicalManifestIdentityInput = {
      ...base,
      entries: [...base.entries].reverse(),
    };
    expect(canonicalManifestId(base)).toMatch(/^man:v1:[0-9a-f]{64}$/);
    expect(canonicalManifestId(base)).toBe(canonicalManifestId(reordered));
  });

  it('changes when content changes, not when commit-only metadata changes', () => {
    expect(canonicalManifestId(base)).not.toBe(
      canonicalManifestId({
        ...base,
        entries: [{ path: 'a.ts', contentHash: 'c'.repeat(64) }],
      }),
    );
  });

  it('rejects non-exact manifest identity', () => {
    expect(() => canonicalManifestId({ ...base, revisionId: '' })).toThrow(TypeError);
    expect(() => canonicalManifestId({ ...base, repositoryId: '' })).toThrow(TypeError);
    expect(() => canonicalManifestId({
      ...base,
      entries: [{ path: '', contentHash: 'a'.repeat(64) }],
    })).toThrow(TypeError);
    expect(() => canonicalManifestId({
      ...base,
      entries: [{ path: 'a.ts', contentHash: 'xyz' }],
    })).toThrow(TypeError);
    expect(() => canonicalManifestId({
      ...base,
      entries: [
        { path: 'a.ts', contentHash: 'a'.repeat(64) },
        { path: 'a.ts', contentHash: 'b'.repeat(64) },
      ],
    })).toThrow(TypeError);
  });
});
