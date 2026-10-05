import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { appError, err, ok, type Result } from '@unified-mpc/domain';
import type { CanonicalExtensionMigrationManifest } from './canonical-extension-migration-manifest.js';
import { withConfigMutationTransaction } from './config-mutation-lock.js';
import { CanonicalSkillMigrationDryRunVerifier } from './canonical-skill-migration-dry-run.js';
import type { CanonicalSkillMigrationStageResult } from './canonical-skill-migration-stager.js';
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

export interface CanonicalSkillMigrationCutoverStateStoreOptions {
  readonly dataDir: string;
}

const CUTOVER_STATE_SCHEMA_VERSION = 1 as const;
const GENERATION_ID_PATTERN = /^[a-f0-9]{64}$/;
const CUTOVER_STATE_FILENAME = 'cutover-state.json';

export class CanonicalSkillMigrationCutoverStateStore {
  private readonly dataDir: string;
  private readonly statePath: string;
  private readonly generationsRoot: string;
  private readonly verifier = new CanonicalSkillMigrationDryRunVerifier();

  public constructor(options: CanonicalSkillMigrationCutoverStateStoreOptions) {
    this.dataDir = path.resolve(options.dataDir);
    const migrationRoot = path.join(this.dataDir, 'extensions', 'state', 'migration');
    this.statePath = path.join(migrationRoot, CUTOVER_STATE_FILENAME);
    this.generationsRoot = path.join(migrationRoot, 'staged-generations');
  }

  public async load(): Promise<Result<CanonicalSkillMigrationCutoverState | undefined>> {
    return loadCutoverState(this.statePath);
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

    try {
      return await withConfigMutationTransaction([this.statePath], async () => {
        const current = await loadCutoverState(this.statePath);
        if (!current.ok) return err(current.error);

        const proof = await this.verifier.verify(manifest, staged);
        if (!proof.ok) return err(proof.error);
        if (proof.value.generationId !== staged.generationId || !proof.value.exactParity) {
          return err(appError(
            'INVALID_INPUT',
            'Canonical Skill cutover requires an exact dry-run proof for the staged generation',
          ));
        }

        if (current.value?.activeGenerationId === staged.generationId) {
          return ok({
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
        return ok({
          changed: true,
          state: nextState,
        });
      });
    } catch (error: unknown) {
      return err(appError(
        'INTERNAL_ERROR',
        `Failed to update canonical Skill cutover state: ${error instanceof Error ? error.message : String(error)}`,
        true,
      ));
    }
  }
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
