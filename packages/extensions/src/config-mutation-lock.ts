import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeAtomic } from './atomic-write.js';

interface FileSnapshot {
  readonly path: string;
  readonly content: string | undefined;
}

let mutationQueue = Promise.resolve();
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 30_000;
// A new acquisition publishes a fully populated directory with one rename, so a
// same-build waiter never observes an empty lock. An empty directory here is a
// release that died between `unlink` and `rmdir`; reclaim it after a grace
// period instead of letting it block forever.
const EMPTY_LOCK_GRACE_MS = 5_000;

/**
 * Hold the shared per-file mutation locks without snapshotting or rolling the
 * files back. Use this for a read-modify-write pass that already handles its
 * own failures per file (for example the managed policy repair): it still
 * serializes with `install`, `prune` and canonical registry writes.
 */
export async function withConfigMutationLock<T>(
  files: readonly string[],
  operation: () => Promise<T>,
): Promise<T> {
  const previous = mutationQueue;
  let release!: () => void;
  mutationQueue = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;
  const lockFiles = normalizeFiles(files);
  const releaseFileLocks: Array<() => Promise<void>> = [];
  try {
    for (const file of lockFiles) {
      releaseFileLocks.push(await acquireFileLock(configMutationLockPath(file)));
    }
    return await operation();
  } finally {
    for (let index = releaseFileLocks.length - 1; index >= 0; index -= 1) {
      await releaseFileLocks[index]!();
    }
    release();
  }
}

export async function withConfigMutationTransaction<T>(
  files: readonly string[],
  operation: () => Promise<T>,
): Promise<T> {
  const transactionFiles = normalizeFiles(files);
  return withConfigMutationLock(transactionFiles, async () => {
    const snapshots = await Promise.all(transactionFiles.map(captureFile));
    try {
      return await operation();
    } catch (error: unknown) {
      await Promise.all(snapshots.map(restoreFile));
      throw error;
    }
  });
}

function normalizeFiles(files: readonly string[]): string[] {
  return [...new Set(files.map((file) => path.resolve(file)))].sort();
}

/**
 * Exported so a regression test can plant the lock a killed writer would leave
 * behind. The hash key keeps the lock name free of the file path.
 */
export function configMutationLockPath(file: string): string {
  const key = createHash('sha256').update(path.resolve(file)).digest('hex');
  return path.join(os.tmpdir(), `unified-mpc-config-${key}.lock`);
}

async function acquireFileLock(lockPath: string): Promise<() => Promise<void>> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    const token = randomUUID();
    // Publish the directory and its owner file with one atomic rename. A waiter
    // can never observe the lock between `mkdir` and the owner write, so a
    // creator stalled in that window cannot have an empty directory reclaimed
    // and then write its owner into the replacement.
    const stagedPath = `${lockPath}.staged-${process.pid}-${token}`;
    const ownerName = `${process.pid}-${token}.owner`;
    try {
      await mkdir(stagedPath, { mode: 0o700 });
      await writeFile(path.join(stagedPath, ownerName), `${process.pid}\n`, { mode: 0o600 });
    } catch (error: unknown) {
      await rm(stagedPath, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }

    try {
      await rename(stagedPath, lockPath);
    } catch (error: unknown) {
      await rm(stagedPath, { recursive: true, force: true }).catch(() => undefined);
      if (!isLockContention(error)) throw error;
      if (await reclaimStaleFileLock(lockPath)) continue;
      if (Date.now() >= deadline) throw new Error(`Timed out acquiring config mutation lock: ${lockPath}`);
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
      continue;
    }

    const ownerPath = path.join(lockPath, ownerName);
    return async (): Promise<void> => {
      await unlink(ownerPath).catch(() => undefined);
      await rmdir(lockPath).catch(() => undefined);
    };
  }
}

function isLockContention(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'ENOTDIR' || code === 'EISDIR';
}

/**
 * Remove a lock directory only when its owner is provably gone. The owner file
 * name starts with the holder's PID, so `kill(pid, 0)` distinguishes a live
 * holder from a writer that died before its release closure ran.
 *
 * A directory with no owner file is a release interrupted between `unlink` and
 * `rmdir`, so it is reclaimed only after `EMPTY_LOCK_GRACE_MS`. While a
 * non-empty directory exists no new owner can acquire it, which is why deleting
 * the owner files observed here cannot delete a newer holder's file.
 */
export async function reclaimStaleFileLock(lockPath: string): Promise<boolean> {
  let entries: string[];
  try {
    entries = await readdir(lockPath);
  } catch (error: unknown) {
    return isMissingPath(error);
  }

  const ownerFiles = entries.filter((entry) => entry.endsWith('.owner'));
  if (ownerFiles.length === 0) {
    let created: Awaited<ReturnType<typeof stat>>;
    try {
      created = await stat(lockPath);
    } catch (error: unknown) {
      return isMissingPath(error);
    }
    if (Date.now() - created.mtimeMs < EMPTY_LOCK_GRACE_MS) return false;
  } else if (ownerFiles.some(isLiveOwnerFile)) {
    return false;
  }

  for (const entry of ownerFiles) {
    await unlink(path.join(lockPath, entry)).catch(() => undefined);
  }
  try {
    await rmdir(lockPath);
    return true;
  } catch (error: unknown) {
    return isMissingPath(error);
  }
}

function isLiveOwnerFile(ownerFile: string): boolean {
  const match = /^(\d+)-/.exec(ownerFile);
  // An owner file this module did not write has unknown provenance: fail closed.
  if (match === null) return true;
  return isProcessAlive(Number.parseInt(match[1]!, 10));
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    // EPERM means the process exists but belongs to another user.
    return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'EPERM';
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
