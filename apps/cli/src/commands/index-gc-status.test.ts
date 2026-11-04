import { describe, expect, it } from 'vitest';
import type { GcStatusReport } from '@unified-mpc/workspace';
import { formatIndexGcStatus, indexGcStatusExitCode, parseIndexGcStatusArgs } from './index-gc-status.js';

const CONTENT = 'a'.repeat(64);
const ARTIFACT_KEY = `file:v1:${'b'.repeat(64)}`;
const REPO = 'repo_abc123';
const DEADLINE = '2026-11-04T00:01:00.000Z';

describe('parseIndexGcStatusArgs', () => {
  it('parses the verb with an optional --json', () => {
    expect(parseIndexGcStatusArgs(['gc', 'status'])).toEqual({
      ok: true,
      value: { kind: 'index-gc-status', json: false },
    });
    expect(parseIndexGcStatusArgs(['gc', 'status', '--json'])).toEqual({
      ok: true,
      value: { kind: 'index-gc-status', json: true },
    });
  });

  it('rejects duplicates, unknown and positional arguments', () => {
    expect(parseIndexGcStatusArgs(['gc', 'status', '--json', '--json'])).toMatchObject({ ok: false });
    expect(parseIndexGcStatusArgs(['gc', 'status', '--apply'])).toMatchObject({ ok: false });
    expect(parseIndexGcStatusArgs(['gc', 'status', '--dry-run'])).toMatchObject({ ok: false });
    expect(parseIndexGcStatusArgs(['gc', 'status', CONTENT])).toMatchObject({ ok: false });
  });

  it('rejects the sibling gc verbs', () => {
    expect(parseIndexGcStatusArgs(['gc'])).toMatchObject({ ok: false });
    expect(parseIndexGcStatusArgs(['gc', 'expire', '--apply'])).toMatchObject({ ok: false });
    expect(parseIndexGcStatusArgs(['revision', 'list'])).toMatchObject({ ok: false });
    expect(parseIndexGcStatusArgs(['status'])).toMatchObject({ ok: false });
  });
});

const emptyReport: GcStatusReport = {
  status: 'healthy',
  lease: { status: 'free' },
  quarantine: { total: 0, due: 0, inGrace: 0, rows: [] },
};

describe('formatIndexGcStatus', () => {
  it('prints a free lease and an empty ledger', () => {
    expect(formatIndexGcStatus(emptyReport)).toBe([
      'gc status: healthy',
      'lease free',
      'quarantine 0 (due 0, in-grace 0)',
    ].join('\n'));
  });

  it('names the holder of a held lease and whether it already expired', () => {
    expect(formatIndexGcStatus({
      ...emptyReport,
      lease: {
        status: 'held',
        ownerId: 'gc_owner',
        generation: 3,
        acquiredAt: '2026-11-03T23:59:00.000Z',
        expiresAt: DEADLINE,
        expired: true,
      },
    })).toContain('lease held by gc_owner until 2026-11-04T00:01:00.000Z (generation 3, expired)');
  });

  it('reports a released lease as released and a corrupt one as degraded', () => {
    expect(formatIndexGcStatus({
      ...emptyReport,
      lease: {
        status: 'released',
        ownerId: 'gc_owner',
        generation: 2,
        expiresAt: DEADLINE,
        releasedAt: '2026-11-04T00:00:30.000Z',
      },
    })).toContain('lease released by gc_owner at 2026-11-04T00:00:30.000Z');

    const corrupt: GcStatusReport = { ...emptyReport, status: 'degraded', lease: { status: 'corrupt' } };
    expect(formatIndexGcStatus(corrupt)).toContain('lease corrupt');
    expect(formatIndexGcStatus(corrupt)).toContain('gc status: degraded');
  });

  it('lists both id spaces with their deadlines, due rows first', () => {
    expect(formatIndexGcStatus({
      ...emptyReport,
      quarantine: {
        total: 2,
        due: 1,
        inGrace: 1,
        rows: [
          { target: CONTENT, quarantinedAt: '2026-11-03T23:00:00.000Z', graceMs: 60_000, expiresAt: DEADLINE, due: true },
          {
            target: { kind: 'artifact-key', repositoryId: REPO, artifactKey: ARTIFACT_KEY },
            quarantinedAt: '2026-11-03T23:59:30.000Z',
            graceMs: 60_000,
            expiresAt: '2026-11-04T00:00:30.000Z',
            due: false,
          },
        ],
      },
    })).toBe([
      'gc status: healthy',
      'lease free',
      'quarantine 2 (due 1, in-grace 1)',
      `  due ${CONTENT} until ${DEADLINE}`,
      `  in-grace ${REPO} ${ARTIFACT_KEY} until 2026-11-04T00:00:30.000Z`,
    ].join('\n'));
  });

  it('marks a row whose own deadline cannot be read instead of calling it due', () => {
    const text = formatIndexGcStatus({
      ...emptyReport,
      quarantine: {
        total: 1,
        due: 0,
        inGrace: 1,
        rows: [{ target: CONTENT, quarantinedAt: 'not-a-date', graceMs: 60_000, expiresAt: null, due: false }],
      },
    });
    expect(text).toContain(`  in-grace ${CONTENT} until unreadable`);
  });
});

describe('indexGcStatusExitCode', () => {
  it('exits zero for a healthy ledger and one for an unreadable lease', () => {
    expect(indexGcStatusExitCode(emptyReport)).toBe(0);
    expect(indexGcStatusExitCode({ ...emptyReport, status: 'degraded', lease: { status: 'corrupt' } })).toBe(1);
  });
});
