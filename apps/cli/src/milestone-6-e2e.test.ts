import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const CLI_BIN = path.resolve(__dirname, '../dist/index.js');
const baseCliEnv = {
  ...process.env,
  NODE_NO_WARNINGS: '1',
};

describe('Milestone 6 - Unified CLI End-to-End Smoketest', () => {
  it('executes "unified-mpc status" via node subprocess and returns exit code 0', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'm6-e2e-status-'));
    temporaryRoots.push(root);

    const { stdout, stderr } = await execFileAsync('node', [CLI_BIN, 'status'], {
      env: { ...baseCliEnv, UNIFIED_MPC_DATA_DIR: path.join(root, 'data') },
    });

    expect(stderr).toBe('');
    expect(stdout).toContain('workspaces:');
  });

  it('executes "unified-mpc sync --targets cline" and writes policy block', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'm6-e2e-sync-'));
    temporaryRoots.push(root);
    const home = path.join(root, 'home');
    const workspace = path.join(root, 'workspace');
    await mkdir(home, { recursive: true });
    await mkdir(workspace, { recursive: true });

    const { stdout, stderr } = await execFileAsync('node', [CLI_BIN, 'sync', '--targets', 'cline'], {
      env: {
        ...baseCliEnv,
        HOME: home,
        UNIFIED_MPC_DATA_DIR: path.join(root, 'data'),
      },
      cwd: workspace,
    });

    expect(stderr).toBe('');
    expect(stdout).toContain('Synchronized policy');
  });

  it('returns exit code 2 and usage on invalid/unknown command', async () => {
    try {
      await execFileAsync('node', [CLI_BIN, 'non-existent-cmd']);
      expect.fail('Expected command to fail with exit code 2');
    } catch (error: any) {
      expect(error.code).toBe(2);
      expect(error.stderr).toContain('Unknown unified-mpc command');
    }
  });

  it('returns exit code 2 on missing subcommand for install', async () => {
    try {
      await execFileAsync('node', [CLI_BIN, 'install']);
      expect.fail('Expected command to fail with exit code 2');
    } catch (error: any) {
      expect(error.code).toBe(2);
      expect(error.stderr).toContain('Usage: unified-mpc install');
    }
  });

  it('e2e install skill and prune skill lifecycle via CLI', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'm6-e2e-skill-'));
    temporaryRoots.push(root);
    const home = path.join(root, 'home');
    const sourceDir = path.join(root, 'test-skill');
    await mkdir(home, { recursive: true });
    await mkdir(sourceDir, { recursive: true });

    await writeFile(
      path.join(sourceDir, 'SKILL.md'),
      '---\nname: e2e-skill\ndescription: E2E test skill\n---\n# E2E Skill\n',
      'utf8'
    );

    const env = {
      ...baseCliEnv,
      HOME: home,
      UNIFIED_MPC_DATA_DIR: path.join(root, 'data'),
    };

    // 1. Install skill
    const installRes = await execFileAsync(
      'node',
      [CLI_BIN, 'install', 'skill', 'e2e-skill', sourceDir, '--targets', 'cline'],
      { env }
    );
    expect(installRes.stderr).toBe('');
    expect(installRes.stdout).toContain('Installed skill "e2e-skill"');

    const installedSkill = path.join(home, '.cline', 'skills', 'e2e-skill', 'SKILL.md');
    const content = await readFile(installedSkill, 'utf8');
    expect(content).toContain('# E2E Skill');

    // 2. Prune skill
    const pruneRes = await execFileAsync(
      'node',
      [CLI_BIN, 'prune', 'skill', 'e2e-skill', '--targets', 'cline'],
      { env }
    );
    expect(pruneRes.stderr).toBe('');
    expect(pruneRes.stdout).toContain('Pruned skill "e2e-skill"');
  });

  it('e2e install server and prune server lifecycle via CLI', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'm6-e2e-srv-'));
    temporaryRoots.push(root);
    const home = path.join(root, 'home');
    await mkdir(home, { recursive: true });

    const env = {
      ...baseCliEnv,
      HOME: home,
      UNIFIED_MPC_DATA_DIR: path.join(root, 'data'),
    };

    // 1. Install server
    const installRes = await execFileAsync(
      'node',
      [CLI_BIN, 'install', 'server', 'test-server', '--command', 'node', '--args', 'test.js', '--targets', 'cursor'],
      { env }
    );
    expect(installRes.stderr).toBe('');
    expect(installRes.stdout).toContain('Installed server "test-server"');

    const cursorConfig = path.join(home, '.cursor', 'mcp.json');
    const doc = JSON.parse(await readFile(cursorConfig, 'utf8'));
    expect(doc.mcpServers['test-server']).toBeDefined();
    expect(doc.mcpServers['test-server'].command).toBe('node');

    // 2. Prune server
    const pruneRes = await execFileAsync(
      'node',
      [CLI_BIN, 'prune', 'server', 'test-server', '--targets', 'cursor'],
      { env }
    );
    expect(pruneRes.stderr).toBe('');
    expect(pruneRes.stdout).toContain('Pruned server "test-server"');

    const updatedDoc = JSON.parse(await readFile(cursorConfig, 'utf8'));
    expect(updatedDoc.mcpServers['test-server']).toBeUndefined();
  });
});
