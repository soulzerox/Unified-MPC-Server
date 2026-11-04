import { describe, expect, it } from 'vitest';
import {
  formatCanonicalRevisionPrune,
  indexRevisionPruneExitCode,
  parseIndexRevisionPruneArgs,
} from './index-revision-prune.js';

const STALE = `man:v1:${'a'.repeat(64)}`;
const ACTIVE = `man:v1:${'b'.repeat(64)}`;
const PINNED = `man:v1:${'c'.repeat(64)}`;

const PLAN = {
  status: 'planned',
  pruneable: [STALE],
  removed: [],
  retained: [
    { manifestId: ACTIVE, reason: 'canonical-ref' },
    { manifestId: PINNED, reason: 'pin' },
  ],
} as const;

describe('parseIndexRevisionPruneArgs', () => {
  it('parses either mode in any position', () => {
    expect(parseIndexRevisionPruneArgs(['revision', 'prune', '--dry-run'])).toEqual({
      ok: true,
      value: { kind: 'index-revision-prune', dryRun: true, json: false },
    });
    expect(parseIndexRevisionPruneArgs(['revision', 'prune', '--apply'])).toEqual({
      ok: true,
      value: { kind: 'index-revision-prune', dryRun: false, json: false },
    });
    expect(parseIndexRevisionPruneArgs(['revision', 'prune', '--json', '--apply'])).toEqual({
      ok: true,
      value: { kind: 'index-revision-prune', dryRun: false, json: true },
    });
    expect(parseIndexRevisionPruneArgs(['revision', 'prune', '--dry-run', '--json'])).toEqual({
      ok: true,
      value: { kind: 'index-revision-prune', dryRun: true, json: true },
    });
  });

  it('requires exactly one explicit mode', () => {
    expect(parseIndexRevisionPruneArgs(['revision', 'prune'])).toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    });
    expect(parseIndexRevisionPruneArgs(['revision', 'prune', '--json'])).toMatchObject({ ok: false });
    expect(parseIndexRevisionPruneArgs(['revision', 'prune', '--dry-run', '--apply'])).toMatchObject({ ok: false });
    expect(parseIndexRevisionPruneArgs(['revision', 'prune', '--apply', '--dry-run'])).toMatchObject({ ok: false });
    expect(parseIndexRevisionPruneArgs(['revision', 'prune', '--dry-run', '--dry-run'])).toMatchObject({ ok: false });
    expect(parseIndexRevisionPruneArgs(['revision', 'prune', '--apply', '--apply'])).toMatchObject({ ok: false });
  });

  it('rejects unknown and positional arguments', () => {
    expect(parseIndexRevisionPruneArgs(['revision', 'prune', '--dry-run', '--force'])).toMatchObject({ ok: false });
    expect(parseIndexRevisionPruneArgs(['revision', 'prune', STALE, '--dry-run'])).toMatchObject({ ok: false });
  });

  it('rejects the sibling revision verbs', () => {
    expect(parseIndexRevisionPruneArgs(['revision', 'list', '--dry-run'])).toMatchObject({ ok: false });
    expect(parseIndexRevisionPruneArgs(['revision', 'pin', STALE])).toMatchObject({ ok: false });
  });
});

describe('formatCanonicalRevisionPrune', () => {
  it('prints the dry-run plan header, prune candidates and retained reasons', () => {
    expect(formatCanonicalRevisionPrune(PLAN, true)).toBe([
      'planned (dry-run) pruneable 1 retained 2',
      `prune ${STALE}`,
      `retain ${ACTIVE} canonical-ref`,
      `retain ${PINNED} pin`,
    ].join('\n'));
  });

  it('prints only the manifests an apply actually removed', () => {
    expect(formatCanonicalRevisionPrune({ ...PLAN, removed: [STALE] }, false)).toBe([
      'applied pruneable 1 removed 1 retained 2',
      `removed ${STALE}`,
      `retain ${ACTIVE} canonical-ref`,
      `retain ${PINNED} pin`,
    ].join('\n'));
  });

  it('prints an empty plan and an empty apply', () => {
    const empty = { status: 'planned', pruneable: [], removed: [], retained: [] } as const;
    expect(formatCanonicalRevisionPrune(empty, true)).toBe('planned (dry-run) pruneable 0 retained 0');
    expect(formatCanonicalRevisionPrune(empty, false)).toBe('applied pruneable 0 removed 0 retained 0');
  });

  it('prints a refusal as a single line', () => {
    expect(formatCanonicalRevisionPrune({
      status: 'refused',
      reason: 'gc lease held by other_gc until 2026-11-04T00:15:00.000Z',
    }, false)).toBe('refused gc lease held by other_gc until 2026-11-04T00:15:00.000Z');
  });
});

describe('indexRevisionPruneExitCode', () => {
  it('exits 0 for a plan or an applied pass and 1 for a refusal', () => {
    expect(indexRevisionPruneExitCode({ status: 'planned', pruneable: [], removed: [], retained: [] })).toBe(0);
    expect(indexRevisionPruneExitCode({
      status: 'refused',
      reason: 'gc lease held by other_gc until 2026-11-04T00:15:00.000Z',
    })).toBe(1);
  });
});
