import { describe, expect, it } from 'vitest';
import type { CanonicalRevisionListReport } from '@unified-mpc/workspace';
import { formatCanonicalRevisionList, parseIndexRevisionListArgs } from './index-revision-list.js';

const REVISION = {
  manifestId: `man:v1:${'a'.repeat(64)}`,
  repositoryId: 'repo_abc123',
  revisionId: `rev:v1:${'b'.repeat(64)}`,
  commitSha: 'c'.repeat(40),
  treeOid: 'd'.repeat(40),
  targetRef: 'refs/remotes/origin/main',
  entryCount: 695,
  createdAt: '2026-10-17T00:00:00.000Z',
  refs: [],
  pins: [],
  overlayGoalIds: [],
  indexJobOperationIds: [],
} as const;

describe('parseIndexRevisionListArgs', () => {
  it('parses the list verb with and without --json', () => {
    expect(parseIndexRevisionListArgs(['revision', 'list'])).toEqual({
      ok: true,
      value: { kind: 'index-revision-list', json: false },
    });
    expect(parseIndexRevisionListArgs(['revision', 'list', '--json'])).toEqual({
      ok: true,
      value: { kind: 'index-revision-list', json: true },
    });
  });

  it('rejects the advance verb, unknown flags and duplicate flags', () => {
    expect(parseIndexRevisionListArgs(['revision', 'advance'])).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(parseIndexRevisionListArgs(['revision', 'list', '--ref', 'refs/heads/main'])).toMatchObject({ ok: false });
    expect(parseIndexRevisionListArgs(['revision', 'list', '--json', '--json'])).toMatchObject({ ok: false });
  });
});

describe('formatCanonicalRevisionList', () => {
  it('prints only the count for an empty store', () => {
    expect(formatCanonicalRevisionList({ revisions: [] })).toBe('revisions 0');
  });

  it('prints a summary line and no detail lines for an unreferenced revision', () => {
    const report: CanonicalRevisionListReport = { revisions: [REVISION] };
    expect(formatCanonicalRevisionList(report).split('\n')).toEqual([
      'revisions 1',
      `  ${REVISION.manifestId} commit ${REVISION.commitSha} tree ${REVISION.treeOid} entries 695 created 2026-10-17T00:00:00.000Z`,
    ]);
  });

  it('names every retention root when a revision is still referenced', () => {
    const report: CanonicalRevisionListReport = {
      revisions: [{
        ...REVISION,
        refs: ['refs/remotes/origin/main'],
        pins: ['goal-base', 'rollback'],
        overlayGoalIds: ['goal_a'],
        indexJobOperationIds: ['op_reindex'],
      }],
    };
    expect(formatCanonicalRevisionList(report).split('\n')).toEqual([
      'revisions 1',
      `  ${REVISION.manifestId} commit ${REVISION.commitSha} tree ${REVISION.treeOid} entries 695 created 2026-10-17T00:00:00.000Z`,
      '    refs refs/remotes/origin/main',
      '    pins goal-base rollback',
      '    overlay-bases goal_a',
      '    index-jobs op_reindex',
    ]);
  });
});
