import { execFile } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { GitAdapter } from './git-adapter.js';
import { DirectGitRunner } from './git-runner.js';

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function hasGit(): Promise<boolean> {
  try {
    await execFileAsync('git', ['--version'], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

describe('GitAdapter integration', () => {
  let gitAvailable = false;
  const originalGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
  const originalGitConfigSystem = process.env.GIT_CONFIG_SYSTEM;

  beforeAll(async () => {
    process.env.GIT_CONFIG_GLOBAL = os.devNull;
    process.env.GIT_CONFIG_SYSTEM = os.devNull;
    gitAvailable = await hasGit();
  });

  afterAll(() => {
    if (originalGitConfigGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = originalGitConfigGlobal;
    if (originalGitConfigSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM;
    else process.env.GIT_CONFIG_SYSTEM = originalGitConfigSystem;
  });

  it('inspects a temporary repository with spaces and Unicode paths', async () => {
    if (!gitAvailable) return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-git-'));
    temporaryRoots.push(root);
    const filename = 'space file Ω.txt';
    await writeFile(path.join(root, filename), 'initial\n', 'utf8');
    await execFileAsync('git', ['init'], { cwd: root, windowsHide: true });
    await execFileAsync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root, windowsHide: true });
    await execFileAsync('git', ['config', 'user.name', 'unified-mpc test'], { cwd: root, windowsHide: true });
    await execFileAsync('git', ['add', '--', filename], { cwd: root, windowsHide: true });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: root, windowsHide: true });
    await writeFile(path.join(root, filename), 'changed\n', 'utf8');
    await writeFile(path.join(root, 'untracked file.txt'), 'new\n', 'utf8');

    const adapter = new GitAdapter(new DirectGitRunner());
    const status = await adapter.status(root);
    const diff = await adapter.diff(root, { path: filename });
    const log = await adapter.log(root, { maxCommits: 20 });
    const pushSafety = await adapter.validatePushSafety(root, 'origin');

    expect(status).toMatchObject({ ok: true, value: { entries: [
      { path: filename, kind: 'modified' },
      { path: 'untracked file.txt', kind: 'untracked' },
    ] } });
    expect(diff).toMatchObject({ ok: true, value: { patch: expect.stringContaining('changed'), truncated: false } });
    expect(log).toMatchObject({ ok: true, value: { entries: [{ subject: 'initial' }], truncated: false } });
    expect(pushSafety).toEqual({ ok: true, value: undefined });
  }, 15_000);

  it('refreshes an exact remote ref into a private destination without changing FETCH_HEAD', async () => {
    if (!gitAvailable) return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-explicit-ref-'));
    temporaryRoots.push(root);
    const remote = path.join(root, 'remote.git');
    const worktree = path.join(root, 'worktree');
    const secondWorktree = path.join(root, 'second-worktree');
    await execFileAsync('git', ['init', '--bare', remote], { windowsHide: true });
    await mkdir(worktree);
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: worktree, windowsHide: true });
    await execFileAsync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: worktree, windowsHide: true });
    await execFileAsync('git', ['config', 'user.name', 'unified-mpc test'], { cwd: worktree, windowsHide: true });
    await writeFile(path.join(worktree, 'source.ts'), 'export const value = 1;\n', 'utf8');
    await execFileAsync('git', ['add', '--', 'source.ts'], { cwd: worktree, windowsHide: true });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: worktree, windowsHide: true });
    await execFileAsync('git', ['remote', 'add', 'origin', remote], { cwd: worktree, windowsHide: true });
    await execFileAsync('git', ['push', 'origin', 'main'], { cwd: worktree, windowsHide: true });
    await execFileAsync('git', ['worktree', 'add', secondWorktree, '-b', 'second', 'main'], { cwd: worktree, windowsHide: true });
    const fetchHead = path.join(worktree, '.git', 'FETCH_HEAD');
    await writeFile(fetchHead, 'other-worktree-fetch-marker\n', 'utf8');
    const expected = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: worktree, windowsHide: true })).stdout.trim();

    const refreshed = await new GitAdapter(new DirectGitRunner()).refreshRemoteRef(
      secondWorktree, 'origin', 'refs/heads/main', 'refs/unified-mpc/admission/base/main',
    );

    expect(refreshed).toEqual({ ok: true, value: expected });
    await expect(execFileAsync('git', ['rev-parse', '--verify', 'refs/unified-mpc/admission/base/main^{commit}'], { cwd: secondWorktree, windowsHide: true }))
      .resolves.toMatchObject({ stdout: `${expected}\n` });
    await expect(readFile(fetchHead, 'utf8')).resolves.toBe('other-worktree-fetch-marker\n');
  }, 15_000);

  it('fingerprints staged, tracked-dirty, and untracked files while ignoring configured generated paths', async () => {
    if (!gitAvailable) return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-workspace-fingerprint-'));
    temporaryRoots.push(root);
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: root, windowsHide: true });
    await execFileAsync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root, windowsHide: true });
    await execFileAsync('git', ['config', 'user.name', 'unified-mpc test'], { cwd: root, windowsHide: true });
    await mkdir(path.join(root, 'src'));
    await mkdir(path.join(root, 'dist'));
    await writeFile(path.join(root, '.gitignore'), '.cache/\n', 'utf8');
    await writeFile(path.join(root, 'src', 'tracked.ts'), 'export const value = 1;\n', 'utf8');
    await writeFile(path.join(root, 'dist', 'bundle.js'), 'generated v1\n', 'utf8');
    await execFileAsync('git', ['add', '--', '.gitignore', 'src/tracked.ts', 'dist/bundle.js'], { cwd: root, windowsHide: true });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: root, windowsHide: true });
    await execFileAsync('git', ['switch', '-c', 'goal'], { cwd: root, windowsHide: true });
    await writeFile(path.join(root, 'src', 'goal.ts'), 'export const goal = true;\n', 'utf8');
    await execFileAsync('git', ['add', '--', 'src/goal.ts'], { cwd: root, windowsHide: true });
    await execFileAsync('git', ['commit', '-m', 'goal progress'], { cwd: root, windowsHide: true });
    const adapter = new GitAdapter(new DirectGitRunner());
    const clean = await adapter.observeWorkspace(root, {
      baseRef: 'refs/heads/main', resolvedBaseRef: 'refs/heads/main', excludedPathSegments: ['dist'],
    });
    expect(clean.ok).toBe(true);
    if (!clean.ok) return;
    expect(clean.value.head).not.toBe(clean.value.baseSha);
    expect(clean.value.mergeBaseSha).toBe(clean.value.baseSha);

    // A dedicated goal created from a feature branch stores its immutable
    // parent commit SHA, not necessarily an existing refs/heads/* name.
    const pinned = await adapter.observeWorkspace(root, {
      baseRef: clean.value.baseSha!,
      excludedPathSegments: ['dist'],
    });
    expect(pinned).toMatchObject({
      ok: true,
      value: {
        baseRef: clean.value.baseSha,
        baseSha: clean.value.baseSha,
        mergeBaseSha: clean.value.baseSha,
        head: clean.value.head,
      },
    });
    await expect(adapter.observeWorkspace(root, { baseRef: 'abc123' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    });
    await expect(adapter.observeWorkspace(root, { baseRef: 'refs/heads/main..evil' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    });

    await writeFile(path.join(root, 'src', 'tracked.ts'), 'export const value = 2;\n', 'utf8');
    const trackedDirty = await adapter.observeWorkspace(root, { excludedPathSegments: ['dist'] });
    expect(trackedDirty.ok && trackedDirty.value.dirtyFingerprint).not.toBe(clean.value.dirtyFingerprint);
    await writeFile(path.join(root, 'src', 'tracked.ts'), 'export const value = 3;\n', 'utf8');
    await execFileAsync('git', ['add', '--', 'src/tracked.ts'], { cwd: root, windowsHide: true });
    const staged = await adapter.observeWorkspace(root, { excludedPathSegments: ['dist'] });
    expect(staged.ok && staged.value.dirtyFingerprint).not.toBe(clean.value.dirtyFingerprint);
    expect(staged.ok && staged.value.stagedFingerprint).not.toBe(clean.ok ? clean.value.stagedFingerprint : '');

    await writeFile(path.join(root, 'src', 'new.ts'), 'export const added = true;\n', 'utf8');
    const untracked = await adapter.observeWorkspace(root, { excludedPathSegments: ['dist'] });
    expect(untracked.ok && untracked.value.dirtyFingerprint).not.toBe(clean.value.dirtyFingerprint);
    await writeFile(path.join(root, 'dist', 'bundle.js'), 'generated v2\n', 'utf8');
    const withGenerated = await adapter.observeWorkspace(root, { excludedPathSegments: ['dist'] });
    expect(withGenerated.ok && withGenerated.value.dirtyFingerprint).toBe(untracked.ok ? untracked.value.dirtyFingerprint : '');
  }, 15_000);

  it('rejects a configured custom receive-pack program', async () => {
    if (!gitAvailable) return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-git-'));
    temporaryRoots.push(root);
    await execFileAsync('git', ['init'], { cwd: root, windowsHide: true });
    await execFileAsync('git', ['config', 'remote.origin.receivepack', '/tmp/custom-receive-pack'], { cwd: root, windowsHide: true });

    await expect(new GitAdapter(new DirectGitRunner()).validatePushSafety(root, 'origin')).resolves.toMatchObject({
      ok: false,
      error: { code: 'PERMISSION_DENIED' },
    });
  }, 15_000);

  it('rejects executable SSH configuration before remote inspection can run it', async () => {
    if (!gitAvailable) return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-git-'));
    temporaryRoots.push(root);
    await execFileAsync('git', ['init'], { cwd: root, windowsHide: true });
    const marker = path.join(root, 'ssh-wrapper-ran');
    const wrapper = path.join(root, 'ssh-wrapper.sh');
    await writeFile(wrapper, `#!/bin/sh\nprintf hit > "${marker}"\nexit 1\n`, 'utf8');
    await chmod(wrapper, 0o755);
    await execFileAsync('git', ['config', 'core.sshCommand', wrapper], { cwd: root, windowsHide: true });

    const adapter = new GitAdapter(new DirectGitRunner());
    await expect(adapter.validatePushSafety(root, 'origin')).resolves.toMatchObject({
      ok: false,
      error: { code: 'PERMISSION_DENIED' },
    });
    await expect(adapter.remoteBranchSha(root, 'origin', 'codex/goal-1')).resolves.toMatchObject({
      ok: false,
      error: { code: 'PERMISSION_DENIED' },
    });
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 15_000);

  it('rejects executable SSH environment overrides before remote inspection can run them', async () => {
    if (!gitAvailable) return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-git-'));
    temporaryRoots.push(root);
    await execFileAsync('git', ['init'], { cwd: root, windowsHide: true });
    const marker = path.join(root, 'ssh-env-wrapper-ran');
    const wrapper = path.join(root, 'ssh-env-wrapper.sh');
    await writeFile(wrapper, `#!/bin/sh\nprintf hit > "${marker}"\nexit 1\n`, 'utf8');
    await chmod(wrapper, 0o755);
    const previous = process.env.GIT_SSH_COMMAND;
    process.env.GIT_SSH_COMMAND = wrapper;
    try {
      const adapter = new GitAdapter(new DirectGitRunner());
      await expect(adapter.remoteBranchSha(root, 'origin', 'codex/goal-1')).resolves.toMatchObject({
        ok: false,
        error: { code: 'PERMISSION_DENIED' },
      });
      await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      if (previous === undefined) delete process.env.GIT_SSH_COMMAND;
      else process.env.GIT_SSH_COMMAND = previous;
    }
  }, 15_000);

  it('rejects executable askpass configuration before remote inspection can run it', async () => {
    if (!gitAvailable) return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-git-'));
    temporaryRoots.push(root);
    await execFileAsync('git', ['init'], { cwd: root, windowsHide: true });
    const marker = path.join(root, 'askpass-wrapper-ran');
    const wrapper = path.join(root, 'askpass-wrapper.sh');
    await writeFile(wrapper, `#!/bin/sh\nprintf hit > "${marker}"\nexit 1\n`, 'utf8');
    await chmod(wrapper, 0o755);
    await execFileAsync('git', ['config', 'core.askPass', wrapper], { cwd: root, windowsHide: true });

    await expect(new GitAdapter(new DirectGitRunner()).validatePushSafety(root, 'origin')).resolves.toMatchObject({
      ok: false,
      error: { code: 'PERMISSION_DENIED' },
    });
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 15_000);

  it('rejects URL-scoped credential helpers before remote inspection can run them', async () => {
    if (!gitAvailable) return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-git-'));
    temporaryRoots.push(root);
    await execFileAsync('git', ['init'], { cwd: root, windowsHide: true });
    const marker = path.join(root, 'credential-wrapper-ran');
    const wrapper = path.join(root, 'credential-wrapper.sh');
    await writeFile(wrapper, `#!/bin/sh\nprintf hit > "${marker}"\nexit 1\n`, 'utf8');
    await chmod(wrapper, 0o755);
    await execFileAsync('git', ['config', 'credential.https://example.invalid.helper', `!${wrapper}`], { cwd: root, windowsHide: true });

    await expect(new GitAdapter(new DirectGitRunner()).validatePushSafety(root, 'origin')).resolves.toMatchObject({
      ok: false,
      error: { code: 'PERMISSION_DENIED' },
    });
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 15_000);

  it('rejects configured signing programs before remote inspection can run them', async () => {
    if (!gitAvailable) return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-git-'));
    temporaryRoots.push(root);
    await execFileAsync('git', ['init'], { cwd: root, windowsHide: true });
    const marker = path.join(root, 'sign-wrapper-ran');
    const wrapper = path.join(root, 'sign-wrapper.sh');
    await writeFile(wrapper, `#!/bin/sh\nprintf hit > "${marker}"\nexit 1\n`, 'utf8');
    await chmod(wrapper, 0o755);
    await execFileAsync('git', ['config', 'gpg.program', wrapper], { cwd: root, windowsHide: true });

    await expect(new GitAdapter(new DirectGitRunner()).validatePushSafety(root, 'origin')).resolves.toMatchObject({
      ok: false,
      error: { code: 'PERMISSION_DENIED' },
    });
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 15_000);

  it('rejects configured recursive submodule pushes before remote inspection', async () => {
    if (!gitAvailable) return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-git-'));
    temporaryRoots.push(root);
    await execFileAsync('git', ['init'], { cwd: root, windowsHide: true });
    await execFileAsync('git', ['config', 'push.recurseSubmodules', 'on-demand'], { cwd: root, windowsHide: true });

    await expect(new GitAdapter(new DirectGitRunner()).validatePushSafety(root, 'origin')).resolves.toMatchObject({
      ok: false,
      error: { code: 'PERMISSION_DENIED' },
    });
  }, 15_000);

  it('rejects external remote-helper targets before ls-remote can execute them', async () => {
    if (!gitAvailable) return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-git-'));
    temporaryRoots.push(root);
    await execFileAsync('git', ['init'], { cwd: root, windowsHide: true });
    const marker = path.join(root, 'ext-wrapper-ran');
    const wrapper = path.join(root, 'ext-wrapper.sh');
    await writeFile(wrapper, `#!/bin/sh\nprintf hit > "${marker}"\nexit 1\n`, 'utf8');
    await chmod(wrapper, 0o755);
    await execFileAsync('git', ['config', 'protocol.ext.allow', 'always'], { cwd: root, windowsHide: true });
    await execFileAsync('git', ['remote', 'add', 'origin', `ext::${wrapper}`], { cwd: root, windowsHide: true });

    await expect(new GitAdapter(new DirectGitRunner()).validatePushSafety(root, 'origin')).resolves.toMatchObject({
      ok: false,
      error: { code: 'PERMISSION_DENIED' },
    });
    await expect(new GitAdapter(new DirectGitRunner()).defaultBranches(root, 'origin')).resolves.toEqual({ ok: true, value: [] });
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 15_000);

  it('aborts a conflicted guarded rebase and restores the exact old head while preserving the recovery ref', async () => {
    if (!gitAvailable) return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-guarded-rebase-'));
    temporaryRoots.push(root);
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: root, windowsHide: true });
    await execFileAsync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root, windowsHide: true });
    await execFileAsync('git', ['config', 'user.name', 'unified-mpc test'], { cwd: root, windowsHide: true });
    await writeFile(path.join(root, 'conflict.txt'), 'base\n', 'utf8');
    await execFileAsync('git', ['add', '--', 'conflict.txt'], { cwd: root, windowsHide: true });
    await execFileAsync('git', ['commit', '-m', 'base'], { cwd: root, windowsHide: true });
    const oldBase = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root, windowsHide: true })).stdout.trim();

    await execFileAsync('git', ['switch', '-c', 'goal'], { cwd: root, windowsHide: true });
    await writeFile(path.join(root, 'conflict.txt'), 'goal\n', 'utf8');
    await execFileAsync('git', ['commit', '-am', 'goal change'], { cwd: root, windowsHide: true });
    const oldHead = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root, windowsHide: true })).stdout.trim();

    await execFileAsync('git', ['switch', 'main'], { cwd: root, windowsHide: true });
    await writeFile(path.join(root, 'conflict.txt'), 'main\n', 'utf8');
    await execFileAsync('git', ['commit', '-am', 'main change'], { cwd: root, windowsHide: true });
    const newBase = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root, windowsHide: true })).stdout.trim();
    await execFileAsync('git', ['switch', 'goal'], { cwd: root, windowsHide: true });

    const recoveryRef = 'refs/unified-mpc/recovery/rebase/conflict-test';
    const adapter = new GitAdapter(new DirectGitRunner());
    await expect(adapter.createRecoveryRef(root, recoveryRef, oldHead)).resolves.toEqual({ ok: true, value: undefined });
    const result = await adapter.guardedRebase(root, {
      expectedBranch: 'goal',
      oldHead,
      oldBaseSha: oldBase,
      newBaseSha: newBase,
      recoveryRef,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        status: 'conflict',
        conflictedPaths: ['conflict.txt'],
        abortSucceeded: true,
        headAfterAbort: oldHead,
        cleanAfterAbort: true,
        reason: 'rebase_conflict',
      },
    });
    await expect(execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root, windowsHide: true }))
      .resolves.toMatchObject({ stdout: `${oldHead}\n` });
    await expect(execFileAsync('git', ['rev-parse', recoveryRef], { cwd: root, windowsHide: true }))
      .resolves.toMatchObject({ stdout: `${oldHead}\n` });
    await expect(readFile(path.join(root, 'conflict.txt'), 'utf8')).resolves.toBe('goal\n');
  }, 15_000);

  it('rejects an active pre-push hook, including a configured hooks path', async () => {
    if (!gitAvailable) return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-git-'));
    temporaryRoots.push(root);
    const hooksPath = path.join(root, '.githooks');
    await execFileAsync('git', ['init'], { cwd: root, windowsHide: true });
    await mkdir(hooksPath);
    await execFileAsync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: root, windowsHide: true });
    const hookPath = path.join(hooksPath, 'pre-push');
    await writeFile(hookPath, '#!/bin/sh\nexit 0\n', 'utf8');
    await chmod(hookPath, 0o755);

    await expect(new GitAdapter(new DirectGitRunner()).validatePushSafety(root, 'origin')).resolves.toMatchObject({
      ok: false,
      error: { code: 'PERMISSION_DENIED' },
    });
  }, 15_000);
});
