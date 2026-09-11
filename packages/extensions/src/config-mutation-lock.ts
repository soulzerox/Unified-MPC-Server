import { readFile, unlink } from 'node:fs/promises';
import { writeAtomic } from './ide-sync.js';

interface FileSnapshot {
  readonly path: string;
  readonly content: string | undefined;
}

let mutationQueue = Promise.resolve();

// ponytail: one in-process lock keeps install/prune transactions consistent; use per-root or OS locks if throughput or multi-process mutation becomes required.
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
  try {
    const snapshots = await Promise.all(files.map(captureFile));
    try {
      return await operation();
    } catch (error: unknown) {
      await Promise.all(snapshots.map(restoreFile));
      throw error;
    }
  } finally {
    release();
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