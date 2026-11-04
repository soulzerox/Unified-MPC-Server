import { describe, expect, it } from 'vitest';
import type { CanonicalStatusReport } from '@unified-mpc/workspace';
import { formatCanonicalStatus, indexStatusExitCode, parseIndexStatusArgs } from './index-status.js';

const HEALTHY: CanonicalStatusReport = {
  status: 'healthy',
  refs: [{ ref: 'refs/remotes/origin/main', manifestId: 'man:v1:abc', commitSha: 'c'.repeat(40) }],
  manifestCount: 1,
  pinCount: 0,
  overlayCount: 0,
  quarantinedCount: 0,
  activeJobCount: 0,
  danglingRefs: [],
  missingOverlayBases: [],
  orphanedPins: [],
};

describe('parseIndexStatusArgs', () => {
  it('parses the status verb with and without --json', () => {
    expect(parseIndexStatusArgs(['status'])).toEqual({ ok: true, value: { kind: 'index-status', json: false } });
    expect(parseIndexStatusArgs(['status', '--json'])).toEqual({ ok: true, value: { kind: 'index-status', json: true } });
  });

  it('rejects a different verb, unknown flags and duplicate flags', () => {
    expect(parseIndexStatusArgs(['revision'])).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(parseIndexStatusArgs(['status', '--ref', 'refs/heads/main'])).toMatchObject({ ok: false });
    expect(parseIndexStatusArgs(['status', '--json', '--json'])).toMatchObject({ ok: false });
  });
});

describe('formatCanonicalStatus', () => {
  it('prints counts and the active ref for a healthy store', () => {
    expect(formatCanonicalStatus(HEALTHY).split('\n')).toEqual([
      'canonical store: healthy',
      'refs 1',
      `  refs/remotes/origin/main man:v1:abc commit ${'c'.repeat(40)}`,
      'manifests 1',
      'pins 0',
      'overlays 0',
      'quarantined 0',
      'active-jobs 0',
      'dangling-refs 0',
      'missing-overlay-bases 0',
      'orphaned-pins 0',
    ]);
  });

  it('prints an empty store without detail lines', () => {
    const report = formatCanonicalStatus({
      ...HEALTHY,
      refs: [],
      manifestCount: 0,
    }).split('\n');
    expect(report[0]).toBe('canonical store: healthy');
    expect(report[1]).toBe('refs 0');
    expect(report).toHaveLength(10);
  });

  it('names every blocking id in a degraded store', () => {
    const report = formatCanonicalStatus({
      ...HEALTHY,
      status: 'degraded',
      danglingRefs: [{ ref: 'refs/remotes/origin/main', manifestId: 'man:v1:gone' }],
      missingOverlayBases: ['goal_1'],
      orphanedPins: ['man:v1:orphan'],
    }).split('\n');
    expect(report).toEqual([
      'canonical store: degraded',
      'refs 1',
      `  refs/remotes/origin/main man:v1:abc commit ${'c'.repeat(40)}`,
      'manifests 1',
      'pins 0',
      'overlays 0',
      'quarantined 0',
      'active-jobs 0',
      'dangling-refs 1',
      '  refs/remotes/origin/main man:v1:gone',
      'missing-overlay-bases 1',
      '  goal_1',
      'orphaned-pins 1',
      '  man:v1:orphan',
    ]);
  });
});

describe('indexStatusExitCode', () => {
  it('exits 0 only for a healthy store', () => {
    expect(indexStatusExitCode(HEALTHY)).toBe(0);
    expect(indexStatusExitCode({ ...HEALTHY, status: 'degraded' })).toBe(1);
  });
});
