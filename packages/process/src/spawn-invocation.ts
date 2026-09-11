import { appError, err, ok, type Result } from '@unified-mpc/domain';

export interface SpawnInvocation {
  readonly executable: string;
  readonly args: readonly string[];
  readonly windowsVerbatimArguments?: boolean;
}

export interface WindowsSpawnOptions {
  readonly allowMetacharacters?: boolean;
}

export interface SpawnInvocationFactory {
  create(executable: string, args: readonly string[], options?: WindowsSpawnOptions): Result<SpawnInvocation>;
}

/** POSIX argv launch receives the executable and argv directly. */
export function toSpawnInvocation(
  executable: string,
  args: readonly string[],
  _options: WindowsSpawnOptions = {},
  _platform: NodeJS.Platform = process.platform,
): Result<SpawnInvocation> {
  void _options;
  void _platform;
  if (executable.trim().length === 0 || args.some((arg) => typeof arg !== 'string')) {
    return err(appError('INVALID_INPUT', 'Executable and args are required'));
  }
  return ok({ executable, args: [...args] });
}

export function createSpawnInvocationFactory(platform: NodeJS.Platform = process.platform): SpawnInvocationFactory {
  return { create: (executable, args, options) => toSpawnInvocation(executable, args, options, platform) };
}
