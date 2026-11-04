import { describe, expect, it } from 'vitest';
import type { LogicalSpaceReport } from '@unified-mpc/workspace';
import { formatLogicalSpace, indexSpaceExitCode, parseIndexSpaceArgs } from './index-space.js';

const MEASURED: LogicalSpaceReport = {
  status: 'measured',
  manifests: {
    total: 3,
    retained: 2,
    prunable: 1,
    retainedManifestIds: ['man:v1:live', 'man:v1:pinned'],
    prunableManifestIds: ['man:v1:orphan'],
  },
  artifacts: {
    total: 4,
    reachable: 3,
    unreferenced: 1,
    unreferencedHashes: ['a'.repeat(64)],
    bytesMeasurable: false,
    reachableBytes: null,
    unreferencedBytes: null,
  },
};

describe('parseIndexSpaceArgs', () => {
  it('parses the space verb with and without --json', () => {
    expect(parseIndexSpaceArgs(['space'])).toEqual({ ok: true, value: { kind: 'index-space', json: false } });
    expect(parseIndexSpaceArgs(['space', '--json'])).toEqual({ ok: true, value: { kind: 'index-space', json: true } });
  });

  it('rejects a different verb, unknown flags and duplicate flags', () => {
    expect(parseIndexSpaceArgs(['status'])).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(parseIndexSpaceArgs(['space', '--dry-run'])).toMatchObject({ ok: false });
    expect(parseIndexSpaceArgs(['space', '--json', '--json'])).toMatchObject({ ok: false });
  });
});

describe('formatLogicalSpace', () => {
  it('prints counts and marks unmeasurable bytes instead of inventing a total', () => {
    expect(formatLogicalSpace(MEASURED).split('\n')).toEqual([
      'logical space: measured',
      'manifests total=3 retained=2 prunable=1',
      'artifacts total=4 reachable=3 unreferenced=1',
      'bytes reachable=unmeasured unreferenced=unmeasured',
    ]);
  });

  it('prints measured byte totals when every artifact has a size', () => {
    const report: LogicalSpaceReport = {
      ...MEASURED,
      artifacts: {
        ...MEASURED.artifacts,
        bytesMeasurable: true,
        reachableBytes: 2048,
        unreferencedBytes: 0,
      },
    };
    expect(formatLogicalSpace(report).split('\n').at(-1)).toBe('bytes reachable=2048 unreferenced=0');
  });

  it('prints only the reason for a refused report', () => {
    const refused: LogicalSpaceReport = { status: 'refused', reason: 'missing root manifest man:v1:gone' };
    expect(formatLogicalSpace(refused)).toBe('refused missing root manifest man:v1:gone');
  });
});

describe('indexSpaceExitCode', () => {
  it('exits 0 only for a measured report', () => {
    expect(indexSpaceExitCode(MEASURED)).toBe(0);
    expect(indexSpaceExitCode({ status: 'refused', reason: 'no roots' })).toBe(1);
  });
});
