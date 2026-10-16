import { describe, expect, it } from 'vitest';
import {
  computeTreeOid,
  decideCanonicalAdvancement,
  describeRefState,
  type CanonicalRefState,
} from './advancement-gate.js';

const C100: CanonicalRefState = {
  commitSha: 'a'.repeat(40),
  treeOid: 'b'.repeat(40),
  manifestId: 'man:v1:' + 'c'.repeat(64),
};
const C101: CanonicalRefState = {
  commitSha: 'd'.repeat(40),
  treeOid: 'e'.repeat(40),
  manifestId: 'man:v1:' + 'f'.repeat(64),
};

describe('canonical revision advancement gate (#210 U6)', () => {
  it('promotes when expected current matches and target is verified', () => {
    const decision = decideCanonicalAdvancement({
      expectedCurrent: C100,
      current: C100,
      target: C101,
      targetVerified: true,
    });
    expect(decision).toMatchObject({ action: 'promote', target: C101 });
  });

  it('no-ops when target already equals current', () => {
    const decision = decideCanonicalAdvancement({
      expectedCurrent: C100,
      current: C100,
      target: C100,
      targetVerified: true,
    });
    expect(decision).toMatchObject({ action: 'noop' });
  });

  it('rejects a stale expected current (CAS fence)', () => {
    const decision = decideCanonicalAdvancement({
      expectedCurrent: C100,
      current: C101,
      target: { commitSha: '9'.repeat(40), treeOid: '8'.repeat(40), manifestId: 'man:v1:' + '7'.repeat(64) },
      targetVerified: true,
    });
    expect(decision.action).toBe('conflict');
  });

  it('never promotes an unverified target', () => {
    const decision = decideCanonicalAdvancement({
      expectedCurrent: C100,
      current: C100,
      target: C101,
      targetVerified: false,
    });
    expect(decision.action).toBe('reject_unverified');
  });
});

describe('canonical tree OID (#210 U6)', () => {
  it('is order-independent and changes only with path/content', () => {
    const a = { path: 'a.ts', contentHash: '1'.repeat(64) };
    const b = { path: 'b.ts', contentHash: '2'.repeat(64) };
    expect(computeTreeOid([a, b])).toBe(computeTreeOid([b, a]));
    expect(computeTreeOid([a])).not.toBe(computeTreeOid([a, b]));
    expect(computeTreeOid([a])).not.toBe(computeTreeOid([{ path: 'a.ts', contentHash: '3'.repeat(64) }]));
  });
});

describe('ref state description (#210 U7 fix)', () => {
  it('renders unset as an explicit marker', () => {
    expect(describeRefState(null)).toBe('<unset>');
    expect(describeRefState({ commitSha: 'a'.repeat(40), treeOid: 'b'.repeat(40), manifestId: 'man' })).toContain('aaaaaaaaaaaa');
  });
});
