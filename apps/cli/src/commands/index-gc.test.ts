import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GC_GRACE_MS,
  formatIndexGc,
  formatIndexMaintenance,
  indexGcExitCode,
  indexMaintenanceExitCode,
  parseGcGrace,
  parseIndexGcArgs,
  parseIndexMaintenanceArgs,
} from './index-gc.js';

const CONTENT = 'a'.repeat(64);
const ARTIFACT_KEY = `file:v1:${'b'.repeat(64)}`;
const REPO = 'repo_abc123';

describe('parseIndexGcArgs', () => {
  it('parses the dry-run flag in any position', () => {
    expect(parseIndexGcArgs(['gc', '--dry-run'])).toEqual({
      ok: true,
      value: { kind: 'index-gc', dryRun: true, graceMs: DEFAULT_GC_GRACE_MS, json: false },
    });
    expect(parseIndexGcArgs(['gc', '--json', '--dry-run'])).toEqual({
      ok: true,
      value: { kind: 'index-gc', dryRun: true, graceMs: DEFAULT_GC_GRACE_MS, json: true },
    });
  });

  it('parses an apply pass with the default and an explicit grace', () => {
    expect(parseIndexGcArgs(['gc', '--apply'])).toEqual({
      ok: true,
      value: { kind: 'index-gc', dryRun: false, graceMs: DEFAULT_GC_GRACE_MS, json: false },
    });
    expect(parseIndexGcArgs(['gc', '--grace', '12h', '--apply', '--json'])).toEqual({
      ok: true,
      value: { kind: 'index-gc', dryRun: false, graceMs: 12 * 3_600_000, json: true },
    });
  });

  it('requires exactly one explicit mode', () => {
    expect(parseIndexGcArgs(['gc'])).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(parseIndexGcArgs(['gc', '--json'])).toMatchObject({ ok: false });
    expect(parseIndexGcArgs(['gc', '--dry-run', '--apply'])).toMatchObject({ ok: false });
    expect(parseIndexGcArgs(['gc', '--apply', '--apply'])).toMatchObject({ ok: false });
  });

  it('rejects --grace on a dry run, because the plan stamps no deadline', () => {
    expect(parseIndexGcArgs(['gc', '--dry-run', '--grace', '7d'])).toMatchObject({ ok: false });
    expect(parseIndexGcArgs(['gc', '--grace', '7d', '--dry-run'])).toMatchObject({ ok: false });
  });

  it('rejects malformed, zero, negative, fractional and duplicate grace values', () => {
    for (const value of ['', '0s', '0d', '-1d', '1.5h', '7', 'd7', '7w', '999999999999999999999d']) {
      expect(parseIndexGcArgs(['gc', '--apply', '--grace', value]), value).toMatchObject({ ok: false });
    }
    expect(parseIndexGcArgs(['gc', '--apply', '--grace'])).toMatchObject({ ok: false });
    expect(parseIndexGcArgs(['gc', '--apply', '--grace', '7d', '--grace', '7d'])).toMatchObject({ ok: false });
  });

  it('rejects duplicate, unknown and positional arguments', () => {
    expect(parseIndexGcArgs(['gc', '--dry-run', '--dry-run'])).toMatchObject({ ok: false });
    expect(parseIndexGcArgs(['gc', '--dry-run', '--json', '--json'])).toMatchObject({ ok: false });
    expect(parseIndexGcArgs(['gc', '--apply', '--force'])).toMatchObject({ ok: false });
    expect(parseIndexGcArgs(['gc', CONTENT, '--apply'])).toMatchObject({ ok: false });
  });

  it('rejects the revision verbs', () => {
    expect(parseIndexGcArgs(['revision', 'prune', '--dry-run'])).toMatchObject({ ok: false });
    expect(parseIndexGcArgs(['status', '--dry-run'])).toMatchObject({ ok: false });
  });
});

