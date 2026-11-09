import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SkillInventoryAuditService } from './skill-inventory-audit.js';
import { DEFAULT_EXTENSIONS_SETTINGS } from './types.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createHome(): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-skill-audit-'));
  temporaryRoots.push(home);
  return home;
}

async function writeSkill(
  skillsRoot: string,
  folder: string,
  declaredName: string,
  body: string,
): Promise<string> {
  const directory = path.join(skillsRoot, folder);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'SKILL.md'), `---
name: ${declaredName}
description: ${declaredName} test skill
---
${body}
`, 'utf8');
  return directory;
}

function canonicalPartition(summary: {
  readonly canonicalMatchNames: number;
  readonly canonicalDivergingNames: number;
  readonly canonicalOnlyNames: number;
  readonly canonicalAbsentNames: number;
  readonly duplicateCanonicalNames: number;
  readonly canonicalUnverifiedNames: number;
}): number {
  return summary.canonicalMatchNames
    + summary.canonicalDivergingNames
    + summary.canonicalOnlyNames
    + summary.canonicalAbsentNames
    + summary.duplicateCanonicalNames
    + summary.canonicalUnverifiedNames;
}

function audit(home: string, managedRoot: string): SkillInventoryAuditService {
  return new SkillInventoryAuditService({
    settings: DEFAULT_EXTENSIONS_SETTINGS,
    managedRoot,
    homeDir: home,
    bundledRoots: [],
  });
}

