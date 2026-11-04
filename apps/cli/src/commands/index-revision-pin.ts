import { appError, err, ok, type Result } from '@unified-mpc/domain';
import type { CanonicalRevisionPinReport } from '@unified-mpc/workspace';

export interface IndexRevisionPinCommand {
  readonly kind: 'index-revision-pin';
  readonly action: 'pin' | 'unpin';
  readonly manifestId: string;
  readonly note?: string;
  /** Print the unprojected report instead of the operator lines. */
  readonly json: boolean;
}

const INDEX_REVISION_PIN_USAGE = 'Usage: unified-mpc index revision pin <manifest-id> [--note <text>] [--json]'
  + ' | index revision unpin <manifest-id> [--json]';

const MANIFEST_ID = /^man:v1:[a-f0-9]{64}$/i;

/**
 * Parse `index revision pin|unpin <manifest-id>`.
 *
 * The manifest-id shape is checked here so a typo is an argument error (exit 2)
 * instead of a store read that silently finds nothing. `--note` belongs to pin
 * only: an unpin has nothing to annotate.
 */
export function parseIndexRevisionPinArgs(args: readonly string[]): Result<IndexRevisionPinCommand> {
  if (args[0] !== 'revision' || (args[1] !== 'pin' && args[1] !== 'unpin')) {
    return err(appError('INVALID_INPUT', INDEX_REVISION_PIN_USAGE));
  }
  const action = args[1];

  let manifestId: string | undefined;
  let note: string | undefined;
  let json = false;
  const rest = args.slice(2);
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index]!;
    if (argument === '--json') {
      if (json) return err(appError('INVALID_INPUT', INDEX_REVISION_PIN_USAGE));
      json = true;
      continue;
    }
    if (argument === '--note') {
      if (action !== 'pin') return err(appError('INVALID_INPUT', INDEX_REVISION_PIN_USAGE));
      const value = rest[index + 1];
      if (value === undefined || value.startsWith('--') || note !== undefined) {
        return err(appError('INVALID_INPUT', INDEX_REVISION_PIN_USAGE));
      }
      note = value;
      index += 1;
      continue;
    }
    if (argument.startsWith('--') || manifestId !== undefined) {
      return err(appError('INVALID_INPUT', INDEX_REVISION_PIN_USAGE));
    }
    manifestId = argument;
  }

  if (manifestId === undefined || !MANIFEST_ID.test(manifestId)) {
    return err(appError('INVALID_INPUT', INDEX_REVISION_PIN_USAGE));
  }
  return ok({
    kind: 'index-revision-pin',
    action,
    manifestId: manifestId.toLowerCase(),
    ...(note === undefined ? {} : { note }),
    json,
  });
}

/**
 * Render one operator pin result (#210 §7).
 *
 * The reason is printed on a pin so the scope is unmistakable: this command
 * only ever writes or removes `user-pin`, and the `pins` line shows every
 * system-owned reason the revision still carries.
 */
export function formatCanonicalRevisionPin(report: CanonicalRevisionPinReport): string {
  const header = report.action === 'pinned'
    ? `pinned ${report.manifestId} reason user-pin`
    : `${report.action} ${report.manifestId}`;
  return [header, `pins ${report.pins.length === 0 ? 'none' : report.pins.join(' ')}`].join('\n');
}
