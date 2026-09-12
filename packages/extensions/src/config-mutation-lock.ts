import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeAtomic } from './ide-sync.js';

interface FileSnapshot {
  readonly path: string;
  readonly content: string | undefined;
}

let mutationQueue = Promise.resolve();
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 30_000;

export async function withConfigMutationTransaction<T>(
  files: readonly string[],
  operation: () => Promise<T>,
): Promise<T> {
  const previous = mutationQueue;
  let release!: () => void;
  mutationQueue = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;
  const lockPath = mutationLockPath(files);
  let releaseFileLock: (() => Promise<void>) | undefined;
  try {
    releaseFileLock = await acquireFileLock(lockPath);
    const snapshots = await Promise.all(files.map(captureFile));
    try {
      return await operation();
    } catch (error: unknown) {
      await Promise.all(snapshots.map(restoreFile));
      throw error;
    }
  } finally {
    await releaseFileLock?.();
    release();
  }
}

function mutationLockPath(files: readonly string[]): string {
  const key = createHash('sha256').update([...files].sort().join('\0')).digest('hex');
  return path.join(os.tmpdir(), `unified-mpc-config-${key}.lock`);
}

async function acquireFileLock(lockPath: string): Promise<() => Promise<void>> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      const ownerPath = path.join(lockPath, `${process.pid}-${randomUUID()}.owner`);
      await writeFile(ownerPath, `${process.pid}\n`, { mode: 0o600 });
      return async (): Promise<void> => {
        await unlink(ownerPath).catch(() => undefined);
        await rmdir(lockPath).catch(() => undefined);
      };
    } catch (error: unknown) {
      if (!isAlreadyExists(error)) throw error;
      if (Date.now() >= deadline) throw new Error(`Timed out acquiring config mutation lock: ${lockPath}`);
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
}

async function captureFile(file: string): Promise<FileSnapshot> {
  try {
    return { path: file, content: await readFile(file, 'utf8') };
  } catch (error: unknown) {
    if (isMissingPath(error)) return { path: file, content: undefined };
    throw error;
  }
}

async function restoreFile(snapshot: FileSnapshot): Promise<void> {
  if (snapshot.content === undefined) {
    try {
      await unlink(snapshot.path);
    } catch (error: unknown) {
      if (!isMissingPath(error)) throw error;
    }
    return;
  }
  await writeAtomic(snapshot.path, snapshot.content);
}

function isMissingPath(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT';
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'EEXIST';
}
