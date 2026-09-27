import { describe, expect, it, vi } from 'vitest';
import { appError, err, ok } from '@unified-mpc/domain';
import type { Workspace } from '@unified-mpc/workspace';
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

  it('keeps snapshot Goal Workspaces explicitly non-Git instead of observing the parent repository', async () => {
    const observeWorkspace = vi.fn();
    const git: GoalWorkspaceGitStatusPort = {
      status: vi.fn(async () => ok({ entries: [] })),
      observeWorkspace,
    };
    const { reader } = fixture({ git, workspace: { ...workspace, lifecycleKind: 'goal', goalWorkspaceKind: 'snapshot' } });

    await expect(reader.readAdmission(workspace.id)).resolves.toMatchObject({
      workspaceKind: 'non_git',
      dirtyState: 'unknown',
    });
    await expect(reader.readAdmission(workspace.id)).resolves.not.toHaveProperty('workspaceHead');
    expect(observeWorkspace).not.toHaveBeenCalled();
  });
});
