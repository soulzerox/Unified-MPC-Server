import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildCanonicalExtensionMigrationManifest,
  type CanonicalExtensionMigrationCandidate,
  type CanonicalExtensionMigrationManifest,
} from './canonical-extension-migration-manifest.js';
import { CanonicalMcpMigrationCutoverStateStore } from './canonical-mcp-migration-cutover-state.js';
import {
  CanonicalMcpMigrationStager,
  type CanonicalMcpMigrationStageResult,
} from './canonical-mcp-migration-stager.js';
import { fingerprintExternalMcpValue } from './mcp-session-manager.js';
import type { McpServerLaunchConfig } from './types.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixtureRoot(name: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), name));
  temporaryRoots.push(root);
  return root;
}

function candidate(input: {
  readonly name: string;
  readonly config: McpServerLaunchConfig;
  readonly sourceClient?: string;
}): CanonicalExtensionMigrationCandidate {
  return {
    kind: 'mcp_server',
    id: 'mcp:' + input.name,
    name: input.name,
    fingerprint: fingerprintExternalMcpValue(input.config),
    enabled: true,
    provenance: {
      importedAt: '2026-10-06T00:00:00.000Z',
      contentSha256: 'c'.repeat(64),
      revision: 'rev-' + input.name,
      version: '1.2.3',
      sourceClient: input.sourceClient ?? 'cursor',
      origin: '/fixture/' + (input.sourceClient ?? 'cursor') + '/' + input.name,
      originType: 'client-import',
    },
    compatibility: { platforms: ['linux'] },
    launchConfig: input.config,
  };
}

