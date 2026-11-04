import { describe, expect, it } from 'vitest';
import { formatIndexGcExpire, indexGcExpireExitCode, parseIndexGcExpireArgs } from './index-gc-expire.js';

const CONTENT = 'a'.repeat(64);
const ARTIFACT_KEY = `file:v1:${'b'.repeat(64)}`;
const REPO = 'repo_abc123';

describe('parseIndexGcExpireArgs', () => {
  it('parses the dry-run flag in any position', () => {
    expect(parseIndexGcExpireArgs(['gc', 'expire', '--dry-run'])).toEqual({
      ok: true,
      value: { kind: 'index-gc-expire', dryRun: true, json: false },
    });
    expect(parseIndexGcExpireArgs(['gc', 'expire', '--json', '--dry-run'])).toEqual({
      ok: true,
      value: { kind: 'index-gc-expire', dryRun: true, json: true },
    });
  });

  it('requires an explicit --dry-run', () => {
    expect(parseIndexGcExpireArgs(['gc', 'expire'])).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(parseIndexGcExpireArgs(['gc', 'expire', '--json'])).toMatchObject({ ok: false });
  });

  it('rejects --apply with a message that says the verb is read-only', () => {
    const result = parseIndexGcExpireArgs(['gc', 'expire', '--apply']);
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(result.ok ? '' : result.error.message).toContain('--apply is not supported');
    expect(parseIndexGcExpireArgs(['gc', 'expire', '--dry-run', '--apply'])).toMatchObject({ ok: false });
  });

  it('rejects duplicate, unknown and positional arguments', () => {
    expect(parseIndexGcExpireArgs(['gc', 'expire', '--dry-run', '--dry-run'])).toMatchObject({ ok: false });
    expect(parseIndexGcExpireArgs(['gc', 'expire', '--dry-run', '--json', '--json'])).toMatchObject({ ok: false });
    expect(parseIndexGcExpireArgs(['gc', 'expire', '--dry-run', '--force'])).toMatchObject({ ok: false });
    expect(parseIndexGcExpireArgs(['gc', 'expire', CONTENT, '--dry-run'])).toMatchObject({ ok: false });
  });

  it('rejects the sibling gc verbs', () => {
    expect(parseIndexGcExpireArgs(['gc', '--dry-run'])).toMatchObject({ ok: false });
    expect(parseIndexGcExpireArgs(['gc', 'status', '--dry-run'])).toMatchObject({ ok: false });
    expect(parseIndexGcExpireArgs(['revision', 'prune', '--dry-run'])).toMatchObject({ ok: false });
  });
});

describe('formatIndexGcExpire', () => {
  it('prints both id spaces and separates expired from retained rows', () => {
    expect(formatIndexGcExpire({
      status: 'planned',
      expired: [CONTENT, { kind: 'artifact-key', repositoryId: REPO, artifactKey: ARTIFACT_KEY }],
      deleted: [],
      retained: [{ kind: 'artifact-key', repositoryId: REPO, artifactKey: `file:v1:${'c'.repeat(64)}` }],
    })).toBe([
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
    })).toBe('planned (dry-run) expired 0 retained 0');
  });

  it('prints a refused plan as the safety verdict', () => {
    expect(formatIndexGcExpire({
      status: 'refused',
      reason: 'no reachability roots supplied; refusing to plan artifact GC',
    })).toBe('refused no reachability roots supplied; refusing to plan artifact GC');
  });
});

describe('indexGcExpireExitCode', () => {
  it('exits 0 for a plan and 1 for a refusal', () => {
    expect(indexGcExpireExitCode({ status: 'planned', expired: [], deleted: [], retained: [] })).toBe(0);
    expect(indexGcExpireExitCode({ status: 'refused', reason: 'missing manifests' })).toBe(1);
  });
});
