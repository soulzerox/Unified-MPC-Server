import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveThaiRagWorkspaceNamespace } from './canonical-workspace.js';
import {
  ThaiRagWorkspaceVerificationStore,
  type ThaiRagWorkspaceVerificationInput,
} from './workspace-verification-store.js';

const WORKSPACE = '0f2e1500-b802-4a1f-8c11-00000000000a';
const roots: string[] = [];
const identity = {
  repositoryIdentity: 'repo-a',
  gitCommonDirIdentity: 'git-a',
  worktreeIdentity: 'worktree-a',
  branchName: 'main',
  workspaceHead: 'a'.repeat(40),
  dirtyFingerprint: 'clean',
  stagedFingerprint: 'none',
};

async function root(): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), 'unified-thai-rag-verification-'));
  roots.push(value);
  return value;
}

function input(overrides: Partial<ThaiRagWorkspaceVerificationInput> = {}): ThaiRagWorkspaceVerificationInput {
  return {
    workspaceId: WORKSPACE,
    sourceIdentity: identity,
    outcome: 'unchanged',
    indexedFiles: 0,
    skippedFiles: 0,
    totalFiles: 0,
    providerJobId: 'idx_verification',
    probeFilePath: '/workspace/package.json',
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

describe('ThaiRagWorkspaceVerificationStore', () => {
  it('persists the verified source identity across store instances', async () => {
    const dataRoot = await root();
    const store = new ThaiRagWorkspaceVerificationStore(dataRoot, {
      now: (): Date => new Date('2026-10-26T00:00:00.000Z'),
    });
    const recorded = await store.record(input());
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    expect(recorded.value).toMatchObject({
      workspaceId: WORKSPACE,
      outcome: 'unchanged',
      sourceIdentity: identity,
      verifiedAt: '2026-10-26T00:00:00.000Z',
      providerJobId: 'idx_verification',
      probeFilePath: '/workspace/package.json',
    });

    const reloaded = await new ThaiRagWorkspaceVerificationStore(dataRoot).get(WORKSPACE);
    expect(reloaded.ok).toBe(true);
    if (!reloaded.ok) return;
    expect(reloaded.value).toEqual(recorded.value);
    await expect(store.isFresh(WORKSPACE, identity)).resolves.toEqual({ ok: true, value: true });

    const namespace = resolveThaiRagWorkspaceNamespace(dataRoot, WORKSPACE);
    expect(namespace.ok).toBe(true);
    if (namespace.ok) await expect(access(path.join(namespace.value.root, 'verification.json'))).resolves.toBeUndefined();
  });

  it('classifies a changed head or dirty fingerprint as stale', async () => {
    const dataRoot = await root();
    const store = new ThaiRagWorkspaceVerificationStore(dataRoot);
    expect((await store.record(input())).ok).toBe(true);

    await expect(store.isFresh(WORKSPACE, { ...identity, workspaceHead: 'b'.repeat(40) }))
      .resolves.toEqual({ ok: true, value: false });
    await expect(store.isFresh(WORKSPACE, { ...identity, dirtyFingerprint: 'dirty-2' }))
      .resolves.toEqual({ ok: true, value: false });
    await expect(store.isFresh(WORKSPACE, identity)).resolves.toEqual({ ok: true, value: true });
  });

  it('treats a corrupt record as absent instead of authorizing a skip', async () => {
    const dataRoot = await root();
    const namespace = resolveThaiRagWorkspaceNamespace(dataRoot, WORKSPACE);
    expect(namespace.ok).toBe(true);
    if (!namespace.ok) return;
    await mkdir(namespace.value.root, { recursive: true });
    await writeFile(path.join(namespace.value.root, 'verification.json'), '{not json', 'utf8');
    await expect(new ThaiRagWorkspaceVerificationStore(dataRoot).get(WORKSPACE)).resolves.toEqual({ ok: true, value: null });
  });

  it('rejects a non-canonical workspace id before writing', async () => {
    const dataRoot = await root();
    const result = await new ThaiRagWorkspaceVerificationStore(dataRoot).record(input({ workspaceId: 'repo' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');
  });
});