function manifestFor(
  candidates: readonly CanonicalExtensionMigrationCandidate[],
): CanonicalExtensionMigrationManifest {
  const result = buildCanonicalExtensionMigrationManifest(candidates, {
    platform: 'linux',
    architecture: 'x64',
    availableCommands: new Set(['node']),
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function stage(
  dataDir: string,
  manifest: CanonicalExtensionMigrationManifest,
): Promise<CanonicalMcpMigrationStageResult> {
  const result = await new CanonicalMcpMigrationStager({ dataDir }).stage(manifest);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe('CanonicalMcpMigrationCutoverStateStore', () => {
  it('activates a verified staged generation without touching the live MCP registry', async () => {
    const root = await fixtureRoot('canonical-mcp-cutover-first-');
    const dataDir = path.join(root, 'data');
    const liveRegistry = path.join(dataDir, 'extensions', 'mcp', 'registry.json');
    await mkdir(path.dirname(liveRegistry), { recursive: true });
    const liveBefore = JSON.stringify({ mcpServers: { legacy: { command: 'legacy' } } }) + '\n';
    await writeFile(liveRegistry, liveBefore, 'utf8');

    const manifest = manifestFor([
      candidate({ name: 'alpha', config: { command: 'node', args: ['alpha.js'] } }),
    ]);
    const staged = await stage(dataDir, manifest);
    const store = new CanonicalMcpMigrationCutoverStateStore({ dataDir });

    const activated = await store.activate(manifest, staged);
    expect(activated.ok).toBe(true);
    if (!activated.ok) return;
    expect(activated.value).toEqual({
      changed: true,
      state: {
        schemaVersion: 1,
        activeGenerationId: staged.generationId,
      },
    });

    const statePath = path.join(dataDir, 'extensions', 'state', 'migration', 'mcp-cutover-state.json');
    expect(JSON.parse(await readFile(statePath, 'utf8'))).toEqual(activated.value.state);
    expect(await readFile(liveRegistry, 'utf8')).toBe(liveBefore);

    const resolved = await store.resolveActiveGeneration();
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value).toMatchObject({
      state: activated.value.state,
      stageSchemaVersion: 2,
      generationPath: staged.generationPath,
      registryPath: staged.registryPath,
      stagedServers: staged.stagedServers,
      skipped: staged.skipped,
    });
  });

  it('keeps verified schema-v1 active generations runtime-compatible without inventing canonical metadata', async () => {
    const root = await fixtureRoot('canonical-mcp-cutover-v1-compat-');
    const dataDir = path.join(root, 'data');
    const config: McpServerLaunchConfig = { command: 'node', args: ['legacy.js'] };
    const stagedServers = [{
      id: 'mcp:legacy',
      name: 'legacy',
      fingerprint: fingerprintExternalMcpValue(config),
      config,
      provenance: [{
        originType: 'client-import' as const,
        origin: '/fixture/cursor/legacy',
        sourceClient: 'cursor',
      }],
    }];
    const projection = {
      schemaVersion: 1 as const,
      stagedServers,
      skipped: [],
    };
    const generationId = createHash('sha256')
      .update(JSON.stringify(projection))
      .digest('hex');
    const generationPath = path.join(
      dataDir,
      'extensions',
      'state',
      'migration',
      'staged-mcp-generations',
      generationId,
    );
    await mkdir(generationPath, { recursive: true });
    const stagePath = path.join(generationPath, 'stage.json');
    await writeFile(
      stagePath,
      JSON.stringify({ ...projection, generationId }, null, 2) + '\n',
      'utf8',
    );
    const stageBefore = await readFile(stagePath, 'utf8');
    await writeFile(
      path.join(generationPath, 'registry.json'),
      JSON.stringify({ mcpServers: { legacy: config } }, null, 2) + '\n',
      'utf8',
    );
    const statePath = path.join(dataDir, 'extensions', 'state', 'migration', 'mcp-cutover-state.json');
    await writeFile(
      statePath,
      JSON.stringify({ schemaVersion: 1, activeGenerationId: generationId }, null, 2) + '\n',
      'utf8',
    );

    const resolved = await new CanonicalMcpMigrationCutoverStateStore({ dataDir }).resolveActiveGeneration();
    expect(resolved.ok).toBe(true);
    if (!resolved.ok || resolved.value === undefined) return;
    expect(resolved.value.stageSchemaVersion).toBe(1);
    expect(resolved.value.stagedServers).toEqual(stagedServers);
    expect(resolved.value.stagedServers[0]?.canonicalEntry).toBeUndefined();
    expect(await readFile(stagePath, 'utf8')).toBe(stageBefore);
  });

  it('reuses the same generation idempotently without inventing rollback history', async () => {
    const root = await fixtureRoot('canonical-mcp-cutover-idempotent-');
    const dataDir = path.join(root, 'data');
    const manifest = manifestFor([
      candidate({ name: 'same', config: { command: 'node', args: ['same.js'] } }),
    ]);
    const staged = await stage(dataDir, manifest);
    const store = new CanonicalMcpMigrationCutoverStateStore({ dataDir });

    const first = await store.activate(manifest, staged);
    const second = await store.activate(manifest, staged);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.changed).toBe(true);
    expect(second.value.changed).toBe(false);
    expect(second.value.state).toEqual(first.value.state);
    expect(second.value.state.previousGenerationId).toBeUndefined();
  });

  it('preserves the previous canonical generation and verifies it as a rollback target', async () => {
    const root = await fixtureRoot('canonical-mcp-cutover-history-');
    const dataDir = path.join(root, 'data');
    const firstManifest = manifestFor([
      candidate({ name: 'alpha', config: { command: 'node', args: ['alpha.js'] } }),
    ]);
    const firstStage = await stage(dataDir, firstManifest);
    const secondManifest = manifestFor([
      candidate({ name: 'beta', config: { command: 'node', args: ['beta.js'] }, sourceClient: 'cline' }),
    ]);
    const secondStage = await stage(dataDir, secondManifest);
    const store = new CanonicalMcpMigrationCutoverStateStore({ dataDir });

    expect((await store.activate(firstManifest, firstStage)).ok).toBe(true);
    const second = await store.activate(secondManifest, secondStage);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.state).toEqual({
      schemaVersion: 1,
      activeGenerationId: secondStage.generationId,
      previousGenerationId: firstStage.generationId,
    });

    const target = await store.resolveRollbackTarget();
    expect(target.ok).toBe(true);
    if (!target.ok) return;
    expect(target.value).toMatchObject({
      target: 'canonical',
      fromGenerationId: secondStage.generationId,
      toGenerationId: firstStage.generationId,
      generation: {
        generationPath: firstStage.generationPath,
        registryPath: firstStage.registryPath,
        stagedServers: firstStage.stagedServers,
      },
    });
  });

  it('fails closed on staged registry drift before activation and preserves the active pointer', async () => {
    const root = await fixtureRoot('canonical-mcp-cutover-drift-');
    const dataDir = path.join(root, 'data');
    const firstManifest = manifestFor([
      candidate({ name: 'alpha', config: { command: 'node', args: ['alpha.js'] } }),
    ]);
    const firstStage = await stage(dataDir, firstManifest);
    const store = new CanonicalMcpMigrationCutoverStateStore({ dataDir });
    const first = await store.activate(firstManifest, firstStage);
    expect(first.ok).toBe(true);

    const secondManifest = manifestFor([
      candidate({ name: 'beta', config: { command: 'node', args: ['beta.js'] } }),
    ]);
    const secondStage = await stage(dataDir, secondManifest);
    await writeFile(secondStage.registryPath, JSON.stringify({ mcpServers: {} }) + '\n', 'utf8');

    const activation = await store.activate(secondManifest, secondStage);
    expect(activation.ok).toBe(false);
    if (!activation.ok) expect(activation.error.message).toContain('registry');

    const loaded = await store.load();
    expect(loaded.ok).toBe(true);
    if (!loaded.ok || !first.ok) return;
    expect(loaded.value).toEqual(first.value.state);
  });

  it('fails closed when the active generation becomes corrupt', async () => {
    const root = await fixtureRoot('canonical-mcp-cutover-corrupt-active-');
    const dataDir = path.join(root, 'data');
    const manifest = manifestFor([
      candidate({ name: 'alpha', config: { command: 'node', args: ['alpha.js'] } }),
    ]);
    const staged = await stage(dataDir, manifest);
    const store = new CanonicalMcpMigrationCutoverStateStore({ dataDir });
    expect((await store.activate(manifest, staged)).ok).toBe(true);

    await writeFile(staged.registryPath, JSON.stringify({ mcpServers: { alpha: { command: 'node', args: ['drift.js'] } } }) + '\n', 'utf8');
    const resolved = await store.resolveActiveGeneration();
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.error.code).toBe('INVALID_INPUT');
      expect(resolved.error.message).toContain('registry');
    }
  });

  it('fails closed when hash-covered canonical compatibility metadata drifts after staging', async () => {
    const root = await fixtureRoot('canonical-mcp-cutover-corrupt-metadata-');
    const dataDir = path.join(root, 'data');
    const manifest = manifestFor([
      candidate({ name: 'alpha', config: { command: 'node', args: ['alpha.js'] } }),
    ]);
    const staged = await stage(dataDir, manifest);
    const store = new CanonicalMcpMigrationCutoverStateStore({ dataDir });
    expect((await store.activate(manifest, staged)).ok).toBe(true);

    const stagePath = path.join(staged.generationPath, 'stage.json');
    const stageSnapshot = JSON.parse(await readFile(stagePath, 'utf8')) as {
      stagedServers: Array<{
        canonicalEntry?: {
          compatibility?: { platforms?: NodeJS.Platform[] };
        };
      }>;
    };
    const canonicalEntry = stageSnapshot.stagedServers[0]?.canonicalEntry;
    expect(canonicalEntry?.compatibility).toBeDefined();
    if (canonicalEntry?.compatibility === undefined) return;
    canonicalEntry.compatibility.platforms = ['darwin'];
    await writeFile(stagePath, JSON.stringify(stageSnapshot, null, 2) + '\n', 'utf8');

    const resolved = await store.resolveActiveGeneration();
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.error.code).toBe('INVALID_INPUT');
      expect(resolved.error.message).toContain('generation hash');
    }
  });

  it('rolls the first canonical MCP cutover back to legacy without touching staged or live registries', async () => {
    const root = await fixtureRoot('canonical-mcp-cutover-rollback-legacy-');
    const dataDir = path.join(root, 'data');
    const liveRegistry = path.join(dataDir, 'extensions', 'mcp', 'registry.json');
    await mkdir(path.dirname(liveRegistry), { recursive: true });
    const liveBefore = JSON.stringify({ mcpServers: { legacy: { command: 'legacy' } } }) + '\n';
    await writeFile(liveRegistry, liveBefore, 'utf8');

    const manifest = manifestFor([
      candidate({ name: 'alpha', config: { command: 'node', args: ['alpha.js'] } }),
    ]);
    const staged = await stage(dataDir, manifest);
    const stagedBefore = await readFile(staged.registryPath, 'utf8');
    const store = new CanonicalMcpMigrationCutoverStateStore({ dataDir });
    expect((await store.activate(manifest, staged)).ok).toBe(true);

    const target = await store.resolveRollbackTarget();
    expect(target.ok).toBe(true);
    if (!target.ok) return;
    expect(target.value).toEqual({
      target: 'legacy',
      fromGenerationId: staged.generationId,
    });

    const rolledBack = await store.rollback(staged.generationId);
    expect(rolledBack.ok).toBe(true);
    if (!rolledBack.ok) return;
    expect(rolledBack.value).toEqual({
      target: 'legacy',
      fromGenerationId: staged.generationId,
    });

    const loaded = await store.load();
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value).toBeUndefined();
    expect((await stat(staged.generationPath)).isDirectory()).toBe(true);
    expect(await readFile(staged.registryPath, 'utf8')).toBe(stagedBefore);
    expect(await readFile(liveRegistry, 'utf8')).toBe(liveBefore);
  });

  it('rolls back to a verified previous canonical MCP generation and swaps rollback history', async () => {
    const root = await fixtureRoot('canonical-mcp-cutover-rollback-canonical-');
    const dataDir = path.join(root, 'data');
    const firstManifest = manifestFor([
      candidate({ name: 'alpha', config: { command: 'node', args: ['alpha.js'] } }),
    ]);
    const firstStage = await stage(dataDir, firstManifest);
    const secondManifest = manifestFor([
      candidate({ name: 'beta', config: { command: 'node', args: ['beta.js'] } }),
    ]);
    const secondStage = await stage(dataDir, secondManifest);
    const store = new CanonicalMcpMigrationCutoverStateStore({ dataDir });
    expect((await store.activate(firstManifest, firstStage)).ok).toBe(true);
    expect((await store.activate(secondManifest, secondStage)).ok).toBe(true);

    const rolledBack = await store.rollback(secondStage.generationId);
    expect(rolledBack.ok).toBe(true);
    if (!rolledBack.ok) return;
    expect(rolledBack.value).toEqual({
      target: 'canonical',
      fromGenerationId: secondStage.generationId,
      toGenerationId: firstStage.generationId,
      state: {
        schemaVersion: 1,
        activeGenerationId: firstStage.generationId,
        previousGenerationId: secondStage.generationId,
      },
    });

    const resolved = await store.resolveActiveGeneration();
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value?.generationPath).toBe(firstStage.generationPath);
    expect(resolved.value?.state).toEqual(rolledBack.value.state);
  });

  it('fails closed on corrupt previous generation and preserves the active pointer', async () => {
    const root = await fixtureRoot('canonical-mcp-cutover-rollback-corrupt-');
    const dataDir = path.join(root, 'data');
    const firstManifest = manifestFor([
      candidate({ name: 'alpha', config: { command: 'node', args: ['alpha.js'] } }),
    ]);
    const firstStage = await stage(dataDir, firstManifest);
    const secondManifest = manifestFor([
      candidate({ name: 'beta', config: { command: 'node', args: ['beta.js'] } }),
    ]);
    const secondStage = await stage(dataDir, secondManifest);
    const store = new CanonicalMcpMigrationCutoverStateStore({ dataDir });
    expect((await store.activate(firstManifest, firstStage)).ok).toBe(true);
    const second = await store.activate(secondManifest, secondStage);
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    await writeFile(firstStage.registryPath, JSON.stringify({ mcpServers: {} }) + '\n', 'utf8');

    const target = await store.resolveRollbackTarget();
    expect(target.ok).toBe(false);
    const rollback = await store.rollback(secondStage.generationId);
    expect(rollback.ok).toBe(false);

    const loaded = await store.load();
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value).toEqual(second.value.state);
  });
});
