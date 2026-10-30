import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appError,
  err,
  ok,
  type PublishCredentialLease,
  type PublishCredentialPort,
  type Result,
} from '@unified-mpc/domain';
import {
  parsePublishCredentialArgs,
  readPublishCredentialSecret,
  resolveGitPushUrls,
  resolvePublishCredentialDeployment,
  runPublishCredentialCommand,
  type PublishCredentialCommandRunner,
} from './publish-credential.js';

const execFileAsync = promisify(execFile);

const NOW = 1_780_000_000_000;
const SECRET = 'super-secret-token-value';
const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const directory = tempDirs.pop();
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  }
});

interface RecordedPort {
  readonly port: PublishCredentialPort;
  readonly grants: Array<{ readonly lease: PublishCredentialLease; readonly secret: string }>;
  readonly revokes: string[];
}

function createPort(): RecordedPort {
  const grants: Array<{ readonly lease: PublishCredentialLease; readonly secret: string }> = [];
  const revokes: string[] = [];
  return {
    grants,
    revokes,
    port: {
      grant: async (lease, secret): Promise<Result<void>> => {
        grants.push({ lease, secret });
        return ok(undefined);
      },
      open: async () => ok(null),
      revoke: async (leaseId): Promise<Result<void>> => {
        revokes.push(leaseId);
        return ok(undefined);
      },
    },
  };
}

function createRunner(
  port: PublishCredentialPort,
  overrides: Partial<PublishCredentialCommandRunner> = {},
): PublishCredentialCommandRunner {
  return {
    credential: port,
    resolveWorkspace: async () => ok({ id: 'workspace-1', rootPath: '/srv/repo' }),
    resolvePushUrls: async () => ok(['https://github.com/owner/repo.git']),
    readSecret: async () => ok(SECRET),
    resolveDeployment: async () => ok({
      promoted: true,
      root: '/home/operator/.local/share/unified-mpc/runtime/releases/deploy-1',
      reason: 'promoted-release',
    }),
    now: () => NOW,
    createLeaseId: () => 'lease-1',
    ...overrides,
  };
}

async function run(
  args: readonly string[],
  runner: PublishCredentialCommandRunner,
): Promise<{ readonly code: number; readonly output: string; readonly errors: string }> {
  const parsed = parsePublishCredentialArgs(args);
  if (!parsed.ok) throw new Error(parsed.error.message);
  const output: string[] = [];
  const errors: string[] = [];
  const code = await runPublishCredentialCommand(
    parsed.value,
    runner,
    (text) => output.push(text),
    (text) => errors.push(text),
  );
  return { code, output: output.join('\n'), errors: errors.join('\n') };
}

function grantArgs(overrides: readonly string[] = []): readonly string[] {
  return ['grant', 'origin', '--workspace', 'workspace-1', '--username', 'git', '--ttl', '900', ...overrides];
}

describe('publish-credential argument parsing', () => {
  it('parses grant, revoke and status', () => {
    expect(parsePublishCredentialArgs(grantArgs())).toEqual({
      ok: true,
      value: {
        kind: 'publish-credential-grant',
        remote: 'origin',
        workspaceReference: 'workspace-1',
        username: 'git',
        ttlSeconds: 900,
      },
    });
    expect(parsePublishCredentialArgs(['revoke', 'lease-1'])).toEqual({
      ok: true,
      value: { kind: 'publish-credential-revoke', leaseId: 'lease-1' },
    });
    expect(parsePublishCredentialArgs(['status', 'lease-1'])).toEqual({
      ok: true,
      value: { kind: 'publish-credential-status', leaseId: 'lease-1' },
    });
  });

  it('refuses missing flags, a bad TTL and a URL-shaped remote', () => {
    expect(parsePublishCredentialArgs(['grant', 'origin'])).toMatchObject({ ok: false });
    expect(parsePublishCredentialArgs(['grant', 'origin', '--workspace', 'w', '--username', 'git', '--ttl', '0']))
      .toMatchObject({ ok: false });
    expect(parsePublishCredentialArgs(['grant', 'origin', '--workspace', 'w', '--username', 'git', '--ttl', 'soon']))
      .toMatchObject({ ok: false });
    expect(parsePublishCredentialArgs(['grant', 'https://github.com/org/repo', '--workspace', 'w', '--username', 'git', '--ttl', '60']))
      .toMatchObject({ ok: false });
    expect(parsePublishCredentialArgs(['revoke', 'bad id'])).toMatchObject({ ok: false });
    expect(parsePublishCredentialArgs(['status'])).toMatchObject({ ok: false });
  });
});

