import { describe, expect, it } from 'vitest';
import type { Workspace, WorkspaceRepository } from '@unified-mpc/workspace';
import { WorkspaceSelectionService } from './workspace-selection-service.js';

const projects: Workspace[] = [
  { id: 'a', displayName: 'A', rootPath: '/projects/a', realRootPath: '/projects/a', createdAt: '2026-01-01T00:00:00.000Z' },
  { id: 'b', displayName: 'B', rootPath: '/projects/b', realRootPath: '/projects/b', createdAt: '2026-01-02T00:00:00.000Z' },
];

function repository(entries: readonly Workspace[] = projects): WorkspaceRepository {
  return {
    list: async () => [...entries],
    get: async (id) => entries.find((project) => project.id === id) ?? null,
    insert: async () => undefined,
    delete: async () => undefined,
  };
}

function store(): { get(): string | null; set(value: string): void } {
  let value: string | null = null;
  return { get: (): string | null => value, set: (next): void => { value = next; } };
}

describe('WorkspaceSelectionService', () => {
  it('keeps the primary workspace first while activating and switching projects', async () => {
    const selection = new WorkspaceSelectionService(repository(), 'a');
    expect((await selection.list()).value).toEqual({ primaryWorkspaceId: 'a', activeWorkspaceIds: ['a'] });

    expect((await selection.activate('b')).ok).toBe(true);
    expect((await selection.setPrimary('b')).ok).toBe(true);
    expect((await selection.list()).value).toEqual({ primaryWorkspaceId: 'b', activeWorkspaceIds: ['b', 'a'] });

    expect((await selection.deactivate('b')).ok).toBe(true);
    expect((await selection.list()).value).toEqual({ primaryWorkspaceId: 'a', activeWorkspaceIds: ['a'] });
  });

  it('refuses unknown projects and an empty active set', async () => {
    const selection = new WorkspaceSelectionService(repository(), 'a');
    expect((await selection.activate('missing')).ok).toBe(false);
    expect((await selection.deactivate('a')).ok).toBe(false);
  });

  it('observes changes written by another service instance through shared storage', async () => {
    const shared = store();
    const first = new WorkspaceSelectionService(repository(), 'a', shared);
    const second = new WorkspaceSelectionService(repository(), 'a', shared);

    expect((await first.activate('b')).ok).toBe(true);
    expect((await second.setPrimary('b')).ok).toBe(true);
    expect((await first.list()).value).toEqual({ primaryWorkspaceId: 'b', activeWorkspaceIds: ['b', 'a'] });
  });

  it('activates and resumes a goal workspace only under its registered parent project', async () => {
    const goal: Workspace = {
      id: 'goal-185',
      displayName: 'Issue 185 Goal Workspace',
      rootPath: '/projects/a/.unified-mpc/worktrees/goal-185',
      realRootPath: '/projects/a/.unified-mpc/worktrees/goal-185',
      createdAt: '2026-01-03T00:00:00.000Z',
      lifecycleKind: 'goal',
      goalId: 'goal-185',
      parentWorkspaceId: 'a',
    };
    const shared = store();
    const first = new WorkspaceSelectionService(repository([...projects, goal]), 'a', shared);
    const resumed = new WorkspaceSelectionService(repository([...projects, goal]), 'a', shared);

    await expect(first.activate(goal.id)).resolves.toMatchObject({ ok: true });
    await expect(first.setPrimary(goal.id)).resolves.toMatchObject({ ok: true });
    await expect(resumed.list()).resolves.toMatchObject({
      ok: true,
      value: { primaryWorkspaceId: goal.id, activeWorkspaceIds: [goal.id, 'a'] },
    });
    expect((await resumed.activeWorkspaces()).value?.map((workspace) => workspace.id)).toEqual([goal.id, 'a']);
  });

  it('never selects orphaned, archived, or out-of-parent goal workspaces', async () => {
    const now = '2026-01-03T00:00:00.000Z';
    const goalBase: Workspace = {
      id: 'goal-base',
      displayName: 'Base',
      rootPath: '/projects/a/.unified-mpc/worktrees/goal-base',
      realRootPath: '/projects/a/.unified-mpc/worktrees/goal-base',
      createdAt: now,
      lifecycleKind: 'goal',
      goalId: 'goal-base',
      parentWorkspaceId: 'a',
    };
    const invalid: Workspace[] = [
      { ...goalBase, id: 'orphan', parentWorkspaceId: 'missing' },
      { ...goalBase, id: 'sibling', rootPath: '/projects/a-neighbor/goal', realRootPath: '/projects/a-neighbor/goal' },
      { ...goalBase, id: 'missing-goal-id', goalId: '' },
      { ...goalBase, id: 'archived', archivedAt: now },
      { ...goalBase, id: 'machine-root', rootPath: '/', realRootPath: '/' },
    ];
    const shared = store();
    shared.set(JSON.stringify({ primaryWorkspaceId: 'orphan', activeWorkspaceIds: invalid.map((workspace) => workspace.id) }));
    const selection = new WorkspaceSelectionService(repository([...projects, ...invalid]), 'a', shared);

    await expect(selection.list()).resolves.toMatchObject({
      ok: true,
      value: { primaryWorkspaceId: 'a', activeWorkspaceIds: ['a'] },
    });
    for (const workspace of invalid) {
      await expect(selection.activate(workspace.id)).resolves.toMatchObject({
        ok: false,
        error: { code: 'WORKSPACE_NOT_FOUND' },
      });
    }

    const archivedParent = { ...projects[0]!, archivedAt: now };
    const archivedSelection = new WorkspaceSelectionService(repository([archivedParent, projects[1]!, goalBase]), 'b');
    await expect(archivedSelection.activate(goalBase.id)).resolves.toMatchObject({
      ok: false,
      error: { code: 'WORKSPACE_NOT_FOUND' },
    });
  });

  it('excludes temporary and inspection registrations from the project selection set', async () => {
    const shared = store();
    shared.set(JSON.stringify({ primaryWorkspaceId: 'temp', activeWorkspaceIds: ['temp', 'inspect', 'a'] }));
    const entries: Workspace[] = [
      ...projects,
      { id: 'temp', displayName: 'Temp', rootPath: '/tmp/a', realRootPath: '/tmp/a', createdAt: new Date(0).toISOString(), lifecycleKind: 'temporary', autoCleanup: true },
      { id: 'inspect', displayName: 'Inspect', rootPath: '/tmp/b', realRootPath: '/tmp/b', createdAt: new Date(0).toISOString(), lifecycleKind: 'inspection', autoCleanup: true },
    ];
    const selection = new WorkspaceSelectionService(repository(entries), 'a', shared);

    await expect(selection.list()).resolves.toMatchObject({
      ok: true,
      value: { primaryWorkspaceId: 'a', activeWorkspaceIds: ['a'] },
    });
    expect(shared.get()).toBe(JSON.stringify({ primaryWorkspaceId: 'a', activeWorkspaceIds: ['a'] }));
  });

  it('persists normalized selection after an archived project disappears', async () => {
    const shared = store();
    shared.set(JSON.stringify({ primaryWorkspaceId: 'b', activeWorkspaceIds: ['b', 'a'] }));
    const selection = new WorkspaceSelectionService(repository([projects[0]!]), 'a', shared);

    await expect(selection.list()).resolves.toMatchObject({
      ok: true,
      value: { primaryWorkspaceId: 'a', activeWorkspaceIds: ['a'] },
    });
    expect(shared.get()).toBe(JSON.stringify({ primaryWorkspaceId: 'a', activeWorkspaceIds: ['a'] }));
  });
});
