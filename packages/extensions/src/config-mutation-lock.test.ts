import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  configMutationLockPath,
  reclaimStaleFileLock,
  withConfigMutationLock,
} from './config-mutation-lock.js';

const temporaryRoots: string[] = [];
const plantedLocks: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  await Promise.all(plantedLocks.splice(0).map((lockPath) => rm(lockPath, { recursive: true, force: true })));
});

async function makeFile(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-lock-'));
  temporaryRoots.push(root);
  const file = path.join(root, 'AGENTS.md');
  await writeFile(file, 'content\n');
  return file;
}

/** Start a process, wait for it to exit, and return the PID it no longer owns. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const pid = child.pid;
  if (pid === undefined) throw new Error('child process did not expose a pid');
  await new Promise<void>((resolve, reject) => {
    child.once('exit', () => resolve());
    child.once('error', reject);
  });
  return pid;
}

async function plantLock(
  file: string,
  options: { readonly ownerPid?: number; readonly ageMs?: number } = {},
): Promise<string> {
  const lockPath = configMutationLockPath(file);
  plantedLocks.push(lockPath);
  await mkdir(lockPath, { mode: 0o700, recursive: true });
  if (options.ownerPid !== undefined) {
    await writeFile(
      path.join(lockPath, `${options.ownerPid}-${randomUUID()}.owner`),
      `${options.ownerPid}\n`,
      { mode: 0o600 },
    );
  }
  if (options.ageMs !== undefined) {
    const past = new Date(Date.now() - options.ageMs);
    await utimes(lockPath, past, past);
  }
  return lockPath;
}

describe('config mutation lock recovery', () => {
  it('reclaims a lock left behind by a process that died', async () => {
    const file = await makeFile();
    const ownerPid = await deadPid();
    const lockPath = await plantLock(file, { ownerPid });

    let ran = false;
    await withConfigMutationLock([file], async () => {
      ran = true;
    });

    expect(ran).toBe(true);
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reclaims an empty lock directory only after the creation grace period', async () => {
    const file = await makeFile();
    const lockPath = await plantLock(file);

    expect(await reclaimStaleFileLock(lockPath)).toBe(false);
    const past = new Date(Date.now() - 60_000);
    await utimes(lockPath, past, past);
    expect(await reclaimStaleFileLock(lockPath)).toBe(true);
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never reclaims a lock whose owner is still alive', async () => {
    const file = await makeFile();
    const lockPath = await plantLock(file, { ownerPid: process.pid });

    expect(await reclaimStaleFileLock(lockPath)).toBe(false);
    expect(await readdir(lockPath)).toHaveLength(1);
  });

  it('keeps a lock when any recorded owner is still alive', async () => {
    const file = await makeFile();
    const dead = await deadPid();
    const lockPath = await plantLock(file, { ownerPid: process.pid });
    await writeFile(path.join(lockPath, `${dead}-${randomUUID()}.owner`), `${dead}\n`);

    // One dead owner must not let a waiter remove the directory while another
    // recorded owner is alive.
    expect(await reclaimStaleFileLock(lockPath)).toBe(false);
    expect(await readdir(lockPath)).toHaveLength(2);

    const liveOwner = (await readdir(lockPath)).find((entry) => entry.startsWith(`${process.pid}-`));
    expect(liveOwner).toBeDefined();
    await unlink(path.join(lockPath, liveOwner!));
    expect(await reclaimStaleFileLock(lockPath)).toBe(true);
  });

  it('fails closed on an owner file this module did not write', async () => {
    const file = await makeFile();
    const lockPath = await plantLock(file);
    await writeFile(path.join(lockPath, 'operator.owner'), '');

    expect(await reclaimStaleFileLock(lockPath)).toBe(false);
    expect(await readFile(path.join(lockPath, 'operator.owner'), 'utf8')).toBe('');
  });
});
