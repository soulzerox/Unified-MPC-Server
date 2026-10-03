import { appError, err, ok, type Result } from '@unified-mpc/domain';

export interface StorageRecoverCommand {
  readonly kind: 'storage-recover';
}

export function parseStorageArgs(args: readonly string[]): Result<StorageRecoverCommand> {
  if (args.length === 1 && args[0] === 'recover') return ok({ kind: 'storage-recover' });
  return err(appError('INVALID_INPUT', 'Usage: unified-mpc storage recover'));
}
