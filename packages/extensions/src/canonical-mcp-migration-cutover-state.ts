import { createHash } from 'node:crypto';
import { readFile, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { appError, err, ok, type Result } from '@unified-mpc/domain';
import type { CanonicalExtensionMigrationManifest } from './canonical-extension-migration-manifest.js';
import {
  isCanonicalExtensionEntry,
  type CanonicalExtensionProvenance,
} from './canonical-extension-registry.js';
import { withConfigMutationTransaction } from './config-mutation-lock.js';
import { writeAtomic } from './ide-sync.js';
import { exclusionReason } from './mcp-config-loader.js';
import {
  CanonicalMcpMigrationStager,
  type CanonicalMcpMigrationSkippedEntry,
  type CanonicalMcpMigrationStagedServer,
  type CanonicalMcpMigrationStageResult,
} from './canonical-mcp-migration-stager.js';
import { fingerprintExternalMcpValue } from './mcp-session-manager.js';
import type { McpServerLaunchConfig } from './types.js';

export interface CanonicalMcpMigrationCutoverState {
  readonly schemaVersion: 1;
  readonly activeGenerationId: string;
  readonly previousGenerationId?: string;
}

export interface CanonicalMcpMigrationCutoverActivation {
  readonly changed: boolean;
  readonly state: CanonicalMcpMigrationCutoverState;
}

export type CanonicalMcpMigrationCutoverRollback =
  | {
    readonly target: 'canonical';
    readonly fromGenerationId: string;
    readonly toGenerationId: string;
    readonly state: CanonicalMcpMigrationCutoverState;
  }
  | {
    readonly target: 'legacy';
    readonly fromGenerationId: string;
  };

export interface CanonicalMcpMigrationActiveGeneration {
  readonly state: CanonicalMcpMigrationCutoverState;
  readonly stageSchemaVersion: 1 | 2;
  readonly generationPath: string;
  readonly registryPath: string;
  readonly stagedServers: readonly CanonicalMcpMigrationStagedServer[];
  readonly skipped: readonly CanonicalMcpMigrationSkippedEntry[];
}

export type CanonicalMcpMigrationRollbackTarget =
  | {
    readonly target: 'legacy';
    readonly fromGenerationId: string;
  }
  | {
    readonly target: 'canonical';
    readonly fromGenerationId: string;
    readonly toGenerationId: string;
    readonly generation: CanonicalMcpMigrationActiveGeneration;
  };

export interface CanonicalMcpMigrationCutoverStateStoreOptions {
  readonly dataDir: string;
}

interface McpStageSnapshot {
  readonly schemaVersion: 1 | 2;
  readonly generationId: string;
  readonly stagedServers: readonly CanonicalMcpMigrationStagedServer[];
  readonly skipped: readonly CanonicalMcpMigrationSkippedEntry[];
}

const CUTOVER_STATE_SCHEMA_VERSION = 1 as const;
const GENERATION_ID_PATTERN = /^[a-f0-9]{64}$/;
const CUTOVER_STATE_FILENAME = 'mcp-cutover-state.json';

export class CanonicalMcpMigrationCutoverStateStore {
  private readonly dataDir: string;
  private readonly statePath: string;
  private readonly generationsRoot: string;

  public constructor(options: CanonicalMcpMigrationCutoverStateStoreOptions) {
    this.dataDir = path.resolve(options.dataDir);
    const migrationRoot = path.join(this.dataDir, 'extensions', 'state', 'migration');
    this.statePath = path.join(migrationRoot, CUTOVER_STATE_FILENAME);
    this.generationsRoot = path.join(migrationRoot, 'staged-mcp-generations');
  }

  public async load(): Promise<Result<CanonicalMcpMigrationCutoverState | undefined>> {
    return loadCutoverState(this.statePath);
  }

  public async resolveActiveGeneration(): Promise<Result<CanonicalMcpMigrationActiveGeneration | undefined>> {
    const state = await this.load();
    if (!state.ok) return err(state.error);
    if (state.value === undefined) return ok(undefined);
    return verifyPersistedGeneration(this.generationsRoot, state.value);
  }

  public async resolveRollbackTarget(): Promise<Result<CanonicalMcpMigrationRollbackTarget | undefined>> {
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

    const rollbackState: CanonicalMcpMigrationCutoverState = {
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
      generation: generation.value,
    });
  }

  public async rollback(
    expectedActiveGenerationId: string,
  ): Promise<Result<CanonicalMcpMigrationCutoverRollback>> {
    if (!isGenerationId(expectedActiveGenerationId)) {
      return err(appError('INVALID_INPUT', 'Canonical MCP rollback requires a valid expected active generation id'));
    }

    try {
      return await withConfigMutationTransaction([this.statePath], async () => {
        const current = await loadCutoverState(this.statePath);
        if (!current.ok) return err(current.error);
        if (current.value === undefined) {
          return err(appError('CONFLICT', 'Canonical MCP rollback requires an active generation'));
        }
        if (current.value.activeGenerationId !== expectedActiveGenerationId) {
          return err(appError(
            'CONFLICT',
            'Canonical MCP active generation changed before rollback could be applied',
            true,
          ));
        }

        const previousGenerationId = current.value.previousGenerationId;
        if (previousGenerationId === undefined) {
          await unlink(this.statePath);
          return ok({
            target: 'legacy',
            fromGenerationId: current.value.activeGenerationId,
          });
        }

        const nextState: CanonicalMcpMigrationCutoverState = {
          schemaVersion: CUTOVER_STATE_SCHEMA_VERSION,
          activeGenerationId: previousGenerationId,
          previousGenerationId: current.value.activeGenerationId,
        };
        const verified = await verifyPersistedGeneration(this.generationsRoot, nextState);
        if (!verified.ok) return err(verified.error);

        await writeAtomic(this.statePath, JSON.stringify(nextState, null, 2) + '\n');
        return ok({
          target: 'canonical',
          fromGenerationId: current.value.activeGenerationId,
          toGenerationId: previousGenerationId,
          state: nextState,
        });
      });
    } catch (error: unknown) {
      return err(appError(
        'INTERNAL_ERROR',
        `Failed to rollback canonical MCP cutover state: ${error instanceof Error ? error.message : String(error)}`,
        true,
      ));
    }
  }

  public async activate(
    manifest: CanonicalExtensionMigrationManifest,
    staged: CanonicalMcpMigrationStageResult,
  ): Promise<Result<CanonicalMcpMigrationCutoverActivation>> {
    const generationPath = validateCanonicalGenerationPath(
      this.generationsRoot,
      staged.generationId,
      staged.generationPath,
    );
    if (!generationPath.ok) return err(generationPath.error);
    if (path.resolve(staged.registryPath) !== path.join(generationPath.value, 'registry.json')) {
      return err(appError(
        'INVALID_INPUT',
        'Canonical MCP cutover staged registry path does not match the parent-owned staging generation',
      ));
    }

    const verified = await verifyStagedGenerationForActivation(this.dataDir, manifest, staged);
    if (!verified.ok) return err(verified.error);

    try {
      return await withConfigMutationTransaction([this.statePath], async () => {
        const current = await loadCutoverState(this.statePath);
        if (!current.ok) return err(current.error);

        if (current.value?.activeGenerationId === staged.generationId) {
          return ok({
            changed: false,
            state: current.value,
          });
        }

        const nextState: CanonicalMcpMigrationCutoverState = {
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
        `Failed to update canonical MCP cutover state: ${error instanceof Error ? error.message : String(error)}`,
        true,
      ));
    }
  }
}

async function verifyStagedGenerationForActivation(
  dataDir: string,
  manifest: CanonicalExtensionMigrationManifest,
  staged: CanonicalMcpMigrationStageResult,
): Promise<Result<undefined>> {
  try {
    const info = await stat(staged.generationPath);
    if (!info.isDirectory()) {
      return err(appError('INVALID_INPUT', 'Canonical MCP cutover requires an existing staged generation directory'));
    }
  } catch (error: unknown) {
    if (isMissingPath(error)) {
      return err(appError('INVALID_INPUT', 'Canonical MCP cutover requires an existing staged generation'));
    }
    return err(appError(
      'INTERNAL_ERROR',
      `Failed to inspect canonical MCP staged generation: ${error instanceof Error ? error.message : String(error)}`,
      true,
    ));
  }

  const restaged = await new CanonicalMcpMigrationStager({ dataDir }).stage(manifest);
  if (!restaged.ok) return err(restaged.error);
  if (!sameStageProjection(restaged.value, staged)) {
    return err(appError(
      'INVALID_INPUT',
      'Canonical MCP cutover staged generation does not exactly match the supplied migration manifest',
    ));
  }
  return ok(undefined);
}

function sameStageProjection(
  expected: CanonicalMcpMigrationStageResult,
  actual: CanonicalMcpMigrationStageResult,
): boolean {
  return expected.schemaVersion === actual.schemaVersion
    && expected.generationId === actual.generationId
    && path.resolve(expected.generationPath) === path.resolve(actual.generationPath)
    && path.resolve(expected.registryPath) === path.resolve(actual.registryPath)
    && JSON.stringify(expected.stagedServers) === JSON.stringify(actual.stagedServers)
    && JSON.stringify(expected.skipped) === JSON.stringify(actual.skipped);
}

async function verifyPersistedGeneration(
  generationsRoot: string,
  state: CanonicalMcpMigrationCutoverState,
): Promise<Result<CanonicalMcpMigrationActiveGeneration>> {
  const generationPath = path.resolve(generationsRoot, state.activeGenerationId);
  try {
    const generationInfo = await stat(generationPath);
    if (!generationInfo.isDirectory()) {
      return err(appError(
        'INVALID_INPUT',
        'Persisted canonical MCP cutover state points to a non-directory generation',
      ));
    }

    const stageContent = await readFile(path.join(generationPath, 'stage.json'), 'utf8');
    const stageValue: unknown = JSON.parse(stageContent);
    const snapshot = decodeStageSnapshot(stageValue);
    if (!snapshot.ok) return err(snapshot.error);
    if (snapshot.value.generationId !== state.activeGenerationId) {
      return err(appError(
        'INVALID_INPUT',
        'Persisted canonical MCP stage metadata does not match the active generation id',
      ));
    }

    const stageRecord = stageValue as Record<string, unknown>;
    const persistedProjection = {
      schemaVersion: stageRecord.schemaVersion,
      stagedServers: stageRecord.stagedServers,
      skipped: stageRecord.skipped,
    };
    const generationId = createHash('sha256')
      .update(JSON.stringify(persistedProjection))
      .digest('hex');
    if (generationId !== state.activeGenerationId) {
      return err(appError(
        'INVALID_INPUT',
        'Persisted canonical MCP generation hash does not match the active generation id',
      ));
    }

    const runtimeNames = new Set<string>();
    for (const server of snapshot.value.stagedServers) {
      if (fingerprintExternalMcpValue(server.config) !== server.fingerprint) {
        return err(appError(
          'INVALID_INPUT',
          `Persisted canonical MCP launch config fingerprint mismatch for ${server.id}`,
        ));
      }
      const exclusion = exclusionReason(server.name, server.config);
      if (exclusion !== undefined) {
        return err(appError(
          'INVALID_INPUT',
          `Persisted canonical MCP server is not runtime-safe: ${server.id}: ${exclusion}`,
        ));
      }
      const runtimeName = server.name.toLowerCase();
      if (runtimeNames.has(runtimeName)) {
        return err(appError(
          'INVALID_INPUT',
          `Persisted canonical MCP runtime name is ambiguous: ${server.name}`,
        ));
      }
      runtimeNames.add(runtimeName);
    }

    const registryPath = path.join(generationPath, 'registry.json');
    const registryContent = await readFile(registryPath, 'utf8');
    if (registryContent !== serializeRegistry(snapshot.value.stagedServers)) {
      return err(appError(
        'INVALID_INPUT',
        'Persisted canonical MCP registry does not match the active staged generation',
      ));
    }

    return ok({
      state,
      stageSchemaVersion: snapshot.value.schemaVersion,
      generationPath,
      registryPath,
      stagedServers: snapshot.value.stagedServers,
      skipped: snapshot.value.skipped,
    });
  } catch (error: unknown) {
    if (isMissingPath(error) || error instanceof SyntaxError) {
      return err(appError(
        'INVALID_INPUT',
        'Persisted canonical MCP active generation is missing or corrupt',
      ));
    }
    return err(appError(
      'INTERNAL_ERROR',
      `Failed to verify persisted canonical MCP active generation: ${error instanceof Error ? error.message : String(error)}`,
      true,
    ));
  }
}

function decodeStageSnapshot(value: unknown): Result<McpStageSnapshot> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return err(appError('INVALID_INPUT', 'Persisted canonical MCP stage metadata must be an object'));
  }
  const record = value as Record<string, unknown>;
  const allowedKeys = new Set(['schemaVersion', 'generationId', 'stagedServers', 'skipped']);
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
    return err(appError('INVALID_INPUT', 'Persisted canonical MCP stage metadata contains unknown fields'));
  }
  const schemaVersion = record.schemaVersion;
  if (
    (schemaVersion !== 1 && schemaVersion !== 2)
    || !isGenerationId(record.generationId)
    || !Array.isArray(record.stagedServers)
    || !Array.isArray(record.skipped)
  ) {
    return err(appError('INVALID_INPUT', 'Persisted canonical MCP stage metadata is invalid'));
  }

  const stagedServers: CanonicalMcpMigrationStagedServer[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const value of record.stagedServers) {
    const server = decodeStagedServer(value, schemaVersion);
    if (!server.ok) return err(server.error);
    const runtimeName = server.value.name.toLowerCase();
    if (ids.has(server.value.id) || names.has(runtimeName)) {
      return err(appError('INVALID_INPUT', 'Persisted canonical MCP staged entry is duplicated'));
    }
    ids.add(server.value.id);
    names.add(runtimeName);
    stagedServers.push(server.value);
  }

  const skipped: CanonicalMcpMigrationSkippedEntry[] = [];
  const skippedIds = new Set<string>();
  for (const value of record.skipped) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return err(appError('INVALID_INPUT', 'Persisted canonical MCP skipped entry is invalid'));
    }
    const skippedEntry = value as Record<string, unknown>;
    const allowedSkippedKeys = new Set(['id', 'reason']);
    if (
      Object.keys(skippedEntry).some((key) => !allowedSkippedKeys.has(key))
      || typeof skippedEntry.id !== 'string'
      || skippedEntry.id.trim().length === 0
      || skippedIds.has(skippedEntry.id)
      || (
        skippedEntry.reason !== 'disabled'
        && skippedEntry.reason !== 'incompatible'
        && skippedEntry.reason !== 'not_mcp_server'
      )
    ) {
      return err(appError('INVALID_INPUT', 'Persisted canonical MCP skipped entry is invalid'));
    }
    skippedIds.add(skippedEntry.id);
    skipped.push({
      id: skippedEntry.id,
      reason: skippedEntry.reason,
    });
  }

  return ok({
    schemaVersion,
    generationId: record.generationId,
    stagedServers,
    skipped,
  });
}