describe('publish-credential grant', () => {
  it('refuses a canonical checkout before reading the secret or contacting Git', async () => {
    const recorded = createPort();
    let secretReads = 0;
    let forkResolutions = 0;
    const result = await run(grantArgs(), createRunner(recorded.port, {
      resolveDeployment: async () => ok({ promoted: false, root: '/home/agent/repos/Unified-MPC-Server', reason: 'canonical-checkout' }),
      resolveWorkspace: async () => {
        forkResolutions += 1;
        return ok({ id: 'workspace-1', rootPath: '/srv/repo' });
      },
      readSecret: async () => {
        secretReads += 1;
        return ok(SECRET);
      },
    }));
    expect(result.code).toBe(1);
    expect(result.errors).toContain('publish-credential-unsupported');
    expect(result.errors).toContain('canonical-checkout');
    expect(secretReads).toBe(0);
    expect(forkResolutions).toBe(0);
    expect(recorded.grants).toHaveLength(0);
  });

  it('refuses an unresolved runtime root rather than assuming a release', async () => {
    const recorded = createPort();
    const result = await run(grantArgs(), createRunner(recorded.port, {
      resolveDeployment: async () => ok({ promoted: false, root: null, reason: 'runtime-root-unset' }),
    }));
    expect(result.code).toBe(1);
    expect(result.errors).toContain('publish-credential-unsupported');
    expect(recorded.grants).toHaveLength(0);
  });

  it('refuses an http push target before reading the secret', async () => {
    const recorded = createPort();
    let secretReads = 0;
    const result = await run(grantArgs(), createRunner(recorded.port, {
      resolvePushUrls: async () => ok(['http://github.com/owner/repo.git']),
      readSecret: async () => {
        secretReads += 1;
        return ok(SECRET);
      },
    }));
    expect(result.code).toBe(1);
    expect(result.errors).toContain('publish-credential-unsupported');
    expect(secretReads).toBe(0);
    expect(recorded.grants).toHaveLength(0);
  });

  it('refuses a remote with more than one push URL', async () => {
    const recorded = createPort();
    const result = await run(grantArgs(), createRunner(recorded.port, {
      resolvePushUrls: async () => ok(['https://github.com/owner/repo.git', 'https://gitlab.com/owner/repo.git']),
    }));
    expect(result.code).toBe(1);
    expect(result.errors).toContain('push-target-ambiguous');
    expect(recorded.grants).toHaveLength(0);
  });

  it('refuses an unknown workspace before resolving the remote', async () => {
    const recorded = createPort();
    let resolutions = 0;
    const result = await run(grantArgs(), createRunner(recorded.port, {
      resolveWorkspace: async () => err(appError('WORKSPACE_NOT_FOUND', 'Workspace is not registered', true)),
      resolvePushUrls: async () => {
        resolutions += 1;
        return ok(['https://github.com/owner/repo.git']);
      },
    }));
    expect(result.code).toBe(1);
    expect(result.errors).toContain('Workspace is not registered');
    expect(resolutions).toBe(0);
    expect(recorded.grants).toHaveLength(0);
  });

  it('grants a lease without ever printing the secret', async () => {
    const recorded = createPort();
    const result = await run(grantArgs(), createRunner(recorded.port));
    expect(result.code).toBe(0);
    expect(result.errors).toBe('');
    expect(result.output).toContain('publish credential granted: lease-1');
    expect(result.output).toContain('hosts: github.com');
    expect(result.output).not.toContain(SECRET);
    expect(recorded.grants).toHaveLength(1);
    expect(recorded.grants[0]?.secret).toBe(SECRET);
    expect(recorded.grants[0]?.lease).toEqual({
      leaseId: 'lease-1',
      workspaceId: 'workspace-1',
      remote: 'origin',
      hosts: ['github.com'],
      username: 'git',
      createdAt: NOW,
      expiresAt: NOW + 900_000,
    });
  });

  it('keeps a non-default port in the resolved host set', async () => {
    const recorded = createPort();
    await run(grantArgs(), createRunner(recorded.port, {
      resolvePushUrls: async () => ok(['https://GitHub.com:8443/owner/repo.git']),
    }));
    expect(recorded.grants[0]?.lease.hosts).toEqual(['github.com:8443']);
  });

  it('reports an unavailable Secret Service without leaking the secret', async () => {
    const recorded = createPort();
    const result = await run(grantArgs(), createRunner({
      ...recorded.port,
      grant: async () => err(appError('SECRET_ACCESS_DENIED', 'Linux Secret Service is unavailable', true, {
        reason: 'publish-credential-unavailable',
      })),
    }));
    expect(result.code).toBe(1);
    expect(result.errors).toContain('publish-credential-unavailable');
    expect(result.errors).not.toContain(SECRET);
    expect(result.output).not.toContain(SECRET);
  });
});

