import { ok } from '@unified-mpc/domain';
import { describe, expect, it } from 'vitest';
import { runWorkspaceAdd, runWorkspaceList } from './workspace.js';

const workspace = {
  id: 'workspace-1',
  displayName: 'demo',
  rootPath: '/home/qwerty/project/demo',
  realRootPath: '/home/qwerty/project/demo',
  createdAt: '2026-08-10T00:00:00.000Z',
};

describe('workspace CLI commands', () => {
  it('derives a display name from a path for workspace add', async () => {
    let receivedName = '';
    const result = await runWorkspaceAdd({
      add: async (displayName, rootPath) => {
        receivedName = `${displayName}|${rootPath}`;
        return ok(workspace);
      },
    }, '/home/qwerty/project/demo/');

    expect(result.ok).toBe(true);
    expect(receivedName).toBe('demo|/home/qwerty/project/demo/');
  });

  it('lists configured workspaces through the injected service', async () => {
    await expect(runWorkspaceList({ list: async () => [workspace] })).resolves.toEqual([workspace]);
  });
});
