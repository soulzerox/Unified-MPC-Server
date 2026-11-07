import { describe, expect, it } from 'vitest';
import type { CanonicalStatusReport } from '@unified-mpc/workspace';
import { formatCanonicalStatus, indexStatusExitCode, parseIndexStatusArgs } from './index-status.js';

const HEALTHY: CanonicalStatusReport = {
  status: 'healthy',
  refs: [{
    ref: 'refs/remotes/origin/main',
    manifestId: 'man:v1:abc',
    commitSha: 'c'.repeat(40),
    treeOid: 'd'.repeat(40),
    manifestCreatedAt: '2026-10-17T00:00:00.000Z',
    manifestEntryCount: 2,
    manifestExists: true,
    pinned: false,
    pinReasons: [],
  }],
  overlays: [],
  jobs: [],
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
      `  refs/remotes/origin/main man:v1:abc commit ${'c'.repeat(40)} tree ${'d'.repeat(40)} entries 2`,
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

  it('distinguishes pin retention, overlay drift and job manifest liveness', () => {
    const report = formatCanonicalStatus({
      ...HEALTHY,
      refs: [{ ...HEALTHY.refs[0], pinned: true, pinReasons: ['rollback', 'user-pin'] }],
      overlays: [{
        goalWorkspaceId: 'goal_a',
        baseManifestId: 'man:v1:base',
        baseCommitSha: 'a'.repeat(40),
        baseTreeOid: 'b'.repeat(40),
        baseManifestExists: true,
        baseMatchesLiveRef: false,
        modifiedCount: 1,
        addedCount: 2,
        deletedCount: 3,
        updatedAt: '2026-10-17T00:00:00.000Z',
      }],
      jobs: [{
        operationId: 'op_1',
        manifestId: 'man:v1:gone',
        status: 'active',
        openedAt: '2026-10-17T00:00:00.000Z',
        updatedAt: '2026-10-17T00:01:00.000Z',
        manifestExists: false,
      }],
      overlayCount: 1,
      activeJobCount: 1,
    }).split('\n');
    expect(report).toContain(
      `  refs/remotes/origin/main man:v1:abc commit ${'c'.repeat(40)} tree ${'d'.repeat(40)} entries 2 pinned rollback,user-pin`,
    );
    expect(report).toContain(
      `  goal goal_a base man:v1:base commit ${'a'.repeat(40)} entries modified=1 added=2 deleted=3 base=drifted updated 2026-10-17T00:00:00.000Z`,
    );
    expect(report).toContain('  op_1 man:v1:gone active opened 2026-10-17T00:00:00.000Z manifest=missing');
  });

  it('names a dangling ref and a missing overlay base without inventing identity', () => {
    const report = formatCanonicalStatus({
      ...HEALTHY,
      status: 'degraded',
      refs: [{
        ...HEALTHY.refs[0],
        manifestExists: false,
        treeOid: null,
        manifestCreatedAt: null,
        manifestEntryCount: null,
      }],
      overlays: [{
        goalWorkspaceId: 'goal_a',
        baseManifestId: 'man:v1:base',
        baseCommitSha: 'a'.repeat(40),
        baseTreeOid: 'b'.repeat(40),
        baseManifestExists: false,
        baseMatchesLiveRef: false,
        modifiedCount: 0,
        addedCount: 0,
        deletedCount: 0,
        updatedAt: '2026-10-17T00:00:00.000Z',
      }],
      overlayCount: 1,
      danglingRefs: [{ ref: 'refs/remotes/origin/main', manifestId: 'man:v1:abc' }],
      missingOverlayBases: ['goal_a'],
    }).split('\n');
    expect(report).toContain(
      `  refs/remotes/origin/main man:v1:abc commit ${'c'.repeat(40)} manifest-missing`,
    );
    expect(report).toContain(
      `  goal goal_a base man:v1:base commit ${'a'.repeat(40)} entries modified=0 added=0 deleted=0 base=missing updated 2026-10-17T00:00:00.000Z`,
    );
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
      `  refs/remotes/origin/main man:v1:abc commit ${'c'.repeat(40)} tree ${'d'.repeat(40)} entries 2`,
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
