import { execFile } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { GitAdapter } from './git-adapter.js';
import { DirectGitRunner } from './git-runner.js';

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

/**
 * A Windows path appears escaped inside a serialized error, so comparing the raw
 * path would pass without proving anything. Compare the same escaped form.
 */
function escapedForJson(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

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
      error: {
        code: 'PERMISSION_DENIED',
        details: { reason: 'push-config-override', key: 'remote.origin.receivepack' },
      },
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
      error: {
        code: 'PERMISSION_DENIED',
        details: { reason: 'push-config-override', key: 'core.sshCommand' },
      },
    });
    await expect(adapter.remoteBranchSha(root, 'origin', 'codex/goal-1')).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'PERMISSION_DENIED',
        details: { reason: 'push-config-override', key: 'core.sshCommand' },
      },
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
      const denied = await adapter.remoteBranchSha(root, 'origin', 'codex/goal-1');
      expect(denied).toMatchObject({
        ok: false,
        error: {
          code: 'PERMISSION_DENIED',
          details: { reason: 'push-environment-override', keys: expect.stringContaining('GIT_SSH_COMMAND') },
        },
      });
      expect(JSON.stringify(denied)).not.toContain(escapedForJson(wrapper));
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

    const denied = await new GitAdapter(new DirectGitRunner()).validatePushSafety(root, 'origin');
    expect(denied).toMatchObject({
      ok: false,
      error: {
        code: 'PERMISSION_DENIED',
        details: { reason: 'push-config-override', key: 'core.askPass' },
      },
    });
    expect(JSON.stringify(denied)).not.toContain(escapedForJson(wrapper));
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

    const denied = await new GitAdapter(new DirectGitRunner()).validatePushSafety(root, 'origin');
    expect(denied).toMatchObject({
      ok: false,
      error: {
        code: 'PERMISSION_DENIED',
        details: { reason: 'push-credential-helper', key: 'credential.<url>.helper' },
      },
    });
    // The diagnostic names the blocking key pattern but never its value or URL scope.
    expect(JSON.stringify(denied)).not.toContain(escapedForJson(wrapper));
    expect(JSON.stringify(denied)).not.toContain('example.invalid');
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 15_000);

  it('does not echo credentials embedded in a URL-scoped credential helper key', async () => {
    if (!gitAvailable) return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-git-'));
    temporaryRoots.push(root);
    await execFileAsync('git', ['init'], { cwd: root, windowsHide: true });
    const marker = path.join(root, 'credential-wrapper-ran');
    const wrapper = path.join(root, 'credential-wrapper.sh');
    await writeFile(wrapper, `#!/bin/sh\nprintf hit > "${marker}"\nexit 1\n`, 'utf8');
    await chmod(wrapper, 0o755);
    await execFileAsync('git', ['config', 'credential.https://user:secret@example.invalid.helper', `!${wrapper}`], { cwd: root, windowsHide: true });

    const denied = await new GitAdapter(new DirectGitRunner()).validatePushSafety(root, 'origin');
    expect(denied).toMatchObject({
      ok: false,
      error: {
        code: 'PERMISSION_DENIED',
        details: { reason: 'push-credential-helper', key: 'credential.<url>.helper' },
      },
    });
    const serialized = JSON.stringify(denied);
    expect(serialized).not.toContain(escapedForJson(wrapper));
    expect(serialized).not.toContain('user:secret');
    expect(serialized).not.toContain('secret@example.invalid');
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 15_000);

  it('reports a global credential helper as a credential denial, not a generic config override', async () => {
    if (!gitAvailable) return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-git-'));
    temporaryRoots.push(root);
    await execFileAsync('git', ['init'], { cwd: root, windowsHide: true });
    const marker = path.join(root, 'credential-wrapper-ran');
    const wrapper = path.join(root, 'credential-wrapper.sh');
    await writeFile(wrapper, `#!/bin/sh\nprintf hit > "${marker}"\nexit 1\n`, 'utf8');
    await chmod(wrapper, 0o755);
    await execFileAsync('git', ['config', 'credential.helper', `!${wrapper}`], { cwd: root, windowsHide: true });

    const denied = await new GitAdapter(new DirectGitRunner()).validatePushSafety(root, 'origin');
    expect(denied).toMatchObject({
      ok: false,
      error: {
        code: 'PERMISSION_DENIED',
        details: { reason: 'push-credential-helper', key: 'credential.helper' },
      },
    });
    expect(JSON.stringify(denied)).not.toContain(escapedForJson(wrapper));
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 15_000);

  it('allows an SSH push while an unrelated credential helper is configured', async () => {
    if (!gitAvailable) return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-git-'));
    temporaryRoots.push(root);
    await execFileAsync('git', ['init'], { cwd: root, windowsHide: true });
    await execFileAsync('git', ['remote', 'add', 'origin', 'git@example.invalid:owner/repo.git'], { cwd: root, windowsHide: true });
    const marker = path.join(root, 'credential-wrapper-ran');
    const wrapper = path.join(root, 'credential-wrapper.sh');
    await writeFile(wrapper, `#!/bin/sh\nprintf hit > "${marker}"\nexit 1\n`, 'utf8');
    await chmod(wrapper, 0o755);
    await execFileAsync('git', ['config', 'credential.helper', `!${wrapper}`], { cwd: root, windowsHide: true });

    // scp-like `user@host:path` is the SSH transport, which never consults a helper.
    await expect(new GitAdapter(new DirectGitRunner()).validatePushSafety(root, 'origin')).resolves.toMatchObject({ ok: true });
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 15_000);

  it('allows an ssh:// push while an unrelated credential helper is configured', async () => {
    if (!gitAvailable) return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-git-'));
    temporaryRoots.push(root);
    await execFileAsync('git', ['init'], { cwd: root, windowsHide: true });
    await execFileAsync('git', ['remote', 'add', 'origin', 'ssh://git@example.invalid/owner/repo.git'], { cwd: root, windowsHide: true });
    await execFileAsync('git', ['config', 'credential.helper', '!true'], { cwd: root, windowsHide: true });

    await expect(new GitAdapter(new DirectGitRunner()).validatePushSafety(root, 'origin')).resolves.toMatchObject({ ok: true });
  }, 15_000);

  it('follows a pushInsteadOf rewrite before judging the credential helper', async () => {
    if (!gitAvailable) return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-git-'));
    temporaryRoots.push(root);
    await execFileAsync('git', ['init'], { cwd: root, windowsHide: true });
    await execFileAsync('git', ['remote', 'add', 'origin', 'https://example.invalid/owner/repo.git'], { cwd: root, windowsHide: true });
    await execFileAsync('git', ['config', 'url.ssh://git@example.invalid/.pushInsteadOf', 'https://example.invalid/'], { cwd: root, windowsHide: true });
    await execFileAsync('git', ['config', 'credential.helper', '!true'], { cwd: root, windowsHide: true });

    // The rewrite makes the realized push transport SSH, so no helper can run;
    // judging the raw `remote.origin.url` would report a false denial.
    await expect(new GitAdapter(new DirectGitRunner()).validatePushSafety(root, 'origin')).resolves.toMatchObject({ ok: true });
  }, 15_000);

  it('keeps the credential-helper denial for a plain HTTP target', async () => {
    if (!gitAvailable) return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-git-'));
    temporaryRoots.push(root);
    await execFileAsync('git', ['init'], { cwd: root, windowsHide: true });
    await execFileAsync('git', ['remote', 'add', 'origin', 'http://example.invalid/owner/repo.git'], { cwd: root, windowsHide: true });
    await execFileAsync('git', ['config', 'credential.helper', '!true'], { cwd: root, windowsHide: true });

    await expect(new GitAdapter(new DirectGitRunner()).validatePushSafety(root, 'origin')).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'PERMISSION_DENIED',
        details: { reason: 'push-credential-helper', key: 'credential.helper' },
      },
    });
  }, 15_000);

  it('keeps the credential-helper denial when any push target uses HTTPS', async () => {
    if (!gitAvailable) return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-git-'));
    temporaryRoots.push(root);
    await execFileAsync('git', ['init'], { cwd: root, windowsHide: true });
    await execFileAsync('git', ['remote', 'add', 'origin', 'git@example.invalid:owner/repo.git'], { cwd: root, windowsHide: true });
    await execFileAsync('git', ['config', '--add', 'remote.origin.pushurl', 'git@example.invalid:owner/repo.git'], { cwd: root, windowsHide: true });
    await execFileAsync('git', ['config', '--add', 'remote.origin.pushurl', 'https://example.invalid/owner/repo.git'], { cwd: root, windowsHide: true });
    const wrapper = path.join(root, 'credential-wrapper.sh');
    await writeFile(wrapper, '#!/bin/sh\nexit 1\n', 'utf8');
    await chmod(wrapper, 0o755);
    await execFileAsync('git', ['config', 'credential.helper', `!${wrapper}`], { cwd: root, windowsHide: true });

    // Git pushes to every pushurl, so one HTTP(S) target can run the helper.
    const denied = await new GitAdapter(new DirectGitRunner()).validatePushSafety(root, 'origin');
    expect(denied).toMatchObject({
      ok: false,
      error: {
        code: 'PERMISSION_DENIED',
        details: { reason: 'push-credential-helper', key: 'credential.helper' },
      },
    });
    expect(JSON.stringify(denied)).not.toContain(escapedForJson(wrapper));
  }, 15_000);

  it('keeps the credential-helper denial for a transport the adapter does not support', async () => {
    if (!gitAvailable) return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-git-'));
    temporaryRoots.push(root);
    await execFileAsync('git', ['init'], { cwd: root, windowsHide: true });
    await execFileAsync('git', ['remote', 'add', 'origin', 'ftp://example.invalid/owner/repo.git'], { cwd: root, windowsHide: true });
    await execFileAsync('git', ['config', 'credential.helper', '!true'], { cwd: root, windowsHide: true });

    // An unsupported transport is not classified, so it must stay guarded even
    // though a helper cannot run on it.
    await expect(new GitAdapter(new DirectGitRunner()).validatePushSafety(root, 'origin')).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'PERMISSION_DENIED',
        details: { reason: 'push-credential-helper', key: 'credential.helper' },
      },
    });
  }, 15_000);

  it('reports a credential-free publish as ready while a helper is configured', async () => {
    if (!gitAvailable) return;
    const parent = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-git-'));
    temporaryRoots.push(parent);
    const origin = path.join(parent, 'origin.git');
    const workRoot = path.join(parent, 'work');
    await execFileAsync('git', ['init', '--bare', origin], { cwd: parent, windowsHide: true });
    await mkdir(workRoot, { recursive: true });
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: workRoot, windowsHide: true });
    await execFileAsync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: workRoot, windowsHide: true });
    await execFileAsync('git', ['config', 'user.name', 'unified-mpc test'], { cwd: workRoot, windowsHide: true });
    await writeFile(path.join(workRoot, 'readme.txt'), 'initial\n', 'utf8');
    await execFileAsync('git', ['add', '--', 'readme.txt'], { cwd: workRoot, windowsHide: true });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: workRoot, windowsHide: true });
    await execFileAsync('git', ['remote', 'add', 'origin', origin], { cwd: workRoot, windowsHide: true });
    await execFileAsync('git', ['config', 'credential.helper', '!true'], { cwd: workRoot, windowsHide: true });

    const preflight = await new GitAdapter(new DirectGitRunner()).publishPreflight(workRoot, 'origin', 'goal/publish');
    expect(preflight).toMatchObject({
      ok: true,
      value: { targets: ['file'], runtime: { ready: true }, approval: 'missing' },
    });
  }, 20_000);

  it('judges an inline push target by its own transport instead of assuming a helper', async () => {
    if (!gitAvailable) return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-git-'));
    temporaryRoots.push(root);
    await execFileAsync('git', ['init'], { cwd: root, windowsHide: true });
    await execFileAsync('git', ['config', 'credential.helper', '!true'], { cwd: root, windowsHide: true });
    const bare = path.join(root, 'bare.git');
    await execFileAsync('git', ['init', '--bare', bare], { cwd: root, windowsHide: true });

    const adapter = new GitAdapter(new DirectGitRunner());
    // A positional target is not a configured remote. A local path and a file://
    // URL never consult a helper, so the configured helper above must not deny
    // them.
    await expect(adapter.validatePushSafety(root, bare)).resolves.toMatchObject({ ok: true });
    await expect(adapter.validatePushSafety(root, `file://${bare}`)).resolves.toMatchObject({ ok: true });
    // An HTTP(S) positional target does consult one, so it stays guarded.
    await expect(adapter.validatePushSafety(root, 'https://example.invalid/owner/repo.git')).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'PERMISSION_DENIED',
        details: { reason: 'push-credential-helper', key: 'credential.helper' },
      },
    });
  }, 15_000);

  it('resolves a remote name Git accepts even when the adapter grammar rejects it', async () => {
    if (!gitAvailable) return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-git-'));
    temporaryRoots.push(root);
    await execFileAsync('git', ['init'], { cwd: root, windowsHide: true });
    // `+` is valid in a Git remote name but outside the adapter's conservative
    // grammar, so the name must be resolved instead of read as a local path.
    await execFileAsync('git', ['remote', 'add', 'foo+bar', 'https://example.invalid/owner/repo.git'], { cwd: root, windowsHide: true });
    await execFileAsync('git', ['config', 'credential.helper', '!true'], { cwd: root, windowsHide: true });

    await expect(new GitAdapter(new DirectGitRunner()).validatePushSafety(root, 'foo+bar')).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'PERMISSION_DENIED',
        details: { reason: 'push-credential-helper', key: 'credential.helper' },
      },
    });
  }, 15_000);

  it('fails closed when a url rewrite can change an inline target transport', async () => {
    if (!gitAvailable) return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-git-'));
    temporaryRoots.push(root);
    await execFileAsync('git', ['init'], { cwd: root, windowsHide: true });
    await execFileAsync('git', ['config', 'credential.helper', '!true'], { cwd: root, windowsHide: true });
    const bare = path.join(root, 'bare.git');
    await execFileAsync('git', ['init', '--bare', bare], { cwd: root, windowsHide: true });
    // Git applies this rewrite to a command-line target too, so the literal
    // file:// URL would become an HTTP(S) push that can run the helper.
    await execFileAsync('git', ['config', 'url.https://example.invalid/.insteadOf', `file://${root}/`], { cwd: root, windowsHide: true });

    const adapter = new GitAdapter(new DirectGitRunner());
    await expect(adapter.validatePushSafety(root, `file://${bare}`)).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'PERMISSION_DENIED',
        details: { reason: 'push-credential-helper', key: 'credential.helper' },
      },
    });
    // A target the rewrite does not match is still judged by its own transport.
    await expect(adapter.validatePushSafety(root, bare)).resolves.toMatchObject({ ok: true });
  }, 15_000);

  it('reduces a host-only credential helper scope to the URL key pattern', async () => {
    if (!gitAvailable) return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-git-'));
    temporaryRoots.push(root);
    await execFileAsync('git', ['init'], { cwd: root, windowsHide: true });
    const marker = path.join(root, 'credential-wrapper-ran');
    const wrapper = path.join(root, 'credential-wrapper.sh');
    await writeFile(wrapper, `#!/bin/sh\nprintf hit > "${marker}"\nexit 1\n`, 'utf8');
    await chmod(wrapper, 0o755);
    await execFileAsync('git', ['config', 'credential.internal.example.helper', `!${wrapper}`], { cwd: root, windowsHide: true });

    const denied = await new GitAdapter(new DirectGitRunner()).validatePushSafety(root, 'origin');
    expect(denied).toMatchObject({
      ok: false,
      error: {
        code: 'PERMISSION_DENIED',
        details: { reason: 'push-credential-helper', key: 'credential.<url>.helper' },
      },
    });
    const serialized = JSON.stringify(denied);
    expect(serialized).not.toContain(escapedForJson(wrapper));
    expect(serialized).not.toContain('internal.example');
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

    const denied = await new GitAdapter(new DirectGitRunner()).validatePushSafety(root, 'origin');
    expect(denied).toMatchObject({
      ok: false,
      error: {
        code: 'PERMISSION_DENIED',
        details: { reason: 'push-signing-program', key: 'gpg.program' },
      },
    });
    expect(JSON.stringify(denied)).not.toContain(escapedForJson(wrapper));
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
      error: {
        code: 'PERMISSION_DENIED',
        details: { reason: 'push-config-override', key: 'push.recurseSubmodules' },
      },
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
      error: {
        code: 'PERMISSION_DENIED',
        details: { reason: 'push-protocol-override', key: 'protocol.ext.allow' },
      },
    });
    await expect(new GitAdapter(new DirectGitRunner()).defaultBranches(root, 'origin')).resolves.toEqual({ ok: true, value: [] });
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 15_000);

  it('rejects the global protocol allow list as a protocol override', async () => {
    if (!gitAvailable) return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-git-'));
    temporaryRoots.push(root);
    await execFileAsync('git', ['init'], { cwd: root, windowsHide: true });
    await execFileAsync('git', ['config', 'protocol.allow', 'always'], { cwd: root, windowsHide: true });

    await expect(new GitAdapter(new DirectGitRunner()).validatePushSafety(root, 'origin')).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'PERMISSION_DENIED',
        details: { reason: 'push-protocol-override', key: 'protocol.allow' },
      },
    });
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
      error: {
        code: 'PERMISSION_DENIED',
        details: { reason: 'push-pre-push-hook' },
      },
    });
  }, 15_000);

  it('reports a ready publish preflight and resolves the protected default branch', async () => {
    if (!gitAvailable) return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-git-'));
    temporaryRoots.push(root);
    const remoteRoot = path.join(root, 'remote.git');
    const workRoot = path.join(root, 'work');
    await mkdir(remoteRoot, { recursive: true });
    await execFileAsync('git', ['init', '--bare', '-b', 'main', remoteRoot], { cwd: root, windowsHide: true });
    await mkdir(workRoot, { recursive: true });
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: workRoot, windowsHide: true });
    await execFileAsync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: workRoot, windowsHide: true });
    await execFileAsync('git', ['config', 'user.name', 'unified-mpc test'], { cwd: workRoot, windowsHide: true });
    await writeFile(path.join(workRoot, 'readme.txt'), 'initial\n', 'utf8');
    await execFileAsync('git', ['add', '--', 'readme.txt'], { cwd: workRoot, windowsHide: true });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: workRoot, windowsHide: true });
    await execFileAsync('git', ['remote', 'add', 'origin', remoteRoot], { cwd: workRoot, windowsHide: true });
    await execFileAsync('git', ['push', 'origin', 'main'], { cwd: workRoot, windowsHide: true });

    const adapter = new GitAdapter(new DirectGitRunner());
    const feature = await adapter.publishPreflight(workRoot, 'origin', 'goal/publish');
    expect(feature).toMatchObject({
      ok: true,
      value: {
        remote: 'origin',
        branch: 'goal/publish',
        defaultBranches: ['main'],
        protectedBranch: false,
        targets: ['file'],
        runtime: { ready: true },
        approval: 'missing',
      },
    });
    const head = await execFileAsync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: workRoot, windowsHide: true });
    expect(feature.ok && feature.value.head).toBe(head.stdout.trim().toLowerCase());

    await expect(adapter.publishPreflight(workRoot, 'origin', 'main')).resolves.toMatchObject({
      ok: true,
      value: { protectedBranch: true },
    });
  }, 20_000);

  it('publishes one exact commit to one branch without running a credential helper', async () => {
    if (!gitAvailable) return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-git-'));
    temporaryRoots.push(root);
    const remoteRoot = path.join(root, 'remote.git');
    const workRoot = path.join(root, 'work');
    await mkdir(remoteRoot, { recursive: true });
    await execFileAsync('git', ['init', '--bare', '-b', 'main', remoteRoot], { cwd: root, windowsHide: true });
    await mkdir(workRoot, { recursive: true });
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: workRoot, windowsHide: true });
    await execFileAsync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: workRoot, windowsHide: true });
    await execFileAsync('git', ['config', 'user.name', 'unified-mpc test'], { cwd: workRoot, windowsHide: true });
    await writeFile(path.join(workRoot, 'readme.txt'), 'initial\n', 'utf8');
    await execFileAsync('git', ['add', '--', 'readme.txt'], { cwd: workRoot, windowsHide: true });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: workRoot, windowsHide: true });
    await execFileAsync('git', ['remote', 'add', 'origin', remoteRoot], { cwd: workRoot, windowsHide: true });
    const marker = path.join(root, 'credential-wrapper-ran');
    const wrapper = path.join(root, 'credential-wrapper.sh');
    await writeFile(wrapper, `#!/bin/sh\nprintf hit > "${marker}"\nexit 1\n`, 'utf8');
    await chmod(wrapper, 0o755);
    await execFileAsync('git', ['config', 'credential.helper', `!${wrapper}`], { cwd: workRoot, windowsHide: true });

    const head = (await execFileAsync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: workRoot, windowsHide: true }))
      .stdout.trim().toLowerCase();
    const adapter = new GitAdapter(new DirectGitRunner());
    const published = await adapter.publish(workRoot, { remote: 'origin', branch: 'goal/publish', expectedSha: head });
    expect(published).toMatchObject({
      ok: true,
      value: { remote: 'origin', branch: 'goal/publish', sha: head, targets: ['file'] },
    });
    const remoteRef = (await execFileAsync('git', ['ls-remote', '--heads', remoteRoot, 'refs/heads/goal/publish'], { cwd: root, windowsHide: true }))
      .stdout.trim();
    expect(remoteRef).toBe(`${head}\trefs/heads/goal/publish`);
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });

    await expect(adapter.publish(workRoot, {
      remote: 'origin', branch: 'goal/publish', expectedSha: 'b'.repeat(40),
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'CONFLICT', details: { reason: 'publish-head-moved' } },
    });
  }, 20_000);

  it('does not publish annotated tags when the repository sets push.followTags', async () => {
    if (!gitAvailable) return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-git-'));
    temporaryRoots.push(root);
    const remoteRoot = path.join(root, 'remote.git');
    const workRoot = path.join(root, 'work');
    await mkdir(remoteRoot, { recursive: true });
    await execFileAsync('git', ['init', '--bare', '-b', 'main', remoteRoot], { cwd: root, windowsHide: true });
    await mkdir(workRoot, { recursive: true });
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: workRoot, windowsHide: true });
    await execFileAsync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: workRoot, windowsHide: true });
    await execFileAsync('git', ['config', 'user.name', 'unified-mpc test'], { cwd: workRoot, windowsHide: true });
    await writeFile(path.join(workRoot, 'readme.txt'), 'initial\n', 'utf8');
    await execFileAsync('git', ['add', '--', 'readme.txt'], { cwd: workRoot, windowsHide: true });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: workRoot, windowsHide: true });
    await execFileAsync('git', ['tag', '-a', 'v1', '-m', 'release'], { cwd: workRoot, windowsHide: true });
    await execFileAsync('git', ['remote', 'add', 'origin', remoteRoot], { cwd: workRoot, windowsHide: true });
    await execFileAsync('git', ['config', 'push.followTags', 'true'], { cwd: workRoot, windowsHide: true });

    const head = (await execFileAsync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: workRoot, windowsHide: true }))
      .stdout.trim().toLowerCase();
    const adapter = new GitAdapter(new DirectGitRunner());
    await expect(adapter.publish(workRoot, { remote: 'origin', branch: 'goal/publish', expectedSha: head }))
      .resolves.toMatchObject({ ok: true, value: { branch: 'goal/publish', sha: head } });

    const remoteRefs = (await execFileAsync('git', ['ls-remote', remoteRoot], { cwd: root, windowsHide: true }))
      .stdout.trim().split(/\r?\n/).filter((line) => line.length > 0);
    expect(remoteRefs).toEqual([`${head}\trefs/heads/goal/publish`]);
  }, 20_000);

  it('classifies a rejected push as an authentication failure and leaves no ref behind', async () => {
    if (!gitAvailable) return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-git-'));
    temporaryRoots.push(root);
    const remoteRoot = path.join(root, 'remote.git');
    const workRoot = path.join(root, 'work');
    await mkdir(remoteRoot, { recursive: true });
    await execFileAsync('git', ['init', '--bare', '-b', 'main', remoteRoot], { cwd: root, windowsHide: true });
    await mkdir(path.join(remoteRoot, 'hooks'), { recursive: true });
    const hook = path.join(remoteRoot, 'hooks', 'pre-receive');
    await writeFile(hook, '#!/bin/sh\nprintf "%s\\n" "fatal: Authentication failed for https://example.invalid/owner/repo.git" >&2\nexit 1\n', 'utf8');
    await chmod(hook, 0o755);
    await mkdir(workRoot, { recursive: true });
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: workRoot, windowsHide: true });
    await execFileAsync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: workRoot, windowsHide: true });
    await execFileAsync('git', ['config', 'user.name', 'unified-mpc test'], { cwd: workRoot, windowsHide: true });
    await writeFile(path.join(workRoot, 'readme.txt'), 'initial\n', 'utf8');
    await execFileAsync('git', ['add', '--', 'readme.txt'], { cwd: workRoot, windowsHide: true });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: workRoot, windowsHide: true });
    await execFileAsync('git', ['remote', 'add', 'origin', remoteRoot], { cwd: workRoot, windowsHide: true });

    const head = (await execFileAsync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: workRoot, windowsHide: true }))
      .stdout.trim().toLowerCase();
    const adapter = new GitAdapter(new DirectGitRunner());
    const published = await adapter.publish(workRoot, { remote: 'origin', branch: 'goal/publish', expectedSha: head });
    expect(published).toMatchObject({
      ok: false,
      error: { code: 'PERMISSION_DENIED', details: { reason: 'publish-authentication-failed' } },
    });
    expect(JSON.stringify(published)).not.toContain('example.invalid');
    const remoteRefs = (await execFileAsync('git', ['ls-remote', remoteRoot], { cwd: root, windowsHide: true })).stdout.trim();
    expect(remoteRefs).toBe('');
  }, 20_000);

  it('reports a credential-helper runtime block without attempting a push', async () => {
    if (!gitAvailable) return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-git-'));
    temporaryRoots.push(root);
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: root, windowsHide: true });
    await execFileAsync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root, windowsHide: true });
    await execFileAsync('git', ['config', 'user.name', 'unified-mpc test'], { cwd: root, windowsHide: true });
    await writeFile(path.join(root, 'readme.txt'), 'initial\n', 'utf8');
    await execFileAsync('git', ['add', '--', 'readme.txt'], { cwd: root, windowsHide: true });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: root, windowsHide: true });
    await execFileAsync('git', ['remote', 'add', 'origin', 'https://example.invalid/owner/repo.git'], { cwd: root, windowsHide: true });
    await execFileAsync('git', ['config', 'credential.https://example.invalid.helper', '!true'], { cwd: root, windowsHide: true });

    const preflight = await new GitAdapter(new DirectGitRunner()).publishPreflight(root, 'origin', 'goal/publish');
    expect(preflight).toMatchObject({
      ok: true,
      value: {
        runtime: { ready: false, reason: 'push-credential-helper', key: 'credential.<url>.helper' },
        approval: 'missing',
      },
    });
    expect(JSON.stringify(preflight)).not.toContain('!true');
  }, 15_000);

  it('does not contact the remote while the runtime is blocked', async () => {
    if (!gitAvailable) return;
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.writeHead(401, { 'www-authenticate': 'Basic realm="test"' });
      response.end('denied\n');
    });
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    try {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-git-'));
      temporaryRoots.push(root);
      await execFileAsync('git', ['init', '-b', 'main'], { cwd: root, windowsHide: true });
      await execFileAsync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root, windowsHide: true });
      await execFileAsync('git', ['config', 'user.name', 'unified-mpc test'], { cwd: root, windowsHide: true });
      await writeFile(path.join(root, 'readme.txt'), 'initial\n', 'utf8');
      await execFileAsync('git', ['add', '--', 'readme.txt'], { cwd: root, windowsHide: true });
      await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: root, windowsHide: true });
      await execFileAsync('git', ['remote', 'add', 'origin', `http://127.0.0.1:${port}/owner/repo.git`], { cwd: root, windowsHide: true });
      const marker = path.join(root, 'credential-wrapper-ran');
      const wrapper = path.join(root, 'credential-wrapper.sh');
      await writeFile(wrapper, `#!/bin/sh\nprintf hit > "${marker}"\nexit 1\n`, 'utf8');
      await chmod(wrapper, 0o755);
      await execFileAsync('git', ['config', 'credential.helper', `!${wrapper}`], { cwd: root, windowsHide: true });

      // Issue #549: `ls-remote` would answer the 401 by running the helper, and the
      // guard already refuses this target, so the blocked preflight must not ask.
      const preflight = await new GitAdapter(new DirectGitRunner()).publishPreflight(root, 'origin', 'goal/publish');
      expect(preflight).toMatchObject({
        ok: true,
        value: {
          targets: [`http://127.0.0.1:${port}`],
          defaultBranches: [],
          protectedBranch: false,
          runtime: { ready: false, reason: 'push-credential-helper', key: 'credential.helper' },
          approval: 'missing',
        },
      });
      expect(requests).toBe(0);
      await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
    }
  }, 20_000);

  it('never echoes credentials embedded in a publish remote URL', async () => {
    if (!gitAvailable) return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-git-'));
    temporaryRoots.push(root);
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: root, windowsHide: true });
    await execFileAsync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root, windowsHide: true });
    await execFileAsync('git', ['config', 'user.name', 'unified-mpc test'], { cwd: root, windowsHide: true });
    await writeFile(path.join(root, 'readme.txt'), 'initial\n', 'utf8');
    await execFileAsync('git', ['add', '--', 'readme.txt'], { cwd: root, windowsHide: true });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: root, windowsHide: true });
    await execFileAsync('git', ['remote', 'add', 'origin', 'https://publisher:super-secret-token@example.invalid/owner/repo.git'], { cwd: root, windowsHide: true });

    const preflight = await new GitAdapter(new DirectGitRunner()).publishPreflight(root, 'origin', 'goal/publish');
    expect(preflight).toMatchObject({ ok: true, value: { targets: ['https://example.invalid'] } });
    expect(JSON.stringify(preflight)).not.toContain('super-secret-token');
    expect(JSON.stringify(preflight)).not.toContain('publisher');
  }, 15_000);
});
