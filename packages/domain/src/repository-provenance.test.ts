import { describe, expect, it } from 'vitest';
import {
  defineRepositoryIdentity,
  sameTrustBoundary,
  requireSameTrustBoundary,
  trustBoundaryKey,
} from './repository-provenance.js';

const REMOTE = { kind: 'git-remote', locator: 'git@github.com:acme/app.git' } as const;

describe('repository provenance and trust scope (#210 U27)', () => {
  it('defines a validated identity and normalizes the remote locator', () => {
    const identity = defineRepositoryIdentity({
      repositoryId: 'repo_abc123',
      provenance: { kind: 'git-remote', locator: '  GIT@GitHub.com:Acme/App.GIT  ' },
      trustScope: 'trust:default',
    });
    expect(identity.provenance.locator).toBe('git@github.com:acme/app');
    expect(identity.trustScope).toBe('trust:default');
  });

  it('rejects empty repository id, scope or locator so a boundary can never be implicit', () => {
    expect(() => defineRepositoryIdentity({
      repositoryId: '  ', provenance: REMOTE, trustScope: 'trust:default',
    })).toThrow(/repositoryId/);
    expect(() => defineRepositoryIdentity({
      repositoryId: 'repo_abc123', provenance: REMOTE, trustScope: '',
    })).toThrow(/trustScope/);
    expect(() => defineRepositoryIdentity({
      repositoryId: 'repo_abc123', provenance: { kind: 'git-local', locator: '   ' }, trustScope: 'trust:default',
    })).toThrow(/locator/);
  });

  it('keys the boundary by repository plus trust scope, never by content hash', () => {
    const a = defineRepositoryIdentity({
      repositoryId: 'repo_abc123', provenance: REMOTE, trustScope: 'trust:default',
    });
    const b = defineRepositoryIdentity({
      repositoryId: 'repo_abc123', provenance: REMOTE, trustScope: 'trust:other',
    });
    expect(trustBoundaryKey(a)).not.toBe(trustBoundaryKey(b));
    expect(trustBoundaryKey(a)).toContain('repo_abc123');
  });

  it('denies sharing across a scope change or a different provenance locator', () => {
    const base = defineRepositoryIdentity({
      repositoryId: 'repo_abc123', provenance: REMOTE, trustScope: 'trust:default',
    });
    const otherScope = defineRepositoryIdentity({
      repositoryId: 'repo_abc123', provenance: REMOTE, trustScope: 'trust:other',
    });
    const otherOrigin = defineRepositoryIdentity({
      repositoryId: 'repo_abc123',
      provenance: { kind: 'git-remote', locator: 'git@github.com:attacker/app.git' },
      trustScope: 'trust:default',
    });
    const sameLocatorDifferentCase = defineRepositoryIdentity({
      repositoryId: 'repo_abc123',
      provenance: { kind: 'git-remote', locator: 'git@github.com:acme/app' },
      trustScope: 'trust:default',
    });

    expect(sameTrustBoundary(base, otherScope)).toBe(false);
    expect(sameTrustBoundary(base, otherOrigin)).toBe(false);
    expect(sameTrustBoundary(base, sameLocatorDifferentCase)).toBe(true);
    expect(sameTrustBoundary(base, defineRepositoryIdentity({
      repositoryId: 'repo_abc123', provenance: REMOTE, trustScope: 'trust:default',
    }))).toBe(true);

    expect(() => requireSameTrustBoundary(base, otherScope)).toThrow(/trust scope/i);
    expect(() => requireSameTrustBoundary(base, otherOrigin)).toThrow(/provenance/i);
    expect(() => requireSameTrustBoundary(base, {
      ...otherScope,
      repositoryId: 'repo_other',
    })).toThrow(/repository/i);
  });

  it('never lets an identical content hash stand in for a trust decision', () => {
    const local = defineRepositoryIdentity({
      repositoryId: 'repo_abc123',
      provenance: { kind: 'git-local', locator: '/tmp/fork' },
      trustScope: 'trust:default',
    });
    const remote = defineRepositoryIdentity({
      repositoryId: 'repo_abc123', provenance: REMOTE, trustScope: 'trust:default',
    });
    // Same repository id and same trust scope, but a fork's local path is a
    // different provenance: authorization must not be inferred from that.
    expect(sameTrustBoundary(local, remote)).toBe(false);
    expect(() => requireSameTrustBoundary(local, remote)).toThrow(/provenance/i);
  });
});
