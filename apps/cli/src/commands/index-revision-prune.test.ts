import { describe, expect, it } from 'vitest';
import { formatCanonicalRevisionPrune, parseIndexRevisionPruneArgs } from './index-revision-prune.js';

const STALE = `man:v1:${'a'.repeat(64)}`;
const ACTIVE = `man:v1:${'b'.repeat(64)}`;

describe('parseIndexRevisionPruneArgs', () => {
  it('parses the dry-run flag in any position', () => {
    expect(parseIndexRevisionPruneArgs(['revision', 'prune', '--dry-run'])).toEqual({
      ok: true,
      value: { kind: 'index-revision-prune', dryRun: true, json: false },
    });
    expect(parseIndexRevisionPruneArgs(['revision', 'prune', '--json', '--dry-run'])).toEqual({
      ok: true,
      value: { kind: 'index-revision-prune', dryRun: true, json: true },
    });
    expect(parseIndexRevisionPruneArgs(['revision', 'prune', '--dry-run', '--json'])).toEqual({
      ok: true,
      value: { kind: 'index-revision-prune', dryRun: true, json: true },
    });
  });

  it('requires an explicit --dry-run', () => {
    expect(parseIndexRevisionPruneArgs(['revision', 'prune'])).toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    });
    expect(parseIndexRevisionPruneArgs(['revision', 'prune', '--json'])).toMatchObject({ ok: false });
  });

  it('rejects --apply with a message that says the verb is read-only', () => {
    const result = parseIndexRevisionPruneArgs(['revision', 'prune', '--apply']);
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(result.ok ? '' : result.error.message).toContain('--apply is not supported');
    expect(parseIndexRevisionPruneArgs(['revision', 'prune', '--dry-run', '--apply'])).toMatchObject({ ok: false });
  });

  it('rejects duplicate, unknown and positional arguments', () => {
    expect(parseIndexRevisionPruneArgs(['revision', 'prune', '--dry-run', '--dry-run'])).toMatchObject({ ok: false });
    expect(parseIndexRevisionPruneArgs(['revision', 'prune', '--dry-run', '--json', '--json'])).toMatchObject({ ok: false });
    expect(parseIndexRevisionPruneArgs(['revision', 'prune', '--dry-run', '--force'])).toMatchObject({ ok: false });
    expect(parseIndexRevisionPruneArgs(['revision', 'prune', STALE, '--dry-run'])).toMatchObject({ ok: false });
  });

  it('rejects the sibling revision verbs', () => {
    expect(parseIndexRevisionPruneArgs(['revision', 'list', '--dry-run'])).toMatchObject({ ok: false });
    expect(parseIndexRevisionPruneArgs(['revision', 'pin', STALE])).toMatchObject({ ok: false });
  });
});

describe('formatCanonicalRevisionPrune', () => {
  it('prints the plan header, prune candidates and retained reasons', () => {
    expect(formatCanonicalRevisionPrune({
      status: 'planned',
      pruneable: [STALE],
      removed: [],
      retained: [
        { manifestId: ACTIVE, reason: 'canonical-ref' },
        { manifestId: `man:v1:${'c'.repeat(64)}`, reason: 'pin' },
      ],
    })).toBe([
      'planned (dry-run) pruneable 1 retained 2',
      `prune ${STALE}`,
      `retain ${ACTIVE} canonical-ref`,
      `retain man:v1:${'c'.repeat(64)} pin`,
    ].join('\n'));
  });

  it('prints an empty plan when nothing is stored', () => {
    expect(formatCanonicalRevisionPrune({
      status: 'planned',
      pruneable: [],
      removed: [],
      retained: [],
    })).toBe('planned (dry-run) pruneable 0 retained 0');
  });
});
