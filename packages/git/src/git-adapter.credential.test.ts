import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  fingerprintPublishCredentialHosts,
  type PublishCredentialLease,
  type PublishCredentialMaterial,
} from '@unified-mpc/domain';
import { GitAdapter, type GitAdapterOptions } from './git-adapter.js';
import type { GitRunOptions, GitRunResult, GitRunner } from './git-runner.js';

const SHA = 'a'.repeat(40);

type Handler = (args: readonly string[], options?: GitRunOptions) => GitRunResult | undefined;

/** A runner that answers the guard's reads from a scripted remote. */
class ScriptedRunner implements GitRunner {
  public readonly calls: { args: readonly string[]; cwd: string; options?: GitRunOptions }[] = [];
  public constructor(private readonly handler: Handler = () => undefined) {}

  public async run(args: readonly string[], cwd: string, options?: GitRunOptions): Promise<GitRunResult> {
    this.calls.push({ args, cwd, ...(options === undefined ? {} : { options }) });
    const scripted = this.handler(args, options);
    if (scripted !== undefined) return scripted;
    if (args[0] === 'config') return { exitCode: 1, stdout: '', stderr: '' };
    if (args[0] === 'remote' && args[1] === 'get-url') {
      return { exitCode: 0, stdout: 'https://github.com/soulzerox/repo.git\n', stderr: '' };
    }
    if (args[0] === 'rev-parse' && args[1] === '--git-path') {
      return { exitCode: 0, stdout: '/nonexistent/unified-mpc-hooks\n', stderr: '' };
    }
    if (args[0] === 'rev-parse' && args[1] === '--verify') {
      return { exitCode: 0, stdout: `${SHA}\n`, stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  }
}

const temporaryRoots: string[] = [];

async function makeDeployment(): Promise<{ root: string; helper: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-deployment-'));
  temporaryRoots.push(root);
  const helper = path.join(root, 'publish-credential-helper');
  await writeFile(helper, '#!/bin/sh\nexit 1\n', 'utf8');
  await chmod(helper, 0o555);
  return { root, helper };
}

function adapterOptions(root: string, overrides: GitAdapterOptions = {}): GitAdapterOptions {
  return {
    resolvePublishCredentialDeployment: async () => ({ root, promoted: true }),
    now: () => Date.now(),
    ...overrides,
  };
}

function lease(overrides: Partial<PublishCredentialLease> = {}): PublishCredentialLease {
  const now = Date.now();
  return {
    leaseId: 'lease-1',
    workspaceId: 'workspace-1',
    remote: 'origin',
    hosts: ['github.com'],
    username: 'x-access-token',
    createdAt: now - 1_000,
    expiresAt: now + 60_000,
    ...overrides,
  };
}

function material(overrides: Partial<PublishCredentialLease> = {}): PublishCredentialMaterial {
  return { lease: lease(overrides), secret: 's3cr3t-token' };
}

function scopedArgv(helper: string, command: readonly string[]): readonly string[] {
  return ['-c', 'credential.helper=', '-c', `credential.helper=!${helper}`, ...command];
}

afterEach(async () => {
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
});

describe('GitAdapter publish credential allowlist', () => {
  it('denies a helper argv without an authorization', async () => {
    const { root, helper } = await makeDeployment();
    const runner = new ScriptedRunner();
    const adapter = new GitAdapter(runner, adapterOptions(root));

    const result = await adapter.validatePushSafety('/repo', 'origin', {
      argv: scopedArgv(helper, ['push', 'origin', `${SHA}:refs/heads/main`]),
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'PERMISSION_DENIED', details: { reason: 'push-credential-helper' } },
    });
  });

  it('keeps denying a configured helper on an HTTP(S) target', async () => {
    const { root } = await makeDeployment();
    const runner = new ScriptedRunner((args) => (args[0] === 'config' && args[1] === '--get-regexp'
      && String(args[2]).includes('credential')
      ? { exitCode: 0, stdout: 'credential.helper store\n', stderr: '' }
      : undefined));
    const adapter = new GitAdapter(runner, adapterOptions(root));

    const result = await adapter.validatePushSafety('/repo', 'origin');

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'PERMISSION_DENIED', details: { reason: 'push-credential-helper', key: 'credential.helper' } },
    });
  });

  it('allows a diagnostic authorization with the exact helper shape', async () => {
    const { root, helper } = await makeDeployment();
    const adapter = new GitAdapter(new ScriptedRunner(), adapterOptions(root));

    const result = await adapter.validatePushSafety('/repo', 'origin', {
      argv: scopedArgv(helper, ['ls-remote', '--symref', 'origin', 'HEAD']),
      authorization: { kind: 'diagnostic', lease: lease() },
    });

    expect(result).toEqual({ ok: true, value: undefined });
  });

  it('refuses a third credential.helper assignment', async () => {
    const { root, helper } = await makeDeployment();
    const adapter = new GitAdapter(new ScriptedRunner(), adapterOptions(root));

    const result = await adapter.validatePushSafety('/repo', 'origin', {
      argv: [...scopedArgv(helper, []), '-c', 'credential.helper=!store', 'push', 'origin', 'HEAD:refs/heads/main'],
      authorization: { kind: 'diagnostic', lease: lease() },
    });

    expect(result).toMatchObject({ ok: false, error: { details: { reason: 'publish-credential-unavailable' } } });
  });

  it('refuses a helper path outside the running deployment', async () => {
    const { root } = await makeDeployment();
    const adapter = new GitAdapter(new ScriptedRunner(), adapterOptions(root));

    const result = await adapter.validatePushSafety('/repo', 'origin', {
      argv: scopedArgv('/tmp/other/publish-credential-helper', ['push', 'origin', 'HEAD:refs/heads/main']),
      authorization: { kind: 'diagnostic', lease: lease() },
    });

    expect(result).toMatchObject({ ok: false, error: { details: { reason: 'publish-credential-unavailable' } } });
  });

  it('refuses a symlinked helper', async () => {
    const { root, helper } = await makeDeployment();
    const target = path.join(root, 'real-helper');
    await writeFile(target, '#!/bin/sh\nexit 1\n', 'utf8');
    await chmod(target, 0o555);
    await rm(helper);
    await symlink(target, helper);
    const adapter = new GitAdapter(new ScriptedRunner(), adapterOptions(root));

    const result = await adapter.validatePushSafety('/repo', 'origin', {
      argv: scopedArgv(helper, ['push', 'origin', 'HEAD:refs/heads/main']),
      authorization: { kind: 'diagnostic', lease: lease() },
    });

    expect(result).toMatchObject({ ok: false, error: { details: { reason: 'publish-credential-unavailable' } } });
  });

  it('refuses a group-writable helper', async () => {
    const { root, helper } = await makeDeployment();
    await chmod(helper, 0o575);
    const adapter = new GitAdapter(new ScriptedRunner(), adapterOptions(root));

    const result = await adapter.validatePushSafety('/repo', 'origin', {
      argv: scopedArgv(helper, ['push', 'origin', 'HEAD:refs/heads/main']),
      authorization: { kind: 'diagnostic', lease: lease() },
    });

    expect(result).toMatchObject({ ok: false, error: { details: { reason: 'publish-credential-unavailable' } } });
  });

  it('refuses a canonical checkout even when the helper file exists', async () => {
    const { root, helper } = await makeDeployment();
    const adapter = new GitAdapter(new ScriptedRunner(), adapterOptions(root, {
      resolvePublishCredentialDeployment: async () => ({ root, promoted: false }),
    }));

    const result = await adapter.validatePushSafety('/repo', 'origin', {
      argv: scopedArgv(helper, ['push', 'origin', 'HEAD:refs/heads/main']),
      authorization: { kind: 'diagnostic', lease: lease() },
    });

    expect(result).toMatchObject({ ok: false, error: { details: { reason: 'publish-credential-unavailable' } } });
  });

  it('refuses a lease whose host set no longer matches the remote', async () => {
    const { root, helper } = await makeDeployment();
    const adapter = new GitAdapter(new ScriptedRunner(), adapterOptions(root));

    const result = await adapter.validatePushSafety('/repo', 'origin', {
      argv: scopedArgv(helper, ['push', 'origin', 'HEAD:refs/heads/main']),
      authorization: { kind: 'diagnostic', lease: lease({ hosts: ['gitlab.com'] }) },
    });

    expect(result).toMatchObject({ ok: false, error: { details: { reason: 'publish-target-changed' } } });
  });

  it('refuses an expired lease', async () => {
    const { root, helper } = await makeDeployment();
    const adapter = new GitAdapter(new ScriptedRunner(), adapterOptions(root));

    const result = await adapter.validatePushSafety('/repo', 'origin', {
      argv: scopedArgv(helper, ['push', 'origin', 'HEAD:refs/heads/main']),
      authorization: { kind: 'diagnostic', lease: lease({ expiresAt: Date.now() - 1 }) },
    });

    expect(result).toMatchObject({ ok: false, error: { details: { reason: 'publish-credential-unavailable' } } });
  });

  it('refuses a publish nonce the adapter did not mint', async () => {
    const { root, helper } = await makeDeployment();
    const adapter = new GitAdapter(new ScriptedRunner(), adapterOptions(root));

    const result = await adapter.validatePushSafety('/repo', 'origin', {
      argv: scopedArgv(helper, ['push', 'origin', 'HEAD:refs/heads/main']),
      authorization: { kind: 'publish', lease: lease(), approvalId: 'approval-1', spendNonce: 'not-minted-here' },
    });

    expect(result).toMatchObject({ ok: false, error: { details: { reason: 'publish-credential-unavailable' } } });
  });

  it('spawns the push and the verification through the helper without exposing the secret', async () => {
    const { root, helper } = await makeDeployment();
    const runner = new ScriptedRunner((args) => {
      if (args.includes('push')) return { exitCode: 0, stdout: '', stderr: '' };
      if (args.includes('ls-remote')) return { exitCode: 0, stdout: `${SHA}\trefs/heads/main\n`, stderr: '' };
      return undefined;
    });
    const adapter = new GitAdapter(runner, adapterOptions(root));
    const credential = { approvalId: 'approval-1', material: material() };

    const result = await adapter.publish('/repo', { remote: 'origin', branch: 'main', expectedSha: SHA }, { credential });

    expect(result).toMatchObject({ ok: true, value: { remote: 'origin', branch: 'main', sha: SHA } });
    const pushCall = runner.calls.find((call) => call.args.includes('push'));
    expect(pushCall?.args).toEqual(scopedArgv(helper, [
      'push', '--no-verify', '--no-follow-tags', '--porcelain', 'origin', `${SHA}:refs/heads/main`,
    ]));
    expect(pushCall?.args.join('\u0000')).not.toContain('s3cr3t-token');
    expect(pushCall?.options?.env).toEqual({
      UNIFIED_PUBLISH_LEASE_ID: 'lease-1',
      UNIFIED_PUBLISH_CREDENTIAL_FD: '3',
    });
    const descriptor = JSON.parse(String(pushCall?.options?.descriptor)) as Record<string, unknown>;
    expect(descriptor).toMatchObject({
      version: 1,
      leaseId: 'lease-1',
      username: 'x-access-token',
      secret: 's3cr3t-token',
      hosts: ['github.com'],
    });
    const verifyCall = runner.calls.find((call) => call.args.includes('ls-remote'));
    expect(verifyCall?.args.slice(0, 4)).toEqual(['-c', 'credential.helper=', '-c', `credential.helper=!${helper}`]);
    expect(verifyCall?.options?.descriptor).toContain('s3cr3t-token');
  });

  it('uses a diagnostic lease for the pre-approval default-branch read', async () => {
    const { root, helper } = await makeDeployment();
    const runner = new ScriptedRunner((args) => {
      if (args.includes('ls-remote')) {
        return { exitCode: 0, stdout: 'ref: refs/heads/main\tHEAD\n', stderr: '' };
      }
      return undefined;
    });
    const adapter = new GitAdapter(runner, adapterOptions(root));

    const result = await adapter.publishPreflight('/repo', 'origin', 'feature', {
      credential: { approvalId: 'diagnostic', material: material() },
    });

    expect(result).toMatchObject({
      ok: true,
      value: { head: SHA, defaultBranches: ['main'], protectedBranch: false, runtime: { ready: true } },
    });
    const read = runner.calls.find((call) => call.args.includes('ls-remote'));
    expect(read?.args.slice(0, 4)).toEqual(['-c', 'credential.helper=', '-c', `credential.helper=!${helper}`]);
    expect(read?.options?.env).toMatchObject({ UNIFIED_PUBLISH_LEASE_ID: 'lease-1' });
  });

  it('leaves an SSH target on the credential-free path', async () => {
    const { root } = await makeDeployment();
    const runner = new ScriptedRunner((args) => {
      if (args[0] === 'remote') return { exitCode: 0, stdout: 'git@github.com:soulzerox/repo.git\n', stderr: '' };
      if (args.includes('ls-remote')) return { exitCode: 0, stdout: `${SHA}\trefs/heads/main\n`, stderr: '' };
      return undefined;
    });
    const adapter = new GitAdapter(runner, adapterOptions(root));

    const result = await adapter.publish('/repo', { remote: 'origin', branch: 'main', expectedSha: SHA });

    expect(result).toMatchObject({ ok: true });
    const pushCall = runner.calls.find((call) => call.args.includes('push'));
    expect(pushCall?.args[0]).toBe('push');
    expect(pushCall?.options?.descriptor).toBeUndefined();
  });

  it('fingerprints one https push host without recording userinfo or the default port', async () => {
    const runner = new ScriptedRunner((args) => (args[0] === 'remote' && args[1] === 'get-url'
      ? { exitCode: 0, stdout: 'https://user:token@github.com:443/soulzerox/repo.git\n', stderr: '' }
      : undefined));
    const adapter = new GitAdapter(runner);

    await expect(adapter.publishTargetFingerprint('/repo', 'origin')).resolves.toEqual({
      ok: true,
      value: fingerprintPublishCredentialHosts(['github.com']),
    });
  });

  it('refuses a credential target with more than one push URL', async () => {
    const runner = new ScriptedRunner((args) => (args[0] === 'remote' && args[1] === 'get-url'
      ? { exitCode: 0, stdout: 'https://github.com/a.git\nhttps://github.com/b.git\n', stderr: '' }
      : undefined));
    const adapter = new GitAdapter(runner);

    await expect(adapter.publishTargetFingerprint('/repo', 'origin')).resolves.toMatchObject({
      ok: false,
      error: { code: 'PERMISSION_DENIED', details: { reason: 'push-target-ambiguous' } },
    });
  });

  it('refuses a non-https credential target', async () => {
    const runner = new ScriptedRunner((args) => (args[0] === 'remote' && args[1] === 'get-url'
      ? { exitCode: 0, stdout: 'http://github.com/a.git\n', stderr: '' }
      : undefined));
    const adapter = new GitAdapter(runner);

    await expect(adapter.publishTargetFingerprint('/repo', 'origin')).resolves.toMatchObject({
      ok: false,
      error: { code: 'UNSUPPORTED_TARGET', details: { reason: 'publish-credential-unsupported' } },
    });
  });
});
