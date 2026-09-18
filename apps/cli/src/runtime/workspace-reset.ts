export const WORKSPACE_RESET_CONFIRMATION = 'DELETE-REGISTERED-WORKSPACES';

interface WorkspaceRegistration {
  readonly id: string;
}

interface WorkspaceRegistrationService {
  list(): Promise<readonly WorkspaceRegistration[]>;
  unregister(id: string): Promise<unknown>;
  unregisterMany?(ids: readonly string[]): Promise<unknown>;
}

interface WorkspaceResetBackupService {
  create(reason: 'manual'): Promise<{ readonly id: string }>;
}

export interface WorkspaceResetResult {
  readonly archived: number;
  readonly backupId: string | null;
}

/**
 * A workspace reset archives only unified-mpc registration rows, never project files.
 * It is still a broad persistent mutation, so it requires an exact phrase and a
 * restorable SQLite snapshot before the first row is removed.
 */
export async function resetWorkspaceRegistrations(
  workspaces: WorkspaceRegistrationService,
  backups: WorkspaceResetBackupService,
  confirmation: string | undefined,
): Promise<WorkspaceResetResult> {
  if (confirmation !== WORKSPACE_RESET_CONFIRMATION) {
    throw new Error(
      `Resetting all workspace registrations requires --confirm-reset-workspaces ${WORKSPACE_RESET_CONFIRMATION}`,
    );
  }

  const existing = await workspaces.list();
  if (existing.length === 0) return { archived: 0, backupId: null };

  const backup = await backups.create('manual');
  if (workspaces.unregisterMany !== undefined) {
    assertSuccessful(await workspaces.unregisterMany(existing.map((workspace) => workspace.id)));
  } else {
    for (const workspace of existing) assertSuccessful(await workspaces.unregister(workspace.id));
  }
  return { archived: existing.length, backupId: backup.id };
}

function assertSuccessful(result: unknown): void {
  if (typeof result !== 'object' || result === null || !('ok' in result)) return;
  if (result.ok === false) {
    const error = 'error' in result && typeof result.error === 'object' && result.error !== null && 'message' in result.error
      ? String(result.error.message)
      : 'Workspace registration reset failed';
    throw new Error(error);
  }
}
