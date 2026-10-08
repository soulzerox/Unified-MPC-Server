import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { GitStatusResult } from '@unified-mpc/git';
import {
  sealMixedDirtyGoalWorkspace,
  verifyRetainedGoalWorkspaceBundle,
  type GoalWorkspaceRetentionGitPort,
  type GoalWorkspaceRetentionManifest,
} from './goal-workspace-retention-service.js';

const head = 'a'.repeat(40);
const tracked = 'src/program.ts';
const untracked = 'scripts/restart.test.mjs';
const testRoots: string[] = [];

afterEach(async (): Promise<void> => {
  await Promise.all(testRoots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ bundle: GoalWorkspaceRetentionManifest; sourceRoot: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'umcp-retention-verify-'));
  testRoots.push(root);
  const sourceRoot = path.join(root, 'source');
  await mkdir(path.join(sourceRoot, 'src'), { recursive: true });
  await mkdir(path.join(sourceRoot, 'scripts'), { recursive: true });
  await writeFile(path.join(sourceRoot, tracked), 'const value = 1;\n');
  await writeFile(path.join(sourceRoot, untracked), 'const restart = true;\n');
  const entries: GitStatusResult['entries'] = [
    { path: tracked, kind: 'modified', indexStatus: ' ', worktreeStatus: 'M' },
    { path: untracked, kind: 'untracked', indexStatus: '?', worktreeStatus: '?' },
  ];
  const git: GoalWorkspaceRetentionGitPort = {
    async status() { return { ok: true, value: { entries } }; },
    async run(_cwd, args) {
      return { ok: true, value: {
        exitCode: 0, stderr: '',
        stdout: args[0] === 'rev-parse' ? head + '\n' : 'goal/owner\n',
      } };
    },
  };
  const result = await sealMixedDirtyGoalWorkspace({
    goalId: 'goal-owner', workspaceId: 'goal-workspace-owner',
    sourceRoot, retentionRoot: path.join(root, 'retained'),
    expectedHead: head, expectedBranch: 'goal/owner', git,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('fixture retention creation failed');
  return { bundle: result.value, sourceRoot };
}

function proof(bundle: GoalWorkspaceRetentionManifest): {
  retentionPath: string; expectedGoalId: string; expectedWorkspaceId: string;
  expectedHead: string; expectedBranch: string; expectedManifestSha256: string;
} {
  return {
    retentionPath: bundle.retentionPath,
    expectedGoalId: bundle.goalId,
    expectedWorkspaceId: bundle.workspaceId,
    expectedHead: bundle.head,
    expectedBranch: bundle.branch,
    expectedManifestSha256: bundle.manifestSha256,
  };
}

describe('verifyRetainedGoalWorkspaceBundle — #298', () => {
  it('independently reopens the sealed manifest and rehashes all retained bytes', async () => {
    const { bundle, sourceRoot } = await fixture();
    const result = await verifyRetainedGoalWorkspaceBundle(proof(bundle));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.manifestSha256).toBe(bundle.manifestSha256);
    expect(result.value.entries).toEqual(bundle.entries);
    expect(await readFile(path.join(sourceRoot, tracked), 'utf8')).toBe('const value = 1;\n');
  });

  it('requires the external pinned manifest hash; it cannot trust the on-disk manifest alone', async () => {
    const { bundle } = await fixture();
    expect((await verifyRetainedGoalWorkspaceBundle({
      ...proof(bundle), expectedManifestSha256: '0'.repeat(64),
    })).ok).toBe(false);
  });

  it('rejects a later mutation of retained file bytes', async () => {
    const { bundle } = await fixture();
    await chmod(path.join(bundle.retentionPath, 'files', tracked), 0o600);
    await writeFile(path.join(bundle.retentionPath, 'files', tracked), 'const value = 2;\n');
    expect((await verifyRetainedGoalWorkspaceBundle(proof(bundle))).ok).toBe(false);
  });

  it('rejects a changed manifest even when the retained source files are unchanged', async () => {
    const { bundle } = await fixture();
    const filename = path.join(bundle.retentionPath, 'manifest.json');
    const contents = await readFile(filename, 'utf8');
    await chmod(filename, 0o600);
    await writeFile(filename, contents.replace('goal-owner', 'goal-other'));
    expect((await verifyRetainedGoalWorkspaceBundle(proof(bundle))).ok).toBe(false);
  });

  it('rejects unrelated file injection into the retention directory', async () => {
    const { bundle } = await fixture();
    await writeFile(path.join(bundle.retentionPath, 'files', 'foreign-file.txt'), 'injected');
    expect((await verifyRetainedGoalWorkspaceBundle(proof(bundle))).ok).toBe(false);
  });

  it('rejects symlink replacement of retained files, even if target content matches', async () => {
    const { bundle } = await fixture();
    const preservedPath = path.join(bundle.retentionPath, 'files', untracked);
    await rm(preservedPath);
    await symlink(path.join(bundle.retentionPath, 'files', tracked), preservedPath);
    expect((await verifyRetainedGoalWorkspaceBundle(proof(bundle))).ok).toBe(false);
  });

  it('rejects stale owner, Goal, workspace, branch or HEAD proof', async () => {
    const { bundle } = await fixture();
    const cases = [
      { expectedGoalId: 'different-goal' },
      { expectedWorkspaceId: 'another-workspace' },
      { expectedHead: 'b'.repeat(40) },
      { expectedBranch: 'goal/other' },
    ];
    for (const drift of cases) {
      expect((await verifyRetainedGoalWorkspaceBundle({ ...proof(bundle), ...drift })).ok).toBe(false);
    }
  });
});
