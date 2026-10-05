import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildCanonicalExtensionMigrationManifest,
  type CanonicalExtensionMigrationCandidate,
  type CanonicalExtensionMigrationManifest,
} from './canonical-extension-migration-manifest.js';
import { CanonicalMcpMigrationStager } from './canonical-mcp-migration-stager.js';
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
  readonly sourceClient: string;
  readonly compatibility?: {
    readonly platforms?: readonly NodeJS.Platform[];
    readonly architectures?: readonly string[];
    readonly requiresCommands?: readonly string[];
    readonly optionalCommands?: readonly string[];
  };
}): CanonicalExtensionMigrationCandidate {
  return {
    kind: 'mcp_server',
    id: 'mcp:' + input.name,
    name: input.name,
    fingerprint: fingerprintExternalMcpValue(input.config),
    enabled: true,
    provenance: {
      originType: 'client-import',
      origin: '/fixture/' + input.sourceClient + '/' + input.name,
      sourceClient: input.sourceClient,
    },
    compatibility: input.compatibility ?? { platforms: ['linux'] },
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

describe('CanonicalMcpMigrationStager', () => {
  it('stages one deterministic canonical registry for identical duplicates without touching live configs', async () => {
    const root = await fixtureRoot('canonical-mcp-stage-');
    const dataDir = path.join(root, 'data');
    const liveRegistry = path.join(dataDir, 'extensions', 'mcp', 'registry.json');
    const clientConfig = path.join(root, 'home', '.cursor', 'mcp.json');
    await mkdir(path.dirname(liveRegistry), { recursive: true });
    await mkdir(path.dirname(clientConfig), { recursive: true });
    const liveBefore = JSON.stringify({ mcpServers: { legacy: { command: 'legacy-server' } } }) + '\n';
    const clientBefore = JSON.stringify({ mcpServers: { context7: { command: 'client-server' } } }) + '\n';
    await writeFile(liveRegistry, liveBefore, 'utf8');
    await writeFile(clientConfig, clientBefore, 'utf8');

    const cursorConfig: McpServerLaunchConfig = {
      command: 'node',
      args: ['context7.js'],
      env: { ZETA: 'z', ALPHA: 'a' },
      type: 'stdio',
    };
    const clineConfig: McpServerLaunchConfig = {
      command: 'node',
      args: ['context7.js'],
      env: { ALPHA: 'a', ZETA: 'z' },
      type: 'stdio',
    };
    const manifest = manifestFor([
      candidate({ name: 'context7', config: cursorConfig, sourceClient: 'cursor' }),
      candidate({ name: 'context7', config: clineConfig, sourceClient: 'cline' }),
    ]);
    expect(manifest.cutover.allowed).toBe(true);

    const stager = new CanonicalMcpMigrationStager({ dataDir });
    const first = await stager.stage(manifest);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.schemaVersion).toBe(2);
    expect(first.value.reused).toBe(false);
    expect(first.value.stagedServers).toEqual([{
      id: 'mcp:context7',
      name: 'context7',
      fingerprint: fingerprintExternalMcpValue(cursorConfig),
      config: {
        command: 'node',
        args: ['context7.js'],
        env: { ALPHA: 'a', ZETA: 'z' },
        type: 'stdio',
      },
      provenance: [
        expect.objectContaining({ sourceClient: 'cline' }),
        expect.objectContaining({ sourceClient: 'cursor' }),
      ],
      canonicalEntry: {
        kind: 'mcp_server',
        id: 'mcp:context7',
        name: 'context7',
        fingerprint: fingerprintExternalMcpValue(cursorConfig),
        enabled: true,
        compatibility: { platforms: ['linux'] },
        compatibilityState: 'compatible',
        conflict: false,
        variantFingerprints: [fingerprintExternalMcpValue(cursorConfig)],
        provenance: [
          expect.objectContaining({ sourceClient: 'cline' }),
          expect.objectContaining({ sourceClient: 'cursor' }),
        ],
      },
    }]);

    const stagedRegistry = JSON.parse(await readFile(first.value.registryPath, 'utf8')) as {
      mcpServers: Record<string, McpServerLaunchConfig>;
    };
    expect(stagedRegistry).toEqual({
      mcpServers: {
        context7: {
          command: 'node',
          args: ['context7.js'],
          env: { ALPHA: 'a', ZETA: 'z' },
          type: 'stdio',
        },
      },
    });
    expect(await readFile(liveRegistry, 'utf8')).toBe(liveBefore);
    expect(await readFile(clientConfig, 'utf8')).toBe(clientBefore);

    const second = await stager.stage(manifest);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value).toEqual({ ...first.value, reused: true });
  });

  it('hashes canonical compatibility metadata into the generation identity', async () => {
    const root = await fixtureRoot('canonical-mcp-stage-metadata-hash-');
    const dataDir = path.join(root, 'data');
    const config: McpServerLaunchConfig = { command: 'node', args: ['same.js'] };
    const platformOnly = manifestFor([
      candidate({
        name: 'same',
        config,
        sourceClient: 'cursor',
        compatibility: { platforms: ['linux'] },
      }),
    ]);
    const platformAndArchitecture = manifestFor([
      candidate({
        name: 'same',
        config,
        sourceClient: 'cursor',
        compatibility: {
          platforms: ['linux'],
          architectures: ['x64'],
          requiresCommands: ['node'],
          optionalCommands: ['rg'],
        },
      }),
    ]);

    const stager = new CanonicalMcpMigrationStager({ dataDir });
    const first = await stager.stage(platformOnly);
    const second = await stager.stage(platformAndArchitecture);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(first.value.generationId).not.toBe(second.value.generationId);
    expect(first.value.stagedServers[0]?.canonicalEntry).toMatchObject({
      compatibility: { platforms: ['linux'] },
      compatibilityState: 'compatible',
    });
    expect(second.value.stagedServers[0]?.canonicalEntry).toMatchObject({
      compatibility: {
        platforms: ['linux'],
        architectures: ['x64'],
        requiresCommands: ['node'],
        optionalCommands: ['rg'],
      },
      compatibilityState: 'compatible',
    });
  });

  it('refuses conflicting same-name MCP configs before materialization', async () => {
    const root = await fixtureRoot('canonical-mcp-conflict-');
    const dataDir = path.join(root, 'data');
    const first = candidate({
      name: 'context7',
      config: { command: 'node', args: ['first.js'] },
      sourceClient: 'cursor',
    });
    const second = candidate({
      name: 'context7',
      config: { command: 'node', args: ['second.js'] },
      sourceClient: 'cline',
    });
    const manifest = manifestFor([first, second]);
    expect(manifest.cutover.allowed).toBe(false);
    expect(manifest.entries[0]?.classification).toBe('conflict');

    const staged = await new CanonicalMcpMigrationStager({ dataDir }).stage(manifest);
    expect(staged.ok).toBe(false);
    if (!staged.ok) {
      expect(staged.error.code).toBe('INVALID_INPUT');
      expect(staged.error.message).toContain('cutover blockers');
    }
  });

  it('materializes only compatible active MCP servers and records incompatible skips', async () => {
    const root = await fixtureRoot('canonical-mcp-compatible-');
    const dataDir = path.join(root, 'data');
    const linuxConfig: McpServerLaunchConfig = { command: 'node', args: ['linux.js'] };
    const windowsConfig: McpServerLaunchConfig = { command: 'node', args: ['windows.js'] };
    const manifest = manifestFor([
      candidate({ name: 'linux-ready', config: linuxConfig, sourceClient: 'cursor' }),
      candidate({
        name: 'windows-only',
        config: windowsConfig,
        sourceClient: 'cline',
        compatibility: { platforms: ['win32'] },
      }),
    ]);
    expect(manifest.cutover.allowed).toBe(true);

    const staged = await new CanonicalMcpMigrationStager({ dataDir }).stage(manifest);
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    expect(staged.value.stagedServers.map((entry) => entry.name)).toEqual(['linux-ready']);
    expect(staged.value.skipped).toEqual([{ id: 'mcp:windows-only', reason: 'incompatible' }]);

    const registry = JSON.parse(await readFile(staged.value.registryPath, 'utf8')) as {
      mcpServers: Record<string, McpServerLaunchConfig>;
    };
    expect(Object.keys(registry.mcpServers)).toEqual(['linux-ready']);
  });

  it('fails closed instead of reusing a corrupt staged registry generation', async () => {
    const root = await fixtureRoot('canonical-mcp-corrupt-');
    const dataDir = path.join(root, 'data');
    const manifest = manifestFor([
      candidate({
        name: 'context7',
        config: { command: 'node', args: ['context7.js'] },
        sourceClient: 'cursor',
      }),
    ]);
    const stager = new CanonicalMcpMigrationStager({ dataDir });
    const first = await stager.stage(manifest);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    await writeFile(first.value.registryPath, '{"mcpServers":{}}\n', 'utf8');
    const second = await stager.stage(manifest);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe('INVALID_INPUT');
      expect(second.error.message).toContain('registry is corrupt');
    }
  });

  it('produces the same generation when inventory discovery order changes', async () => {
    const root = await fixtureRoot('canonical-mcp-order-');
    const dataDir = path.join(root, 'data');
    const inventory = [
      candidate({ name: 'alpha', config: { command: 'node', args: ['alpha.js'] }, sourceClient: 'cursor' }),
      candidate({ name: 'beta', config: { command: 'node', args: ['beta.js'] }, sourceClient: 'cline' }),
    ];
    const forward = manifestFor(inventory);
    const reverse = manifestFor([...inventory].reverse());
    expect(reverse).toEqual(forward);

    const stager = new CanonicalMcpMigrationStager({ dataDir });
    const first = await stager.stage(forward);
    const second = await stager.stage(reverse);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.generationId).toBe(first.value.generationId);
    expect(second.value.registryPath).toBe(first.value.registryPath);
    expect(second.value.reused).toBe(true);
  });
});
