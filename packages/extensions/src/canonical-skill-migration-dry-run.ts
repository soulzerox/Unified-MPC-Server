import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { appError, err, ok, type Result } from '@unified-mpc/domain';
import {
  type CanonicalExtensionMigrationManifest,
  type CanonicalExtensionMigrationManifestEntry,
  type CanonicalExtensionMigrationSource,
} from './canonical-extension-migration-manifest.js';
import {
  fingerprintCanonicalSkillDirectory,
  type CanonicalSkillMigrationSkippedEntry,
  type CanonicalSkillMigrationStagedSkill,
  type CanonicalSkillMigrationStageResult,
} from './canonical-skill-migration-stager.js';
import { SkillCatalog } from './skill-catalog.js';
import { DEFAULT_EXTENSIONS_SETTINGS, type SkillSummary } from './types.js';

export interface CanonicalSkillMigrationDryRunResolvedSkill {
  readonly canonicalId: string;
  readonly catalogSkillId: string;
  readonly name: string;
  readonly fingerprint: string;
  readonly relativePath: string;
}

export interface CanonicalSkillMigrationDryRunResult {
  readonly schemaVersion: 1;
  readonly generationId: string;
  readonly exactParity: true;
  readonly resolved: readonly CanonicalSkillMigrationDryRunResolvedSkill[];
  readonly skipped: readonly CanonicalSkillMigrationSkippedEntry[];
}

interface ExpectedSkill {
  readonly id: string;
  readonly name: string;
  readonly fingerprint: string;
  readonly sourcePath: string;
}

const DRY_RUN_SCHEMA_VERSION = 1 as const;
const MANAGED_SKILL_SOURCE = 'unified-mpc-skills';

export class CanonicalSkillMigrationDryRunVerifier {
  public async verify(
    manifest: CanonicalExtensionMigrationManifest,
    staged: CanonicalSkillMigrationStageResult,
  ): Promise<Result<CanonicalSkillMigrationDryRunResult>> {
    if (!manifest.cutover.allowed) {
      return err(appError(
        'INVALID_INPUT',
        `Canonical migration manifest still has cutover blockers: ${manifest.cutover.reasons.join(', ')}`,
      ));
    }

    const expectedGenerationId = createHash('sha256')
      .update(JSON.stringify(manifest))
      .digest('hex');
    if (
      staged.generationId !== expectedGenerationId
      || path.basename(path.resolve(staged.generationPath)) !== staged.generationId
    ) {
      return err(appError(
        'INVALID_INPUT',
        'Canonical dry-run staged generation is not bound to the supplied migration manifest',
      ));
    }

    const expected = expectedSkills(manifest);
    if (!expected.ok) return err(expected.error);

    const metadata = verifyStageMetadata(expected.value, staged.stagedSkills);
    if (!metadata.ok) return err(metadata.error);

    const managedRoot = path.join(staged.generationPath, 'skills');
    const catalog = new SkillCatalog({
      settings: DEFAULT_EXTENSIONS_SETTINGS,
      homeDir: path.join(staged.generationPath, '.dry-run-home'),
      managedRoot,
    });
    const listed = await catalog.list({ source: MANAGED_SKILL_SOURCE });
    if (!listed.ok) return err(listed.error);

    const catalogSkills = [...listed.value.skills].sort(compareCatalogSkills);
    if (catalogSkills.length !== staged.stagedSkills.length) {
      return err(appError(
        'INVALID_INPUT',
        `Canonical dry-run catalog parity mismatch: expected ${staged.stagedSkills.length} staged skills but discovered ${catalogSkills.length}`,
      ));
    }

    const resolved: CanonicalSkillMigrationDryRunResolvedSkill[] = [];
    for (const expectedSkill of expected.value) {
      const stagedSkill = staged.stagedSkills.find((skill) => skill.id === expectedSkill.id);
      if (stagedSkill === undefined) {
        return err(appError(
          'INVALID_INPUT',
          `Canonical dry-run stage metadata mismatch: missing ${expectedSkill.id}`,
        ));
      }

      const stagedDirectory = resolveStagedDirectory(staged.generationPath, stagedSkill);
      if (!stagedDirectory.ok) return err(stagedDirectory.error);

      let expectedSkillFile: string;
      try {
        expectedSkillFile = await realpath(path.join(stagedDirectory.value, 'SKILL.md'));
      } catch {
        return err(appError(
          'INVALID_INPUT',
          `Canonical dry-run catalog parity mismatch: staged SKILL.md is missing for ${expectedSkill.id}`,
        ));
      }

      const matches = catalogSkills.filter((skill) => skill.canonicalSkillPath === expectedSkillFile);
      if (matches.length !== 1) {
        return err(appError(
          'INVALID_INPUT',
          `Canonical dry-run catalog parity mismatch: ${expectedSkill.id} resolved to ${matches.length} catalog entries`,
        ));
      }
      const catalogSkill = matches[0]!;
      if (catalogSkill.name !== expectedSkill.name) {
        return err(appError(
          'INVALID_INPUT',
          `Canonical dry-run catalog name mismatch for ${expectedSkill.id}: expected ${expectedSkill.name}, got ${catalogSkill.name}`,
        ));
      }

      const content = await catalog.read({ skillId: catalogSkill.id });
      if (!content.ok) {
        return err(appError(
          'INVALID_INPUT',
          `Canonical dry-run failed to read ${expectedSkill.id} through SkillCatalog: ${content.error.message}`,
        ));
      }
      if (content.value.name !== expectedSkill.name) {
        return err(appError(
          'INVALID_INPUT',
          `Canonical dry-run readback name mismatch for ${expectedSkill.id}`,
        ));
      }

      const fingerprint = await fingerprintCanonicalSkillDirectory(stagedDirectory.value);
      if (!fingerprint.ok) return err(fingerprint.error);
      if (fingerprint.value !== expectedSkill.fingerprint) {
        return err(appError(
          'INVALID_INPUT',
          `Canonical dry-run staged fingerprint mismatch for ${expectedSkill.id}`,
        ));
      }

      resolved.push({
        canonicalId: expectedSkill.id,
        catalogSkillId: catalogSkill.id,
        name: expectedSkill.name,
        fingerprint: expectedSkill.fingerprint,
        relativePath: stagedSkill.relativePath,
      });
    }

    const matchedCatalogIds = new Set(resolved.map((entry) => entry.catalogSkillId));
    if (matchedCatalogIds.size !== catalogSkills.length) {
      return err(appError(
        'INVALID_INPUT',
        'Canonical dry-run catalog parity mismatch: unexpected staged capabilities are discoverable',
      ));
    }

    return ok({
      schemaVersion: DRY_RUN_SCHEMA_VERSION,
      generationId: staged.generationId,
      exactParity: true,
      resolved: resolved.sort((left, right) => left.canonicalId.localeCompare(right.canonicalId)),
      skipped: staged.skipped,
    });
  }
}

