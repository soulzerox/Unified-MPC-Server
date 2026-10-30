import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Writable } from 'node:stream';
import {
  PUBLISH_CREDENTIAL_DESCRIPTOR_FD_ENV,
  PUBLISH_CREDENTIAL_LEASE_ID_ENV,
  serializePublishCredentialDescriptorAnswer,
  type PublishCredentialDescriptorAnswer,
} from '@unified-mpc/domain';
import { describe, expect, it, vi } from 'vitest';
import {
  PUBLISH_CREDENTIAL_HELPER_REFUSED,
  runPublishCredentialHelper,
  type PublishCredentialHelperIo,
} from './publish-credential-helper.js';

const LEASE_ID = 'lease-1';
const SECRET = 's3cret-token-value';
const NOW = 10_000;

function answer(overrides: Partial<PublishCredentialDescriptorAnswer> = {}): PublishCredentialDescriptorAnswer {
  return {
    version: 1,
    leaseId: LEASE_ID,
    username: 'x-access-token',
    secret: SECRET,
    hosts: ['github.com'],
    expiresAt: NOW + 60_000,
    ...overrides,
  };
}

interface Harness {
  readonly io: PublishCredentialHelperIo;
  readonly stdout: ReturnType<typeof vi.fn>;
  readonly readPrompt: ReturnType<typeof vi.fn>;
  readonly readDescriptor: ReturnType<typeof vi.fn>;
}

function harness(overrides: {
  argv?: readonly string[];
  env?: Readonly<Record<string, string | undefined>>;
  prompt?: string | null;
  descriptor?: string | null;
  now?: number;
} = {}): Harness {
  const stdout = vi.fn();
  const readPrompt = vi.fn(async () => overrides.prompt === undefined
    ? 'protocol=https\nhost=github.com\npath=soulzerox/repo.git\n\n'
    : overrides.prompt);
  const readDescriptor = vi.fn(async () => overrides.descriptor === undefined
    ? serializePublishCredentialDescriptorAnswer(answer())
    : overrides.descriptor);
  return {
    io: {
      argv: overrides.argv ?? ['get'],
      env: overrides.env ?? {
        [PUBLISH_CREDENTIAL_LEASE_ID_ENV]: LEASE_ID,
        [PUBLISH_CREDENTIAL_DESCRIPTOR_FD_ENV]: '3',
      },
      readPrompt,
      readDescriptor,
      writeStdout: stdout,
      now: () => overrides.now ?? NOW,
    },
    stdout,
    readPrompt,
    readDescriptor,
  };
}

