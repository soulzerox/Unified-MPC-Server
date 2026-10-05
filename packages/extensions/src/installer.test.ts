import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CanonicalExtensionRegistry } from './canonical-extension-registry.js';
import { fingerprintCanonicalSkillDirectory } from './canonical-skill-migration-stager.js';
import { InstallerService, type InstallSkillInput } from './installer.js';

const temporaryRoots: string[] = [];
const FIXTURE_REVISION = '0123456789abcdef0123456789abcdef01234567';

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function fixtureGitRunner(
  fixtureDir: string,
  revision = FIXTURE_REVISION,
): { run(args: readonly string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> } {
  return {
    async run(args: readonly string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
      if (args.includes('rev-parse')) return { exitCode: 0, stdout: `${revision}\n`, stderr: '' };
      if (args[0] !== 'clone') return { exitCode: 1, stdout: '', stderr: `unsupported git command: ${args[0] ?? ''}` };
      const destination = args.at(-1);
      if (destination === undefined) return { exitCode: 1, stdout: '', stderr: 'missing clone destination' };
      await cp(fixtureDir, destination, { recursive: true });
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  };
}

describe('InstallerService - Skill Ingestion Pipeline', () => {
  it('installs a skill into the canonical unified-mpc store without touching IDE catalogs', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'installer-parent-skill-'));
    temporaryRoots.push(root);
    const home = path.join(root, 'home');
    const dataDir = path.join(root, 'data');
    const sourceDir = path.join(root, 'source-skill');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(path.join(sourceDir, 'SKILL.md'), '---\nname: parent-skill\ndescription: Parent-owned skill\n---\n# Parent Skill\n', 'utf8');

    const result = await new InstallerService({ homeDir: home, dataDir }).installSkill({
      name: 'parent-skill',
      source: sourceDir,
      targets: ['unified-mpc' as never],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.installedPaths).toEqual([path.join(dataDir, 'extensions', 'skills', 'parent-skill', 'SKILL.md')]);
    expect(await readFile(result.value.installedPaths[0]!, 'utf8')).toContain('# Parent Skill');
    await expect(readFile(path.join(home, '.cursor', 'skills', 'parent-skill', 'SKILL.md'), 'utf8')).rejects.toThrow();
    await expect(readFile(path.join(home, '.cline', 'skills', 'parent-skill', 'SKILL.md'), 'utf8')).rejects.toThrow();
  });

  it('persists canonical Skill installed-state, preserves MCP entries, and keeps identical installs idempotent', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'installer-canonical-skill-registry-'));
    temporaryRoots.push(root);
    const home = path.join(root, 'home');
    const dataDir = path.join(root, 'data');
    const sourceDir = path.join(root, 'source-skill');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(
      path.join(sourceDir, 'SKILL.md'),
      '---\nname: persisted-skill\ndescription: Persisted canonical skill\n---\n# Persisted Skill\n',
      'utf8',
    );

    const registry = new CanonicalExtensionRegistry({ dataDir });
    const seeded = await registry.upsertAtomically({
      kind: 'mcp_server',
      id: 'mcp:existing-child',
      name: 'existing-child',
      fingerprint: 'c'.repeat(64),
      enabled: true,
      provenance: {
        originType: 'managed',
        origin: 'unified-mpc:mcp_install',
      },
    }, {
      platform: 'linux',
      architecture: 'x64',
      availableCommands: new Set(),
    }, [], async () => undefined);
    expect(seeded.ok).toBe(true);

    const fingerprint = await fingerprintCanonicalSkillDirectory(sourceDir);
    expect(fingerprint.ok).toBe(true);
    if (!fingerprint.ok) return;

    const installer = new InstallerService({ homeDir: home, dataDir });
    const first = await installer.installSkill({
      name: 'persisted-skill',
      source: sourceDir,
      targets: ['unified-mpc'],
    });
    expect(first.ok).toBe(true);

    const afterFirst = await registry.load();
    expect(afterFirst.ok).toBe(true);
    if (!afterFirst.ok) return;
    expect(afterFirst.value.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'mcp_server',
        id: 'mcp:existing-child',
        fingerprint: 'c'.repeat(64),
      }),
      expect.objectContaining({
        kind: 'skill',
        id: 'skill:persisted-skill',
        name: 'persisted-skill',
        fingerprint: fingerprint.value,
        enabled: true,
        provenance: [expect.objectContaining({
          originType: 'local-import',
          origin: sourceDir,
          contentSha256: fingerprint.value,
        })],
      }),
    ]));
    const generation = afterFirst.value.generation;

    const second = await installer.installSkill({
      name: 'persisted-skill',
      source: sourceDir,
      targets: ['unified-mpc'],
    });
    expect(second.ok).toBe(true);

    const afterSecond = await registry.load();
    expect(afterSecond.ok).toBe(true);
    if (!afterSecond.ok) return;
    expect(afterSecond.value.generation).toBe(generation);
    expect(afterSecond.value.entries).toEqual(afterFirst.value.entries);
  });

  it('preserves the working canonical Skill copy and registry when staged validation fails', async () => {
    const { symlink } = await import('node:fs/promises');
    const root = await mkdtemp(path.join(os.tmpdir(), 'installer-canonical-skill-rollback-'));
    temporaryRoots.push(root);
    const home = path.join(root, 'home');
    const dataDir = path.join(root, 'data');
    const originalDir = path.join(root, 'original-skill');
    const replacementDir = path.join(root, 'replacement-skill');
    const outside = path.join(root, 'outside.txt');
    await mkdir(originalDir, { recursive: true });
    await mkdir(replacementDir, { recursive: true });
    await writeFile(
      path.join(originalDir, 'SKILL.md'),
      '---\nname: rollback-skill\ndescription: Original\n---\n# Original Skill\n',
      'utf8',
    );
    await writeFile(
      path.join(replacementDir, 'SKILL.md'),
      '---\nname: rollback-skill\ndescription: Replacement\n---\n# Replacement Skill\n',
      'utf8',
    );
    await writeFile(outside, 'outside\n', 'utf8');
    await symlink(outside, path.join(replacementDir, 'unsafe-link'));

    const installer = new InstallerService({ homeDir: home, dataDir });
    const installed = await installer.installSkill({
      name: 'rollback-skill',
      source: originalDir,
      targets: ['unified-mpc'],
    });
    expect(installed.ok).toBe(true);

    const registry = new CanonicalExtensionRegistry({ dataDir });
    const before = await registry.load();
    expect(before.ok).toBe(true);
    if (!before.ok) return;

    const replacement = await installer.installSkill({
      name: 'rollback-skill',
      source: replacementDir,
      targets: ['unified-mpc'],
    });
    expect(replacement.ok).toBe(false);
    expect(await readFile(
      path.join(dataDir, 'extensions', 'skills', 'rollback-skill', 'SKILL.md'),
      'utf8',
    )).toContain('# Original Skill');
    expect(await registry.load()).toEqual(before);
  });

  it('preserves the working canonical Skill copy and registry when activation cannot swap directories', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'installer-canonical-skill-activation-failure-'));
    temporaryRoots.push(root);
    const home = path.join(root, 'home');
    const dataDir = path.join(root, 'data');
    const originalDir = path.join(root, 'original-skill');
    const replacementDir = path.join(root, 'replacement-skill');
    await mkdir(originalDir, { recursive: true });
    await mkdir(replacementDir, { recursive: true });
    await writeFile(
      path.join(originalDir, 'SKILL.md'),
      '---\nname: activation-skill\ndescription: Original\n---\n# Original Skill\n',
      'utf8',
    );
    await writeFile(
      path.join(replacementDir, 'SKILL.md'),
      '---\nname: activation-skill\ndescription: Replacement\n---\n# Replacement Skill\n',
      'utf8',
    );

    const installer = new InstallerService({ homeDir: home, dataDir });
    const installed = await installer.installSkill({
      name: 'activation-skill',
      source: originalDir,
      targets: ['unified-mpc'],
    });
    expect(installed.ok).toBe(true);

    const registry = new CanonicalExtensionRegistry({ dataDir });
    const before = await registry.load();
    expect(before.ok).toBe(true);
    if (!before.ok) return;

    const backupRoot = path.join(dataDir, 'extensions', 'state', 'skill-install-backups');
    await writeFile(backupRoot, 'block directory creation\n', 'utf8');

    const replacementResult = await installer.installSkill({
      name: 'activation-skill',
      source: replacementDir,
      targets: ['unified-mpc'],
    });
    expect(replacementResult.ok).toBe(false);
    expect(await readFile(
      path.join(dataDir, 'extensions', 'skills', 'activation-skill', 'SKILL.md'),
      'utf8',
    )).toContain('# Original Skill');
    expect(await registry.load()).toEqual(before);
  });

  it('rejects a declared incompatible skill before copying it into the canonical store', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'installer-incompatible-skill-'));
    temporaryRoots.push(root);
    const home = path.join(root, 'home');
    const dataDir = path.join(root, 'data');
    const sourceDir = path.join(root, 'source-skill');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(path.join(sourceDir, 'SKILL.md'), '---\nname: windows-skill\ndescription: Windows-only skill\n---\n# Windows Skill\n', 'utf8');
    await writeFile(path.join(sourceDir, 'manifest.json'), JSON.stringify({
      compatibility: { platforms: ['win32'] },
    }), 'utf8');

    const result = await new InstallerService({
      homeDir: home,
      dataDir,
      platform: 'linux',
      architecture: 'x64',
      availableCommands: new Set(),
    }).installSkill({
      name: 'windows-skill',
      source: sourceDir,
      targets: ['unified-mpc'],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('UNSUPPORTED_PLATFORM');
      expect(result.error.message).toContain('linux');
      expect(result.error.message).toContain('win32');
    }
    await expect(readFile(path.join(dataDir, 'extensions', 'skills', 'windows-skill', 'SKILL.md'), 'utf8')).rejects.toThrow();
  });

  it('rejects a skill with missing declared runtime commands before copying it', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'installer-missing-command-skill-'));
    temporaryRoots.push(root);
    const home = path.join(root, 'home');
    const dataDir = path.join(root, 'data');
    const sourceDir = path.join(root, 'source-skill');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(path.join(sourceDir, 'SKILL.md'), '# Command Skill\n', 'utf8');
    await writeFile(path.join(sourceDir, 'manifest.json'), JSON.stringify({
      compatibility: { platforms: ['linux'], requiresCommands: ['missing-tool'] },
    }), 'utf8');

    const result = await new InstallerService({
      homeDir: home,
      dataDir,
      platform: 'linux',
      architecture: 'x64',
      availableCommands: new Set(),
    }).installSkill({
      name: 'command-skill',
      source: sourceDir,
      targets: ['unified-mpc'],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('EXECUTABLE_NOT_FOUND');
      expect(result.error.message).toContain('missing-tool');
    }
    await expect(readFile(path.join(dataDir, 'extensions', 'skills', 'command-skill', 'SKILL.md'), 'utf8')).rejects.toThrow();
  });

  it('accepts a skill whose declared compatibility matches the current host', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'installer-compatible-skill-'));
    temporaryRoots.push(root);
    const home = path.join(root, 'home');
    const dataDir = path.join(root, 'data');
    const sourceDir = path.join(root, 'source-skill');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(path.join(sourceDir, 'SKILL.md'), '# Linux Skill\n', 'utf8');
    await writeFile(path.join(sourceDir, 'manifest.json'), JSON.stringify({
      compatibility: {
        platforms: ['linux'],
        architectures: ['x64'],
        requiresCommands: ['node'],
      },
    }), 'utf8');

    const result = await new InstallerService({
      homeDir: home,
      dataDir,
      platform: 'linux',
      architecture: 'x64',
      availableCommands: new Set(['node']),
    }).installSkill({
      name: 'linux-skill',
      source: sourceDir,
      targets: ['unified-mpc'],
    });

    expect(result.ok).toBe(true);
    expect(await readFile(path.join(dataDir, 'extensions', 'skills', 'linux-skill', 'SKILL.md'), 'utf8')).toContain('# Linux Skill');
  });

  it('materializes an HTTPS Git repository before installing a skill', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'installer-remote-skill-'));
    temporaryRoots.push(root);
    const fixture = path.join(root, 'fixture');
    const home = path.join(root, 'home');
    await mkdir(fixture, { recursive: true });
    await writeFile(path.join(fixture, 'SKILL.md'), '---\nname: remote-skill\ndescription: Remote fixture\n---\n# Remote Skill\n', 'utf8');

    const installer = new InstallerService({ homeDir: home, gitRunner: fixtureGitRunner(fixture) });
    const result = await installer.installSkill({
      name: 'remote-skill',
      source: 'https://github.com/example/remote-skill.git',
      targets: ['cursor'],
    });

    expect(result.ok).toBe(true);
    expect(await readFile(path.join(home, '.cursor', 'skills', 'remote-skill', 'SKILL.md'), 'utf8')).toContain('# Remote Skill');
  });

  it('does not copy Git metadata from a remote skill checkout into installed targets', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'installer-remote-skill-git-'));
    temporaryRoots.push(root);
    const fixture = path.join(root, 'fixture');
    const home = path.join(root, 'home');
    await mkdir(path.join(fixture, '.git'), { recursive: true });
    await writeFile(path.join(fixture, 'SKILL.md'), '---\nname: remote-skill\ndescription: Remote fixture\n---\n# Remote Skill\n', 'utf8');
    await writeFile(path.join(fixture, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');

    const result = await new InstallerService({ homeDir: home, gitRunner: fixtureGitRunner(fixture) }).installSkill({
      name: 'remote-skill',
      source: 'https://github.com/example/remote-skill.git',
      targets: ['cursor'],
    });

    expect(result.ok).toBe(true);
    await expect(readFile(path.join(home, '.cursor', 'skills', 'remote-skill', '.git', 'HEAD'), 'utf8')).rejects.toThrow();
  });

  it('rejects symlinks from untrusted remote skill repositories', async () => {
    const { symlink } = await import('node:fs/promises');
    const root = await mkdtemp(path.join(os.tmpdir(), 'installer-remote-skill-link-'));
    temporaryRoots.push(root);
    const fixture = path.join(root, 'fixture');
    const home = path.join(root, 'home');
    const outside = path.join(root, 'outside.txt');
    await mkdir(fixture, { recursive: true });
    await writeFile(path.join(fixture, 'SKILL.md'), '---\nname: remote-skill\ndescription: Remote fixture\n---\n# Remote Skill\n', 'utf8');
    await writeFile(outside, 'outside\n', 'utf8');
    await symlink(outside, path.join(fixture, 'outside-link'));

    const result = await new InstallerService({ homeDir: home, gitRunner: fixtureGitRunner(fixture) }).installSkill({
      name: 'remote-skill',
      source: 'https://github.com/example/remote-skill.git',
      targets: ['cursor'],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_INPUT');
      expect(result.error.message).toContain('symbolic links');
    }
  });

  it('returns FILE_NOT_FOUND when source does not contain SKILL.md', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'installer-test-'));
    temporaryRoots.push(root);
    const home = path.join(root, 'home');
    const emptySource = path.join(root, 'empty-dir');
    await mkdir(home, { recursive: true });
    await mkdir(emptySource, { recursive: true });

    const installer = new InstallerService({ homeDir: home });
    const input: InstallSkillInput = {
      name: 'broken-skill',
      source: emptySource,
      targets: ['antigravity'],
    };

    const result = await installer.installSkill(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FILE_NOT_FOUND');
      expect(result.error.message).toContain('SKILL.md');
    }
  });

  it('installs skill into global targets (antigravity, cline, cursor, claude, opencode)', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'installer-test-'));
    temporaryRoots.push(root);
    const home = path.join(root, 'home');
    const sourceDir = path.join(root, 'source-skill');
    await mkdir(home, { recursive: true });
    await mkdir(sourceDir, { recursive: true });

    await writeFile(
      path.join(sourceDir, 'SKILL.md'),
      '---\nname: my-skill\ndescription: Test skill description\n---\n# My Skill\nRun commands.\n',
      'utf8',
    );
    await writeFile(path.join(sourceDir, 'helper.sh'), '#!/bin/bash\necho "hello"\n', 'utf8');

    const installer = new InstallerService({ homeDir: home });
    const result = await installer.installSkill({
      name: 'my-skill',
      source: sourceDir,
      targets: ['antigravity', 'cline', 'cursor', 'claude', 'opencode'],
      scope: 'global',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.name).toBe('my-skill');
    expect(result.value.installedPaths).toHaveLength(5);

    // Verify Antigravity global
    const agSkill = path.join(home, '.gemini', 'config', 'skills', 'my-skill', 'SKILL.md');
    const agContent = await readFile(agSkill, 'utf8');
    expect(agContent).toContain('# My Skill');

    // Verify Cline global
    const clineSkill = path.join(home, '.cline', 'skills', 'my-skill', 'SKILL.md');
    const clineContent = await readFile(clineSkill, 'utf8');
    expect(clineContent).toContain('# My Skill');

    // Verify Cursor global
    const cursorSkill = path.join(home, '.cursor', 'skills', 'my-skill', 'SKILL.md');
    const cursorContent = await readFile(cursorSkill, 'utf8');
    expect(cursorContent).toContain('# My Skill');

    // Verify Claude global
    const claudeSkill = path.join(home, '.claude', 'skills', 'my-skill', 'SKILL.md');
    const claudeContent = await readFile(claudeSkill, 'utf8');
    expect(claudeContent).toContain('# My Skill');

    // Verify OpenCode global
    const opencodeSkill = path.join(home, '.config', 'opencode', 'skill', 'my-skill', 'SKILL.md');
    const opencodeContent = await readFile(opencodeSkill, 'utf8');
    expect(opencodeContent).toContain('# My Skill');

    // Verify companion files copied
    const helperFile = path.join(home, '.gemini', 'config', 'skills', 'my-skill', 'helper.sh');
    const helperContent = await readFile(helperFile, 'utf8');
    expect(helperContent).toContain('echo "hello"');
  });

  it('installs skill into workspace targets when scope is workspace', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'installer-test-ws-'));
    temporaryRoots.push(root);
    const home = path.join(root, 'home');
    const workspace = path.join(root, 'workspace');
    const sourceDir = path.join(root, 'ws-skill');
    await mkdir(home, { recursive: true });
    await mkdir(workspace, { recursive: true });
    await mkdir(sourceDir, { recursive: true });

    await writeFile(
      path.join(sourceDir, 'SKILL.md'),
      '---\nname: ws-tool\ndescription: Workspace tool\n---\n# WS Tool\n',
      'utf8',
    );

    const installer = new InstallerService({
      homeDir: home,
      workspaceRoot: workspace,
    });

    const result = await installer.installSkill({
      name: 'ws-tool',
      source: sourceDir,
      targets: ['all'],
      scope: 'workspace',
      workspaceRoot: workspace,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Verify workspace paths
    const wsAg = path.join(workspace, '.gemini', 'skills', 'ws-tool', 'SKILL.md');
    expect(await readFile(wsAg, 'utf8')).toContain('# WS Tool');

    const wsCline = path.join(workspace, '.cline', 'skills', 'ws-tool', 'SKILL.md');
    expect(await readFile(wsCline, 'utf8')).toContain('# WS Tool');

    const wsCursor = path.join(workspace, '.cursor', 'skills', 'ws-tool', 'SKILL.md');
    expect(await readFile(wsCursor, 'utf8')).toContain('# WS Tool');

    const wsClaude = path.join(workspace, '.claude', 'skills', 'ws-tool', 'SKILL.md');
    expect(await readFile(wsClaude, 'utf8')).toContain('# WS Tool');

    const wsOpenCode = path.join(workspace, '.opencode', 'skills', 'ws-tool', 'SKILL.md');
    expect(await readFile(wsOpenCode, 'utf8')).toContain('# WS Tool');
  });
});

