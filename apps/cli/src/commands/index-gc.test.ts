import { describe, expect, it } from 'vitest';
import { formatIndexGc, indexGcExitCode, parseIndexGcArgs } from './index-gc.js';

const CONTENT = 'a'.repeat(64);
const ARTIFACT_KEY = `file:v1:${'b'.repeat(64)}`;
const REPO = 'repo_abc123';

describe('parseIndexGcArgs', () => {
  it('parses the dry-run flag in any position', () => {
    expect(parseIndexGcArgs(['gc', '--dry-run'])).toEqual({
      ok: true,
      value: { kind: 'index-gc', dryRun: true, json: false },
    });
    expect(parseIndexGcArgs(['gc', '--json', '--dry-run'])).toEqual({
      ok: true,
      value: { kind: 'index-gc', dryRun: true, json: true },
    });
  });

  it('requires an explicit --dry-run', () => {
    expect(parseIndexGcArgs(['gc'])).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(parseIndexGcArgs(['gc', '--json'])).toMatchObject({ ok: false });
  });

  it('rejects --apply with a message that says the verb is read-only', () => {
    const result = parseIndexGcArgs(['gc', '--apply']);
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(result.ok ? '' : result.error.message).toContain('--apply is not supported');
    expect(parseIndexGcArgs(['gc', '--dry-run', '--apply'])).toMatchObject({ ok: false });
  });

  it('rejects duplicate, unknown and positional arguments', () => {
    expect(parseIndexGcArgs(['gc', '--dry-run', '--dry-run'])).toMatchObject({ ok: false });
    expect(parseIndexGcArgs(['gc', '--dry-run', '--json', '--json'])).toMatchObject({ ok: false });
    expect(parseIndexGcArgs(['gc', '--dry-run', '--force'])).toMatchObject({ ok: false });
    expect(parseIndexGcArgs(['gc', CONTENT, '--dry-run'])).toMatchObject({ ok: false });
  });

  it('rejects the revision verbs', () => {
    expect(parseIndexGcArgs(['revision', 'prune', '--dry-run'])).toMatchObject({ ok: false });
    expect(parseIndexGcArgs(['status', '--dry-run'])).toMatchObject({ ok: false });
  });
});

describe('formatIndexGc', () => {
  it('prints counts, unreachable hashes and repository-scoped artifact keys', () => {
    expect(formatIndexGc({
      status: 'planned',
      reachable: [CONTENT],
      unreachable: [CONTENT],
      unreachableArtifacts: [{ repositoryId: REPO, artifactKey: ARTIFACT_KEY }],
      quarantined: [],
      quarantinedArtifacts: [],
    })).toBe([
      'planned (dry-run) reachable 1 unreachable 1 artifact-unreachable 1',
      `unreachable ${CONTENT}`,
      `artifact-unreachable ${REPO} ${ARTIFACT_KEY}`,
    ].join('\n'));
  });

  it('prints an empty plan when nothing is collectible', () => {
    expect(formatIndexGc({
      status: 'planned',
      reachable: [],
      unreachable: [],
      unreachableArtifacts: [],
      quarantined: [],
      quarantinedArtifacts: [],
    })).toBe('planned (dry-run) reachable 0 unreachable 0 artifact-unreachable 0');
  });

  it('prints a refused plan as the safety verdict', () => {
    expect(formatIndexGc({
      status: 'refused',
      reason: 'no reachability roots supplied; refusing to plan artifact GC',
    })).toBe('refused no reachability roots supplied; refusing to plan artifact GC');
  });
});

describe('indexGcExitCode', () => {
  it('exits 0 for a plan and 1 for a refusal', () => {
    const planned = {
      status: 'planned',
      reachable: [],
      unreachable: [],
      unreachableArtifacts: [],
      quarantined: [],
      quarantinedArtifacts: [],
    } as const;
    expect(indexGcExitCode(planned)).toBe(0);
    expect(indexGcExitCode({ status: 'refused', reason: 'missing manifests' })).toBe(1);
  });
});
