import { createHash, createHmac } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createThaiRagPrivateWorkerBootstrap } from './native-thai-rag-private-bootstrap.js';

const WS = '14fc20d1-5836-4faf-aed6-0df6a9633a38';
const OTHER = 'ee83c457-0b79-49d7-937e-5c35aa91975d';
const dirs: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'thai-rag-private-bootstrap-'));
  dirs.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function options(workspacesProvider: () => Promise<readonly { id: string; realRootPath: string }[]>) {
  return { ownerId: 'unified-worker-1', authorityGeneration: 7, workspacesProvider };
}

describe('Unified private Python-worker bootstrap payload', () => {
  it('makes external durable-generation read errors sticky, even if the reader later recovers', async () => {
    const root = await tempRoot();
    let epoch = 7;
    let unavailable = false;
    const worker = await createThaiRagPrivateWorkerBootstrap({
      ...options(async () => [{ id: WS, realRootPath: root }]),
      registryGenerationProvider: () => {
        if (unavailable) throw new Error('sqlite temporarily locked');
        return epoch;
      },
    });
    expect(await worker.validateLiveBinding()).toBe(true);
    unavailable = true;
    expect(await worker.validateLiveBinding()).toBe(false);
    unavailable = false;
    expect(await worker.validateLiveBinding()).toBe(false);
    await expect(worker.issue({ workspaceId: WS, operation: 'recall' }))
      .rejects.toThrow('thai_rag_authority_denied');
    worker.dispose();

    epoch += 1;
    await expect(createThaiRagPrivateWorkerBootstrap({
      ...options(async () => [{ id: WS, realRootPath: root }]),
      registryGenerationProvider: () => epoch,
    })).resolves.toHaveProperty('payload');
  });

  it('matches inherited-FD Python wire schema, signs tokens with per-worker secret and live roots', async () => {
    const root = await tempRoot();
    const worker = await createThaiRagPrivateWorkerBootstrap(options(async () => [{ id: WS, realRootPath: root }]));
    const decoded = JSON.parse(worker.payload.toString('utf8')) as Record<string, unknown>;
    expect(Object.keys(decoded).sort()).toEqual(['authority_generation', 'owner_id', 'secret_b64url', 'workspace_roots']);
    expect(decoded.owner_id).toBe('unified-worker-1');
    expect(decoded.authority_generation).toBe(7);
    expect(decoded.workspace_roots).toEqual({ [WS]: root });
    const secret = Buffer.from(decoded.secret_b64url as string, 'base64url');
    expect(secret.byteLength).toBe(32);
    expect(worker.payload.length).toBeLessThan(128 * 1024);
    const token = await worker.issue({ workspaceId: WS, operation: 'recall' });
    const [body, signature] = token.split('.');
    expect(Buffer.from(body!, 'base64url').toString('utf8')).toContain('"workspace_id"');
    const sig = createHmac('sha256', secret)
      .update('thai-rag-external-workspace-authority-v1\0')
      .update(Buffer.from(body!, 'base64url'))
      .digest('base64url');
    expect(signature).toBe(sig);
    const claims = JSON.parse(Buffer.from(body!, 'base64url').toString('utf8')) as Record<string, unknown>;
    expect(claims.root_fingerprint).toBe('sha256:' + createHash('sha256').update(root).digest('hex'));
    worker.dispose();
    expect(worker.payload.every(x => x === 0)).toBe(true);
    await expect(worker.issue({ workspaceId: WS, operation: 'recall' })).rejects.toThrow('thai_rag_authority_denied');
  });

  it('fresh launch rotates secret independently of stable owner and generation', async () => {
    const root = await tempRoot();
    const config = options(async () => [{ id: WS, realRootPath: root }]);
    const first = await createThaiRagPrivateWorkerBootstrap(config);
    const second = await createThaiRagPrivateWorkerBootstrap(config);
    const a = JSON.parse(first.payload.toString('utf8')) as { secret_b64url: string };
    const b = JSON.parse(second.payload.toString('utf8')) as { secret_b64url: string };
    expect(a.secret_b64url).not.toBe(b.secret_b64url);
    expect(first.payload.toString('utf8')).not.toBe(second.payload.toString('utf8'));
    first.dispose();
    second.dispose();
  });

  it('refuses absent/duplicate/unregistered/aliased/relative/symlink/missing roots', async () => {
    const root = await tempRoot();
    const missing = await tempRoot();
    const link = path.join(root, 'alias');
    await symlink(missing, link);
    const invalids = [
      [{ id: WS, realRootPath: root }, { id: WS, realRootPath: root }],
      [{ id: WS, realRootPath: root }, { id: OTHER, realRootPath: root }],
      [{ id: 'local-' + '0'.repeat(32), realRootPath: root }],
      [{ id: WS.toUpperCase(), realRootPath: root }],
      [{ id: WS, realRootPath: 'relative/path' }],
      [{ id: WS, realRootPath: link }],
      [{ id: WS, realRootPath: path.join(root, 'nonexistent') }],
      [],
    ];
    for (const entries of invalids) {
      await expect(createThaiRagPrivateWorkerBootstrap(options(async () => entries)))
        .rejects.toThrow('thai_rag_authority_denied');
    }
  });

  it('fences an existing child on live registration deletion even when its root stays on disk', async () => {
    const root = await tempRoot();
    let registered = true;
    const worker = await createThaiRagPrivateWorkerBootstrap(options(async () =>
      registered ? [{ id: WS, realRootPath: root }] : []));
    expect(await worker.validateLiveBinding()).toBe(true);
    registered = false;
    expect(await worker.validateLiveBinding()).toBe(false);
    await expect(worker.issue({ workspaceId: WS, operation: 'recall' }))
      .rejects.toThrow('thai_rag_authority_denied');
    worker.dispose();
    expect(await worker.validateLiveBinding()).toBe(false);
  });

  it('fences same-path directory replacement and symlink relocation despite unchanged registry entry', async () => {
    const parent = await tempRoot();
    const root = path.join(parent, 'workspace');
    const replacement = path.join(parent, 'replacement');
    await mkdir(root);
    await mkdir(replacement);
    const worker = await createThaiRagPrivateWorkerBootstrap(options(async () =>
      [{ id: WS, realRootPath: root }]));
    expect(await worker.validateLiveBinding()).toBe(true);
    await rm(root, { recursive: true });
    await symlink(replacement, root);
    expect(await worker.validateLiveBinding()).toBe(false);
    await rm(root);
    await mkdir(root);
    expect(await worker.validateLiveBinding()).toBe(false);
    await expect(worker.issue({ workspaceId: WS, operation: 'recall' }))
      .rejects.toThrow('thai_rag_authority_denied');
    worker.dispose();
  });

  it('fails closed on bad authority context/registry and never exposes key in env/argv', async () => {
    const root = await tempRoot();
    const provider = async () => [{ id: WS, realRootPath: root }];
    await expect(createThaiRagPrivateWorkerBootstrap({ ...options(provider), authorityGeneration: 0 }))
      .rejects.toThrow('thai_rag_authority_denied');
    await expect(createThaiRagPrivateWorkerBootstrap({ ...options(provider), ownerId: 'illegal 🔥' }))
      .rejects.toThrow('thai_rag_authority_denied');
    await expect(createThaiRagPrivateWorkerBootstrap(options(async () => { throw new Error('private registry details'); })))
      .rejects.toThrow('thai_rag_authority_denied');
    const before = Object.keys(process.env).filter(k => k.startsWith('THAI_RAG_EXTERNAL_AUTH'));
    const worker = await createThaiRagPrivateWorkerBootstrap(options(provider));
    const after = Object.keys(process.env).filter(k => k.startsWith('THAI_RAG_EXTERNAL_AUTH'));
    expect(after).toEqual(before);
    expect(worker.payload.toString('utf8')).toContain('secret_b64url');
    worker.dispose();
  });

  it('refuses issuance after live parent registry revocation while bootstrap snapshot stays unchanged', async () => {
    const root = await tempRoot();
    let allowed = true;
    const worker = await createThaiRagPrivateWorkerBootstrap(options(async () =>
      allowed ? [{ id: WS, realRootPath: root }] : []));
    expect(await worker.issue({ workspaceId: WS, operation: 'recall' })).toContain('.');
    allowed = false;
    await expect(worker.issue({ workspaceId: WS, operation: 'recall' }))
      .rejects.toThrow('thai_rag_authority_denied');
    worker.dispose();
  });
});