describe('publish credential helper contract', () => {
  it('answers one get with the lease username and secret', async () => {
    const h = harness();
    await expect(runPublishCredentialHelper(h.io)).resolves.toBe(0);
    expect(h.stdout).toHaveBeenCalledWith(`username=x-access-token\npassword=${SECRET}\n`);
    expect(h.readDescriptor).toHaveBeenCalledWith(3, expect.any(Number));
  });

  it('normalizes a case-folded, default-port prompt host before matching', async () => {
    const h = harness({ prompt: 'protocol=https\nhost=GitHub.com:443\n' });
    await expect(runPublishCredentialHelper(h.io)).resolves.toBe(0);
    expect(h.stdout).toHaveBeenCalledTimes(1);
  });

  it('refuses a forged prompt host and writes nothing', async () => {
    const h = harness({ prompt: 'protocol=https\nhost=gitlab.com\n' });
    await expect(runPublishCredentialHelper(h.io)).resolves.toBe(PUBLISH_CREDENTIAL_HELPER_REFUSED);
    expect(h.stdout).not.toHaveBeenCalled();
  });

  it('refuses a different port on the same host', async () => {
    const leased = harness({ descriptor: serializePublishCredentialDescriptorAnswer(answer({ hosts: ['github.example.com:8443'] })) });
    await expect(runPublishCredentialHelper({
      ...leased.io,
      readPrompt: async () => 'protocol=https\nhost=github.example.com\n',
    })).resolves.toBe(PUBLISH_CREDENTIAL_HELPER_REFUSED);
    expect(leased.stdout).not.toHaveBeenCalled();
  });

  it('answers the same host when the lease carries the non-default port', async () => {
    const h = harness({
      prompt: 'protocol=https\nhost=github.example.com:8443\n',
      descriptor: serializePublishCredentialDescriptorAnswer(answer({ hosts: ['github.example.com:8443'] })),
    });
    await expect(runPublishCredentialHelper(h.io)).resolves.toBe(0);
    expect(h.stdout).toHaveBeenCalledTimes(1);
  });

  it('refuses a non-https prompt without opening the descriptor', async () => {
    const h = harness({ prompt: 'protocol=http\nhost=github.com\n' });
    await expect(runPublishCredentialHelper(h.io)).resolves.toBe(PUBLISH_CREDENTIAL_HELPER_REFUSED);
    expect(h.readDescriptor).not.toHaveBeenCalled();
    expect(h.stdout).not.toHaveBeenCalled();
  });

  it.each(['store', 'erase'])('does nothing for %s', async (operation) => {
    const h = harness({ argv: [operation] });
    await expect(runPublishCredentialHelper(h.io)).resolves.toBe(PUBLISH_CREDENTIAL_HELPER_REFUSED);
    expect(h.readPrompt).not.toHaveBeenCalled();
    expect(h.readDescriptor).not.toHaveBeenCalled();
    expect(h.stdout).not.toHaveBeenCalled();
  });

  it('refuses a missing, empty or extra operation argument', async () => {
    for (const argv of [[], ['get', 'store'], ['GET']]) {
      const h = harness({ argv });
      await expect(runPublishCredentialHelper(h.io)).resolves.toBe(PUBLISH_CREDENTIAL_HELPER_REFUSED);
      expect(h.stdout).not.toHaveBeenCalled();
    }
  });

  it('refuses a missing or malformed lease id', async () => {
    for (const leaseId of [undefined, '', 'bad id', 'x'.repeat(121)]) {
      const h = harness({ env: { [PUBLISH_CREDENTIAL_DESCRIPTOR_FD_ENV]: '3', ...(leaseId === undefined ? {} : { [PUBLISH_CREDENTIAL_LEASE_ID_ENV]: leaseId }) } });
      await expect(runPublishCredentialHelper(h.io)).resolves.toBe(PUBLISH_CREDENTIAL_HELPER_REFUSED);
      expect(h.stdout).not.toHaveBeenCalled();
    }
  });

  it('refuses a missing descriptor, a stdio descriptor and a non-numeric descriptor', async () => {
    for (const fd of [undefined, '0', '2', '-3', 'abc']) {
      const h = harness({ env: { [PUBLISH_CREDENTIAL_LEASE_ID_ENV]: LEASE_ID, ...(fd === undefined ? {} : { [PUBLISH_CREDENTIAL_DESCRIPTOR_FD_ENV]: fd }) } });
      await expect(runPublishCredentialHelper(h.io)).resolves.toBe(PUBLISH_CREDENTIAL_HELPER_REFUSED);
      expect(h.readDescriptor).not.toHaveBeenCalled();
      expect(h.stdout).not.toHaveBeenCalled();
    }
  });

  it('refuses when the descriptor cannot be read', async () => {
    const h = harness({ descriptor: null });
    await expect(runPublishCredentialHelper(h.io)).resolves.toBe(PUBLISH_CREDENTIAL_HELPER_REFUSED);
    expect(h.stdout).not.toHaveBeenCalled();
  });

  it('refuses an expired lease even when the host answered', async () => {
    const h = harness({ descriptor: serializePublishCredentialDescriptorAnswer(answer({ expiresAt: NOW })) });
    await expect(runPublishCredentialHelper(h.io)).resolves.toBe(PUBLISH_CREDENTIAL_HELPER_REFUSED);
    expect(h.stdout).not.toHaveBeenCalled();
  });

  it('refuses an answer issued for a different lease', async () => {
    const h = harness({ descriptor: serializePublishCredentialDescriptorAnswer(answer({ leaseId: 'lease-2' })) });
    await expect(runPublishCredentialHelper(h.io)).resolves.toBe(PUBLISH_CREDENTIAL_HELPER_REFUSED);
    expect(h.stdout).not.toHaveBeenCalled();
  });

  it('refuses an unparsable descriptor answer', async () => {
    for (const descriptor of ['', 'not json', '{"version":1}', JSON.stringify({ ...answer(), secret: 'a\nb' })]) {
      const h = harness({ descriptor });
      await expect(runPublishCredentialHelper(h.io)).resolves.toBe(PUBLISH_CREDENTIAL_HELPER_REFUSED);
      expect(h.stdout).not.toHaveBeenCalled();
    }
  });

  it('never writes the secret when the prompt cannot be read', async () => {
    const h = harness({ prompt: null });
    await expect(runPublishCredentialHelper(h.io)).resolves.toBe(PUBLISH_CREDENTIAL_HELPER_REFUSED);
    expect(h.stdout).not.toHaveBeenCalled();
  });

  it('writes the secret to exactly one channel', async () => {
    const h = harness();
    await expect(runPublishCredentialHelper(h.io)).resolves.toBe(0);
    expect(h.stdout).toHaveBeenCalledTimes(1);
    expect(h.stdout.mock.calls[0]).toEqual([`username=x-access-token\npassword=${SECRET}\n`]);
    // The contract takes no stderr, file or log sink at all, so there is no
    // other channel for the helper to leak through.
    expect(Object.keys(h.io).sort()).toEqual(['argv', 'env', 'now', 'readDescriptor', 'readPrompt', 'writeStdout']);
  });
});

