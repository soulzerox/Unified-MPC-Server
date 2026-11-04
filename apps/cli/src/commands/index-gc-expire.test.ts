import { describe, expect, it } from 'vitest';
import { formatIndexGcExpire, indexGcExpireExitCode, parseIndexGcExpireArgs } from './index-gc-expire.js';

const CONTENT = 'a'.repeat(64);
const ARTIFACT_KEY = `file:v1:${'b'.repeat(64)}`;
const REPO = 'repo_abc123';

describe('parseIndexGcExpireArgs', () => {
  it('parses either mode in any position', () => {
    expect(parseIndexGcExpireArgs(['gc', 'expire', '--dry-run'])).toEqual({
      ok: true,
      value: { kind: 'index-gc-expire', dryRun: true, json: false },
    });
    expect(parseIndexGcExpireArgs(['gc', 'expire', '--json', '--dry-run'])).toEqual({
      ok: true,
      value: { kind: 'index-gc-expire', dryRun: true, json: true },
    });
    expect(parseIndexGcExpireArgs(['gc', 'expire', '--apply'])).toEqual({
      ok: true,
      value: { kind: 'index-gc-expire', dryRun: false, json: false },
    });
    expect(parseIndexGcExpireArgs(['gc', 'expire', '--json', '--apply'])).toEqual({
      ok: true,
      value: { kind: 'index-gc-expire', dryRun: false, json: true },
    });
  });

  it('requires exactly one explicit mode', () => {
    expect(parseIndexGcExpireArgs(['gc', 'expire'])).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(parseIndexGcExpireArgs(['gc', 'expire', '--json'])).toMatchObject({ ok: false });
    expect(parseIndexGcExpireArgs(['gc', 'expire', '--dry-run', '--apply'])).toMatchObject({ ok: false });
    expect(parseIndexGcExpireArgs(['gc', 'expire', '--apply', '--dry-run'])).toMatchObject({ ok: false });
    expect(parseIndexGcExpireArgs(['gc', 'expire', '--apply', '--apply'])).toMatchObject({ ok: false });
  });

  it('rejects duplicate, unknown and positional arguments', () => {
    expect(parseIndexGcExpireArgs(['gc', 'expire', '--dry-run', '--dry-run'])).toMatchObject({ ok: false });
    expect(parseIndexGcExpireArgs(['gc', 'expire', '--apply', '--json', '--json'])).toMatchObject({ ok: false });
    expect(parseIndexGcExpireArgs(['gc', 'expire', '--apply', '--force'])).toMatchObject({ ok: false });
    expect(parseIndexGcExpireArgs(['gc', 'expire', CONTENT, '--apply'])).toMatchObject({ ok: false });
    expect(parseIndexGcExpireArgs(['gc', 'expire', '--apply', '--grace', '7d'])).toMatchObject({ ok: false });
  });

  it('rejects the sibling gc verbs', () => {
    expect(parseIndexGcExpireArgs(['gc', '--dry-run'])).toMatchObject({ ok: false });
    expect(parseIndexGcExpireArgs(['gc', 'status', '--apply'])).toMatchObject({ ok: false });
    expect(parseIndexGcExpireArgs(['revision', 'prune', '--apply'])).toMatchObject({ ok: false });
  });
});

describe('formatIndexGcExpire', () => {
  it('prints both id spaces and separates expired from retained rows in a dry run', () => {
    expect(formatIndexGcExpire({
      status: 'planned',
      expired: [CONTENT, { kind: 'artifact-key', repositoryId: REPO, artifactKey: ARTIFACT_KEY }],
      deleted: [],
      retained: [{ kind: 'artifact-key', repositoryId: REPO, artifactKey: `file:v1:${'c'.repeat(64)}` }],
    }, true)).toBe([
      'planned (dry-run) expired 2 retained 1',
      `expire ${CONTENT}`,
      `expire ${REPO} ${ARTIFACT_KEY}`,
      `retain ${REPO} ${`file:v1:${'c'.repeat(64)}`}`,
    ].join('\n'));
  });

  it('prints an empty plan when nothing is due', () => {
    expect(formatIndexGcExpire({
      status: 'planned',
      expired: [],
      deleted: [],
      retained: [],
    }, true)).toBe('planned (dry-run) expired 0 retained 0');
  });

  it('prints released rows, not due candidates, in an apply pass', () => {
    expect(formatIndexGcExpire({
      status: 'planned',
      expired: [CONTENT, { kind: 'artifact-key', repositoryId: REPO, artifactKey: ARTIFACT_KEY }],
      deleted: [CONTENT, { kind: 'artifact-key', repositoryId: REPO, artifactKey: ARTIFACT_KEY }],
      retained: [`${'e'.repeat(64)}`],
    }, false)).toBe([
      'applied due 2 released 2 retained 1',
      `released ${CONTENT}`,
      `released ${REPO} ${ARTIFACT_KEY}`,
      `retain ${'e'.repeat(64)}`,
    ].join('\n'));
  });

  it('prints an empty apply as an applied pass, not a plan', () => {
    expect(formatIndexGcExpire({
      status: 'planned',
      expired: [],
      deleted: [],
      retained: [],
    }, false)).toBe('applied due 0 released 0 retained 0');
  });

  it('prints a refused pass as the safety verdict', () => {
    expect(formatIndexGcExpire({
      status: 'refused',
      reason: 'gc lease held by other-gc until 2026-11-04T12:00:00.000Z',
    }, false)).toBe('refused gc lease held by other-gc until 2026-11-04T12:00:00.000Z');
  });
});

describe('indexGcExpireExitCode', () => {
  it('exits 0 for a plan and 1 for a refusal', () => {
    expect(indexGcExpireExitCode({ status: 'planned', expired: [], deleted: [], retained: [] })).toBe(0);
    expect(indexGcExpireExitCode({ status: 'refused', reason: 'missing manifests' })).toBe(1);
  });
});
