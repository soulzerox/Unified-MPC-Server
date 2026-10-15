import { describe, expect, it } from 'vitest';
import {
  canonicalRevisionId,
  type CanonicalRevisionIdentityInput,
} from './canonical-revision.js';

const base: CanonicalRevisionIdentityInput = {
  repositoryId: 'repo_abc123',
  commitSha: 'a'.repeat(40),
  treeOid: 'b'.repeat(40),
  targetRef: 'refs/remotes/origin/main',
  parents: [],
};

describe('canonical revision identity (#210 U1)', () => {
  it('derives a stable revision id from exact commit/tree/ref', () => {
    expect(canonicalRevisionId(base)).toMatch(/^rev:v1:[0-9a-f]{64}$/);
    expect(canonicalRevisionId(base)).toBe(canonicalRevisionId({ ...base }));
  });

  it('treats commit/tree as identity, not the manifest cache key', () => {
    expect(canonicalRevisionId(base)).not.toBe(
      canonicalRevisionId({ ...base, commitSha: 'c'.repeat(40) }),
    );
    expect(canonicalRevisionId(base)).not.toBe(
      canonicalRevisionId({ ...base, treeOid: 'd'.repeat(40) }),
    );
  });

  it('rejects non-exact revision identity', () => {
    expect(() => canonicalRevisionId({ ...base, commitSha: 'abc' })).toThrow(TypeError);
    expect(() => canonicalRevisionId({ ...base, treeOid: '' })).toThrow(TypeError);
    expect(() => canonicalRevisionId({ ...base, targetRef: 'main' })).toThrow(TypeError);
    expect(() => canonicalRevisionId({ ...base, repositoryId: '' })).toThrow(TypeError);
  });
});
