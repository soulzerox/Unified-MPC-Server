import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { GitAdapter } from '@unified-mpc/git';
import type { Workspace, WorkspaceRepository } from '@unified-mpc/workspace';
import { GitService } from './git-service.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createWorkspace(): Promise<Workspace> {
  const rawRoot = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-git-service-'));
  temporaryRoots.push(rawRoot);
  const root = await realpath(rawRoot);
  return {
    id: 'workspace-1',
    displayName: 'Fixture',
    rootPath: root,
    realRootPath: root,
    createdAt: new Date(0).toISOString(),
  };
}

function repository(workspace: Workspace): WorkspaceRepository {
  return {
    async list(): Promise<Workspace[]> { return [workspace]; },
    async get(id: string): Promise<Workspace | null> { return id === workspace.id ? workspace : null; },
    async insert(): Promise<void> {},
    async delete(): Promise<void> {},
  };
}

describe('GitService', () => {
  it('accepts prohibited Git forms and an outside cwd only with trusted Full Bypass authorization', async () => {
    const workspace = await createWorkspace();
    const outsideRoot = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-git-outside-'));
    temporaryRoots.push(outsideRoot);
    const calls: Array<{ readonly cwd: string; readonly args: readonly string[] }> = [];
    const adapter = {
      async run(cwd: string, args: readonly string[]): Promise<{ ok: true; value: { exitCode: number; stdout: string; stderr: string } }> {
        calls.push({ cwd, args });
        return { ok: true, value: { exitCode: 0, stdout: '', stderr: '' } };
      },
    } as unknown as GitAdapter;
    const service = new GitService(repository(workspace), undefined, adapter);
    const authorization = { mode: 'full_bypass', applicationApproved: true, bypassApplicationAuthorization: true, source: 'full_bypass' } as const;

    await expect(service.run({ clientId: 'test', clientName: 'test' }, {
      args: ['-C', outsideRoot, 'status'],
      workspaceId: workspace.id,
      cwd: outsideRoot,
    }, undefined, authorization)).resolves.toMatchObject({ ok: true });
    expect(calls).toEqual([{ cwd: await realpath(outsideRoot), args: ['-C', outsideRoot, 'status'] }]);
  });

  it('keeps the default-branch invariant under trusted Full Bypass', async () => {
    const workspace = await createWorkspace();
    let calls = 0;
    const adapter = {
      async validatePushSafety(): Promise<{ ok: true; value: undefined }> { return { ok: true, value: undefined }; },
      async defaultBranch(): Promise<{ ok: true; value: string }> { return { ok: true, value: 'trunk' }; },
      async run(): Promise<{ ok: true; value: { exitCode: number; stdout: string; stderr: string } }> {
        calls += 1;
        return { ok: true, value: { exitCode: 0, stdout: '', stderr: '' } };
      },
    } as unknown as GitAdapter;
    const service = new GitService(repository(workspace), undefined, adapter);
    const authorization = { mode: 'full_bypass', applicationApproved: true, bypassApplicationAuthorization: true, source: 'full_bypass' } as const;

    await expect(service.run({ clientId: 'test', clientName: 'test' }, {
      args: ['push', 'origin', 'trunk'],
      workspaceId: workspace.id,
    }, undefined, authorization)).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    expect(calls).toBe(0);
  });

  it.each([
    ['-c', ['-c', 'color.ui=false', 'push', 'origin', 'trunk']],
    ['--no-pager', ['--no-pager', 'push', 'origin', 'trunk']],
    ['--exec-path=', ['--exec-path=/tmp/custom-bin', 'push', 'origin', 'feature/review-gate']],
    ['--exec-path value', ['--exec-path', '/tmp/custom-bin', 'push', 'origin', 'feature/review-gate']],
  ] as const)('keeps the default-branch invariant after Git global option %s under Full Bypass', async (_label, args) => {
    const workspace = await createWorkspace();
    let defaultBranchCalls = 0;
    const adapter = {
      async validatePushSafety(): Promise<{ ok: true; value: undefined }> { return { ok: true, value: undefined }; },
      async defaultBranch(): Promise<{ ok: true; value: string }> {
        defaultBranchCalls += 1;
        return { ok: true, value: 'trunk' };
      },
      async run(): Promise<{ ok: true; value: { exitCode: number; stdout: string; stderr: string } }> {
        throw new Error('default branch push must be denied before adapter execution');
      },
    } as unknown as GitAdapter;
    const service = new GitService(repository(workspace), undefined, adapter);
    const authorization = { mode: 'full_bypass', applicationApproved: true, bypassApplicationAuthorization: true, source: 'full_bypass' } as const;

    await expect(service.run({ clientId: 'test', clientName: 'test' }, { args, workspaceId: workspace.id }, undefined, authorization))
      .resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    expect(defaultBranchCalls).toBe(_label === '--no-pager' ? 1 : 0);
  });

  it.each([
    ['-C', ['-C', '/outside', 'push', 'origin', 'trunk']],
    ['--git-dir', ['--git-dir', '/outside/.git', 'push', 'origin', 'trunk']],
    ['--work-tree', ['--work-tree', '/outside', 'push', 'origin', 'trunk']],
  ] as const)('rejects scope-changing Git global option %s before a push', async (_label, args) => {
    const workspace = await createWorkspace();
    let defaultBranchCalls = 0;
    const adapter = {
      async defaultBranch(): Promise<{ ok: true; value: string }> {
        defaultBranchCalls += 1;
        return { ok: true, value: 'trunk' };
      },
      async run(): Promise<never> { throw new Error('scope-changing push must be denied before adapter execution'); },
    } as unknown as GitAdapter;
    const service = new GitService(repository(workspace), undefined, adapter);

    await expect(service.run({ clientId: 'test', clientName: 'test' }, { args, workspaceId: workspace.id }, undefined, {
      mode: 'full_bypass',
      applicationApproved: true,
      bypassApplicationAuthorization: true,
      source: 'full_bypass',
    })).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    expect(defaultBranchCalls).toBe(0);
  });

  it.each([
    ['stored alias', ['ship']],
    ['inline alias', ['-c', 'alias.ship=push origin HEAD:main', 'ship']],
  ] as const)('blocks %s under Full Bypass before Git alias expansion', async (_label, args) => {
    const workspace = await createWorkspace();
    let calls = 0;
    const adapter = {
      async run(): Promise<never> {
        calls += 1;
        throw new Error('Git aliases must be blocked before adapter execution');
      },
    } as unknown as GitAdapter;
    const service = new GitService(repository(workspace), undefined, adapter);

    await expect(service.run({ clientId: 'test', clientName: 'test' }, { args, workspaceId: workspace.id }, undefined, {
      mode: 'full_bypass',
      applicationApproved: true,
      bypassApplicationAuthorization: true,
      source: 'full_bypass',
    })).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    expect(calls).toBe(0);
  });

  it('checks every actual push target default branch under Full Bypass', async () => {
    const workspace = await createWorkspace();
    let calls = 0;
    const adapter = {
      async validatePushSafety(): Promise<{ ok: true; value: undefined }> { return { ok: true, value: undefined }; },
      async defaultBranches(): Promise<{ ok: true; value: readonly string[] }> {
        return { ok: true, value: ['trunk', 'main'] };
      },
      async run(): Promise<never> {
        calls += 1;
        throw new Error('push to any target default branch must be denied');
      },
    } as unknown as GitAdapter;
    const service = new GitService(repository(workspace), undefined, adapter);

    await expect(service.run({ clientId: 'test', clientName: 'test' }, {
      args: ['push', 'origin', 'main'],
      workspaceId: workspace.id,
    }, undefined, {
      mode: 'full_bypass',
      applicationApproved: true,
      bypassApplicationAuthorization: true,
      source: 'full_bypass',
    })).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    expect(calls).toBe(0);
  });

  it.each([
    ['push URL override', ['-c', 'remote.origin.pushurl=/tmp/other.git', 'push', 'origin', 'main']],
    ['included push URL override', ['-c', 'include.path=/tmp/override.cfg', 'push', 'origin', 'main']],
    ['config-env include override', ['--config-env=include.path=GIT_INCLUDE', 'push', 'origin', 'main']],
  ] as const)('rejects %s under Full Bypass before resolution', async (_label, args) => {
    const workspace = await createWorkspace();
    let defaultBranchCalls = 0;
    const adapter = {
      async defaultBranches(): Promise<{ ok: true; value: readonly string[] }> {
        defaultBranchCalls += 1;
        return { ok: true, value: ['trunk'] };
      },
      async run(): Promise<never> { throw new Error('push URL override must be denied before adapter execution'); },
    } as unknown as GitAdapter;
    const service = new GitService(repository(workspace), undefined, adapter);

    await expect(service.run({ clientId: 'test', clientName: 'test' }, {
      args,
      workspaceId: workspace.id,
    }, undefined, {
      mode: 'full_bypass',
      applicationApproved: true,
      bypassApplicationAuthorization: true,
      source: 'full_bypass',
    })).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    expect(defaultBranchCalls).toBe(0);
  });

  it.each([
    ['ssh command', ['config', 'core.sshCommand', '/tmp/ssh-wrapper']],
    ['remote upload-pack', ['config', '--add', 'remote.origin.uploadpack', '/tmp/upload-pack']],
    ['credential helper', ['config', '--unset', 'credential.helper']],
    ['external protocol allowlist', ['config', 'protocol.ext.allow', 'always']],
  ] as const)('rejects executable %s config mutations under Full Bypass', async (_label, args) => {
    const workspace = await createWorkspace();
    let calls = 0;
    const adapter = {
      async run(): Promise<never> {
        calls += 1;
        throw new Error('executable Git config mutation must be denied');
      },
    } as unknown as GitAdapter;
    const service = new GitService(repository(workspace), undefined, adapter);

    await expect(service.run({ clientId: 'test', clientName: 'test' }, {
      args,
      workspaceId: workspace.id,
    }, undefined, {
      mode: 'full_bypass',
      applicationApproved: true,
      bypassApplicationAuthorization: true,
      source: 'full_bypass',
    })).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    expect(calls).toBe(0);
  });

  it('denies a push when native push side effects cannot be verified under Full Bypass', async () => {
    const workspace = await createWorkspace();
    let defaultBranchCalls = 0;
    let runCalls = 0;
    const adapter = {
      async validatePushSafety(): Promise<{ ok: false; error: { code: 'PERMISSION_DENIED' } }> {
        return { ok: false, error: { code: 'PERMISSION_DENIED' } };
      },
      async defaultBranches(): Promise<{ ok: true; value: readonly string[] }> {
        defaultBranchCalls += 1;
        return { ok: true, value: ['trunk'] };
      },
      async run(): Promise<never> {
        runCalls += 1;
        throw new Error('push must be denied before execution');
      },
    } as unknown as GitAdapter;
    const service = new GitService(repository(workspace), undefined, adapter);

    await expect(service.run({ clientId: 'test', clientName: 'test' }, {
      args: ['push', 'origin', 'feature/review-gate'],
      workspaceId: workspace.id,
    }, undefined, {
      mode: 'full_bypass',
      applicationApproved: true,
      bypassApplicationAuthorization: true,
      source: 'full_bypass',
    })).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    expect(defaultBranchCalls).toBe(0);
    expect(runCalls).toBe(0);
  });

  it('parses push option values before resolving the push remote', async () => {
    const workspace = await createWorkspace();
    const remotes: string[] = [];
    let calls = 0;
    const adapter = {
      async validatePushSafety(): Promise<{ ok: true; value: undefined }> { return { ok: true, value: undefined }; },
      async defaultBranch(_cwd: string, remote: string): Promise<{ ok: true; value: string }> {
        remotes.push(remote);
        return { ok: true, value: 'trunk' };
      },
      async run(): Promise<{ ok: true; value: { exitCode: number; stdout: string; stderr: string } }> {
        calls += 1;
        return { ok: true, value: { exitCode: 0, stdout: '', stderr: '' } };
      },
    } as unknown as GitAdapter;
    const service = new GitService(repository(workspace), undefined, adapter);
    const authorization = { mode: 'full_bypass', applicationApproved: true, bypassApplicationAuthorization: true, source: 'full_bypass' } as const;

    await expect(service.run({ clientId: 'test', clientName: 'test' }, {
      args: ['push', '-o', 'ci.skip', 'origin', 'feature/review-gate'],
      workspaceId: workspace.id,
      userConfirmed: true,
    }, undefined, authorization)).resolves.toMatchObject({ ok: true });
    expect(remotes).toEqual(['origin']);
    expect(calls).toBe(1);
  });

  it('forwards cancellation to every MCP-exposed Git adapter operation', async () => {
    const workspace = await createWorkspace();
    const observedSignals: Array<AbortSignal | undefined> = [];
    const adapter = {
      async status(_cwd: string, signal?: AbortSignal) {
        observedSignals.push(signal);
        return { ok: true as const, value: { entries: [] } };
      },
      async diff(_cwd: string, _request: unknown, signal?: AbortSignal) {
        observedSignals.push(signal);
        return { ok: true as const, value: { patch: '', truncated: false } };
      },
      async log(_cwd: string, _request: unknown, signal?: AbortSignal) {
        observedSignals.push(signal);
        return { ok: true as const, value: { entries: [], truncated: false } };
      },
      async run(_cwd: string, _args: readonly string[], _timeoutMs: number | undefined, signal?: AbortSignal) {
        observedSignals.push(signal);
        return { ok: true as const, value: { exitCode: 0, stdout: '', stderr: '' } };
      },
    } as unknown as GitAdapter;
    const service = new GitService(repository(workspace), undefined, adapter);
    const actor = { clientId: 'test', clientName: 'test' };
    const signal = new AbortController().signal;

    await service.status(actor, workspace.id, signal);
    await service.diff(actor, workspace.id, {}, signal);
    await service.log(actor, workspace.id, {}, signal);
    await service.run(actor, { args: ['status'], workspaceId: workspace.id }, signal);

    expect(observedSignals).toEqual([signal, signal, signal, signal]);
  });

  it('guards a diff path before delegating to the Git adapter', async () => {
    const workspace = await createWorkspace();
    const adapter = {
      async status(): Promise<never> { throw new Error('not used'); },
      async diff(rootPath: string, request: { path?: string; staged?: boolean; maxBytes?: number }): Promise<{ ok: true; value: { patch: string; truncated: boolean } }> {
        expect(rootPath).toBe(workspace.realRootPath);
        expect(request.path).toBe(path.join('src', 'new.txt'));
        return { ok: true, value: { patch: '', truncated: false } };
      },
      async log(): Promise<never> { throw new Error('not used'); },
    } as unknown as GitAdapter;
    const service = new GitService(repository(workspace), undefined, adapter);

    const result = await service.diff({ clientId: 'test', clientName: 'test' }, workspace.id, { path: path.join('src', 'new.txt') });

    expect(result).toEqual({ ok: true, value: { patch: '', truncated: false } });
  });

  it('rejects a diff path outside the workspace', async () => {
    const workspace = await createWorkspace();
    const service = new GitService(repository(workspace), undefined, {
      async status(): Promise<never> { throw new Error('not used'); },
      async diff(): Promise<never> { throw new Error('must not run'); },
      async log(): Promise<never> { throw new Error('not used'); },
    } as unknown as GitAdapter);

    const result = await service.diff({ clientId: 'test', clientName: 'test' }, workspace.id, { path: path.join('..', 'outside.txt') });

    expect(result).toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });
  });

  it('runs git against an absolute cwd in a registered workspace', async () => {
    const workspace = await createWorkspace();
    const adapter = {
      async status(): Promise<never> { throw new Error('not used'); },
      async diff(): Promise<never> { throw new Error('not used'); },
      async log(): Promise<never> { throw new Error('not used'); },
      async run(cwd: string, args: readonly string[]): Promise<{ ok: true; value: { exitCode: number; stdout: string; stderr: string } }> {
        expect(path.resolve(cwd).toLowerCase()).toBe(path.resolve(workspace.realRootPath).toLowerCase());
        expect(args).toEqual(['init']);
        return { ok: true, value: { exitCode: 0, stdout: 'Initialized empty Git repository', stderr: '' } };
      },
    } as unknown as GitAdapter;
    const service = new GitService(repository(workspace), undefined, adapter);

    const result = await service.run({ clientId: 'test', clientName: 'test' }, {
      args: ['init'],
      cwd: workspace.realRootPath,
      userConfirmed: true,
    });

    expect(result).toEqual({
      ok: true,
      value: { exitCode: 0, stdout: 'Initialized empty Git repository', stderr: '' },
    });
  });

  it.each([
    ['global option', ['-C', 'C:\\outside', 'status']],
    ['repository mutation', ['init']],
    ['deletion', ['rm', 'victim.txt']],
    ['read command with broad pathspec magic', ['status', ':/']],
  ] as const)('rejects an unconfirmed %s before the Git adapter runs', async (_label, args) => {
    const workspace = await createWorkspace();
    let calls = 0;
    const adapter = {
      async run(): Promise<{ ok: true; value: { exitCode: number; stdout: string; stderr: string } }> {
        calls += 1;
        return { ok: true, value: { exitCode: 0, stdout: '', stderr: '' } };
      },
    } as unknown as GitAdapter;
    const service = new GitService(repository(workspace), undefined, adapter);

    await expect(service.run({ clientId: 'test', clientName: 'test' }, { args, workspaceId: workspace.id }))
      .resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
    expect(calls).toBe(0);
  });

  it.each([
    ['workspace override', ['-C', 'C:\\outside', 'status']],
    ['inline alias override', ['-c', 'alias.wipe=!rm -rf .', 'wipe']],
    ['repository shell alias', ['wipe']],
    ['path checkout', ['checkout', '--', 'victim.txt']],
    ['stash history deletion', ['stash', 'drop']],
    ['forced branch deletion', ['branch', '-D', 'old']],
    ['forced remote rewrite', ['push', '--force', 'origin', 'main']],
    ['remote ref deletion', ['push', 'origin', ':main']],
  ] as const)('denies confirmed Git %s because it can bypass scope or irreversibly discard recovery state', async (_label, args) => {
    const workspace = await createWorkspace();
    let calls = 0;
    const adapter = {
      async run(): Promise<{ ok: true; value: { exitCode: number; stdout: string; stderr: string } }> {
        calls += 1;
        return { ok: true, value: { exitCode: 0, stdout: '', stderr: '' } };
      },
    } as unknown as GitAdapter;
    const service = new GitService(repository(workspace), undefined, adapter);

    await expect(service.run({ clientId: 'test', clientName: 'test' }, {
      args,
      workspaceId: workspace.id,
      userConfirmed: true,
    })).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    expect(calls).toBe(0);
  });

  it.each([
    ['rm', '--', 'victim.txt'],
    ['clean', '-fd'],
    ['reset', '--hard'],
    ['restore', '--worktree', 'victim.txt'],
    ['add', '--', 'src/file.ts'],
    ['commit', '-m', 'safe checkpoint'],
    ['reset', '--soft', 'HEAD~1'],
    ['restore', '--staged', 'src/file.ts'],
  ] as const)('allows a confirmed policy-supported Git command: %s', async (...args) => {
    const workspace = await createWorkspace();
    const observed: readonly string[][] = [];
    const calls: string[][] = observed as string[][];
    const adapter = {
      async run(_cwd: string, command: readonly string[]): Promise<{ ok: true; value: { exitCode: number; stdout: string; stderr: string } }> {
        calls.push([...command]);
        return { ok: true, value: { exitCode: 0, stdout: '', stderr: '' } };
      },
    } as unknown as GitAdapter;
    const service = new GitService(repository(workspace), undefined, adapter);

    await expect(service.run({ clientId: 'test', clientName: 'test' }, {
      args,
      workspaceId: workspace.id,
      userConfirmed: true,
    })).resolves.toMatchObject({ ok: true });
    expect(calls).toEqual([[...args]]);
  });

  it('requires workspaceId unless cwd is an absolute path', async () => {
    const workspace = await createWorkspace();
    const service = new GitService(repository(workspace));

    const result = await service.run({ clientId: 'test', clientName: 'test' }, { args: ['status'] });

    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });
});
