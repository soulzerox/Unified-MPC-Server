import { describe, expect, it, vi } from 'vitest';
import {
  WORKSPACE_RESET_CONFIRMATION,
  resetWorkspaceRegistrations,
} from './workspace-reset.js';

describe('resetWorkspaceRegistrations', () => {
  it('refuses a broad registration reset without the exact confirmation phrase', async () => {
    const list = vi.fn(async () => [{ id: 'workspace-1' }]);
    const unregister = vi.fn(async () => undefined);
    const createBackup = vi.fn(async () => ({ id: 'backup-1' }));

    await expect(resetWorkspaceRegistrations(
      { list, unregister },
      { create: createBackup },
      'yes',
    )).rejects.toThrow(WORKSPACE_RESET_CONFIRMATION);

    expect(createBackup).not.toHaveBeenCalled();
    expect(unregister).not.toHaveBeenCalled();
  });

  it('creates a recoverable database backup before archiving any registration', async () => {
    const events: string[] = [];
    const result = await resetWorkspaceRegistrations(
      {
        list: async () => [{ id: 'workspace-1' }, { id: 'workspace-2' }],
        unregister: async (id) => { events.push(`archive:${id}`); },
      },
      {
        create: async (reason) => {
          events.push(`backup:${reason}`);
          return { id: 'backup-before-reset' };
        },
      },
      WORKSPACE_RESET_CONFIRMATION,
    );

    expect(events).toEqual([
      'backup:manual',
      'archive:workspace-1',
      'archive:workspace-2',
    ]);
    expect(result).toEqual({ archived: 2, backupId: 'backup-before-reset' });
  });

  it('does not create a needless backup when there are no registrations', async () => {
    const createBackup = vi.fn(async () => ({ id: 'backup-1' }));

    await expect(resetWorkspaceRegistrations(
      { list: async () => [], unregister: async () => undefined },
      { create: createBackup },
      WORKSPACE_RESET_CONFIRMATION,
    )).resolves.toEqual({ archived: 0, backupId: null });

    expect(createBackup).not.toHaveBeenCalled();
  });
});