describe('SkillInventoryAuditService', () => {
  it('classifies identical legacy and canonical copies as matching content', async () => {
    const home = await createHome();
    const canonicalRoot = path.join(home, 'canonical-skills');
    await writeSkill(path.join(home, '.claude', 'skills'), 'alpha', 'alpha', 'same body\n');
    await writeSkill(canonicalRoot, 'alpha', 'alpha', 'same body\n');

    const report = await audit(home, canonicalRoot).audit();
    expect(report.ok).toBe(true);
    if (!report.ok) return;

    const alpha = report.value.names.find((entry) => entry.name === 'alpha');
    expect(alpha).toMatchObject({
      canonicalId: 'skill:alpha',
      classification: 'identical',
      canonicalState: 'matches',
    });
    expect(alpha?.variantFingerprints).toHaveLength(1);
    expect(alpha?.canonicalFingerprints).toEqual(alpha?.variantFingerprints);
    expect(alpha?.entries.map((entry) => entry.isCanonical)).toEqual([false, true]);
    expect(report.value.summary).toMatchObject({
      directories: 2,
      declaredNames: 1,
      identicalNames: 1,
      canonicalPresentNames: 1,
      canonicalMatchNames: 1,
      canonicalDivergingNames: 0,
      duplicateCanonicalNames: 0,
    });
  });

  it('reports divergent variants and a canonical copy that matches none of them', async () => {
    const home = await createHome();
    const canonicalRoot = path.join(home, 'canonical-skills');
    await writeSkill(path.join(home, '.claude', 'skills'), 'beta', 'beta', 'legacy body\n');
    await writeSkill(path.join(home, '.cursor', 'skills'), 'beta', 'beta', 'other legacy body\n');
    await writeSkill(canonicalRoot, 'beta', 'beta', 'canonical body\n');

    const report = await audit(home, canonicalRoot).audit();
    expect(report.ok).toBe(true);
    if (!report.ok) return;

    const beta = report.value.names.find((entry) => entry.name === 'beta');
    expect(beta).toMatchObject({ classification: 'divergent', canonicalState: 'diverges' });
    expect(beta?.variantFingerprints).toHaveLength(3);
    expect(beta?.canonicalFingerprints).toHaveLength(1);
    expect(report.value.summary).toMatchObject({
      divergentNames: 1,
      canonicalDivergingNames: 1,
      canonicalMatchNames: 0,
    });
  });

  it('separates legacy-only names from canonical-only names', async () => {
    const home = await createHome();
    const canonicalRoot = path.join(home, 'canonical-skills');
    await writeSkill(path.join(home, '.claude', 'skills'), 'legacy-only', 'legacy-only', 'legacy\n');
    await writeSkill(canonicalRoot, 'canonical-only', 'canonical-only', 'canonical\n');

    const report = await audit(home, canonicalRoot).audit();
    expect(report.ok).toBe(true);
    if (!report.ok) return;

    expect(report.value.names.find((entry) => entry.name === 'legacy-only')).toMatchObject({
      classification: 'unique',
      canonicalState: 'absent',
    });
    expect(report.value.names.find((entry) => entry.name === 'canonical-only')).toMatchObject({
      classification: 'unique',
      canonicalState: 'only-canonical',
    });
    expect(report.value.summary).toMatchObject({
      uniqueNames: 2,
      canonicalAbsentNames: 1,
      canonicalPresentNames: 1,
    });
  });

  it('counts only a legacy copy with matching content as a canonical match', async () => {
    const home = await createHome();
    const canonicalRoot = path.join(home, 'canonical-skills');
    await writeSkill(path.join(home, '.claude', 'skills'), 'shared', 'shared', 'same body\n');
    await writeSkill(canonicalRoot, 'shared', 'shared', 'same body\n');
    await writeSkill(canonicalRoot, 'canonical-only', 'canonical-only', 'canonical\n');
    await writeSkill(path.join(home, '.claude', 'skills'), 'legacy-only', 'legacy-only', 'legacy\n');

    const report = await audit(home, canonicalRoot).audit();
    expect(report.ok).toBe(true);
    if (!report.ok) return;

    const summary = report.value.summary;
    expect(summary).toMatchObject({
      declaredNames: 3,
      canonicalMatchNames: 1,
      canonicalOnlyNames: 1,
      canonicalDivergingNames: 0,
      canonicalAbsentNames: 1,
      duplicateCanonicalNames: 0,
      canonicalUnverifiedNames: 0,
    });
    expect(canonicalPartition(summary)).toBe(summary.declaredNames);
  });

  it('partitions an unfingerprintable legacy-only name instead of dropping it', async () => {
    const home = await createHome();
    const canonicalRoot = path.join(home, 'canonical-skills');
    const legacy = await writeSkill(path.join(home, '.claude', 'skills'), 'delta', 'delta', 'legacy\n');
    await symlink(path.join(home, 'outside.md'), path.join(legacy, 'linked.md'));

    const report = await audit(home, canonicalRoot).audit();
    expect(report.ok).toBe(true);
    if (!report.ok) return;

    const summary = report.value.summary;
    expect(summary).toMatchObject({
      declaredNames: 1,
      canonicalPresentNames: 0,
      canonicalAbsentNames: 0,
      canonicalUnverifiedNames: 1,
      canonicalMatchNames: 0,
    });
    expect(canonicalPartition(summary)).toBe(summary.declaredNames);
  });

  it('surfaces two canonical directories advertising one logical name as a duplicate', async () => {
    const home = await createHome();
    const canonicalRoot = path.join(home, 'canonical-skills');
    await writeSkill(canonicalRoot, 'ui-ux-pro-max', 'ui-ux-pro-max', 'first install\n');
    await writeSkill(canonicalRoot, 'ux-ui-promax-skill', 'ui-ux-pro-max', 'second install\n');

    const report = await audit(home, canonicalRoot).audit();
    expect(report.ok).toBe(true);
    if (!report.ok) return;

    const duplicate = report.value.names.find((entry) => entry.name === 'ui-ux-pro-max');
    expect(duplicate).toMatchObject({
      canonicalId: 'skill:ui-ux-pro-max',
      classification: 'divergent',
      canonicalState: 'duplicate',
    });
    expect(duplicate?.entries).toHaveLength(2);
    expect(report.value.summary.duplicateCanonicalNames).toBe(1);
  });

  it('refuses to count variants when a copy cannot be fingerprinted', async () => {
    const home = await createHome();
    const canonicalRoot = path.join(home, 'canonical-skills');
    const legacy = await writeSkill(path.join(home, '.claude', 'skills'), 'gamma', 'gamma', 'legacy\n');
    await writeSkill(canonicalRoot, 'gamma', 'gamma', 'legacy\n');
    await symlink(path.join(home, 'outside.md'), path.join(legacy, 'linked.md'));

    const report = await audit(home, canonicalRoot).audit();
    expect(report.ok).toBe(true);
    if (!report.ok) return;

    const gamma = report.value.names.find((entry) => entry.name === 'gamma');
    expect(gamma).toMatchObject({ classification: 'unverified', canonicalState: 'unverified' });
    expect(gamma?.variantFingerprints).toHaveLength(1);
    expect(report.value.skipped).toHaveLength(1);
    expect(report.value.skipped[0]?.skillPath).toBe(path.join(legacy, 'SKILL.md'));
    expect(report.value.skipped[0]?.reason).toContain('symbolic links');
    expect(report.value.summary.unverifiedNames).toBe(1);
  });

  it('keeps the report deterministic across runs', async () => {
    const home = await createHome();
    const canonicalRoot = path.join(home, 'canonical-skills');
    await writeSkill(path.join(home, 'not-a-skill-root'), 'ignored', 'ignored', 'x\n');
    await writeSkill(path.join(home, '.cursor', 'skills'), 'zulu', 'zulu', 'z\n');
    await writeSkill(path.join(home, '.claude', 'skills'), 'alpha', 'alpha', 'a\n');
    await writeSkill(canonicalRoot, 'alpha', 'alpha', 'a\n');

    const service = audit(home, canonicalRoot);
    const first = await service.audit();
    const second = await service.audit();
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(JSON.stringify(second.value)).toBe(JSON.stringify(first.value));
    expect(first.value.names.map((entry) => entry.name)).toEqual(['alpha', 'zulu']);
    expect(first.value.roots.map((root) => root.source)).toEqual([
      'claude-skills',
      'cursor-skills',
      'unified-mpc-skills',
    ]);
    expect(first.value.roots.every((root) => root.directories === 1)).toBe(true);
  });

  it('rejects an empty canonical root instead of auditing nothing', async () => {
    const home = await createHome();
    const report = await audit(home, '   ').audit();
    expect(report.ok).toBe(false);
    if (report.ok) return;
    expect(report.error.message).toContain('canonical Skill root');
  });
});