function decodeStagedServer(
  value: unknown,
  schemaVersion: 1 | 2,
): Result<CanonicalMcpMigrationStagedServer> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return err(appError('INVALID_INPUT', 'Persisted canonical MCP staged entry is invalid'));
  }
  const record = value as Record<string, unknown>;
  const allowedKeys = schemaVersion === 1
    ? new Set(['id', 'name', 'fingerprint', 'config', 'provenance'])
    : new Set(['id', 'name', 'fingerprint', 'config', 'provenance', 'canonicalEntry']);
  if (
    Object.keys(record).some((key) => !allowedKeys.has(key))
    || typeof record.id !== 'string'
    || record.id.trim().length === 0
    || typeof record.name !== 'string'
    || record.name.trim().length === 0
    || !isGenerationId(record.fingerprint)
    || !Array.isArray(record.provenance)
  ) {
    return err(appError('INVALID_INPUT', 'Persisted canonical MCP staged entry is invalid'));
  }

  const config = decodeLaunchConfig(record.config);
  if (!config.ok) return err(config.error);
  const provenance = decodeProvenance(record.provenance);
  if (!provenance.ok) return err(provenance.error);

  if (schemaVersion === 1) {
    return ok({
      id: record.id,
      name: record.name,
      fingerprint: record.fingerprint,
      config: config.value,
      provenance: provenance.value,
    });
  }

  if (!isCanonicalExtensionEntry(record.canonicalEntry)) {
    return err(appError('INVALID_INPUT', 'Persisted canonical MCP staged canonical metadata is invalid'));
  }
  const canonicalEntry = record.canonicalEntry;
  if (
    canonicalEntry.kind !== 'mcp_server'
    || canonicalEntry.id !== record.id
    || canonicalEntry.name !== record.name
    || canonicalEntry.fingerprint !== record.fingerprint
    || canonicalEntry.enabled !== true
    || canonicalEntry.compatibility === undefined
    || canonicalEntry.compatibilityState !== 'compatible'
    || canonicalEntry.conflict
    || canonicalEntry.missingCommands !== undefined
    || !sameProvenance(canonicalEntry.provenance, provenance.value)
  ) {
    return err(appError('INVALID_INPUT', 'Persisted canonical MCP staged canonical metadata is inconsistent'));
  }

  return ok({
    id: record.id,
    name: record.name,
    fingerprint: record.fingerprint,
    config: config.value,
    provenance: provenance.value,
    canonicalEntry,
  });
}

