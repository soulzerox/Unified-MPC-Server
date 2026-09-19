import { lstat, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_TREE_DEPTH, DEFAULT_TREE_ENTRIES, err, MAX_TREE_DEPTH, MAX_TREE_ENTRIES, ok, type Result, type ResultBudget } from '@unified-mpc/domain';
import { isWithin } from '@unified-mpc/workspace';

export interface TreeOptions {
  readonly maxDepth?: number;
  readonly maxEntries?: number;
}

export interface TreeEntry {
  readonly path: string;
  readonly type: 'file' | 'directory';
}

export interface TreeResult {
  readonly entries: readonly TreeEntry[];
  readonly truncated: boolean;
}

export class TreeReader {
  public async read(rootPath: string, options: TreeOptions = {}, budget?: ResultBudget, signal?: AbortSignal): Promise<Result<TreeResult>> {
    if (signal?.aborted === true) return err({ code: 'PROCESS_TIMEOUT', message: 'Tree read was cancelled', recoverable: true });
    const maxDepth = options.maxDepth ?? DEFAULT_TREE_DEPTH;
    const maxEntries = Math.min(options.maxEntries ?? DEFAULT_TREE_ENTRIES, budget?.maxItems ?? Number.MAX_SAFE_INTEGER);
    if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > MAX_TREE_DEPTH || !Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_TREE_ENTRIES) {
      return err({ code: 'INVALID_INPUT', message: 'Tree bounds are invalid', recoverable: false });
    }

    let rootRealPath: string;
    try {
      rootRealPath = await realpath(rootPath);
    } catch {
      return err({ code: 'FILE_NOT_FOUND', message: 'Tree root was not found', recoverable: false });
    }

    const entries: TreeEntry[] = [];
    let truncated = false;
    const walk = async (currentPath: string, relativeDirectory: string, depth: number): Promise<void> => {
      if (truncated || depth > maxDepth || signal?.aborted === true) return;
      let directory;
      try {
        directory = await opendir(currentPath);
      } catch {
        return;
      }
      const remaining = maxEntries - entries.length;
      const candidates: Array<{ readonly absolutePath: string; readonly entry: import('node:fs').Dirent }> = [];
      let hasMoreCandidates = false;
      try {
        for await (const directoryEntry of directory) {
          if (signal?.aborted) return;
          const absoluteEntryPath = path.join(currentPath, directoryEntry.name);
          let entryRealPath: string;
          try {
            entryRealPath = await realpath(absoluteEntryPath);
          } catch {
            continue;
          }
          if (!isWithin(rootRealPath, entryRealPath)) continue;
          if (!directoryEntry.isDirectory() && !directoryEntry.isFile()) continue;
          candidates.push({ absolutePath: absoluteEntryPath, entry: directoryEntry });
          candidates.sort((left, right) => left.entry.name.localeCompare(right.entry.name, undefined, { sensitivity: 'base' }));
          if (candidates.length > remaining) {
            candidates.pop();
            hasMoreCandidates = true;
          }
        }
      } catch {
        return;
      }
      if (hasMoreCandidates) truncated = true;
      for (const candidate of candidates) {
        if (entries.length >= maxEntries) {
          truncated = true;
          return;
        }
        const relativePath = path.join(relativeDirectory, candidate.entry.name);
        const isDirectory = candidate.entry.isDirectory();
        entries.push({ path: relativePath, type: isDirectory ? 'directory' : 'file' });
        if (isDirectory && depth < maxDepth) await walk(candidate.absolutePath, relativePath, depth + 1);
      }
    };

    try {
      if (!(await lstat(rootPath)).isDirectory()) return err({ code: 'INVALID_INPUT', message: 'Tree root must be a directory', recoverable: false });
    } catch {
      return err({ code: 'FILE_NOT_FOUND', message: 'Tree root was not found', recoverable: false });
    }
    await walk(rootPath, '', 1);
    if (signal?.aborted) return err({ code: 'PROCESS_TIMEOUT', message: 'Tree read was cancelled', recoverable: true });
    return ok({ entries, truncated });
  }
}

export * from './text-file-reader.js';
