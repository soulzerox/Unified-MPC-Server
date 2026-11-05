import { describe, expect, it } from 'vitest';
import {
  formatCanonicalStoreRepair,
  indexRepairExitCode,
  parseIndexRepairArgs,
} from './index-repair.js';

const ORPHAN = `man:v1:${'a'.repeat(64)}`;
const GHOST = `man:v1:${'b'.repeat(64)}`;

describe('parseIndexRepairArgs', () => {
  it('parses either mode in any position', () => {
    expect(parseIndexRepairArgs(['repair', '--dry-run'])).toEqual({
      ok: true,
      value: { kind: 'index-repair', dryRun: true, json: false },
    });
    expect(parseIndexRepairArgs(['repair', '--apply'])).toEqual({
      ok: true,
      value: { kind: 'index-repair', dryRun: false, json: false },
    });
    expect(parseIndexRepairArgs(['repair', '--json', '--apply'])).toEqual({
      ok: true,
      value: { kind: 'index-repair', dryRun: false, json: true },
    });
    expect(parseIndexRepairArgs(['repair', '--dry-run', '--json'])).toEqual({
      ok: true,
      value: { kind: 'index-repair', dryRun: true, json: true },
    });
  });

  it('requires exactly one explicit mode', () => {
    expect(parseIndexRepairArgs(['repair'])).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(parseIndexRepairArgs(['repair', '--json'])).toMatchObject({ ok: false });
    expect(parseIndexRepairArgs(['repair', '--dry-run', '--apply'])).toMatchObject({ ok: false });
    expect(parseIndexRepairArgs(['repair', '--apply', '--dry-run'])).toMatchObject({ ok: false });
    expect(parseIndexRepairArgs(['repair', '--dry-run', '--dry-run'])).toMatchObject({ ok: false });
    expect(parseIndexRepairArgs(['repair', '--apply', '--apply'])).toMatchObject({ ok: false });
  });

  it('rejects unknown and positional arguments', () => {
    expect(parseIndexRepairArgs(['repair', '--dry-run', '--force'])).toMatchObject({ ok: false });
    expect(parseIndexRepairArgs(['repair', ORPHAN, '--dry-run'])).toMatchObject({ ok: false });
  });

  it('rejects the sibling index verbs', () => {
    expect(parseIndexRepairArgs(['status', '--dry-run'])).toMatchObject({ ok: false });
    expect(parseIndexRepairArgs(['revision', 'prune', '--dry-run'])).toMatchObject({ ok: false });
  });
});

describe('formatCanonicalStoreRepair', () => {
  it('prints the dry-run plan header and the orphan pins it would remove', () => {
    expect(formatCanonicalStoreRepair({
      status: 'planned',
      orphanPins: [{ manifestId: ORPHAN, reasons: ['rollback', 'user-pin'] }],
      danglingRefs: [],
      missingOverlayBases: [],
    })).toBe([
      'planned (dry-run) orphan-pins 1',
      `repair ${ORPHAN} rollback,user-pin`,
      'dangling-refs 0',
      'missing-overlay-bases 0',
    ].join('\n'));
  });

  it('prints only the pins an apply actually removed', () => {
    expect(formatCanonicalStoreRepair({
      status: 'applied',
      orphanPins: [{ manifestId: ORPHAN, reasons: ['user-pin'] }],
      danglingRefs: [],
      missingOverlayBases: [],
    })).toBe([
      'applied orphan-pins 1',
      `removed ${ORPHAN} user-pin`,
      'dangling-refs 0',
      'missing-overlay-bases 0',
    ].join('\n'));
  });

  it('prints the degraded state this verb will not touch', () => {
    expect(formatCanonicalStoreRepair({
      status: 'applied',
      orphanPins: [],
      danglingRefs: [{ ref: 'refs/remotes/origin/main', manifestId: GHOST }],
      missingOverlayBases: ['goal-ghost'],
    })).toBe([
      'applied orphan-pins 0',
      'dangling-refs 1',
      `  refs/remotes/origin/main ${GHOST}`,
      'missing-overlay-bases 1',
      '  goal-ghost',
    ].join('\n'));
  });

  it('prints a refusal as a single line', () => {
    expect(formatCanonicalStoreRepair({
      status: 'refused',
      reason: 'gc lease held by other_gc until 2026-11-04T00:15:00.000Z',
    })).toBe('refused gc lease held by other_gc until 2026-11-04T00:15:00.000Z');
  });
});

describe('indexRepairExitCode', () => {
  it('exits 0 when the store is healthy after the plan or pass', () => {
    expect(indexRepairExitCode({
      status: 'planned',
      orphanPins: [{ manifestId: ORPHAN, reasons: ['user-pin'] }],
      danglingRefs: [],
      missingOverlayBases: [],
    })).toBe(0);
    expect(indexRepairExitCode({
      status: 'applied',
      orphanPins: [],
      danglingRefs: [],
      missingOverlayBases: [],
    })).toBe(0);
  });

  it('exits 1 for a refusal or remaining unrepairable degraded state', () => {
    expect(indexRepairExitCode({
      status: 'refused',
      reason: 'gc lease held by other_gc until 2026-11-04T00:15:00.000Z',
    })).toBe(1);
    expect(indexRepairExitCode({
      status: 'applied',
      orphanPins: [],
      danglingRefs: [{ ref: 'refs/remotes/origin/main', manifestId: GHOST }],
      missingOverlayBases: [],
    })).toBe(1);
    expect(indexRepairExitCode({
      status: 'planned',
      orphanPins: [],
      danglingRefs: [],
      missingOverlayBases: ['goal-ghost'],
    })).toBe(1);
  });
});
