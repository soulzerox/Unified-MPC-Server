import { appError, err, type Result } from '@unified-mpc/domain';

/**
 * Rejects a token that no parser branch consumed.
 *
 * Unknown options used to be ignored, so a documented typo such as
 * `web --no-open` ran with the default port and exited 0, while SPEC §6 and
 * `docs/CLI_REFERENCE.md` both promise exit code 2 for an unknown flag.
 */
export function unexpectedOption(token: string): Result<never> {
  return err(appError(
    'INVALID_INPUT',
    token.startsWith('-') ? `Unknown option: ${token}` : `Unexpected argument: ${token}`,
  ));
}

/** Rejects a known option written without the value it needs. */
export function missingOptionValue(option: string): Result<never> {
  return err(appError('INVALID_INPUT', `Missing value for option: ${option}`));
}