function expectedSkills(
  manifest: CanonicalExtensionMigrationManifest,
): Result<readonly ExpectedSkill[]> {
  const expected: ExpectedSkill[] = [];
  for (const entry of manifest.entries) {
    if (!isActiveCompatibleSkill(entry)) continue;
    if (
      (entry.classification !== 'unique' && entry.classification !== 'identical')
      || entry.selectedFingerprint === undefined
    ) {
      return err(appError(
        'INVALID_INPUT',
        `Canonical dry-run cannot resolve unsafe migration entry: ${entry.id}`,
      ));
    }
    const source = selectedSource(entry);
    if (source?.sourcePath === undefined) {
      return err(appError(
        'INVALID_INPUT',
        `Canonical dry-run source path is missing for ${entry.id}`,
      ));
    }
    expected.push({
      id: entry.id,
      name: entry.name,
      fingerprint: entry.selectedFingerprint,
      sourcePath: source.sourcePath,
    });
  }
  return ok(expected.sort((left, right) => left.id.localeCompare(right.id)));
}

function isActiveCompatibleSkill(entry: CanonicalExtensionMigrationManifestEntry): boolean {
  return entry.kind === 'skill'
    && entry.enabledStates.length === 1
    && entry.enabledStates[0] === true
    && entry.compatibilityState === 'compatible';
}

function selectedSource(
  entry: CanonicalExtensionMigrationManifestEntry,
): CanonicalExtensionMigrationSource | undefined {
  return entry.sources.find((source) => (
    source.enabled
    && source.compatibilityState === 'compatible'
    && source.fingerprint === entry.selectedFingerprint
    && source.sourcePath !== undefined
    && source.sourcePath.trim().length > 0
  ));
}

function verifyStageMetadata(
  expected: readonly ExpectedSkill[],
  staged: readonly CanonicalSkillMigrationStagedSkill[],
): Result<undefined> {
  if (expected.length !== staged.length) {
    return err(appError(
      'INVALID_INPUT',
      `Canonical dry-run stage metadata mismatch: expected ${expected.length} active skills but stage reports ${staged.length}`,
    ));
  }

  const stagedById = new Map<string, CanonicalSkillMigrationStagedSkill>();
  for (const skill of staged) {
    if (stagedById.has(skill.id)) {
      return err(appError(
        'INVALID_INPUT',
        `Canonical dry-run stage metadata mismatch: duplicate canonical id ${skill.id}`,
      ));
    }
    stagedById.set(skill.id, skill);
  }

  for (const skill of expected) {
    const actual = stagedById.get(skill.id);
    if (
      actual === undefined
      || actual.name !== skill.name
      || actual.fingerprint !== skill.fingerprint
      || path.resolve(actual.sourcePath) !== path.resolve(skill.sourcePath)
    ) {
      return err(appError(
        'INVALID_INPUT',
        `Canonical dry-run stage metadata mismatch for ${skill.id}`,
      ));
    }
  }
  return ok(undefined);
}

function resolveStagedDirectory(
  generationPath: string,
  staged: CanonicalSkillMigrationStagedSkill,
): Result<string> {
  const generationRoot = path.resolve(generationPath);
  const resolved = path.resolve(generationRoot, staged.relativePath);
  const relative = path.relative(generationRoot, resolved);
  if (
    relative === ''
    || path.isAbsolute(relative)
    || relative.split(path.sep)[0] === '..'
    || relative.split(path.sep)[0] !== 'skills'
  ) {
    return err(appError(
      'INVALID_INPUT',
      `Canonical dry-run staged path escapes the inactive skills root: ${staged.id}`,
    ));
  }
  return ok(resolved);
}

function compareCatalogSkills(left: SkillSummary, right: SkillSummary): number {
  return [
    left.canonicalSkillPath ?? left.skillPath,
    left.id,
    left.name,
  ].join('\u0000').localeCompare([
    right.canonicalSkillPath ?? right.skillPath,
    right.id,
    right.name,
  ].join('\u0000'));
}
