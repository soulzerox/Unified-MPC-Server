import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPrivateFdAuthorizedClientFactory } from '@unified-mpc/extensions';
import { createThaiRagPrivateWorkerBootstrap } from './native-thai-rag-private-bootstrap.js';

const WS = '14fc20d1-5836-4faf-aed6-0df6a9633a38';
const OTHER = 'ee83c457-0b79-49d7-937e-5c35aa91975d';
const python = process.env.THAI_RAG_REAL_PYTHON;
const source = process.env.THAI_RAG_REAL_SOURCE;

describe('real Python strict FD3 worker cross-repository E2E (explicit opt-in)', () => {
  it.skipIf(!python || !source)(
    'verifies the actual Python FastMCP challenge, scopes, and revocation before IPC',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'strict-python-fd3-e2e-'));
      let registered = true;
      try {
        const factory = createPrivateFdAuthorizedClientFactory({
          createBootstrap: () => createThaiRagPrivateWorkerBootstrap({
            ownerId: 'unified-real-python-e2e', authorityGeneration: 23,
            workspacesProvider: async () => registered ? [{ id: WS, realRootPath: root }] : [],
          }),
        });
        const session = await factory.connect({
          command: python!,
          args: ['-m', 'thai_rag.server'],
          env: { PYTHONPATH: source! },
        });
        try {
          const tools = await session.listTools();
          expect(tools.some(tool => tool.name === 'recall')).toBe(true);
          expect(tools.some(tool => tool.name === 'worker_authority_probe')).toBe(false);
          await expect(session.callTool('recall', { workspace_id: OTHER, query: 'forged' }))
            .rejects.toThrow('workspace_authority_denied');
          await expect(session.callTool('recall', { workspace_id: WS, query: 'attack',
            authority_proof: 'forged' })).rejects.toThrow('workspace_authority_denied');
          registered = false;
          // No further operation is required to fence the existing Python child.
          await expect.poll(async () => {
            try { await session.listTools(); return false; } catch { return true; }
          }, { timeout: 3_000, interval: 50 }).toBe(true);
          // Restoring the same registration cannot revive its old secret.
          registered = true;
          await expect(session.callTool('recall', { workspace_id: WS, query: 'revoked' }))
            .rejects.toThrow('workspace_authority_denied');
        } finally {
          await session.close();
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }, 45_000,
  );

  it.skipIf(!python || !source)(
    'fences idle actual Python worker on root symlink swap and refuses restored path',
    async () => {
      const base = await mkdtemp(path.join(os.tmpdir(), 'strict-python-root-swap-'));
      const root = path.join(base, 'root');
      const other = path.join(base, 'other');
      try {
        await mkdir(root);
        await mkdir(other);
        const factory = createPrivateFdAuthorizedClientFactory({
          createBootstrap: () => createThaiRagPrivateWorkerBootstrap({
            ownerId: 'unified-real-python-root-swap', authorityGeneration: 24,
            workspacesProvider: async () => [{ id: WS, realRootPath: root }],
          }),
        });
        const session = await factory.connect({
          command: python!,
          args: ['-m', 'thai_rag.server'],
          env: { PYTHONPATH: source! },
        });
        try {
          expect((await session.listTools()).some(t => t.name === 'recall')).toBe(true);
          await rm(root, { recursive: true });
          await symlink(other, root);
          await expect.poll(async () => {
            try { await session.listTools(); return false; } catch { return true; }
          }, { timeout: 3_000, interval: 50 }).toBe(true);
          await rm(root);
          await mkdir(root);
          await expect(session.callTool('health', {}))
            .rejects.toThrow('workspace_authority_denied');
        } finally { await session.close(); }
      } finally { await rm(base, { recursive: true, force: true }); }
    }, 45_000,
  );
});