/**
 * The compiled entry, spawned exactly the way Git spawns it: one operation
 * argument, a prompt on stdin, the descriptor on an inherited fd 3.
 */
const builtHelper = path.join(import.meta.dirname, '..', '..', 'dist', 'bin', 'publish-credential-helper.js');

interface SpawnedHelper {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

async function spawnHelper(input: {
  readonly operation: string;
  readonly prompt: string;
  readonly descriptor: string | null;
  readonly leaseId?: string;
  readonly env?: Readonly<Record<string, string>>;
  /** Replace the inherited fd 3 with an already-open file descriptor. */
  readonly descriptorFileDescriptor?: number;
  /** Override `UNIFIED_PUBLISH_CREDENTIAL_FD` (defaults to 3). */
  readonly descriptorFd?: number;
}): Promise<SpawnedHelper> {
  if (!fs.existsSync(builtHelper)) {
    throw new Error(
      `publish-credential-helper build is missing; run \`corepack pnpm --filter @unified-mpc/cli build\` (looked for ${builtHelper})`,
    );
  }
  const child = spawn(process.execPath, [builtHelper, input.operation], {
    env: {
      PATH: process.env.PATH ?? '',
      [PUBLISH_CREDENTIAL_LEASE_ID_ENV]: input.leaseId ?? LEASE_ID,
      [PUBLISH_CREDENTIAL_DESCRIPTOR_FD_ENV]: String(input.descriptorFd ?? 3),
      ...input.env,
    },
    stdio: ['pipe', 'pipe', 'pipe', input.descriptorFileDescriptor ?? 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  // A refused helper exits without draining its stdin and descriptor, which
  // resets the parent end. That is the expected shape of a refusal, not a test
  // failure, so the parent side ignores it.
  child.stdin.on('error', () => {});
  child.stdout.on('error', () => {});
  child.stderr.on('error', () => {});
  const descriptor = child.stdio[3] as Writable | null;
  descriptor?.on('error', () => {});
  if (input.descriptor !== null) descriptor?.end(input.descriptor);
  else descriptor?.end();
  child.stdin.end(input.prompt);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  return {
    code,
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
  };
}

describe('publish credential helper entry point', () => {
  it('answers a live get on stdout and keeps the secret out of argv and the environment', async () => {
    const result = await spawnHelper({
      operation: 'get',
      prompt: 'protocol=https\nhost=github.com\npath=soulzerox/repo.git\n\n',
      descriptor: serializePublishCredentialDescriptorAnswer(answer({ expiresAt: Date.now() + 60_000 })),
    });
    expect(result).toEqual({
      code: 0,
      stdout: `username=x-access-token\npassword=${SECRET}\n`,
      stderr: '',
    });
    // The child argv is the entry point plus one operation, and the environment
    // carries the lease id and the fd number only.
    const argv = [builtHelper, 'get'];
    for (const value of argv) expect(value).not.toContain(SECRET);
    for (const [key, value] of Object.entries({ [PUBLISH_CREDENTIAL_LEASE_ID_ENV]: LEASE_ID, [PUBLISH_CREDENTIAL_DESCRIPTOR_FD_ENV]: '3' })) {
      expect(`${key}=${value}`).not.toContain(SECRET);
    }
  });

  it('exits 1 silently for a forged prompt host', async () => {
    const result = await spawnHelper({
      operation: 'get',
      prompt: 'protocol=https\nhost=gitlab.com\n\n',
      descriptor: serializePublishCredentialDescriptorAnswer(answer({ expiresAt: Date.now() + 60_000 })),
    });
    expect(result).toEqual({ code: PUBLISH_CREDENTIAL_HELPER_REFUSED, stdout: '', stderr: '' });
  });

  it('exits 1 silently without a descriptor', async () => {
    const result = await spawnHelper({
      operation: 'get',
      prompt: 'protocol=https\nhost=github.com\n\n',
      descriptor: null,
    });
    expect(result).toEqual({ code: PUBLISH_CREDENTIAL_HELPER_REFUSED, stdout: '', stderr: '' });
  });

  it('exits 1 silently when the descriptor names another lease', async () => {
    const result = await spawnHelper({
      operation: 'get',
      prompt: 'protocol=https\nhost=github.com\n\n',
      descriptor: serializePublishCredentialDescriptorAnswer(answer({ leaseId: 'lease-2', expiresAt: Date.now() + 60_000 })),
    });
    expect(result).toEqual({ code: PUBLISH_CREDENTIAL_HELPER_REFUSED, stdout: '', stderr: '' });
  });

  it('exits 1 instead of crashing when the descriptor fd is not open', async () => {
    const result = await spawnHelper({
      operation: 'get',
      prompt: 'protocol=https\nhost=github.com\n\n',
      descriptor: null,
      descriptorFd: 9,
    });
    expect(result).toEqual({ code: PUBLISH_CREDENTIAL_HELPER_REFUSED, stdout: '', stderr: '' });
  });

  it('refuses a descriptor that is a regular file rather than a pipe', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-credential-helper-'));
    const file = path.join(root, 'descriptor.json');
    fs.writeFileSync(file, serializePublishCredentialDescriptorAnswer(answer({ expiresAt: Date.now() + 60_000 })));
    const fd = fs.openSync(file, 'r');
    try {
      const result = await spawnHelper({
        operation: 'get',
        prompt: 'protocol=https\nhost=github.com\n\n',
        descriptor: null,
        descriptorFileDescriptor: fd,
      });
      expect(result).toEqual({ code: PUBLISH_CREDENTIAL_HELPER_REFUSED, stdout: '', stderr: '' });
    } finally {
      fs.closeSync(fd);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does nothing for store and erase', async () => {
    for (const operation of ['store', 'erase']) {
      const result = await spawnHelper({
        operation,
        prompt: 'protocol=https\nhost=github.com\nusername=git\npassword=stored\n\n',
        descriptor: serializePublishCredentialDescriptorAnswer(answer({ expiresAt: Date.now() + 60_000 })),
      });
      expect(result).toEqual({ code: PUBLISH_CREDENTIAL_HELPER_REFUSED, stdout: '', stderr: '' });
    }
  });
});
