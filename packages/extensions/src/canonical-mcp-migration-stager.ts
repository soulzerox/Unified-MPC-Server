import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { appError, err, ok, type Result } from '@unified-mpc/domain';
import type {
  CanonicalExtensionMigrationManifest,
  CanonicalExtensionMigrationManifestEntry,
  CanonicalExtensionMigrationSource,
} from './canonical-extension-migration-manifest.js';
import type {
  CanonicalExtensionEntry,
  CanonicalExtensionProvenance,
} from './canonical-extension-registry.js';
import { exclusionReason } from './mcp-config-loader.js';
import { fingerprintExternalMcpValue } from './mcp-session-manager.js';
import type { McpServerLaunchConfig } from './types.js';

export type CanonicalMcpMigrationSkipReason =
  | 'disabled'
  | 'incompatible'
  | 'not_mcp_server';

export interface CanonicalMcpMigrationSkippedEntry {
  readonly id: string;
  readonly reason: CanonicalMcpMigrationSkipReason;
}

export interface CanonicalMcpMigrationStagedServer {
  readonly id: string;
  readonly name: string;
  readonly fingerprint: string;
  readonly config: McpServerLaunchConfig;
  readonly provenance: readonly CanonicalExtensionProvenance[];
  readonly canonicalEntry?: CanonicalExtensionEntry;
}

export interface CanonicalMcpMigrationStageResult {
  readonly schemaVersion: 2;
  readonly generationId: string;
  readonly generationPath: string;
  readonly registryPath: string;
  readonly reused: boolean;
  readonly stagedServers: readonly CanonicalMcpMigrationStagedServer[];
  readonly skipped: readonly CanonicalMcpMigrationSkippedEntry[];
}

export interface CanonicalMcpMigrationStagerOptions {
  readonly dataDir: string;
}

interface PlannedServer {
  readonly entry: CanonicalExtensionMigrationManifestEntry;
  readonly source: CanonicalExtensionMigrationSource & { readonly launchConfig: McpServerLaunchConfig };
  readonly staged: CanonicalMcpMigrationStagedServer;
}

interface McpStageSnapshot {
  readonly schemaVersion: 2;
  readonly generationId: string;
  readonly stagedServers: readonly CanonicalMcpMigrationStagedServer[];
  readonly skipped: readonly CanonicalMcpMigrationSkippedEntry[];
}

const STAGE_SCHEMA_VERSION = 2 as const;

export class CanonicalMcpMigrationStager {
  private readonly dataDir: string;

  public constructor(options: CanonicalMcpMigrationStagerOptions) {
    this.dataDir = path.resolve(options.dataDir);
  }

