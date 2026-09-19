import { mkdir, mkdtemp, opendir, rm, writeFile } from 'node:fs/promises';
import type { Dir } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TreeReader } from './tree-reader.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('TreeReader', () => {
  it('sorts entries without hiding generated, hidden, dependency, or environment paths', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-tree-'));
    temporaryRoots.push(root);
    await mkdir(path.join(root, 'src'));
    await mkdir(path.join(root, '.git'));
    await mkdir(path.join(root, 'dist'));
    await mkdir(path.join(root, 'node_modules'));
    await writeFile(path.join(root, '.env'), 'TOKEN=visible', 'utf8');
    await writeFile(path.join(root, 'z.txt'), 'z', 'utf8');
    await writeFile(path.join(root, 'a.txt'), 'a', 'utf8');
    await writeFile(path.join(root, '.git', 'config'), 'config', 'utf8');
    await writeFile(path.join(root, 'dist', 'app.js'), 'build', 'utf8');
    await writeFile(path.join(root, 'node_modules', 'hidden.txt'), 'hidden', 'utf8');

    const result = await new TreeReader().read(root, { maxDepth: 3, maxEntries: 20 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entries.map((entry) => entry.path.replace(/\\/g, '/'))).toEqual(expect.arrayContaining([
      '.env', '.git', '.git/config', 'a.txt', 'dist', 'dist/app.js', 'node_modules', 'node_modules/hidden.txt', 'src', 'z.txt',
    ]));
    expect(result.value.truncated).toBe(false);
  });

  it('applies result item budgets before walking entries', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-tree-'));
    temporaryRoots.push(root);
    await writeFile(path.join(root, 'a.txt'), 'a', 'utf8');
    await writeFile(path.join(root, 'b.txt'), 'b', 'utf8');

    const result = await new TreeReader().read(root, { maxDepth: 1, maxEntries: 20 }, {
      maxItems: 1,
      maxTextBytes: 1024,
      maxStructuredBytes: 1024,
      maxBinaryBytes: 1024,
      maxBase64Bytes: 1024,
    });

    expect(result).toMatchObject({ ok: true, value: { entries: [{ type: 'file' }], truncated: true } });
  });

  it('stops before walking when cancelled', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-tree-'));
    temporaryRoots.push(root);
    const controller = new AbortController();
    controller.abort();

    await expect(new TreeReader().read(root, {}, undefined, controller.signal)).resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
  });

  it('returns cancellation when enumeration aborts before metadata resolves', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-tree-cancel-'));
    temporaryRoots.push(root);
    await writeFile(path.join(root, 'a.txt'), 'a', 'utf8');
    const controller = new AbortController();
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const resultPromise = new TreeReader(async (directoryPath) => {
      const directory = await opendir(directoryPath);
      return {
        close: () => directory.close(),
        [Symbol.asyncIterator]: () => {
          const iterator = directory[Symbol.asyncIterator]();
          return {
            next: async (): Promise<IteratorResult<unknown>> => {
              const value = await iterator.next();
              if (!value.done) await paused;
              return value;
            },
            return: async (): Promise<IteratorResult<unknown>> => {
              await directory.close();
              return { done: true, value: undefined };
            },
          };
        },
      } as unknown as Dir;
    }).read(root, { maxDepth: 1, maxEntries: 1 }, undefined, controller.signal);
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
    release();

    await expect(resultPromise).resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
  });

  it('stops enumerating a directory once entry cap is reached', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-tree-large-'));
    temporaryRoots.push(root);
    await Promise.all(Array.from({ length: 10_000 }, (_, index) => writeFile(path.join(root, `entry-${index}.txt`), 'x', 'utf8')));

    const result = await new TreeReader().read(root, { maxDepth: 1, maxEntries: 2 });

    expect(result).toMatchObject({ ok: true, value: { entries: expect.any(Array), truncated: true } });
    if (result.ok) expect(result.value.entries).toHaveLength(2);
  });

  it('enumerates only one lookahead entry after the retained budget is full', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-tree-stop-'));
    temporaryRoots.push(root);
    await writeFile(path.join(root, 'a.txt'), 'a', 'utf8');
    await writeFile(path.join(root, 'b.txt'), 'b', 'utf8');
    await writeFile(path.join(root, 'c.txt'), 'c', 'utf8');

    let enumerated = 0;
    const result = await new TreeReader(async (directoryPath) => {
      const directory = await opendir(directoryPath);
      return {
        close: () => directory.close(),
        [Symbol.asyncIterator]: () => {
          const iterator = directory[Symbol.asyncIterator]();
          return {
            next: async (): Promise<IteratorResult<unknown>> => {
              const value = await iterator.next();
              if (!value.done) enumerated += 1;
              return value;
            },
            return: async (): Promise<IteratorResult<unknown>> => {
              await directory.close();
              return { done: true, value: undefined };
            },
          };
        },
      } as unknown as Dir;
    }).read(root, { maxDepth: 1, maxEntries: 1 });

    expect(result.ok).toBe(true);
    expect(enumerated).toBe(2);
  });

  it('marks the result when an entry exists beyond the entry cap', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-tree-'));
    temporaryRoots.push(root);
    await writeFile(path.join(root, 'a.txt'), 'a', 'utf8');
    await writeFile(path.join(root, 'b.txt'), 'b', 'utf8');
    await writeFile(path.join(root, 'c.txt'), 'c', 'utf8');

    const result = await new TreeReader().read(root, { maxDepth: 1, maxEntries: 2 });

    expect(result).toMatchObject({
      ok: true,
      value: {
        entries: [{ type: 'file' }, { type: 'file' }],
        truncated: true,
      },
    });
  });

  it('does not mark an exact-cap tree as truncated', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-tree-exact-cap-'));
    temporaryRoots.push(root);
    await writeFile(path.join(root, 'a.txt'), 'a', 'utf8');
    await writeFile(path.join(root, 'b.txt'), 'b', 'utf8');

    const result = await new TreeReader().read(root, { maxDepth: 1, maxEntries: 2 });

    expect(result).toMatchObject({
      ok: true,
      value: {
        entries: [{ type: 'file' }, { type: 'file' }],
        truncated: false,
      },
    });
  });
});
