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

  it('releases provider generations after archiving every registration', async () => {
    const events: string[] = [];
    const result = await resetWorkspaceRegistrations(
      {
        list: async () => [{ id: 'workspace-1' }],
        unregister: async (id) => { events.push(`archive:${id}`); },
      },
      {
        create: async (reason) => {
          events.push(`backup:${reason}`);
          return { id: 'backup-before-reset' };
        },
      },
      WORKSPACE_RESET_CONFIRMATION,
      {
        releaseUnknown: async (ids) => {
          events.push(`release:${ids.length}`);
          return ['workspace-1'];
        },
      },
    );

    expect(events).toEqual([
      'backup:manual',
      'archive:workspace-1',
      'release:0',
    ]);
    expect(result).toEqual({ archived: 1, backupId: 'backup-before-reset' });
  });

  it('releases provider generations even when nothing is left to archive', async () => {
    const releaseUnknown = vi.fn(async () => ['workspace-1']);

    await expect(resetWorkspaceRegistrations(
      { list: async () => [], unregister: async () => undefined },
      { create: async () => ({ id: 'backup-1' }) },
      WORKSPACE_RESET_CONFIRMATION,
      { releaseUnknown },
    )).resolves.toEqual({ archived: 0, backupId: null });

    expect(releaseUnknown).toHaveBeenCalledWith([]);
  });

  it('propagates a provider release failure so a retry can converge', async () => {
    await expect(resetWorkspaceRegistrations(
      { list: async () => [], unregister: async () => undefined },
      { create: async () => ({ id: 'backup-1' }) },
      WORKSPACE_RESET_CONFIRMATION,
      { releaseUnknown: async () => { throw new Error('ledger is read-only'); } },
    )).rejects.toThrow('ledger is read-only');
  });
});
