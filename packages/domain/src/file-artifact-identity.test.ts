import { describe, expect, it } from 'vitest';
import {
  fileArtifactId,
  type FileArtifactIdentityInput,
} from './file-artifact-identity.js';

const base: FileArtifactIdentityInput = {
  sourceContentSha256: 'a'.repeat(64),
  language: 'typescript',
  sourceKind: 'source',
  representationVersion: 'v1',
};

describe('file artifact identity (#210 §1/§8)', () => {
  it('derives a stable content-addressed file key', () => {
    expect(fileArtifactId(base)).toMatch(/^file:v1:[0-9a-f]{64}$/);
    expect(fileArtifactId(base)).toBe(fileArtifactId({ ...base }));
  });

  it('changes when any key-bearing field changes', () => {
    expect(fileArtifactId(base)).not.toBe(fileArtifactId({ ...base, sourceContentSha256: 'b'.repeat(64) }));
    expect(fileArtifactId(base)).not.toBe(fileArtifactId({ ...base, language: 'python' }));
    expect(fileArtifactId(base)).not.toBe(fileArtifactId({ ...base, sourceKind: 'test' }));
    expect(fileArtifactId(base)).not.toBe(fileArtifactId({ ...base, representationVersion: 'v2' }));
  });

  it('normalizes content hash case, not tokens', () => {
    expect(fileArtifactId(base)).toBe(fileArtifactId({
      ...base,
      sourceContentSha256: 'A'.repeat(64),
    }));
    expect(fileArtifactId({ ...base, language: 'TypeScript' })).not.toBe(fileArtifactId(base));
  });

  it('rejects non-exact identity inputs', () => {
    expect(() => fileArtifactId({ ...base, sourceContentSha256: 'xyz' })).toThrow(TypeError);
    expect(() => fileArtifactId({ ...base, sourceContentSha256: 'a'.repeat(63) })).toThrow(TypeError);
    expect(() => fileArtifactId({ ...base, language: '' })).toThrow(TypeError);
    expect(() => fileArtifactId({ ...base, sourceKind: '' })).toThrow(TypeError);
    expect(() => fileArtifactId({ ...base, representationVersion: '' })).toThrow(TypeError);
    expect(() => fileArtifactId({
      ...base,
      language: 'type\u0000script',
    })).toThrow(TypeError);
  });
});