describe('publish-credential revoke and status', () => {
  it('revokes a lease idempotently', async () => {
    const recorded = createPort();
    const runner = createRunner(recorded.port);
    await expect(run(['revoke', 'lease-1'], runner)).resolves.toMatchObject({
      code: 0,
      output: 'publish credential revoked: lease-1',
    });
    await expect(run(['revoke', 'lease-1'], runner)).resolves.toMatchObject({ code: 0 });
    expect(recorded.revokes).toEqual(['lease-1', 'lease-1']);
  });

  it('prints lease metadata and state but never the secret', async () => {
    const recorded = createPort();
    const result = await run(['status', 'lease-1'], createRunner(recorded.port, {
      inspect: async () => ok({
        lease: {
          leaseId: 'lease-1',
          workspaceId: 'workspace-1',
          remote: 'origin',
          hosts: ['github.com'],
          username: 'git',
          createdAt: NOW,
          expiresAt: NOW + 900_000,
        },
        revokedAt: null,
      }),
    }));
    expect(result.code).toBe(0);
    expect(result.output).toContain('username: git');
    expect(result.output).toContain('hosts: github.com');
    expect(result.output).toContain('state: active');
    expect(result.output).not.toContain(SECRET);
  });

  it('reports an expired lease from metadata without the secret', async () => {
    const recorded = createPort();
    const result = await run(['status', 'lease-1'], createRunner(recorded.port, {
      inspect: async () => ok({
        lease: {
          leaseId: 'lease-1',
          workspaceId: 'workspace-1',
          remote: 'origin',
          hosts: ['github.com'],
          username: 'git',
          createdAt: NOW - 1_000,
          expiresAt: NOW - 1,
        },
        revokedAt: null,
      }),
    }));
    expect(result.output).toContain('state: expired');
    expect(result.output).not.toContain(SECRET);
  });
});

describe('publish-credential deployment classification', () => {
  const runtimeDir = '/home/operator/.local/share/unified-mpc/runtime';

  it('treats the runtime/current pointer inside releases as a promoted release', async () => {
    await expect(resolvePublishCredentialDeployment({
      env: { UNIFIED_MPC_ROOT: `${runtimeDir}/current` },
      runtimeDir,
      resolveRealPath: async () => `${runtimeDir}/releases/deploy-9`,
    })).resolves.toEqual({
      promoted: true,
      root: `${runtimeDir}/releases/deploy-9`,
      reason: 'promoted-release',
    });
  });

  it('refuses a canonical checkout, an unset root and a nested release path', async () => {
    await expect(resolvePublishCredentialDeployment({
      env: { UNIFIED_MPC_ROOT: '/home/agent/repos/Unified-MPC-Server' },
      runtimeDir,
      resolveRealPath: async (target) => target,
    })).resolves.toMatchObject({ promoted: false, reason: 'canonical-checkout' });

    await expect(resolvePublishCredentialDeployment({ env: {}, runtimeDir }))
      .resolves.toMatchObject({ promoted: false, root: null, reason: 'runtime-root-unset' });

    await expect(resolvePublishCredentialDeployment({
      env: { UNIFIED_MPC_ROOT: 'runtime/releases/deploy-1' },
      runtimeDir,
    })).resolves.toMatchObject({ promoted: false, reason: 'runtime-root-unset' });

    await expect(resolvePublishCredentialDeployment({
      env: { UNIFIED_MPC_ROOT: `${runtimeDir}/releases/deploy-1/nested` },
      runtimeDir,
      resolveRealPath: async (target) => target,
    })).resolves.toMatchObject({ promoted: false, reason: 'canonical-checkout' });

    await expect(resolvePublishCredentialDeployment({
      env: { UNIFIED_MPC_ROOT: '/home/agent/repos/Unified-MPC-Server' },
      runtimeDir,
      resolveRealPath: async () => {
        throw new Error('ENOENT');
      },
    })).resolves.toMatchObject({ promoted: false, root: null, reason: 'runtime-root-unset' });
  });
});

describe('publish-credential secret intake', () => {
  it('refuses a secret passed as an argument', () => {
    expect(parsePublishCredentialArgs([
      'grant', 'origin', '--workspace', 'workspace-1', '--username', 'git', '--ttl', '900', '--secret', SECRET,
    ])).toMatchObject({ ok: false });
    expect(parsePublishCredentialArgs([
      'grant', 'origin', '--workspace', 'workspace-1', '--username', 'git', '--ttl', '900', `token=${SECRET}`,
    ])).toMatchObject({ ok: false });
  });

  it('fails closed when no secret arrives on stdin', async () => {
    const recorded = createPort();
    const result = await run(grantArgs(), createRunner(recorded.port, {
      readSecret: async () => err(appError('INVALID_INPUT', 'The secret must not be empty', false, {
        reason: 'publish-credential-invalid',
      })),
    }));
    expect(result.code).toBe(1);
    expect(result.errors).toContain('publish-credential-invalid');
    expect(recorded.grants).toHaveLength(0);
  });
});