function decodeLaunchConfig(value: unknown): Result<McpServerLaunchConfig> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return err(appError('INVALID_INPUT', 'Persisted canonical MCP launch config is invalid'));
  }
  const record = value as Record<string, unknown>;
  const allowedKeys = new Set(['command', 'args', 'env', 'cwd', 'type', 'url']);
  if (
    Object.keys(record).some((key) => !allowedKeys.has(key))
    || typeof record.command !== 'string'
    || record.command.trim().length === 0
    || (record.args !== undefined && (
      !Array.isArray(record.args)
      || record.args.some((entry) => typeof entry !== 'string')
    ))
    || (record.env !== undefined && !isStringRecord(record.env))
    || (record.cwd !== undefined && typeof record.cwd !== 'string')
    || (record.type !== undefined && typeof record.type !== 'string')
    || (record.url !== undefined && typeof record.url !== 'string')
  ) {
    return err(appError('INVALID_INPUT', 'Persisted canonical MCP launch config is invalid'));
  }

  return ok({
    command: record.command,
    ...(record.args === undefined ? {} : { args: record.args as string[] }),
    ...(record.env === undefined ? {} : { env: record.env as Record<string, string> }),
    ...(record.cwd === undefined ? {} : { cwd: record.cwd as string }),
    ...(record.type === undefined ? {} : { type: record.type as string }),
    ...(record.url === undefined ? {} : { url: record.url as string }),
  });
}