describe('InstallerService - Server Ingestion Pipeline', () => {
  it('registers a child MCP server in the canonical unified-mpc registry without touching IDE configs', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'installer-parent-mcp-'));
    temporaryRoots.push(root);
    const home = path.join(root, 'home');
    const dataDir = path.join(root, 'data');

    const result = await new InstallerService({ homeDir: home, dataDir }).installServer({
      name: 'parent-child',
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      targets: ['unified-mpc' as never],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const registryFile = path.join(dataDir, 'extensions', 'mcp', 'registry.json');
    expect(result.value.updatedConfigFiles).toEqual([registryFile]);
    const registry = JSON.parse(await readFile(registryFile, 'utf8'));
    expect(registry.mcpServers['parent-child']).toEqual({ command: 'node', args: ['server.js'] });
    const canonicalState = JSON.parse(await readFile(path.join(dataDir, 'extensions', 'state', 'registry.json'), 'utf8'));
    expect(canonicalState).toMatchObject({
      schemaVersion: 1,
      generation: 1,
      entries: [{
        kind: 'mcp_server',
        id: 'mcp:parent-child',
        name: 'parent-child',
        enabled: true,
        compatibilityState: 'unknown',
        conflict: false,
        provenance: [{
          originType: 'managed',
          origin: 'unified-mpc:mcp_install',
        }],
      }],
    });
    const canonicalEntry = canonicalState.entries[0];
    expect(canonicalEntry.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(canonicalEntry.variantFingerprints).toEqual([canonicalEntry.fingerprint]);

    const repeated = await new InstallerService({ homeDir: home, dataDir }).installServer({
      name: 'parent-child',
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      targets: ['unified-mpc'],
    });
    expect(repeated.ok).toBe(true);
    const repeatedState = JSON.parse(await readFile(path.join(dataDir, 'extensions', 'state', 'registry.json'), 'utf8'));
    expect(repeatedState.generation).toBe(1);
    expect(repeatedState.entries).toEqual(canonicalState.entries);

    await expect(readFile(path.join(home, '.cursor', 'mcp.json'), 'utf8')).rejects.toThrow();
    await expect(readFile(path.join(home, '.cline', 'mcp.json'), 'utf8')).rejects.toThrow();
  });

  it('fails closed before MCP config writes when canonical installed-state registry is invalid', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'installer-invalid-canonical-registry-'));
    temporaryRoots.push(root);
    const home = path.join(root, 'home');
    const dataDir = path.join(root, 'data');
    const canonicalRegistryFile = path.join(dataDir, 'extensions', 'state', 'registry.json');
    await mkdir(path.dirname(canonicalRegistryFile), { recursive: true });
    const invalidRegistry = JSON.stringify({
      schemaVersion: 1,
      generation: 1,
      entries: [{ kind: 'mcp_server' }],
    });
    await writeFile(canonicalRegistryFile, invalidRegistry, 'utf8');

    const result = await new InstallerService({ homeDir: home, dataDir }).installServer({
      name: 'blocked-child',
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      targets: ['unified-mpc'],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_INPUT');
    expect(await readFile(canonicalRegistryFile, 'utf8')).toBe(invalidRegistry);
    await expect(
      readFile(path.join(dataDir, 'extensions', 'mcp', 'registry.json'), 'utf8'),
    ).rejects.toThrow();
  });

  it('rejects a declared incompatible managed MCP source before registering it', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'installer-incompatible-mcp-'));
    temporaryRoots.push(root);
    const fixture = path.join(root, 'fixture');
    const home = path.join(root, 'home');
    const dataDir = path.join(root, 'data');
    await mkdir(fixture, { recursive: true });
    await writeFile(path.join(fixture, 'package.json'), JSON.stringify({ name: 'windows-mcp', bin: 'server.js' }), 'utf8');
    await writeFile(path.join(fixture, 'server.js'), '#!/usr/bin/env node\n', 'utf8');
    await writeFile(path.join(fixture, 'manifest.json'), JSON.stringify({
      compatibility: { platforms: ['win32'] },
    }), 'utf8');

    const result = await new InstallerService({
      homeDir: home,
      dataDir,
      gitRunner: fixtureGitRunner(fixture),
      platform: 'linux',
      architecture: 'x64',
      availableCommands: new Set(['node']),
    }).installServer({
      name: 'windows-mcp',
      transport: 'stdio',
      source: 'https://github.com/example/windows-mcp.git',
      targets: ['unified-mpc'],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('UNSUPPORTED_PLATFORM');
    await expect(readFile(path.join(dataDir, 'extensions', 'mcp', 'registry.json'), 'utf8')).rejects.toThrow();
    const versionsDirectory = path.join(dataDir, 'extensions', 'mcp', 'windows-mcp', 'versions');
    expect(await readdir(versionsDirectory)).toEqual([]);
  });

  it('materializes an HTTPS Git repository and derives a stdio command from package.json bin', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'installer-remote-server-'));
    temporaryRoots.push(root);
    const fixture = path.join(root, 'fixture');
    const home = path.join(root, 'home');
    const dataDir = path.join(root, 'data');
    await mkdir(fixture, { recursive: true });
    await writeFile(path.join(fixture, 'package.json'), JSON.stringify({ name: 'remote-mcp', bin: 'server.js' }), 'utf8');
    await writeFile(path.join(fixture, 'server.js'), '#!/usr/bin/env node\n', 'utf8');

    const installer = new InstallerService({ homeDir: home, dataDir, gitRunner: fixtureGitRunner(fixture) });
    const result = await installer.installServer({
      name: 'remote-mcp',
      transport: 'stdio',
      source: 'https://github.com/example/remote-mcp.git',
      targets: ['cursor'],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.managedSourcePath).toEqual(expect.any(String));
    const config = JSON.parse(await readFile(path.join(home, '.cursor', 'mcp.json'), 'utf8'));
    expect(config.mcpServers['remote-mcp']).toEqual({
      command: process.execPath,
      args: [path.join(result.value.managedSourcePath, 'server.js')],
      cwd: result.value.managedSourcePath,
    });
    await expect(
      readFile(path.join(dataDir, 'extensions', 'state', 'registry.json'), 'utf8'),
    ).rejects.toThrow();
  });

  it('records immutable Git provenance and an atomic current-version marker for managed child MCP source', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'installer-remote-server-provenance-'));
    temporaryRoots.push(root);
    const fixture = path.join(root, 'fixture');
    const home = path.join(root, 'home');
    const dataDir = path.join(root, 'data');
    await mkdir(fixture, { recursive: true });
    await writeFile(path.join(fixture, 'package.json'), JSON.stringify({ name: 'remote-mcp', bin: 'server.js' }), 'utf8');
    await writeFile(path.join(fixture, 'server.js'), '#!/usr/bin/env node\nconsole.log("v1")\n', 'utf8');
    await writeFile(path.join(fixture, 'manifest.json'), JSON.stringify({
      compatibility: {
        platforms: ['linux'],
        architectures: ['x64'],
        requiresCommands: ['node'],
        optionalCommands: ['rg'],
      },
    }), 'utf8');

    const result = await new InstallerService({
      homeDir: home,
      dataDir,
      gitRunner: fixtureGitRunner(fixture),
      platform: 'linux',
      architecture: 'x64',
      availableCommands: new Set(['node']),
    }).installServer({
      name: 'remote-mcp',
      transport: 'stdio',
      source: 'https://github.com/example/remote-mcp.git',
      targets: ['unified-mpc'],
    });

    expect(result.ok).toBe(true);
    if (!result.ok || result.value.managedSourcePath === undefined) return;
    expect(result.value.sourceRevision).toBe(FIXTURE_REVISION);
    expect(result.value.sourceContentSha256).toMatch(/^[a-f0-9]{64}$/);
    const versionRoot = path.dirname(result.value.managedSourcePath);
    const provenance = JSON.parse(await readFile(path.join(versionRoot, 'provenance.json'), 'utf8'));
    expect(provenance).toMatchObject({
      version: 1,
      source: 'https://github.com/example/remote-mcp.git',
      revision: FIXTURE_REVISION,
      contentSha256: result.value.sourceContentSha256,
      versionId: path.basename(versionRoot),
    });
    const current = JSON.parse(await readFile(path.join(dataDir, 'extensions', 'mcp', 'remote-mcp', 'current.json'), 'utf8'));
    expect(current).toEqual(provenance);

    const canonicalState = JSON.parse(await readFile(path.join(dataDir, 'extensions', 'state', 'registry.json'), 'utf8'));
    expect(canonicalState).toMatchObject({
      schemaVersion: 1,
      generation: 1,
      entries: [{
        kind: 'mcp_server',
        id: 'mcp:remote-mcp',
        name: 'remote-mcp',
        enabled: true,
        compatibility: {
          platforms: ['linux'],
          architectures: ['x64'],
          requiresCommands: ['node'],
          optionalCommands: ['rg'],
        },
        compatibilityState: 'compatible',
        conflict: false,
        provenance: [{
          originType: 'github',
          origin: 'https://github.com/example/remote-mcp.git',
          revision: FIXTURE_REVISION,
          contentSha256: result.value.sourceContentSha256,
        }],
      }],
    });
  });

  it('retains referenced managed versions while collecting only excess unreferenced versions', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'installer-remote-server-retention-'));
    temporaryRoots.push(root);
    const fixture = path.join(root, 'fixture');
    const home = path.join(root, 'home');
    const dataDir = path.join(root, 'data');
    await mkdir(fixture, { recursive: true });
    await writeFile(path.join(fixture, 'package.json'), JSON.stringify({ name: 'remote-mcp', bin: 'server.js' }), 'utf8');

    const install = async (revisionDigit: string, label: string, targets: readonly ('cursor' | 'unified-mpc')[]): ReturnType<InstallerService['installServer']> => {
      await writeFile(path.join(fixture, 'server.js'), `#!/usr/bin/env node\nconsole.log(${JSON.stringify(label)})\n`, 'utf8');
      return new InstallerService({
        homeDir: home,
        dataDir,
        gitRunner: fixtureGitRunner(fixture, revisionDigit.repeat(40)),
      }).installServer({
        name: 'remote-mcp',
        transport: 'stdio',
        source: 'https://github.com/example/remote-mcp.git',
        targets,
      });
    };

    const exported = await install('1', 'exported-v1', ['cursor']);
    expect(exported.ok).toBe(true);
    if (!exported.ok || exported.value.managedSourcePath === undefined) return;
    const exportedVersionRoot = path.dirname(exported.value.managedSourcePath);

    for (const [digit, label] of [['2', 'parent-v2'], ['3', 'parent-v3'], ['4', 'parent-v4'], ['5', 'parent-v5']] as const) {
      const installed = await install(digit, label, ['unified-mpc']);
      expect(installed.ok).toBe(true);
    }

    const versionsDirectory = path.join(dataDir, 'extensions', 'mcp', 'remote-mcp', 'versions');
    const retained = (await readdir(versionsDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    expect(retained).toHaveLength(4);
    expect(retained).toContain(path.basename(exportedVersionRoot));
    const cursorConfig = await readFile(path.join(home, '.cursor', 'mcp.json'), 'utf8');
    expect(cursorConfig).toContain(exported.value.managedSourcePath);
  });

  it('fails closed for remote MCP packages that require runtime dependency installation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'installer-remote-server-deps-'));
    temporaryRoots.push(root);
    const fixture = path.join(root, 'fixture');
    const home = path.join(root, 'home');
    await mkdir(fixture, { recursive: true });
    await writeFile(path.join(fixture, 'package.json'), JSON.stringify({
      name: 'remote-mcp',
      bin: 'server.js',
      dependencies: { express: '^5.0.0' },
    }), 'utf8');
    await writeFile(path.join(fixture, 'server.js'), '#!/usr/bin/env node\n', 'utf8');

    const result = await new InstallerService({ homeDir: home, gitRunner: fixtureGitRunner(fixture) }).installServer({
      name: 'remote-mcp',
      transport: 'stdio',
      source: 'https://github.com/example/remote-mcp.git',
      targets: ['cursor'],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_INPUT');
      expect(result.error.message).toContain('runtime dependencies');
    }
  });

  it('rejects self-aggregation attempts to install unified-mpc', async () => {
    const installer = new InstallerService();
    const result = await installer.installServer({
      name: 'unified-mpc',
      transport: 'stdio',
      command: 'node',
      targets: ['antigravity'],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_INPUT');
      expect(result.error.message).toContain('Refusing to aggregate unified-mpc itself');
    }
  });

  it('rejects unsupported targets instead of reporting a no-op success', async () => {
    const installer = new InstallerService({ homeDir: '/tmp/unified-mpc-installer-test' });
    const result = await installer.installServer({
      name: 'fixture',
      transport: 'stdio',
      command: 'node',
      targets: ['not-a-target' as never],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('UNSUPPORTED_TARGET');
      expect(result.error.message).toContain('not-a-target');
      expect(result.error.message).toContain('antigravity');
    }
  });

  it('rejects stdio server when command is missing', async () => {
    const installer = new InstallerService();
    const result = await installer.installServer({
      name: 'broken-server',
      transport: 'stdio',
      targets: ['cursor'],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_INPUT');
      expect(result.error.message).toContain('Command is required');
    }
  });

  it('rejects invalid server identifiers, transports, and scopes at runtime', async () => {
    const installer = new InstallerService();
    const cases = [
      { name: 'bad/name', transport: 'stdio', command: 'node', targets: ['cursor'] },
      { name: 'fixture', transport: 'ws', url: 'https://example.com', targets: ['cursor'] },
      { name: 'fixture', transport: 'stdio', command: 'node', targets: ['cursor'], scope: 'machine' },
    ] as const;
    for (const input of cases) {
      const result = await installer.installServer(input as never);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('INVALID_INPUT');
    }
  });

  it('fails closed instead of replacing malformed config with an empty config', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'installer-malformed-'));
    temporaryRoots.push(root);
    const home = path.join(root, 'home');
    const cursorDir = path.join(home, '.cursor');
    await mkdir(cursorDir, { recursive: true });
    const configFile = path.join(cursorDir, 'mcp.json');
    await writeFile(configFile, '{ malformed', 'utf8');

    const result = await new InstallerService({ homeDir: home }).installServer({
      name: 'fixture', transport: 'stdio', command: 'node', targets: ['cursor'], scope: 'global',
    });
    expect(result.ok).toBe(false);
    expect(await readFile(configFile, 'utf8')).toBe('{ malformed');
  });

  it('rolls back earlier target config writes when a later target fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'installer-rollback-'));
    temporaryRoots.push(root);
    const home = path.join(root, 'home');
    const appData = path.join(home, '.config');
    const claudeFile = path.join(appData, 'Claude', 'claude_desktop_config.json');
    await mkdir(path.dirname(claudeFile), { recursive: true });
    await writeFile(claudeFile, '{ malformed', 'utf8');

    const cursorFile = path.join(home, '.cursor', 'mcp.json');
    const result = await new InstallerService({ homeDir: home, appDataDir: appData }).installServer({
      name: 'rollback-server',
      transport: 'stdio',
      command: 'node',
      targets: ['cursor', 'claude'],
      scope: 'global',
    });

    expect(result.ok).toBe(false);
    await expect(readFile(cursorFile, 'utf8')).rejects.toThrow();
    expect(await readFile(claudeFile, 'utf8')).toBe('{ malformed');
  });

  it('installs stdio server into global target configs (antigravity, cursor, claude, cline, opencode)', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'installer-srv-test-'));
    temporaryRoots.push(root);
    const home = path.join(root, 'home');
    const appData = path.join(home, '.config');
    await mkdir(home, { recursive: true });

    // Pre-create some configs to test merging
    const agConfigDir = path.join(home, '.gemini', 'config');
    await mkdir(agConfigDir, { recursive: true });
    await writeFile(path.join(agConfigDir, 'mcp_config.json'), JSON.stringify({
      mcpServers: { 'existing-server': { command: 'existing-bin' } },
    }), 'utf8');

    const installer = new InstallerService({
      homeDir: home,
      appDataDir: appData,
    });

    const result = await installer.installServer({
      name: 'playwright-tool',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@playwright/mcp'],
      env: { DEBUG: 'pw:*' },
      targets: ['antigravity', 'cursor', 'claude', 'cline', 'opencode'],
      scope: 'global',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.name).toBe('playwright-tool');
    expect(result.value.updatedConfigFiles).toHaveLength(5);

    // 1. Antigravity config
    const agContent = JSON.parse(await readFile(path.join(agConfigDir, 'mcp_config.json'), 'utf8'));
    expect(agContent.mcpServers['existing-server']).toBeDefined();
    expect(agContent.mcpServers['playwright-tool']).toEqual({
      command: 'npx',
      args: ['-y', '@playwright/mcp'],
      env: { DEBUG: 'pw:*' },
    });

    // 2. Cursor config
    const cursorFile = path.join(home, '.cursor', 'mcp.json');
    const cursorContent = JSON.parse(await readFile(cursorFile, 'utf8'));
    expect(cursorContent.mcpServers['playwright-tool'].command).toBe('npx');

    // 3. Claude config
    const claudeFile = path.join(appData, 'Claude', 'claude_desktop_config.json');
    const claudeContent = JSON.parse(await readFile(claudeFile, 'utf8'));
    expect(claudeContent.mcpServers['playwright-tool'].command).toBe('npx');

    // 4. Cline config
    const clineFile = path.join(appData, 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json');
    const clineContent = JSON.parse(await readFile(clineFile, 'utf8'));
    expect(clineContent.mcpServers['playwright-tool'].command).toBe('npx');

    // 5. OpenCode config
    const opencodeFile = path.join(home, '.config', 'opencode', 'opencode.json');
    const opencodeContent = JSON.parse(await readFile(opencodeFile, 'utf8'));
    expect(opencodeContent.mcpServers['playwright-tool'].command).toBe('npx');
  });

  it('installs server into workspace target configs when scope is workspace', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'installer-srv-ws-'));
    temporaryRoots.push(root);
    const home = path.join(root, 'home');
    const workspace = path.join(root, 'workspace');
    await mkdir(home, { recursive: true });
    await mkdir(workspace, { recursive: true });

    const installer = new InstallerService({
      homeDir: home,
      workspaceRoot: workspace,
    });

    const result = await installer.installServer({
      name: 'workspace-helper',
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      targets: ['all'],
      scope: 'workspace',
      workspaceRoot: workspace,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Verify workspace configs
    const agWs = JSON.parse(await readFile(path.join(workspace, '.gemini', 'mcp.json'), 'utf8'));
    expect(agWs.mcpServers['workspace-helper'].command).toBe('node');

    const clineWs = JSON.parse(await readFile(path.join(workspace, '.cline', 'mcp.json'), 'utf8'));
    expect(clineWs.mcpServers['workspace-helper'].command).toBe('node');

    const cursorWs = JSON.parse(await readFile(path.join(workspace, '.cursor', 'mcp.json'), 'utf8'));
    expect(cursorWs.mcpServers['workspace-helper'].command).toBe('node');

    const claudeWs = JSON.parse(await readFile(path.join(workspace, '.claude', 'mcp.json'), 'utf8'));
    expect(claudeWs.mcpServers['workspace-helper'].command).toBe('node');

    const opencodeWs = JSON.parse(await readFile(path.join(workspace, '.opencode', 'mcp.json'), 'utf8'));
    expect(opencodeWs.mcpServers['workspace-helper'].command).toBe('node');
  });
});

