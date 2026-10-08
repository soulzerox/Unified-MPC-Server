import { describe, expect, it } from 'vitest';
import { issueThaiRagWorkspaceProof, type ThaiRagAuthorityIssueOptions } from './native-thai-rag-authority.js';

const WS = '14fc20d1-5836-4faf-aed6-0df6a9633a38';
const ROOT = `sha256:${'b'.repeat(64)}`;

// Generated with the Python thai_rag.external_authority.issue_attestation
// from main (Thai-RAG PR #192), not a TS-only self-reference.
const PYTHON_GOLDEN = 'eyJhdXRob3JpdHlfZ2VuZXJhdGlvbiI6NywiZXhwaXJlc19hdCI6MTAzMCwiaXNzdWVkX2F0IjoxMDAwLCJub25jZSI6Im5vbmNlLTAwMSIsIm9wZXJhdGlvbiI6InJlY2FsbCIsIm93bmVyX2lkIjoidW5pZmllZC13b3JrZXItMSIsInJvb3RfZmluZ2VycHJpbnQiOiJzaGEyNTY6YmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYiIsIndvcmtzcGFjZV9pZCI6IjE0ZmMyMGQxLTU4MzYtNGZhZi1hZWQ2LTBkZjZhOTYzM2EzOCJ9.QfMK0kLs2ixQq_Ksa18th55cFEqlGz0GgM6GOYn01ys';

function fixture(): ThaiRagAuthorityIssueOptions {
  return {
    secret: Buffer.alloc(32),
    workspaceId: WS,
    operation: 'recall',
    ownerId: 'unified-worker-1',
    authorityGeneration: 7,
    rootFingerprint: ROOT,
    issuedAt: 1000,
    expiresAt: 1030,
    nonce: 'nonce-001',
  };
}

describe('Unified => Thai-RAG HMAC workspace authority proof contract', () => {
  it('byte-matches the actual Python verifier/issuer golden token', () => {
    expect(issueThaiRagWorkspaceProof(fixture())).toBe(PYTHON_GOLDEN);
    const [encodedClaims, signature, extra] = PYTHON_GOLDEN.split('.');
    expect(encodedClaims).toBeTruthy();
    expect(signature).toBeTruthy();
    expect(extra).toBeUndefined();
    expect(Buffer.from(encodedClaims!, 'base64url').toString('utf8')).toContain('"workspace_id"');
  });

  it('uses independent random nonces and emits canonical base64url when no nonce provided', () => {
    const { nonce: _nonce, ...withoutNonce } = fixture();
    const first = issueThaiRagWorkspaceProof(withoutNonce);
    const second = issueThaiRagWorkspaceProof(withoutNonce);
    expect(first).not.toBe(second);
    for (const token of [first, second]) {
      expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
      const decoded = JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString('utf8')) as { nonce: string };
      expect(decoded.nonce).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
    }
  });

  it('rejects weak keys, invalid authority scopes and stale claim lifetimes', () => {
    const invalid: Array<Partial<ThaiRagAuthorityIssueOptions>> = [
      { secret: Buffer.alloc(31) },
      { workspaceId: WS.toUpperCase() },
      { workspaceId: 'local-' + 'f'.repeat(32) },
      { operation: 'delete_everything' as never },
      { ownerId: '' },
      { ownerId: 'owner-😀' },
      { authorityGeneration: 0 },
      { authorityGeneration: 1.5 },
      { rootFingerprint: `sha256:${'Z'.repeat(64)}` },
      { rootFingerprint: ROOT.slice(0, -1) },
      { issuedAt: -1 },
      { expiresAt: 1000 },
      { expiresAt: 1061 },
      { nonce: 'short' },
      { nonce: 'nonce bad space' },
    ];
    for (const change of invalid) {
      expect(() => issueThaiRagWorkspaceProof({ ...fixture(), ...change })).toThrow('thai_rag_authority_denied');
    }
  });

  it('binds operation and scope in signed claims, without reflecting secret material', () => {
    const token = issueThaiRagWorkspaceProof({
      ...fixture(), operation: 'pre_edit_context', nonce: 'nonce-002',
    });
    const payload = Buffer.from(token.split('.')[0]!, 'base64url').toString('utf8');
    expect(payload).toContain('"operation":"pre_edit_context"');
    expect(payload).toContain('"root_fingerprint":"sha256:');
    expect(payload).not.toContain('secret');
    expect(payload).not.toContain('Buffer');
    expect(payload).not.toContain('undefined');
  });
});
