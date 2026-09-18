import { execFile } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
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
  beforeAll(async () => {
    gitAvailable = await hasGit();
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

    await expect(new GitAdapter(new DirectGitRunner()).validatePushSafety(root, 'origin')).resolves.toMatchObject({
      ok: false,
      error: { code: 'PERMISSION_DENIED' },
    });
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
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