describe('parseGcGrace', () => {
  it('accepts every supported unit', () => {
    expect(parseGcGrace('30s')).toBe(30_000);
    expect(parseGcGrace('5m')).toBe(300_000);
    expect(parseGcGrace('12h')).toBe(43_200_000);
    expect(parseGcGrace('7d')).toBe(DEFAULT_GC_GRACE_MS);
  });

  it('refuses anything that is not a positive whole unit count', () => {
    for (const value of ['', 's', '0s', '+1d', '1 d', '1D', '1.0d']) {
      expect(parseGcGrace(value), value).toBeNull();
    }
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
    }, true)).toBe([
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
    }, true)).toBe('planned (dry-run) reachable 0 unreachable 0 artifact-unreachable 0');
  });

  it('prints the rows an apply pass actually quarantined', () => {
    expect(formatIndexGc({
      status: 'planned',
      reachable: [CONTENT],
      unreachable: [CONTENT],
      unreachableArtifacts: [{ repositoryId: REPO, artifactKey: ARTIFACT_KEY }],
      quarantined: [CONTENT],
      quarantinedArtifacts: [{ repositoryId: REPO, artifactKey: ARTIFACT_KEY }],
    }, false)).toBe([
      'applied quarantined 1 artifact-quarantined 1',
      `quarantined ${CONTENT}`,
      `artifact-quarantined ${REPO} ${ARTIFACT_KEY}`,
    ].join('\n'));
  });

  it('prints an empty apply as an applied pass, not a plan', () => {
    expect(formatIndexGc({
      status: 'planned',
      reachable: [CONTENT],
      unreachable: [],
      unreachableArtifacts: [],
      quarantined: [],
      quarantinedArtifacts: [],
    }, false)).toBe('applied quarantined 0 artifact-quarantined 0');
  });

  it('prints a refused pass as the safety verdict', () => {
    expect(formatIndexGc({
      status: 'refused',
      reason: 'gc lease held by other-cli until 2026-11-04T12:00:00.000Z',
    }, false)).toBe('refused gc lease held by other-cli until 2026-11-04T12:00:00.000Z');
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

describe('parseIndexMaintenanceArgs', () => {
  it('parses the mode flag in any position', () => {
    expect(parseIndexMaintenanceArgs(['maintenance', '--dry-run'])).toEqual({
      ok: true,
      value: { kind: 'index-maintenance', dryRun: true, json: false },
    });
    expect(parseIndexMaintenanceArgs(['maintenance', '--json', '--apply'])).toEqual({
      ok: true,
      value: { kind: 'index-maintenance', dryRun: false, json: true },
    });
  });

  it('requires exactly one explicit mode', () => {
    expect(parseIndexMaintenanceArgs(['maintenance'])).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(parseIndexMaintenanceArgs(['maintenance', '--json'])).toMatchObject({ ok: false });
    expect(parseIndexMaintenanceArgs(['maintenance', '--dry-run', '--apply'])).toMatchObject({ ok: false });
    expect(parseIndexMaintenanceArgs(['maintenance', '--apply', '--apply'])).toMatchObject({ ok: false });
  });

  it('rejects duplicate, unknown and positional arguments', () => {
    expect(parseIndexMaintenanceArgs(['maintenance', '--dry-run', '--dry-run'])).toMatchObject({ ok: false });
    expect(parseIndexMaintenanceArgs(['maintenance', '--apply', '--json', '--json'])).toMatchObject({ ok: false });
    expect(parseIndexMaintenanceArgs(['maintenance', '--apply', '--force'])).toMatchObject({ ok: false });
    expect(parseIndexMaintenanceArgs(['maintenance', CONTENT, '--apply'])).toMatchObject({ ok: false });
  });

  it('rejects the per-verb grace flag the cycle does not thread', () => {
    expect(parseIndexMaintenanceArgs(['maintenance', '--apply', '--grace', '7d'])).toMatchObject({ ok: false });
  });

  it('rejects the other index verbs', () => {
    expect(parseIndexMaintenanceArgs(['gc', '--dry-run'])).toMatchObject({ ok: false });
    expect(parseIndexMaintenanceArgs(['status'])).toMatchObject({ ok: false });
  });
});

const HEALTHY_VERIFICATION = {
  status: 'healthy',
  danglingRefs: [],
  missingOverlays: [],
  orphanedPins: [],
  manifests: [{ manifestId: 'manifest_1', pinned: true, reasons: ['operator'] }],
} as const;

describe('formatIndexMaintenance', () => {
  it('prints a completed dry run with the GC plan it would apply', () => {
    expect(formatIndexMaintenance({
      status: 'completed',
      gc: {
        status: 'planned',
        reachable: [],
        unreachable: [CONTENT],
        unreachableArtifacts: [{ repositoryId: REPO, artifactKey: ARTIFACT_KEY }],
        quarantined: [],
        quarantinedArtifacts: [],
      },
      verification: HEALTHY_VERIFICATION,
      tookFence: true,
      tookAdmission: true,
    }, true)).toBe([
      'completed (dry-run) verification healthy manifests 1',
      'planned (dry-run) reachable 0 unreachable 1 artifact-unreachable 1',
      `unreachable ${CONTENT}`,
      `artifact-unreachable ${REPO} ${ARTIFACT_KEY}`,
    ].join('\n'));
  });

  it('prints a completed apply with the rows it quarantined', () => {
    expect(formatIndexMaintenance({
      status: 'completed',
      gc: {
        status: 'planned',
        reachable: [],
        unreachable: [CONTENT],
        unreachableArtifacts: [],
        quarantined: [CONTENT],
        quarantinedArtifacts: [],
      },
      verification: HEALTHY_VERIFICATION,
      tookFence: true,
      tookAdmission: true,
    }, false)).toBe([
      'completed (applied) verification healthy manifests 1',
      'applied quarantined 1 artifact-quarantined 0',
      `quarantined ${CONTENT}`,
    ].join('\n'));
  });

  it('prints a skip as a successful verdict, not a failure', () => {
    expect(formatIndexMaintenance({
      status: 'skipped',
      reason: 'reader-pressure',
      tookFence: true,
      tookAdmission: false,
    }, false)).toBe('skipped reader-pressure');
    expect(formatIndexMaintenance({
      status: 'skipped',
      reason: 'below-threshold',
      tookFence: true,
      tookAdmission: false,
    }, true)).toBe('skipped below-threshold');
  });

  it('prints a refusal as the safety verdict with the deciding detail', () => {
    expect(formatIndexMaintenance({
      status: 'refused',
      reason: 'headroom-insufficient',
      detail: 'required 276824064 bytes free 10485760',
      tookFence: false,
      tookAdmission: false,
    }, false)).toBe('refused headroom-insufficient: required 276824064 bytes free 10485760');
  });
});

describe('indexMaintenanceExitCode', () => {
  it('exits 1 only for a refusal', () => {
    expect(indexMaintenanceExitCode({
      status: 'refused',
      reason: 'admission-rejected',
      detail: 'admission denied: global-cost-limit',
      tookFence: true,
      tookAdmission: false,
    })).toBe(1);
    expect(indexMaintenanceExitCode({
      status: 'skipped',
      reason: 'below-threshold',
      tookFence: true,
      tookAdmission: false,
    })).toBe(0);
    expect(indexMaintenanceExitCode({
      status: 'completed',
      gc: {
        status: 'planned',
        reachable: [],
        unreachable: [],
        unreachableArtifacts: [],
        quarantined: [],
        quarantinedArtifacts: [],
      },
      verification: HEALTHY_VERIFICATION,
      tookFence: true,
      tookAdmission: true,
    })).toBe(0);
  });
});
