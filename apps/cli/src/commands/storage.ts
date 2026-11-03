import { appError, err, ok, type Result } from '@unified-mpc/domain';

export interface StorageRecoverCommand {
  readonly kind: 'storage-recover';
}

export interface StorageMetricsCommand {
  readonly kind: 'storage-metrics';
  /** Print the unprojected metrics document instead of the operator lines. */
  readonly json: boolean;
}

export type StorageCommand = StorageRecoverCommand | StorageMetricsCommand;

const STORAGE_USAGE = 'Usage: unified-mpc storage <recover|metrics [--json]>';

export function parseStorageArgs(args: readonly string[]): Result<StorageCommand> {
  if (args.length === 1 && args[0] === 'recover') return ok({ kind: 'storage-recover' });
  if (args[0] === 'metrics') {
    const rest = args.slice(1);
    // Only `--json` is accepted: an unparsed flag must not silently become a
    // report the caller did not ask for.
    const unknown = rest.filter((argument) => argument !== '--json');
    if (unknown.length > 0) return err(appError('INVALID_INPUT', STORAGE_USAGE));
    return ok({ kind: 'storage-metrics', json: rest.includes('--json') });
  }
  return err(appError('INVALID_INPUT', STORAGE_USAGE));
}