  public async stage(
    manifest: CanonicalExtensionMigrationManifest,
  ): Promise<Result<CanonicalMcpMigrationStageResult>> {
    const plan = buildStagePlan(manifest);
    if (!plan.ok) return err(plan.error);

    const projection = {
      schemaVersion: STAGE_SCHEMA_VERSION,
      stagedServers: plan.value.servers.map((server) => server.staged),
      skipped: plan.value.skipped,
    };
    const generationId = sha256(JSON.stringify(projection));
    const generationRoot = path.join(
      this.dataDir,
      'extensions',
      'state',
      'migration',
      'staged-mcp-generations',
    );
    const generationPath = path.join(generationRoot, generationId);
    const snapshot: McpStageSnapshot = {
      schemaVersion: STAGE_SCHEMA_VERSION,
      generationId,
      stagedServers: projection.stagedServers,
      skipped: projection.skipped,
    };
    const registryJson = serializeRegistry(plan.value.servers);

    let generationExists: boolean;
    try {
      generationExists = await isDirectory(generationPath);
    } catch (error: unknown) {
      return err(appError(
        'INTERNAL_ERROR',
        `Failed to inspect canonical MCP migration staging root: ${error instanceof Error ? error.message : String(error)}`,
        true,
      ));
    }

    if (generationExists) {
      const verified = await verifyExistingGeneration(generationPath, registryJson, snapshot);
      if (!verified.ok) return err(verified.error);
      return ok(stageResult(generationPath, snapshot, true));
    }

    let temporaryPath: string;
    try {
      await mkdir(generationRoot, { recursive: true });
      temporaryPath = await mkdtemp(path.join(generationRoot, '.tmp-'));
    } catch (error: unknown) {
      return err(appError(
        'INTERNAL_ERROR',
        `Failed to create canonical MCP migration staging directory: ${error instanceof Error ? error.message : String(error)}`,
        true,
      ));
    }

    try {
      await writeFile(path.join(temporaryPath, 'registry.json'), registryJson, 'utf8');
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
        const verified = await verifyExistingGeneration(generationPath, registryJson, snapshot);
        if (!verified.ok) return err(verified.error);
        return ok(stageResult(generationPath, snapshot, true));
      }

      return ok(stageResult(generationPath, snapshot, false));
    } catch (error: unknown) {
      return err(appError(
        'INTERNAL_ERROR',
        `Failed to stage canonical MCP migration generation: ${error instanceof Error ? error.message : String(error)}`,
        true,
      ));
    } finally {
      await rm(temporaryPath, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function buildStagePlan(
  manifest: CanonicalExtensionMigrationManifest,
): Result<{
  readonly servers: readonly PlannedServer[];
  readonly skipped: readonly CanonicalMcpMigrationSkippedEntry[];
}> {
  if (!manifest.cutover.allowed) {
    return err(appError(
      'INVALID_INPUT',
      `Canonical migration manifest still has cutover blockers: ${manifest.cutover.reasons.join(', ')}`,
    ));
  }

  const servers: PlannedServer[] = [];
  const skipped: CanonicalMcpMigrationSkippedEntry[] = [];
  const runtimeNames = new Set<string>();

  for (const entry of manifest.entries) {
    if (entry.kind !== 'mcp_server') {
      skipped.push({ id: entry.id, reason: 'not_mcp_server' });
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
      return err(appError('INVALID_INPUT', `Canonical MCP server is not safe to stage: ${entry.id}`));
    }

    const source = entry.sources.find((candidate) => (
      candidate.enabled
      && candidate.compatibilityState === 'compatible'
      && candidate.fingerprint === entry.selectedFingerprint
      && candidate.launchConfig !== undefined
    ));
    if (source?.launchConfig === undefined) {
      return err(appError('INVALID_INPUT', `Canonical MCP launch config is missing: ${entry.id}`));
    }
    if (fingerprintExternalMcpValue(source.launchConfig) !== entry.selectedFingerprint) {
      return err(appError(
        'INVALID_INPUT',
        `Canonical MCP launch config fingerprint does not match migration manifest: ${entry.id}`,
      ));
    }

    const exclusion = exclusionReason(entry.name, source.launchConfig);
    if (exclusion !== undefined) {
      return err(appError('INVALID_INPUT', `Canonical MCP server cannot be staged: ${entry.id}: ${exclusion}`));
    }

    const runtimeName = entry.name.toLowerCase();
    if (runtimeNames.has(runtimeName)) {
      return err(appError(
        'INVALID_INPUT',
        `Canonical MCP runtime name is ambiguous after migration: ${entry.name}`,
      ));
    }
    runtimeNames.add(runtimeName);

    servers.push({
      entry,
      source: source as CanonicalExtensionMigrationSource & { readonly launchConfig: McpServerLaunchConfig },
      staged: {
        id: entry.id,
        name: entry.name,
        fingerprint: entry.selectedFingerprint,
        config: source.launchConfig,
        provenance: entry.provenance,
        canonicalEntry: {
          kind: 'mcp_server',
          id: entry.id,
          name: entry.name,
          fingerprint: entry.selectedFingerprint,
          enabled: true,
          ...(source.compatibility === undefined ? {} : { compatibility: source.compatibility }),
          compatibilityState: 'compatible',
          conflict: false,
          variantFingerprints: entry.variantFingerprints,
          provenance: entry.provenance,
        },
      },
    });
  }

  return ok({
    servers: servers.sort((left, right) => left.entry.name.localeCompare(right.entry.name)),
    skipped: skipped.sort((left, right) => left.id.localeCompare(right.id)),
  });
}

function serializeRegistry(servers: readonly PlannedServer[]): string {
  const mcpServers = Object.fromEntries(
    servers.map((server) => [server.entry.name, server.source.launchConfig]),
  );
  return JSON.stringify({ mcpServers }, null, 2) + '\n';
}

async function verifyExistingGeneration(
  generationPath: string,
  registryJson: string,
  expected: McpStageSnapshot,
): Promise<Result<undefined>> {
  try {
    if (await readFile(path.join(generationPath, 'registry.json'), 'utf8') !== registryJson) {
      return err(appError(
        'INVALID_INPUT',
        `Existing canonical MCP migration registry is corrupt: ${generationPath}`,
      ));
    }
    const stageContent = await readFile(path.join(generationPath, 'stage.json'), 'utf8');
    const parsed: unknown = JSON.parse(stageContent);
    if (JSON.stringify(parsed) !== JSON.stringify(expected)) {
      return err(appError(
        'INVALID_INPUT',
        `Existing canonical MCP migration metadata is corrupt: ${generationPath}`,
      ));
    }
    return ok(undefined);
  } catch (error: unknown) {
    if (isMissingPath(error) || error instanceof SyntaxError) {
      return err(appError(
        'INVALID_INPUT',
        `Existing canonical MCP migration generation is incomplete or corrupt: ${generationPath}`,
      ));
    }
    return err(appError(
      'INTERNAL_ERROR',
      `Failed to verify canonical MCP migration generation: ${error instanceof Error ? error.message : String(error)}`,
      true,
    ));
  }
}

function stageResult(
  generationPath: string,
  snapshot: McpStageSnapshot,
  reused: boolean,
): CanonicalMcpMigrationStageResult {
  return {
    schemaVersion: STAGE_SCHEMA_VERSION,
    generationId: snapshot.generationId,
    generationPath,
    registryPath: path.join(generationPath, 'registry.json'),
    reused,
    stagedServers: snapshot.stagedServers,
    skipped: snapshot.skipped,
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
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
