import { describe, expect, it } from 'vitest';
import type { Workspace, WorkspaceRepository } from '@unified-mpc/workspace';
import { WorkspaceSelectionService } from './workspace-selection-service.js';

const projects: Workspace[] = [
  { id: 'a', displayName: 'A', rootPath: '/projects/a', realRootPath: '/projects/a', createdAt: '2026-01-01T00:00:00.000Z' },
  { id: 'b', displayName: 'B', rootPath: '/projects/b', realRootPath: '/projects/b', createdAt: '2026-01-02T00:00:00.000Z' },
];

function repository(): WorkspaceRepository {
  return {
    list: async () => projects,
    get: async (id) => projects.find((project) => project.id === id) ?? null,
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
});