describe('publish-credential secret intake from stdin', () => {
  beforeEach(() => {
    // The TTY prompt goes to stderr; keep the test output quiet.
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function terminal(): PassThrough & { isTTY?: boolean; setRawMode?: (mode: boolean) => void } {
    const stream = new PassThrough() as PassThrough & { isTTY?: boolean; setRawMode?: (mode: boolean) => void };
    Object.defineProperty(stream, 'isTTY', { value: true });
    return stream;
  }

  it('reads a piped secret to EOF and strips the trailing newline', async () => {
    const stream = new PassThrough();
    const pending = readPublishCredentialSecret(stream as unknown as NodeJS.ReadStream);
    stream.end(`${SECRET}\n`);
    await expect(pending).resolves.toEqual(ok(SECRET));
  });

  it('reads a no-echo TTY secret until enter and restores the terminal mode', async () => {
    const stream = terminal();
    const modes: boolean[] = [];
    stream.setRawMode = (mode: boolean): void => {
      modes.push(mode);
    };
    const pending = readPublishCredentialSecret(stream as unknown as NodeJS.ReadStream);
    stream.write('tok');
    stream.write('en\r');
    await expect(pending).resolves.toEqual(ok('token'));
    expect(modes).toEqual([true, false]);
  });

  it('cancels a TTY read on ctrl-c', async () => {
    const stream = terminal();
    const modes: boolean[] = [];
    stream.setRawMode = (mode: boolean): void => {
      modes.push(mode);
    };
    const pending = readPublishCredentialSecret(stream as unknown as NodeJS.ReadStream);
    stream.write('\u0003');
    await expect(pending).resolves.toMatchObject({ ok: false });
    expect(modes).toEqual([true, false]);
  });

  it('refuses an empty, multi-line or oversized secret', async () => {
    const empty = new PassThrough();
    const emptyPending = readPublishCredentialSecret(empty as unknown as NodeJS.ReadStream);
    empty.end('\n');
    await expect(emptyPending).resolves.toMatchObject({ ok: false });

    const multiLine = new PassThrough();
    const multiLinePending = readPublishCredentialSecret(multiLine as unknown as NodeJS.ReadStream);
    multiLine.end('line\nline\n');
    await expect(multiLinePending).resolves.toMatchObject({ ok: false });

    const oversized = new PassThrough();
    const oversizedPending = readPublishCredentialSecret(oversized as unknown as NodeJS.ReadStream);
    oversized.end('a'.repeat(8_193));
    await expect(oversizedPending).resolves.toMatchObject({ ok: false });
  });
});

describe('resolveGitPushUrls', () => {
  async function repository(remote: string): Promise<string> {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'unified-publish-'));
    tempDirs.push(directory);
    await execFileAsync('git', ['init', '--quiet'], { cwd: directory });
    await execFileAsync('git', ['remote', 'add', 'origin', remote], { cwd: directory });
    return directory;
  }

  it('resolves the configured push URL of a remote', async () => {
    const directory = await repository('https://github.com/owner/repo.git');
    await expect(resolveGitPushUrls(directory, 'origin')).resolves.toEqual({
      ok: true,
      value: ['https://github.com/owner/repo.git'],
    });
  });

  it('reports every push URL so the command can refuse an ambiguous remote', async () => {
    const directory = await repository('https://github.com/owner/repo.git');
    for (const url of ['https://github.com/owner/repo.git', 'https://gitlab.com/owner/repo.git']) {
      await execFileAsync('git', ['remote', 'set-url', '--add', '--push', 'origin', url], { cwd: directory });
    }
    const resolved = await resolveGitPushUrls(directory, 'origin');
    expect(resolved).toMatchObject({ ok: true });
    expect(resolved.ok ? resolved.value : []).toEqual([
      'https://github.com/owner/repo.git',
      'https://gitlab.com/owner/repo.git',
    ]);
  });

  it('fails closed when the remote does not exist', async () => {
    const directory = await repository('https://github.com/owner/repo.git');
    const resolved = await resolveGitPushUrls(directory, 'missing');
    expect(resolved.ok).toBe(false);
    expect(resolved.ok ? undefined : resolved.error.details?.reason).toBe('push-target-unresolved');
  });
});
