import { describe, expect, it } from 'vitest';
import {
  isPublishCredentialHost,
  isPublishCredentialLeaseId,
  isPublishCredentialSecret,
  isPublishCredentialTimestamp,
  isPublishCredentialUsername,
  isValidPublishCredentialLease,
  type PublishCredentialLease,
} from './publish-credential.js';

function lease(overrides: Partial<PublishCredentialLease> = {}): PublishCredentialLease {
  return {
    leaseId: 'lease-1',
    workspaceId: 'workspace-1',
    remote: 'origin',
    hosts: ['github.com'],
    username: 'git',
    createdAt: 1_000,
    expiresAt: 2_000,
    ...overrides,
  };
}

describe('publish credential validators', () => {
  it('accepts only SecretStore-safe lease ids', () => {
    expect(isPublishCredentialLeaseId('lease-1')).toBe(true);
    expect(isPublishCredentialLeaseId('a.b_c-9')).toBe(true);
    expect(isPublishCredentialLeaseId('a'.repeat(120))).toBe(true);
    expect(isPublishCredentialLeaseId('')).toBe(false);
    expect(isPublishCredentialLeaseId('publish/lease')).toBe(false);
    expect(isPublishCredentialLeaseId('lease id')).toBe(false);
    // 121 id characters would build a 129-character `publish-` key, which the
    // SecretStore refuses, so the id bound stops at 120.
    expect(isPublishCredentialLeaseId('a'.repeat(121))).toBe(false);
    expect(isPublishCredentialLeaseId('a'.repeat(129))).toBe(false);
    expect(isPublishCredentialLeaseId(42)).toBe(false);
  });

  it('accepts lowercase host or host:port targets only', () => {
    expect(isPublishCredentialHost('github.com')).toBe(true);
    expect(isPublishCredentialHost('git.example.com:8443')).toBe(true);
    expect(isPublishCredentialHost('localhost')).toBe(true);
    expect(isPublishCredentialHost('127.0.0.1:443')).toBe(true);
    expect(isPublishCredentialHost('GitHub.com')).toBe(false);
    expect(isPublishCredentialHost('github.com:')).toBe(false);
    expect(isPublishCredentialHost('github.com:0')).toBe(false);
    expect(isPublishCredentialHost('github.com:70000')).toBe(false);
    expect(isPublishCredentialHost('-github.com')).toBe(false);
    expect(isPublishCredentialHost('github-.com')).toBe(false);
    expect(isPublishCredentialHost('git..example.com')).toBe(false);
    expect(isPublishCredentialHost('[::1]')).toBe(false);
    expect(isPublishCredentialHost('')).toBe(false);
  });

  it('bounds the operator username and refuses control characters', () => {
    expect(isPublishCredentialUsername('git')).toBe(true);
    expect(isPublishCredentialUsername('a'.repeat(256))).toBe(true);
    expect(isPublishCredentialUsername('a'.repeat(257))).toBe(false);
    expect(isPublishCredentialUsername('')).toBe(false);
    expect(isPublishCredentialUsername('git\nuser')).toBe(false);
    expect(isPublishCredentialUsername('git\u0000user')).toBe(false);
  });

  it('accepts a single-line non-empty secret', () => {
    expect(isPublishCredentialSecret('token')).toBe(true);
    expect(isPublishCredentialSecret('')).toBe(false);
    expect(isPublishCredentialSecret('   ')).toBe(false);
    expect(isPublishCredentialSecret('line\nline')).toBe(false);
  });

  it('validates a complete lease', () => {
    expect(isValidPublishCredentialLease(lease())).toBe(true);
    expect(isValidPublishCredentialLease(lease({ remote: 'https://github.com/org/repo.git' }))).toBe(false);
    expect(isValidPublishCredentialLease(lease({ hosts: [] }))).toBe(false);
    expect(isValidPublishCredentialLease(lease({ hosts: ['github.com', 'github.com'] }))).toBe(false);
    expect(isValidPublishCredentialLease(lease({ hosts: ['GitHub.com'] }))).toBe(false);
    expect(isValidPublishCredentialLease(lease({ username: '' }))).toBe(false);
    expect(isValidPublishCredentialLease(lease({ expiresAt: 1_000 }))).toBe(false);
    expect(isValidPublishCredentialLease(lease({ expiresAt: 999 }))).toBe(false);
    expect(isValidPublishCredentialLease(lease({ createdAt: -1 }))).toBe(false);
    expect(isValidPublishCredentialLease(lease({ workspaceId: '' }))).toBe(false);
  });

  it('treats only non-negative safe integers as timestamps', () => {
    expect(isPublishCredentialTimestamp(0)).toBe(true);
    expect(isPublishCredentialTimestamp(-1)).toBe(false);
    expect(isPublishCredentialTimestamp(1.5)).toBe(false);
    expect(isPublishCredentialTimestamp(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
  });
});
