import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { appError, err, ok } from '@unified-mpc/domain';
import type { Workspace, WorkspaceRepository } from '@unified-mpc/workspace';
import {
  GoalWorkspaceTruthReader,
  type GoalWorkspaceGitStatusPort,
  type WorkspaceRootProbe,
} from './goal-workspace-truth-reader.js';

const workspace: Workspace = {
  id: 'workspace-1',
  displayName: 'Workspace 1',
  rootPath: '/workspace-1',
  realRootPath: '/workspace-1',
  createdAt: '2026-09-22T00:00:00.000Z',
};

function fixture(options: {
  workspace?: Workspace | null;
  probeRoot?: WorkspaceRootProbe;
  git?: GoalWorkspaceGitStatusPort;
} = {}): {
  reader: GoalWorkspaceTruthReader;
  status: ReturnType<typeof vi.fn>;
} {
  const status = vi.fn(async () => ok({ entries: [] }));
  const git = options.git ?? { status };
  const reader = new GoalWorkspaceTruthReader(
    { get: vi.fn(async () => options.workspace === undefined ? workspace : options.workspace) },
    git,
    { probeRoot: options.probeRoot ?? vi.fn(async () => 'present') },
  );
  return { reader, status };
}

describe('GoalWorkspaceTruthReader', () => {
  it('reads caller-verified integration metadata from the single active Goal Workspace', async (): Promise<void> => {
    const goalWorkspace: Workspace = {
      ...workspace,
      id: 'goal-workspace-1',
      lifecycleKind: 'goal',
      goalId: 'goal-1',
      integrationState: 'integrated',
    };
    const repository: Pick<WorkspaceRepository, 'get' | 'listAll'> = {
      get: vi.fn(async () => workspace),
      listAll: vi.fn(async () => [
        { ...goalWorkspace, archivedAt: '2026-09-21T00:00:00.000Z', integrationState: 'conflict' as const },
        goalWorkspace,
      ]),
    };
    const reader = new GoalWorkspaceTruthReader(
      repository,
      { status: vi.fn(async () => ok({ entries: [] })) },
    );

    await expect(reader.readIntegration('goal-1')).resolves.toEqual({
      state: 'integrated',
      detail: 'Goal Workspace integration metadata is integrated',
    });
  });

  it('keeps integration truth unknown when active Goal Workspace ownership is ambiguous', async (): Promise<void> => {
    const repository: Pick<WorkspaceRepository, 'get' | 'listAll'> = {
      get: vi.fn(async () => workspace),
      listAll: vi.fn(async () => [
        { ...workspace, id: 'goal-workspace-a', lifecycleKind: 'goal' as const, goalId: 'goal-1', integrationState: 'pending' as const },
        { ...workspace, id: 'goal-workspace-b', lifecycleKind: 'goal' as const, goalId: 'goal-1', integrationState: 'integrated' as const },
      ]),
    };
    const reader = new GoalWorkspaceTruthReader(
      repository,
      { status: vi.fn(async () => ok({ entries: [] })) },
    );

    await expect(reader.readIntegration('goal-1')).resolves.toMatchObject({
      state: 'unknown',
      detail: expect.stringContaining('ambiguous'),
    });
  });

  it('reports clean only from a readable registered Git workspace with no status entries', async (): Promise<void> => {
    const { reader } = fixture();
    await expect(reader.read(workspace.id)).resolves.toEqual({
      state: 'clean',
      detail: 'Git workspace is clean',
    });
  });

  it('reports dirty from authoritative Git status changes', async (): Promise<void> => {
    const git: GoalWorkspaceGitStatusPort = {
      status: vi.fn(async () => ok({ entries: [{ path: 'changed.ts' } as never] })),
    };
    const { reader } = fixture({ git });
    await expect(reader.read(workspace.id)).resolves.toEqual({
      state: 'dirty',
      detail: 'Git workspace has uncommitted changes',
    });
  });

  it('reports missing when the registered canonical root disappears before Git status', async (): Promise<void> => {
    const probeRoot = vi.fn(async (): Promise<never> => {
      throw Object.assign(new Error('gone'), { code: 'ENOENT' });
    });
    const { reader, status } = fixture({ probeRoot });
    await expect(reader.read(workspace.id)).resolves.toMatchObject({ state: 'missing' });
    expect(status).not.toHaveBeenCalled();
  });

  it('reports unavailable when the canonical root probe fails without proving absence', async (): Promise<void> => {
    const probeRoot = vi.fn(async (): Promise<never> => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    });
    const { reader, status } = fixture({ probeRoot });
    await expect(reader.read(workspace.id)).resolves.toMatchObject({ state: 'unavailable' });
    expect(status).not.toHaveBeenCalled();
  });

  it('reports unknown for a readable non-Git workspace instead of inventing integration truth', async (): Promise<void> => {
    const git: GoalWorkspaceGitStatusPort = {
      status: vi.fn(async () => err(appError('GIT_NOT_REPOSITORY', 'not git'))),
    };
    const { reader } = fixture({ git });
    await expect(reader.read(workspace.id)).resolves.toEqual({
      state: 'unknown',
      detail: 'workspace is not a Git repository',
    });
  });

  it('reports unavailable when Git status itself cannot be trusted', async (): Promise<void> => {
    const git: GoalWorkspaceGitStatusPort = {
      status: vi.fn(async () => err(appError('INTERNAL_ERROR', 'git failed', true))),
    };
    const { reader } = fixture({ git });
    await expect(reader.read(workspace.id)).resolves.toEqual({
      state: 'unavailable',
      detail: 'Git status is unavailable',
    });
  });

  it('returns bounded Git admission evidence while keeping workspace HEAD distinct from the registered base', async () => {
    const snapshot = {
      repositoryIdentity: 'repo-1',
      gitCommonDirIdentity: 'common-1',
      worktreeIdentity: 'worktree-1',
      branch: 'goal/one',
      head: 'a'.repeat(40),
      statusEntries: [],
      stagedFingerprint: 'staged-hash',
      dirtyFingerprint: 'dirty-hash',
      baseRef: 'base-1',
      resolvedBaseRef: 'refs/unified-mpc/admission/base-1',
      baseSha: 'b'.repeat(40),
      mergeBaseSha: 'b'.repeat(40),
    };
    const git: GoalWorkspaceGitStatusPort = {
      status: vi.fn(async () => ok({ entries: [] })),
      observeWorkspace: vi.fn(async (_actor, _workspaceId, options) => {
        expect(options).toMatchObject({ baseRef: 'b'.repeat(40) });
        return ok(snapshot);
      }),
    };
    const { reader } = fixture({ git, workspace: { ...workspace, baseRevision: 'b'.repeat(40), lifecycleKind: 'goal', goalWorkspaceKind: 'git_worktree' } });

    await expect(reader.readAdmission(workspace.id)).resolves.toMatchObject({
      workspaceKind: 'git',
      workspaceHead: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
      dirtyState: 'clean',
      dirtyFingerprint: 'dirty-hash',
    });
  });

  it('refreshes a moving base directly into a private ref before classifying remote base drift', async () => {
    const privateRef = 'refs/unified-mpc/admission/workspaces/workspace-1/main';
    const currentBase = 'c'.repeat(40);
    const git: GoalWorkspaceGitStatusPort = {
      status: vi.fn(async () => ok({ entries: [] })),
      refreshAdmissionRef: vi.fn(async () => ok({ ref: privateRef, sha: currentBase })),
      observeWorkspace: vi.fn(async (_actor, _workspaceId, options) => {
        expect(options).toMatchObject({ baseRef: 'origin/main', resolvedBaseRef: privateRef });
        return ok({
          repositoryIdentity: 'repo-1', gitCommonDirIdentity: 'common-1', worktreeIdentity: 'worktree-1',
          branch: 'codex/goal-1', head: 'a'.repeat(40), statusEntries: [], stagedFingerprint: 'staged',
          dirtyFingerprint: 'dirty', baseRef: 'origin/main', resolvedBaseRef: privateRef,
          baseSha: currentBase, mergeBaseSha: 'b'.repeat(40),
        });
      }),
    };
    const { reader } = fixture({
      git,
      workspace: { ...workspace, lifecycleKind: 'goal', goalWorkspaceKind: 'git_worktree', baseRef: 'origin/main', baseRevision: 'b'.repeat(40) },
    });

    await expect(reader.readAdmission(workspace.id)).resolves.toMatchObject({
      baseRef: 'origin/main', baseSha: currentBase, resolvedBaseRef: privateRef,
    });
    expect(git.refreshAdmissionRef).toHaveBeenCalledWith(expect.anything(), workspace.id, 'origin', 'refs/heads/main');
  });

  it('fingerprints bounded snapshot content as non-Git admission evidence', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.goal-snapshot-'));
    try {
      await writeFile(path.join(root, 'source.ts'), 'snapshot source v1');
      const observeWorkspace = vi.fn();
      const git: GoalWorkspaceGitStatusPort = {
        status: vi.fn(async () => ok({ entries: [] })),
        observeWorkspace,
      };
      const snapshotWorkspace: Workspace = {
        ...workspace,
        realRootPath: root,
        lifecycleKind: 'goal',
        goalWorkspaceKind: 'snapshot',
        goalId: 'goal-1',
        parentWorkspaceId: 'project-1',
        baseRevision: 'snapshot-base-1',
        writerLease: { leaseId: 'lease-1', ownerId: 'owner-1', generation: 3, expiresAt: '2099-01-01T00:00:00.000Z' },
      };
      const { reader } = fixture({ git, workspace: snapshotWorkspace });
      const first = await reader.readAdmission(workspace.id);
      expect(first).toMatchObject({
        workspaceKind: 'non_git',
        dirtyState: 'clean',
        sourceSnapshotGeneration: '2026-09-22T00:00:00.000Z:snapshot-base-1',
      });
      expect(first.sourceContentFingerprint).toMatch(/^[0-9a-f]{64}$/u);
      expect(first).not.toHaveProperty('workspaceHead');

      await writeFile(path.join(root, 'source.ts'), 'snapshot source v2');
      const second = await reader.readAdmission(workspace.id);
      expect(second.sourceContentFingerprint).not.toBe(first.sourceContentFingerprint);
      expect(observeWorkspace).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