function decodeProvenance(value: readonly unknown[]): Result<readonly CanonicalExtensionProvenance[]> {
  const provenance: CanonicalExtensionProvenance[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return err(appError('INVALID_INPUT', 'Persisted canonical MCP provenance is invalid'));
    }
    const record = item as Record<string, unknown>;
    const allowedKeys = new Set([
      'originType',
      'origin',
      'sourceClient',
      'version',
      'revision',
      'contentSha256',
      'importedAt',
    ]);
    if (
      Object.keys(record).some((key) => !allowedKeys.has(key))
      || !isCanonicalOriginType(record.originType)
      || typeof record.origin !== 'string'
      || record.origin.trim().length === 0
      || (record.sourceClient !== undefined && typeof record.sourceClient !== 'string')
      || (record.version !== undefined && typeof record.version !== 'string')
      || (record.revision !== undefined && typeof record.revision !== 'string')
      || (record.contentSha256 !== undefined && typeof record.contentSha256 !== 'string')
      || (record.importedAt !== undefined && typeof record.importedAt !== 'string')
    ) {
      return err(appError('INVALID_INPUT', 'Persisted canonical MCP provenance is invalid'));
    }
    provenance.push({
      originType: record.originType,
      origin: record.origin,
      ...(record.sourceClient === undefined ? {} : { sourceClient: record.sourceClient as string }),
      ...(record.version === undefined ? {} : { version: record.version as string }),
      ...(record.revision === undefined ? {} : { revision: record.revision as string }),
      ...(record.contentSha256 === undefined ? {} : { contentSha256: record.contentSha256 as string }),
      ...(record.importedAt === undefined ? {} : { importedAt: record.importedAt as string }),
    });
  }
  return ok(provenance);
}

