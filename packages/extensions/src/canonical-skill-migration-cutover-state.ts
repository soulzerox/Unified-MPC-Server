import { createHash } from 'node:crypto';
import { readFile, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { appError, err, ok, type Result } from '@unified-mpc/domain';
import type { CanonicalExtensionMigrationManifest } from './canonical-extension-migration-manifest.js';
import {
  CanonicalExtensionRegistry,
  type CanonicalExtensionEntry,
} from './canonical-extension-registry.js';
import { CanonicalSkillMigrationDryRunVerifier } from './canonical-skill-migration-dry-run.js';
import {
  type CanonicalSkillMigrationSkippedEntry,
  type CanonicalSkillMigrationStagedSkill,
  type CanonicalSkillMigrationStageResult,
} from './canonical-skill-migration-stager.js';
import { writeAtomic } from './ide-sync.js';

export interface CanonicalSkillMigrationCutoverState {
  readonly schemaVersion: 1;
  readonly activeGenerationId: string;
  readonly previousGenerationId?: string;
}

export interface CanonicalSkillMigrationCutoverActivation {
  readonly changed: boolean;
  readonly state: CanonicalSkillMigrationCutoverState;
}

export type CanonicalSkillMigrationCutoverRollback =
  | {
    readonly target: 'canonical';
    readonly fromGenerationId: string;
    readonly toGenerationId: string;
    readonly state: CanonicalSkillMigrationCutoverState;
  }
  | {
    readonly target: 'legacy';
    readonly fromGenerationId: string;
  };

export interface CanonicalSkillMigrationActiveGeneration {
  readonly state: CanonicalSkillMigrationCutoverState;
  readonly generationPath: string;
  readonly managedRoot: string;
  readonly stagedSkills: readonly CanonicalSkillMigrationStagedSkill[];
  readonly skipped: readonly CanonicalSkillMigrationSkippedEntry[];
}

export type CanonicalSkillMigrationRollbackTarget =
  | {
    readonly target: 'legacy';
    readonly fromGenerationId: string;
  }
  | {
    readonly target: 'canonical';
    readonly fromGenerationId: string;
    readonly toGenerationId: string;
    readonly generation: CanonicalSkillMigrationActiveGeneration;
  };

export interface CanonicalSkillMigrationCutoverStateStoreOptions {
  readonly dataDir: string;
}

interface VerifiedCanonicalSkillMigrationGeneration {
  readonly generation: CanonicalSkillMigrationActiveGeneration;
  readonly manifest: CanonicalExtensionMigrationManifest;
}

const CUTOVER_STATE_SCHEMA_VERSION = 1 as const;
const GENERATION_ID_PATTERN = /^[a-f0-9]{64}$/;
const CUTOVER_STATE_FILENAME = 'cutover-state.json';

export class CanonicalSkillMigrationCutoverStateStore {
  private readonly dataDir: string;
  private readonly statePath: string;
  private readonly generationsRoot: string;
  private readonly installedRegistry: CanonicalExtensionRegistry;
  private readonly verifier = new CanonicalSkillMigrationDryRunVerifier();

  public constructor(options: CanonicalSkillMigrationCutoverStateStoreOptions) {
    this.dataDir = path.resolve(options.dataDir);
    const migrationRoot = path.join(this.dataDir, 'extensions', 'state', 'migration');
    this.statePath = path.join(migrationRoot, CUTOVER_STATE_FILENAME);
    this.generationsRoot = path.join(migrationRoot, 'staged-generations');
    this.installedRegistry = new CanonicalExtensionRegistry({ dataDir: this.dataDir });
  }

  public async load(): Promise<Result<CanonicalSkillMigrationCutoverState | undefined>> {
    return loadCutoverState(this.statePath);
  }

  public async resolveActiveGeneration(): Promise<Result<CanonicalSkillMigrationActiveGeneration | undefined>> {
    const state = await this.load();
    if (!state.ok) return err(state.error);
    if (state.value === undefined) return ok(undefined);

    const verified = await verifyPersistedGeneration(
      this.generationsRoot,
      state.value,
    );
    if (!verified.ok) return err(verified.error);
    return ok(verified.value.generation);
  }

  public async resolveRollbackTarget(): Promise<Result<CanonicalSkillMigrationRollbackTarget | undefined>> {
    const current = await this.load();
    if (!current.ok) return err(current.error);
    if (current.value === undefined) return ok(undefined);

    const previousGenerationId = current.value.previousGenerationId;
    if (previousGenerationId === undefined) {
      return ok({
        target: 'legacy',
        fromGenerationId: current.value.activeGenerationId,
      });
    }

    const rollbackState: CanonicalSkillMigrationCutoverState = {
      schemaVersion: CUTOVER_STATE_SCHEMA_VERSION,
      activeGenerationId: previousGenerationId,
      previousGenerationId: current.value.activeGenerationId,
    };
    const generation = await verifyPersistedGeneration(this.generationsRoot, rollbackState);
    if (!generation.ok) return err(generation.error);

    return ok({
      target: 'canonical',
      fromGenerationId: current.value.activeGenerationId,
      toGenerationId: previousGenerationId,
      generation: generation.value.generation,
    });
  }

  public async rollback(
    expectedActiveGenerationId: string,
  ): Promise<Result<CanonicalSkillMigrationCutoverRollback>> {
    if (!isGenerationId(expectedActiveGenerationId)) {
      return err(appError('INVALID_INPUT', 'Canonical Skill rollback requires a valid expected active generation id'));
    }

    const current = await loadCutoverState(this.statePath);
    if (!current.ok) return err(current.error);
    if (current.value === undefined) {
      return err(appError('CONFLICT', 'Canonical Skill rollback requires an active generation'));
    }
    if (current.value.activeGenerationId !== expectedActiveGenerationId) {
      return err(appError(
        'CONFLICT',
        'Canonical Skill active generation changed before rollback could be applied',
        true,
      ));
    }

    const previousGenerationId = current.value.previousGenerationId;
    let replacementEntries: readonly CanonicalExtensionEntry[] = [];
    if (previousGenerationId !== undefined) {
      const rollbackState: CanonicalSkillMigrationCutoverState = {
        schemaVersion: CUTOVER_STATE_SCHEMA_VERSION,
        activeGenerationId: previousGenerationId,
        previousGenerationId: current.value.activeGenerationId,
      };
      const verified = await verifyPersistedGeneration(this.generationsRoot, rollbackState);
      if (!verified.ok) return err(verified.error);
      const entries = canonicalEntriesForInstalledState(verified.value);
      if (!entries.ok) return err(entries.error);
      replacementEntries = entries.value;
    }

    const replaced = await this.installedRegistry.replaceKindAtomically(
      'skill',
      replacementEntries,
      [this.statePath],
      async () => {
        const lockedCurrent = await loadCutoverState(this.statePath);
        if (!lockedCurrent.ok) return err(lockedCurrent.error);
        if (lockedCurrent.value === undefined) {
          return err(appError('CONFLICT', 'Canonical Skill rollback requires an active generation'));
        }
        if (lockedCurrent.value.activeGenerationId !== expectedActiveGenerationId) {
          return err(appError(
            'CONFLICT',
            'Canonical Skill active generation changed before rollback could be applied',
            true,
          ));
        }
        if (lockedCurrent.value.previousGenerationId !== previousGenerationId) {
          return err(appError(
            'CONFLICT',
            'Canonical Skill rollback target changed before rollback could be applied',
            true,
          ));
        }

        if (previousGenerationId === undefined) {
          await unlink(this.statePath);
          return ok<CanonicalSkillMigrationCutoverRollback>({
            target: 'legacy',
            fromGenerationId: lockedCurrent.value.activeGenerationId,
          });
        }

        const nextState: CanonicalSkillMigrationCutoverState = {
          schemaVersion: CUTOVER_STATE_SCHEMA_VERSION,
          activeGenerationId: previousGenerationId,
          previousGenerationId: lockedCurrent.value.activeGenerationId,
        };
        const lockedVerified = await verifyPersistedGeneration(this.generationsRoot, nextState);
        if (!lockedVerified.ok) return err(lockedVerified.error);
        const lockedEntries = canonicalEntriesForInstalledState(lockedVerified.value);
        if (!lockedEntries.ok) return err(lockedEntries.error);
        if (JSON.stringify(lockedEntries.value) !== JSON.stringify(replacementEntries)) {
          return err(appError(
            'CONFLICT',
            'Canonical Skill rollback target metadata changed before rollback could be applied',
            true,
          ));
        }

        await writeAtomic(this.statePath, JSON.stringify(nextState, null, 2) + '\n');
        return ok<CanonicalSkillMigrationCutoverRollback>({
          target: 'canonical',
          fromGenerationId: lockedCurrent.value.activeGenerationId,
          toGenerationId: previousGenerationId,
          state: nextState,
        });
      },
    );
    if (!replaced.ok) return err(replaced.error);
    return ok(replaced.value.operationValue);
  }

  public async activate(
    manifest: CanonicalExtensionMigrationManifest,
    staged: CanonicalSkillMigrationStageResult,
  ): Promise<Result<CanonicalSkillMigrationCutoverActivation>> {
    const generationPath = validateCanonicalGenerationPath(
      this.generationsRoot,
      staged.generationId,
      staged.generationPath,
    );
    if (!generationPath.ok) return err(generationPath.error);

    const proof = await this.verifier.verify(manifest, staged);
    if (!proof.ok) return err(proof.error);
    if (proof.value.generationId !== staged.generationId || !proof.value.exactParity) {
      return err(appError(
        'INVALID_INPUT',
        'Canonical Skill cutover requires an exact dry-run proof for the staged generation',
      ));
    }

    const replacementEntries = canonicalEntriesFromManifest(manifest, staged.stagedSkills);
    if (!replacementEntries.ok) return err(replacementEntries.error);

    const replaced = await this.installedRegistry.replaceKindAtomically(
      'skill',
      replacementEntries.value,
      [this.statePath],
      async () => {
        const current = await loadCutoverState(this.statePath);
        if (!current.ok) return err(current.error);

        if (current.value?.activeGenerationId === staged.generationId) {
          return ok<CanonicalSkillMigrationCutoverActivation>({
            changed: false,
            state: current.value,
          });
        }

        const nextState: CanonicalSkillMigrationCutoverState = {
          schemaVersion: CUTOVER_STATE_SCHEMA_VERSION,
          activeGenerationId: staged.generationId,
          ...(current.value === undefined
            ? {}
            : { previousGenerationId: current.value.activeGenerationId }),
        };
        await writeAtomic(this.statePath, JSON.stringify(nextState, null, 2) + '\n');
        return ok<CanonicalSkillMigrationCutoverActivation>({
          changed: true,
          state: nextState,
        });
      },
    );
    if (!replaced.ok) return err(replaced.error);
    return ok(replaced.value.operationValue);
  }
}

interface PersistedStageSnapshot {
  readonly schemaVersion: 1;
  readonly generationId: string;
  readonly manifestSha256: string;
  readonly stagedSkills: readonly CanonicalSkillMigrationStagedSkill[];
  readonly skipped: readonly CanonicalSkillMigrationSkippedEntry[];
}

function canonicalEntriesForInstalledState(
  generation: VerifiedCanonicalSkillMigrationGeneration,
): Result<readonly CanonicalExtensionEntry[]> {
  return canonicalEntriesFromManifest(generation.manifest, generation.generation.stagedSkills);
}

function canonicalEntriesFromManifest(
  manifest: CanonicalExtensionMigrationManifest,
  stagedSkills: readonly CanonicalSkillMigrationStagedSkill[],
): Result<readonly CanonicalExtensionEntry[]> {
  const activeManifestEntries = manifest.entries.filter((entry) => (
    entry.kind === 'skill'
    && entry.enabledStates.length === 1
    && entry.enabledStates[0] === true
    && entry.compatibilityState === 'compatible'
    && (entry.classification === 'unique' || entry.classification === 'identical')
    && entry.selectedFingerprint !== undefined
  ));
  if (activeManifestEntries.length !== stagedSkills.length) {
    return err(appError(
      'INVALID_INPUT',
      'Canonical Skill staged generation does not match installed-state manifest entries',
    ));
  }

  const entries: CanonicalExtensionEntry[] = [];
  for (const staged of stagedSkills) {
    const entry = activeManifestEntries.find((candidate) => candidate.id === staged.id);
    if (
      entry === undefined
      || entry.selectedFingerprint !== staged.fingerprint
      || entry.name !== staged.name
    ) {
      return err(appError(
        'INVALID_INPUT',
        `Canonical Skill installed-state metadata does not match staged entry: ${staged.id}`,
      ));
    }

    const source = entry.sources.find((candidate) => (
      candidate.enabled
      && candidate.compatibilityState === 'compatible'
      && candidate.fingerprint === staged.fingerprint
      && candidate.sourcePath === staged.sourcePath
    ));
    if (source === undefined) {
      return err(appError(
        'INVALID_INPUT',
        `Canonical Skill installed-state source metadata is missing: ${staged.id}`,
      ));
    }

    entries.push({
      kind: 'skill',
      id: entry.id,
      name: entry.name,
      fingerprint: staged.fingerprint,
      enabled: true,
      ...(source.compatibility === undefined ? {} : { compatibility: source.compatibility }),
      compatibilityState: 'compatible',
      conflict: false,
      variantFingerprints: entry.variantFingerprints,
      provenance: entry.provenance,
    });
  }

  return ok(entries.sort((left, right) => left.id.localeCompare(right.id)));
}

async function verifyPersistedGeneration(
  generationsRoot: string,
  state: CanonicalSkillMigrationCutoverState,
): Promise<Result<VerifiedCanonicalSkillMigrationGeneration>> {
  const generationPath = path.resolve(generationsRoot, state.activeGenerationId);
  try {
    const generationInfo = await stat(generationPath);
    if (!generationInfo.isDirectory()) {
      return err(appError(
        'INVALID_INPUT',
        'Persisted canonical Skill cutover state points to a non-directory generation',
      ));
    }

    const manifestContent = await readFile(path.join(generationPath, 'manifest.json'), 'utf8');
    const manifestValue: unknown = JSON.parse(manifestContent);
    const manifestSha256 = createHash('sha256')
      .update(JSON.stringify(manifestValue))
      .digest('hex');
    if (manifestSha256 !== state.activeGenerationId) {
      return err(appError(
        'INVALID_INPUT',
        'Persisted canonical Skill generation manifest hash does not match the active generation id',
      ));
    }

    const stageContent = await readFile(path.join(generationPath, 'stage.json'), 'utf8');
    const stageValue: unknown = JSON.parse(stageContent);
    const snapshot = decodeStageSnapshot(stageValue);
    if (!snapshot.ok) return err(snapshot.error);
    if (
      snapshot.value.generationId !== state.activeGenerationId
      || snapshot.value.manifestSha256 !== state.activeGenerationId
    ) {
      return err(appError(
        'INVALID_INPUT',
        'Persisted canonical Skill stage metadata does not match the active generation id',
      ));
    }

    const staged: CanonicalSkillMigrationStageResult = {
      schemaVersion: 1,
      generationId: snapshot.value.generationId,
      generationPath,
      reused: true,
      stagedSkills: snapshot.value.stagedSkills,
      skipped: snapshot.value.skipped,
    };

    let proof;
    try {
      proof = await new CanonicalSkillMigrationDryRunVerifier().verify(
        manifestValue as CanonicalExtensionMigrationManifest,
        staged,
      );
    } catch {
      return err(appError(
        'INVALID_INPUT',
        'Persisted canonical Skill generation manifest is structurally invalid',
      ));
    }
    if (!proof.ok) return err(proof.error);

    return ok({
      generation: {
        state,
        generationPath,
        managedRoot: path.join(generationPath, 'skills'),
        stagedSkills: staged.stagedSkills,
        skipped: staged.skipped,
      },
      manifest: manifestValue as CanonicalExtensionMigrationManifest,
    });
  } catch (error: unknown) {
    if (isMissingPath(error) || error instanceof SyntaxError) {
      return err(appError(
        'INVALID_INPUT',
        'Persisted canonical Skill active generation is missing or corrupt',
      ));
    }
    return err(appError(
      'INTERNAL_ERROR',
      `Failed to verify persisted canonical Skill active generation: ${error instanceof Error ? error.message : String(error)}`,
      true,
    ));
  }
}

function decodeStageSnapshot(value: unknown): Result<PersistedStageSnapshot> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return err(appError('INVALID_INPUT', 'Persisted canonical Skill stage metadata must be an object'));
  }
  const record = value as Record<string, unknown>;
  const allowedKeys = new Set([
    'schemaVersion',
    'generationId',
    'manifestSha256',
    'stagedSkills',
    'skipped',
  ]);
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
    return err(appError('INVALID_INPUT', 'Persisted canonical Skill stage metadata contains unknown fields'));
  }
  if (
    record.schemaVersion !== 1
    || !isGenerationId(record.generationId)
    || !isGenerationId(record.manifestSha256)
    || !Array.isArray(record.stagedSkills)
    || !Array.isArray(record.skipped)
  ) {
    return err(appError('INVALID_INPUT', 'Persisted canonical Skill stage metadata is invalid'));
  }

  const stagedSkills: CanonicalSkillMigrationStagedSkill[] = [];
  const ids = new Set<string>();
  const relativePaths = new Set<string>();
  for (const value of record.stagedSkills) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return err(appError('INVALID_INPUT', 'Persisted canonical Skill staged entry is invalid'));
    }
    const skill = value as Record<string, unknown>;
    const allowedSkillKeys = new Set(['id', 'name', 'fingerprint', 'sourcePath', 'relativePath']);
    if (
      Object.keys(skill).some((key) => !allowedSkillKeys.has(key))
      || typeof skill.id !== 'string'
      || skill.id.trim().length === 0
      || typeof skill.name !== 'string'
      || skill.name.trim().length === 0
      || !isGenerationId(skill.fingerprint)
      || typeof skill.sourcePath !== 'string'
      || skill.sourcePath.trim().length === 0
      || typeof skill.relativePath !== 'string'
      || skill.relativePath.trim().length === 0
      || ids.has(skill.id)
      || relativePaths.has(skill.relativePath)
    ) {
      return err(appError('INVALID_INPUT', 'Persisted canonical Skill staged entry is invalid'));
    }
    ids.add(skill.id);
    relativePaths.add(skill.relativePath);
    stagedSkills.push({
      id: skill.id,
      name: skill.name,
      fingerprint: skill.fingerprint,
      sourcePath: skill.sourcePath,
      relativePath: skill.relativePath,
    });
  }

  const skipped: CanonicalSkillMigrationSkippedEntry[] = [];
  for (const value of record.skipped) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return err(appError('INVALID_INPUT', 'Persisted canonical Skill skipped entry is invalid'));
    }
    const skippedEntry = value as Record<string, unknown>;
    if (
      typeof skippedEntry.id !== 'string'
      || skippedEntry.id.trim().length === 0
      || (
        skippedEntry.reason !== 'disabled'
        && skippedEntry.reason !== 'incompatible'
        && skippedEntry.reason !== 'not_skill'
      )
    ) {
      return err(appError('INVALID_INPUT', 'Persisted canonical Skill skipped entry is invalid'));
    }
    skipped.push({
      id: skippedEntry.id,
      reason: skippedEntry.reason,
    });
  }

  return ok({
    schemaVersion: 1,
    generationId: record.generationId,
    manifestSha256: record.manifestSha256,
    stagedSkills,
    skipped,
  });
}

