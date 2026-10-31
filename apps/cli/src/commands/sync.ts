import { ok, type Result } from '@unified-mpc/domain';
import type { IdeSyncService, SyncTarget } from '@unified-mpc/extensions';
import { missingOptionValue, unexpectedOption } from './options.js';

export interface SyncCommand {
  readonly kind: 'sync';
  readonly targets: readonly SyncTarget[];
  readonly workspaceRoot?: string;
}

export function parseSyncArgs(args: readonly string[]): Result<SyncCommand> {
  let targets: SyncTarget[] = ['all'];
  let workspaceRoot: string | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i]!;
    const value = args[i + 1];
    if (flag === '--targets') {
      if (value === undefined) return missingOptionValue(flag);
      targets = value.split(',').map((t) => t.trim() as SyncTarget).filter(Boolean);
      i += 1;
    } else if (flag === '--workspace') {
      if (value === undefined) return missingOptionValue(flag);
      workspaceRoot = value.trim();
      i += 1;
    } else {
      return unexpectedOption(flag);
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