function sameProvenance(
  left: readonly CanonicalExtensionProvenance[],
  right: readonly CanonicalExtensionProvenance[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((entry, index) => {
    const other = right[index];
    return other !== undefined
      && entry.originType === other.originType
      && entry.origin === other.origin
      && entry.sourceClient === other.sourceClient
      && entry.version === other.version
      && entry.revision === other.revision
      && entry.contentSha256 === other.contentSha256
      && entry.importedAt === other.importedAt;
  });
}

function serializeRegistry(servers: readonly CanonicalMcpMigrationStagedServer[]): string {
  return JSON.stringify({
    mcpServers: Object.fromEntries(servers.map((server) => [server.name, server.config])),
  }, null, 2) + '\n';
}

async function loadCutoverState(
  statePath: string,
): Promise<Result<CanonicalMcpMigrationCutoverState | undefined>> {
  let content: string;
  try {
    content = await readFile(statePath, 'utf8');
  } catch (error: unknown) {
    if (isMissingPath(error)) return ok(undefined);
    return err(appError(
      'INTERNAL_ERROR',
      `Failed to read canonical MCP cutover state: ${error instanceof Error ? error.message : String(error)}`,
      true,
    ));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return err(appError('INVALID_INPUT', 'Persisted canonical MCP cutover state is invalid JSON'));
  }
  return decodeCutoverState(parsed);
}

function decodeCutoverState(value: unknown): Result<CanonicalMcpMigrationCutoverState> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return err(appError('INVALID_INPUT', 'Persisted canonical MCP cutover state must be an object'));
  }
  const record = value as Record<string, unknown>;
  const allowedKeys = new Set(['schemaVersion', 'activeGenerationId', 'previousGenerationId']);
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
    return err(appError('INVALID_INPUT', 'Persisted canonical MCP cutover state contains unknown fields'));
  }
  if (record.schemaVersion !== CUTOVER_STATE_SCHEMA_VERSION) {
    return err(appError('INVALID_INPUT', 'Persisted canonical MCP cutover state has an unsupported schema version'));
  }
  if (!isGenerationId(record.activeGenerationId)) {
    return err(appError('INVALID_INPUT', 'Persisted canonical MCP cutover state has an invalid active generation id'));
  }
  if (
    record.previousGenerationId !== undefined
    && !isGenerationId(record.previousGenerationId)
  ) {
    return err(appError('INVALID_INPUT', 'Persisted canonical MCP cutover state has an invalid previous generation id'));
  }
  if (record.previousGenerationId === record.activeGenerationId) {
    return err(appError(
      'INVALID_INPUT',
      'Persisted canonical MCP cutover state cannot point active and previous to the same generation',
    ));
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
    return err(appError('INVALID_INPUT', 'Canonical MCP cutover received an invalid staged generation id'));
  }
  const expected = path.resolve(generationsRoot, generationId);
  const actual = path.resolve(generationPath);
  if (actual !== expected) {
    return err(appError(
      'INVALID_INPUT',
      'Canonical MCP cutover staged generation path does not match the parent-owned staging root',
    ));
  }
  return ok(expected);
}

function isCanonicalOriginType(
  value: unknown,
): value is CanonicalExtensionProvenance['originType'] {
  return value === 'bundled'
    || value === 'github'
    || value === 'url'
    || value === 'local-import'
    || value === 'client-import'
    || value === 'managed';
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.values(value).every((entry) => typeof entry === 'string');
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
