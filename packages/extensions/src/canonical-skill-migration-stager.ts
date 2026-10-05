import { createHash } from 'node:crypto';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { appError, err, ok, type Result } from '@unified-mpc/domain';
import {
  type CanonicalExtensionMigrationManifest,
  type CanonicalExtensionMigrationManifestEntry,
  type CanonicalExtensionMigrationSource,
} from './canonical-extension-migration-manifest.js';
import { parseSkillMarkdown } from './skill-catalog.js';

export type CanonicalSkillMigrationSkipReason =
  | 'disabled'
  | 'incompatible'
  | 'not_skill';

export interface CanonicalSkillMigrationSkippedEntry {
  readonly id: string;
  readonly reason: CanonicalSkillMigrationSkipReason;
}

export interface CanonicalSkillMigrationStagedSkill {
  readonly id: string;
  readonly name: string;
  readonly fingerprint: string;
  readonly sourcePath: string;
  readonly relativePath: string;
}

export interface CanonicalSkillMigrationStageResult {
  readonly schemaVersion: 1;
  readonly generationId: string;
  readonly generationPath: string;
  readonly reused: boolean;
  readonly stagedSkills: readonly CanonicalSkillMigrationStagedSkill[];
  readonly skipped: readonly CanonicalSkillMigrationSkippedEntry[];
}

export interface CanonicalSkillMigrationStagerOptions {
  readonly dataDir: string;
}

interface PlannedSkill {
  readonly entry: CanonicalExtensionMigrationManifestEntry;
  readonly source: CanonicalExtensionMigrationSource & { readonly sourcePath: string };
  readonly staged: CanonicalSkillMigrationStagedSkill;
}

interface MigrationStageSnapshot {
  readonly schemaVersion: 1;
  readonly generationId: string;
  readonly manifestSha256: string;
  readonly stagedSkills: readonly CanonicalSkillMigrationStagedSkill[];
  readonly skipped: readonly CanonicalSkillMigrationSkippedEntry[];
}

interface ValidatedPlannedSkill {
  readonly planned: PlannedSkill;
  readonly resolvedSourcePath: string;
}

const STAGE_SCHEMA_VERSION = 1 as const;

export class CanonicalSkillMigrationStager {
  private readonly dataDir: string;

  public constructor(options: CanonicalSkillMigrationStagerOptions) {
    this.dataDir = path.resolve(options.dataDir);
  }

