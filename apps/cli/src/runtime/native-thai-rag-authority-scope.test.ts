import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { issueRegisteredThaiRagWorkspaceProof, type ThaiRagTrustedAuthority } from './native-thai-rag-authority-scope.js';

const WS = '14fc20d1-5836-4faf-aed6-0df6a9633a38';
const FOREIGN = 'ee83c457-0b79-49d7-937e-5c35aa91975d';
const created: string[] = [];

async function dir(): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), 'thai-rag-bound-authority-'));
  created.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

function authority(
  workspacesProvider: ThaiRagTrustedAuthority['workspacesProvider'],
  overrides: Partial<ThaiRagTrustedAuthority> = {},
): ThaiRagTrustedAuthority {
  return {
    secret: Buffer.alloc(32, 9), ownerId: 'unified-worker-1',
    authorityGeneration: 7, workspacesProvider,
    clockSeconds: () => 1000, ttlSeconds: 30, nonceFactory: () => 'nonce-001',
    ...overrides,
  };
}

function request(workspaceId = WS) {
  return { workspaceId, operation: 'recall' };
}

function payload(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString('utf8')) as Record<string, unknown>;
}

describe('Unified trusted live registry proof issuance', () => {
  it('issues only from the registered canonical directory and derives the root hash itself', async () => {
    const root = await dir();
    let calls = 0;
    const trusted = authority(async () => {
      calls += 1;
      return [{ id: WS, realRootPath: root }];
    });
    const issued = await issueRegisteredThaiRagWorkspaceProof(trusted, request());
    const claims = payload(issued);
    const expected = createHash('sha256').update(await realpath(root), 'utf8').digest('hex');
    expect(claims).toMatchObject({
      workspace_id: WS, operation: 'recall', owner_id: 'unified-worker-1',
      authority_generation: 7, root_fingerprint: `sha256:${expected}`,
      issued_at: 1000, expires_at: 1030, nonce: 'nonce-001',
    });
    expect(calls).toBe(1);
    expect(issued.split('.')).toHaveLength(2);
  });

  it('rejects forged, unregistered or duplicate workspace ids before issuing', async () => {
    const root = await dir();
    const one = authority(async () => [{ id: WS, realRootPath: root }]);
    await expect(issueRegisteredThaiRagWorkspaceProof(one, request(FOREIGN))).rejects.toThrow('thai_rag_authority_denied');
    await expect(issueRegisteredThaiRagWorkspaceProof(one, request(WS.toUpperCase()))).rejects.toThrow('thai_rag_authority_denied');
    await expect(issueRegisteredThaiRagWorkspaceProof(one, request('local-' + 'f'.repeat(32)))).rejects.toThrow('thai_rag_authority_denied');
    const duplicate = authority(async () => [{ id: WS, realRootPath: root }, { id: WS, realRootPath: root }]);
    await expect(issueRegisteredThaiRagWorkspaceProof(duplicate, request())).rejects.toThrow('thai_rag_authority_denied');
  });

  it('denies symlinks, stale moved roots, non-directory roots and relative roots', async () => {
    const original = await dir();
    const other = await dir();
    const link = path.join(original, 'alias');
    await symlink(other, link);
    const linked = authority(async () => [{ id: WS, realRootPath: link }]);
    await expect(issueRegisteredThaiRagWorkspaceProof(linked, request())).rejects.toThrow('thai_rag_authority_denied');
    const file = path.join(original, 'file.txt');
    await writeFile(file, 'not a workspace');
    await expect(issueRegisteredThaiRagWorkspaceProof(
      authority(async () => [{ id: WS, realRootPath: file }]), request()
    )).rejects.toThrow('thai_rag_authority_denied');
    await expect(issueRegisteredThaiRagWorkspaceProof(
      authority(async () => [{ id: WS, realRootPath: 'relative/root' }]), request()
    )).rejects.toThrow('thai_rag_authority_denied');
    const stale = path.join(original, 'deleted');
    await mkdir(stale);
    await rm(stale, { recursive: true, force: true });
    await expect(issueRegisteredThaiRagWorkspaceProof(
      authority(async () => [{ id: WS, realRootPath: stale }]), request()
    )).rejects.toThrow('thai_rag_authority_denied');
  });

  it('consults live registry on each issuance and fails closed when unavailable', async () => {
    const root = await dir();
    let allowed = true;
    const trusted = authority(async () => allowed ? [{ id: WS, realRootPath: root }] : []);
    expect(payload(await issueRegisteredThaiRagWorkspaceProof(trusted, request())).workspace_id).toBe(WS);
    allowed = false;
    await expect(issueRegisteredThaiRagWorkspaceProof(trusted, request())).rejects.toThrow('thai_rag_authority_denied');
    const unavailable = authority(async () => { throw new Error('sensitive registry details'); });
    await expect(issueRegisteredThaiRagWorkspaceProof(unavailable, request())).rejects.toThrow('thai_rag_authority_denied');
  });

  it('does not permit a caller-provided root override, weak proof TTL or invalid operations', async () => {
    const root = await dir();
    const trusted = authority(async () => [{ id: WS, realRootPath: root }]);
    await expect(issueRegisteredThaiRagWorkspaceProof(
      { ...trusted, ttlSeconds: 61 }, request(),
    )).rejects.toThrow('thai_rag_authority_denied');
    await expect(issueRegisteredThaiRagWorkspaceProof(trusted, { ...request(), operation: 'dangerous' }))
      .rejects.toThrow('thai_rag_authority_denied');
    const randomAuthority = { ...trusted, nonceFactory: undefined };
    const first = await issueRegisteredThaiRagWorkspaceProof(randomAuthority, request());
    const second = await issueRegisteredThaiRagWorkspaceProof(randomAuthority, request());
    expect(first).not.toBe(second);
    const forged = { ...request(), rootFingerprint: 'sha256:' + '0'.repeat(64), issuedAt: 9999999999, nonce: 'attacker00' };
    const verified = payload(await issueRegisteredThaiRagWorkspaceProof(trusted, forged));
    expect(verified.issued_at).toBe(1000);
    expect(verified.nonce).toBe('nonce-001');
    expect(verified.root_fingerprint).not.toBe(forged.rootFingerprint);
  });
});
