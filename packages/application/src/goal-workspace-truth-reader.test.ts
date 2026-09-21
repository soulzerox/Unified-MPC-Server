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
});
