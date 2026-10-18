import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appError, err, type Result } from '@unified-mpc/domain';
import { GitAdapter, type GitRunResult, type GitStatusResult } from '@unified-mpc/git';
import { createGoalWorktreeGitPort, type GoalWorktreeGitAdapter } from './goal-worktree-git-port.js';

interface ScriptedCall {
  readonly args: readonly string[];
  readonly cwd: string;
}

interface ScriptedRunnerOptions {
  readonly status?: string;
  readonly statusExit?: number;
  readonly head?: string;
  readonly headExit?: number;
  readonly ancestryExit?: number;
}

function scriptedGit(options: ScriptedRunnerOptions = {}): { readonly git: GitAdapter; readonly calls: ScriptedCall[] } {
  const calls: ScriptedCall[] = [];
  const runner = {
    async run(args: readonly string[], cwd: string): Promise<GitRunResult> {
      calls.push({ args, cwd });
      if (args[0] === 'status') {
        return { exitCode: options.statusExit ?? 0, stdout: options.status ?? '', stderr: '' };
      }
      if (args[0] === 'rev-parse') {
        return { exitCode: options.headExit ?? 0, stdout: `${options.head ?? 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'}\n`, stderr: '' };
      }
      return { exitCode: options.ancestryExit ?? 0, stdout: '', stderr: '' };
    },
  };
  return { git: new GitAdapter(runner), calls };
}

function failingGit(message: string): GoalWorktreeGitAdapter {
  return {
    status: async (): Promise<Result<GitStatusResult>> => err(appError('PROCESS_TIMEOUT', message)),
    run: async () => err(appError('PROCESS_TIMEOUT', message)),
  };
}

const WORKTREE = '/workspaces/.worktrees/agent-abc123';

describe('createGoalWorktreeGitPort', () => {
  describe('exists', () => {
    let root: string;

    beforeEach(async () => {
      root = await mkdtemp(path.join(tmpdir(), 'uw-goal-worktree-'));
    });

    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    it('resolves true for a real worktree directory and false for a vanished path', async () => {
      const port = createGoalWorktreeGitPort({ git: scriptedGit().git });
      expect(await port.exists(root)).toBe(true);
      expect(await port.exists(path.join(root, 'missing'))).toBe(false);
    });

    it('resolves false when the worktree path is occupied by a plain file', async () => {
      const filePath = path.join(root, 'not-a-worktree');
      await writeFile(filePath, 'x');
      const port = createGoalWorktreeGitPort({ git: scriptedGit().git });
      expect(await port.exists(filePath)).toBe(false);
    });
  });

  describe('status', () => {
    it('counts dirty and untracked entries and every unmerged porcelain state', async () => {
      const porcelain = [
        'UU conflicted.ts',
        'AA both-added.ts',
        'DD both-deleted.ts',
        ' M modified.ts',
        '?? untracked.ts',
        '',
      ].join('\0');
      const { git, calls } = scriptedGit({ status: porcelain });
      const port = createGoalWorktreeGitPort({ git });
      const probe = await port.status(WORKTREE);
      expect(probe).toEqual({ dirtyEntries: 5, unmergedEntries: 3 });
      expect(calls[0]).toEqual({ args: ['status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd: WORKTREE });
    });

    it('reports a clean worktree as zero dirty and zero unmerged', async () => {
      const port = createGoalWorktreeGitPort({ git: scriptedGit({ status: '' }).git });
      expect(await port.status(WORKTREE)).toEqual({ dirtyEntries: 0, unmergedEntries: 0 });
    });

    it('throws with the git error message when the status probe fails', async () => {
      const port = createGoalWorktreeGitPort({ git: failingGit('git status timed out') });
      await expect(port.status(WORKTREE)).rejects.toThrow(/git status timed out/);
    });
  });

  describe('headSha', () => {
    it('returns the trimmed HEAD sha', async () => {
      const port = createGoalWorktreeGitPort({ git: scriptedGit({ head: 'deadbeef' }).git });
      expect(await port.headSha(WORKTREE)).toBe('deadbeef');
    });

    it('resolves null when HEAD cannot be resolved', async () => {
      const port = createGoalWorktreeGitPort({ git: scriptedGit({ headExit: 128 }).git });
      expect(await port.headSha(WORKTREE)).toBeNull();
    });

    it('resolves null when the adapter itself errors', async () => {
      const port = createGoalWorktreeGitPort({ git: failingGit('git missing') });
      expect(await port.headSha(WORKTREE)).toBeNull();
    });
  });

  describe('isAncestor', () => {
    it('maps exit 0 to yes and exit 1 to no against the worktree HEAD', async () => {
      const yes = scriptedGit({ ancestryExit: 0 });
      const no = scriptedGit({ ancestryExit: 1 });
      expect(await createGoalWorktreeGitPort({ git: yes.git }).isAncestor({ worktreePath: WORKTREE, ref: 'main', base: 'origin/main' }))
        .toBe('yes');
      expect(await createGoalWorktreeGitPort({ git: no.git }).isAncestor({ worktreePath: WORKTREE, ref: 'main', base: 'origin/main' }))
        .toBe('no');
      expect(no.calls[0]).toEqual({ args: ['merge-base', '--is-ancestor', 'HEAD', 'origin/main'], cwd: WORKTREE });
    });

    it('maps unexpected exit codes and adapter errors to unknown', async () => {
      const unexpected = scriptedGit({ ancestryExit: 129 });
      expect(await createGoalWorktreeGitPort({ git: unexpected.git }).isAncestor({ worktreePath: WORKTREE, ref: 'main', base: 'origin/main' }))
        .toBe('unknown');
      expect(await createGoalWorktreeGitPort({ git: failingGit('git merge-base timed out') }).isAncestor({ worktreePath: WORKTREE, ref: 'main', base: 'origin/main' }))
        .toBe('unknown');
    });
  });
});
