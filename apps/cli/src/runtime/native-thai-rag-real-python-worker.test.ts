import { mkdtemp, rm } from 'node:fs/promises';
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
});
