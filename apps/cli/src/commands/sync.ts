import { ok, type Result } from '@unified-mpc/domain';
import type { IdeSyncService, SyncTarget } from '@unified-mpc/extensions';

export interface SyncCommand {
  readonly kind: 'sync';
  readonly targets: readonly SyncTarget[];
  readonly workspaceRoot?: string;
}

export function parseSyncArgs(args: readonly string[]): Result<SyncCommand> {
  let targets: SyncTarget[] = ['all'];
  let workspaceRoot: string | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (flag === '--targets' && args[i + 1] !== undefined) {
      targets = args[i + 1]!.split(',').map((t) => t.trim() as SyncTarget).filter(Boolean);
      i += 1;
    } else if (flag === '--workspace' && args[i + 1] !== undefined) {
      workspaceRoot = args[i + 1]!.trim();
      i += 1;
    }
  }

  return ok({
    kind: 'sync',
    targets,
    ...(workspaceRoot ? { workspaceRoot } : {}),
  });
}

export async function runSync(
  service: Pick<IdeSyncService, 'sync'>,
  targets?: readonly SyncTarget[],
): Promise<Result<{ readonly updatedFiles: readonly string[] }>> {
  return service.sync(targets);
}