async function loadCutoverState(
  statePath: string,
): Promise<Result<CanonicalSkillMigrationCutoverState | undefined>> {
  let content: string;
  try {
    content = await readFile(statePath, 'utf8');
  } catch (error: unknown) {
    if (isMissingPath(error)) return ok(undefined);
    return err(appError(
      'INTERNAL_ERROR',
      `Failed to read canonical Skill cutover state: ${error instanceof Error ? error.message : String(error)}`,
      true,
    ));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return err(appError('INVALID_INPUT', 'Persisted canonical Skill cutover state is invalid JSON'));
  }

  return decodeCutoverState(parsed);
}

function decodeCutoverState(
  value: unknown,
): Result<CanonicalSkillMigrationCutoverState> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return err(appError('INVALID_INPUT', 'Persisted canonical Skill cutover state must be an object'));
  }

  const record = value as Record<string, unknown>;
  const allowedKeys = new Set(['schemaVersion', 'activeGenerationId', 'previousGenerationId']);
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
    return err(appError('INVALID_INPUT', 'Persisted canonical Skill cutover state contains unknown fields'));
  }
  if (record.schemaVersion !== CUTOVER_STATE_SCHEMA_VERSION) {
    return err(appError('INVALID_INPUT', 'Persisted canonical Skill cutover state has an unsupported schema version'));
  }
  if (!isGenerationId(record.activeGenerationId)) {
    return err(appError('INVALID_INPUT', 'Persisted canonical Skill cutover state has an invalid active generation id'));
  }
  if (
    record.previousGenerationId !== undefined
    && !isGenerationId(record.previousGenerationId)
  ) {
    return err(appError('INVALID_INPUT', 'Persisted canonical Skill cutover state has an invalid previous generation id'));
  }
  if (record.previousGenerationId === record.activeGenerationId) {
    return err(appError('INVALID_INPUT', 'Persisted canonical Skill cutover state cannot point active and previous to the same generation'));
  }

  return ok({
    schemaVersion: CUTOVER_STATE_SCHEMA_VERSION,
    activeGenerationId: record.activeGenerationId,
    ...(record.previousGenerationId === undefined
      ? {}
      : { previousGenerationId: record.previousGenerationId }),
  });
}

function validateCanonicalGenerationPath(
  generationsRoot: string,
  generationId: string,
  generationPath: string,
): Result<string> {
  if (!isGenerationId(generationId)) {
    return err(appError('INVALID_INPUT', 'Canonical Skill cutover received an invalid staged generation id'));
  }

  const expected = path.resolve(generationsRoot, generationId);
  const actual = path.resolve(generationPath);
  if (actual !== expected) {
    return err(appError(
      'INVALID_INPUT',
      'Canonical Skill cutover staged generation path does not match the parent-owned staging root',
    ));
  }
  return ok(expected);
}

function isGenerationId(value: unknown): value is string {
  return typeof value === 'string' && GENERATION_ID_PATTERN.test(value);
}

function isMissingPath(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { readonly code?: unknown }).code === 'ENOENT';
}