  public async stage(
    manifest: CanonicalExtensionMigrationManifest,
  ): Promise<Result<CanonicalSkillMigrationStageResult>> {
    const plan = buildStagePlan(manifest);
    if (!plan.ok) return err(plan.error);

    const manifestJson = JSON.stringify(manifest, null, 2) + '\n';
    const generationId = sha256(JSON.stringify(manifest));
    const generationRoot = path.join(
      this.dataDir,
      'extensions',
      'state',
      'migration',
      'staged-generations',
    );
    const generationPath = path.join(generationRoot, generationId);
    const snapshot: MigrationStageSnapshot = {
      schemaVersion: STAGE_SCHEMA_VERSION,
      generationId,
      manifestSha256: generationId,
      stagedSkills: plan.value.skills.map((skill) => skill.staged),
      skipped: plan.value.skipped,
    };

    let generationExists: boolean;
    try {
      generationExists = await isDirectory(generationPath);
    } catch (error: unknown) {
      return err(appError(
        'INTERNAL_ERROR',
        `Failed to inspect canonical skill migration staging root: ${error instanceof Error ? error.message : String(error)}`,
        true,
      ));
    }
    if (generationExists) {
      const verified = await verifyExistingGeneration(generationPath, manifestJson, snapshot);
      if (!verified.ok) return err(verified.error);
      return ok(stageResult(generationPath, snapshot, true));
    }

    const validated: ValidatedPlannedSkill[] = [];
    for (const planned of plan.value.skills) {
      const source = await validateSource(planned);
      if (!source.ok) return err(source.error);
      validated.push(source.value);
    }

    let temporaryPath: string;
    try {
      await mkdir(generationRoot, { recursive: true });
      temporaryPath = await mkdtemp(path.join(generationRoot, '.tmp-'));
    } catch (error: unknown) {
      return err(appError(
        'INTERNAL_ERROR',
        `Failed to create canonical skill migration staging directory: ${error instanceof Error ? error.message : String(error)}`,
        true,
      ));
    }

    try {
      for (const item of validated) {
        const targetPath = path.join(temporaryPath, item.planned.staged.relativePath);
        await mkdir(path.dirname(targetPath), { recursive: true });
        const rootGitPath = path.join(item.resolvedSourcePath, '.git');
        await cp(item.resolvedSourcePath, targetPath, {
          recursive: true,
          filter: (sourcePath) => path.resolve(sourcePath) !== rootGitPath,
        });

        const copiedFingerprint = await fingerprintCanonicalSkillDirectory(targetPath);
        if (!copiedFingerprint.ok) return err(copiedFingerprint.error);
        if (copiedFingerprint.value !== item.planned.staged.fingerprint) {
          return err(appError(
            'INVALID_INPUT',
            `Staged canonical skill fingerprint changed during copy: ${item.planned.entry.id}`,
          ));
        }

        const stagedSkill = await validateSkillMarkdown(
          targetPath,
          item.planned.entry.name,
          item.planned.entry.id,
        );
        if (!stagedSkill.ok) return err(stagedSkill.error);
      }

      await writeFile(path.join(temporaryPath, 'manifest.json'), manifestJson, 'utf8');
      await writeFile(
        path.join(temporaryPath, 'stage.json'),
        JSON.stringify(snapshot, null, 2) + '\n',
        'utf8',
      );

      try {
        await rename(temporaryPath, generationPath);
      } catch (error: unknown) {
        if (!isExistingTargetError(error) || !await isDirectory(generationPath)) throw error;
        await rm(temporaryPath, { recursive: true, force: true });
        const verified = await verifyExistingGeneration(generationPath, manifestJson, snapshot);
        if (!verified.ok) return err(verified.error);
        return ok(stageResult(generationPath, snapshot, true));
      }

      return ok(stageResult(generationPath, snapshot, false));
    } catch (error: unknown) {
      return err(appError(
        'INTERNAL_ERROR',
        `Failed to stage canonical skill migration generation: ${error instanceof Error ? error.message : String(error)}`,
        true,
      ));
    } finally {
      await rm(temporaryPath, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export async function fingerprintCanonicalSkillDirectory(
  sourcePath: string,
): Promise<Result<string>> {
  const root = path.resolve(sourcePath);
  try {
    const info = await stat(root);
    if (!info.isDirectory()) {
      return err(appError('INVALID_INPUT', `Canonical skill source must be a directory: ${sourcePath}`));
    }
    const hash = createHash('sha256');
    await hashSkillTree(root, root, hash);
    return ok(hash.digest('hex'));
  } catch (error: unknown) {
    if (error instanceof UnsupportedSkillTreeEntryError) {
      return err(appError('INVALID_INPUT', error.message));
    }
    if (isMissingPath(error)) {
      return err(appError('FILE_NOT_FOUND', `Canonical skill source was not found: ${sourcePath}`));
    }
    return err(appError(
      'INTERNAL_ERROR',
      `Failed to fingerprint canonical skill source: ${error instanceof Error ? error.message : String(error)}`,
      true,
    ));
  }
}

function buildStagePlan(
  manifest: CanonicalExtensionMigrationManifest,
): Result<{
  readonly skills: readonly PlannedSkill[];
  readonly skipped: readonly CanonicalSkillMigrationSkippedEntry[];
}> {
  if (!manifest.cutover.allowed) {
    return err(appError(
      'INVALID_INPUT',
      `Canonical migration manifest still has cutover blockers: ${manifest.cutover.reasons.join(', ')}`,
    ));
  }

  const skills: PlannedSkill[] = [];
  const skipped: CanonicalSkillMigrationSkippedEntry[] = [];
  for (const entry of manifest.entries) {
    if (entry.kind !== 'skill') {
      skipped.push({ id: entry.id, reason: 'not_skill' });
      continue;
    }
    if (entry.enabledStates.length !== 1 || entry.enabledStates[0] !== true) {
      skipped.push({ id: entry.id, reason: 'disabled' });
      continue;
    }
    if (entry.compatibilityState !== 'compatible') {
      skipped.push({ id: entry.id, reason: 'incompatible' });
      continue;
    }
    if (
      (entry.classification !== 'unique' && entry.classification !== 'identical')
      || entry.selectedFingerprint === undefined
    ) {
      return err(appError(
        'INVALID_INPUT',
        `Canonical skill is not safe to stage: ${entry.id}`,
      ));
    }

    const source = entry.sources.find((candidate) => (
      candidate.enabled
      && candidate.compatibilityState === 'compatible'
      && candidate.fingerprint === entry.selectedFingerprint
      && candidate.sourcePath !== undefined
      && candidate.sourcePath.trim().length > 0
    ));
    if (source?.sourcePath === undefined) {
      return err(appError(
        'INVALID_INPUT',
        `Canonical skill migration source path is missing: ${entry.id}`,
      ));
    }

    skills.push({
      entry,
      source: source as CanonicalExtensionMigrationSource & { readonly sourcePath: string },
      staged: {
        id: entry.id,
        name: entry.name,
        fingerprint: entry.selectedFingerprint,
        sourcePath: source.sourcePath,
        relativePath: path.posix.join('skills', sha256(entry.id)),
      },
    });
  }

  return ok({
    skills,
    skipped: skipped.sort((left, right) => left.id.localeCompare(right.id)),
  });
}

async function validateSource(planned: PlannedSkill): Promise<Result<ValidatedPlannedSkill>> {
  let resolvedSourcePath: string;
  try {
    resolvedSourcePath = await realpath(planned.source.sourcePath);
  } catch (error: unknown) {
    if (isMissingPath(error)) {
      return err(appError(
        'FILE_NOT_FOUND',
        `Canonical skill migration source was not found: ${planned.source.sourcePath}`,
      ));
    }
    return err(appError(
      'INTERNAL_ERROR',
      `Failed to resolve canonical skill migration source: ${error instanceof Error ? error.message : String(error)}`,
      true,
    ));
  }

  const fingerprint = await fingerprintCanonicalSkillDirectory(resolvedSourcePath);
  if (!fingerprint.ok) return err(fingerprint.error);
  if (fingerprint.value !== planned.entry.selectedFingerprint) {
    return err(appError(
      'INVALID_INPUT',
      `Canonical skill migration source fingerprint drifted after inventory: ${planned.entry.id}`,
    ));
  }

  const markdown = await validateSkillMarkdown(
    resolvedSourcePath,
    planned.entry.name,
    planned.entry.id,
  );
  if (!markdown.ok) return err(markdown.error);
  return ok({ planned, resolvedSourcePath });
}

async function validateSkillMarkdown(
  skillRoot: string,
  expectedName: string,
  id: string,
): Promise<Result<undefined>> {
  try {
    const skillFile = path.join(skillRoot, 'SKILL.md');
    if (!(await stat(skillFile)).isFile()) {
      return err(appError('INVALID_INPUT', `Staged canonical skill SKILL.md is not a file: ${id}`));
    }
    const parsed = parseSkillMarkdown(await readFile(skillFile, 'utf8'), expectedName);
    if (parsed.name !== expectedName) {
      return err(appError(
        'INVALID_INPUT',
        `Staged canonical skill name does not match migration manifest: ${id}`,
      ));
    }
    return ok(undefined);
  } catch (error: unknown) {
    if (isMissingPath(error)) {
      return err(appError('FILE_NOT_FOUND', `Staged canonical skill is missing SKILL.md: ${id}`));
    }
    return err(appError(
      'INVALID_INPUT',
      `Failed to validate staged canonical skill: ${id}: ${error instanceof Error ? error.message : String(error)}`,
    ));
  }
}

async function verifyExistingGeneration(
  generationPath: string,
  manifestJson: string,
  expected: MigrationStageSnapshot,
): Promise<Result<undefined>> {
  try {
    if (await readFile(path.join(generationPath, 'manifest.json'), 'utf8') !== manifestJson) {
      return err(appError(
        'INVALID_INPUT',
        `Existing canonical skill migration generation manifest is corrupt: ${generationPath}`,
      ));
    }
    const stageContent = await readFile(path.join(generationPath, 'stage.json'), 'utf8');
    const parsed: unknown = JSON.parse(stageContent);
    if (JSON.stringify(parsed) !== JSON.stringify(expected)) {
      return err(appError(
        'INVALID_INPUT',
        `Existing canonical skill migration generation metadata is corrupt: ${generationPath}`,
      ));
    }

    for (const skill of expected.stagedSkills) {
      const skillPath = path.resolve(generationPath, skill.relativePath);
      if (!isPathInside(generationPath, skillPath)) {
        return err(appError('INVALID_INPUT', `Staged canonical skill path escapes generation root: ${skill.id}`));
      }
      const fingerprint = await fingerprintCanonicalSkillDirectory(skillPath);
      if (!fingerprint.ok) return err(fingerprint.error);
      if (fingerprint.value !== skill.fingerprint) {
        return err(appError(
          'INVALID_INPUT',
          `Existing staged canonical skill fingerprint is corrupt: ${skill.id}`,
        ));
      }
      const markdown = await validateSkillMarkdown(skillPath, skill.name, skill.id);
      if (!markdown.ok) return err(markdown.error);
    }
    return ok(undefined);
  } catch (error: unknown) {
    if (isMissingPath(error) || error instanceof SyntaxError) {
      return err(appError(
        'INVALID_INPUT',
        `Existing canonical skill migration generation is incomplete or corrupt: ${generationPath}`,
      ));
    }
    return err(appError(
      'INTERNAL_ERROR',
      `Failed to verify canonical skill migration generation: ${error instanceof Error ? error.message : String(error)}`,
      true,
    ));
  }
}

function stageResult(
  generationPath: string,
  snapshot: MigrationStageSnapshot,
  reused: boolean,
): CanonicalSkillMigrationStageResult {
  return {
    schemaVersion: STAGE_SCHEMA_VERSION,
    generationId: snapshot.generationId,
    generationPath,
    reused,
    stagedSkills: snapshot.stagedSkills,
    skipped: snapshot.skipped,
  };
}

async function hashSkillTree(
  root: string,
  directory: string,
  hash: ReturnType<typeof createHash>,
): Promise<void> {
  const relativeDirectory = path.relative(root, directory).split(path.sep).join('/');
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => !(relativeDirectory.length === 0 && entry.name === '.git'))
    .sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    const relativePath = relativeDirectory.length === 0
      ? entry.name
      : `${relativeDirectory}/${entry.name}`;

    if (entry.isSymbolicLink()) {
      throw new UnsupportedSkillTreeEntryError(
        `Canonical skill migration does not stage symbolic links: ${relativePath}`,
      );
    }
    if (entry.isDirectory()) {
      hash.update(`dir\0${relativePath}\0`);
      await hashSkillTree(root, absolutePath, hash);
      continue;
    }
    if (entry.isFile()) {
      hash.update(`file\0${relativePath}\0`);
      hash.update(await readFile(absolutePath));
      hash.update('\0');
      continue;
    }
    throw new UnsupportedSkillTreeEntryError(
      `Canonical skill migration found unsupported filesystem entry: ${relativePath}`,
    );
  }
}

class UnsupportedSkillTreeEntryError extends Error {}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!path.isAbsolute(relative) && relative.split(path.sep)[0] !== '..');
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch (error: unknown) {
    if (isMissingPath(error)) return false;
    throw error;
  }
}

function isMissingPath(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { readonly code?: unknown }).code === 'ENOENT';
}

function isExistingTargetError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const code = (error as { readonly code?: unknown }).code;
  return code === 'EEXIST' || code === 'ENOTEMPTY';
}
