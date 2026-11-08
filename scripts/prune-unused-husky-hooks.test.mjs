import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { pruneUnusedHuskyHooks, unusedHookShims } from './prune-unused-husky-hooks.mjs';

test('keeps the shim for every hook the repository defines', () => {
  assert.deepEqual(
    unusedHookShims({
      shimNames: ['h', 'husky.sh', '.gitignore', 'pre-commit', 'pre-push', 'commit-msg'],
      hookNames: ['_', '.gitignore', 'pre-commit', 'commit-msg'],
    }),
    ['pre-push'],
  );
});

test('never treats husky metadata as a hook to prune', () => {
  assert.deepEqual(
    unusedHookShims({
      shimNames: ['h', 'husky.sh', '.gitignore'],
      hookNames: [],
    }),
    [],
  );
});

test('prunes only shims without a hook script and keeps the dispatcher', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'husky-prune-'));
  try {
    await mkdir(path.join(root, '.husky', '_'), { recursive: true });
    for (const name of ['h', 'husky.sh', 'pre-commit', 'pre-push']) {
      await writeFile(path.join(root, '.husky', '_', name), '');
    }
    await writeFile(path.join(root, '.husky', 'pre-commit'), '');

    const result = await pruneUnusedHuskyHooks({ root });

    assert.deepEqual(result, { status: 'pruned', removed: ['pre-push'], dryRun: false });
    assert.deepEqual((await readdir(path.join(root, '.husky', '_'))).sort(), ['h', 'husky.sh', 'pre-commit']);
    assert.deepEqual((await readdir(path.join(root, '.husky'))).sort(), ['_', 'pre-commit']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a dry run reports the shims without deleting them', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'husky-prune-'));
  try {
    await mkdir(path.join(root, '.husky', '_'), { recursive: true });
    await writeFile(path.join(root, '.husky', '_', 'h'), '');
    await writeFile(path.join(root, '.husky', '_', 'pre-push'), '');

    const result = await pruneUnusedHuskyHooks({ root, dryRun: true });

    assert.deepEqual(result, { status: 'pruned', removed: ['pre-push'], dryRun: true });
    assert.deepEqual((await readdir(path.join(root, '.husky', '_'))).sort(), ['h', 'pre-push']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('refuses to delete when the directory is not husky-managed', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'husky-prune-'));
  try {
    await mkdir(path.join(root, '.husky', '_'), { recursive: true });
    await writeFile(path.join(root, '.husky', '_', 'pre-push'), '');

    const result = await pruneUnusedHuskyHooks({ root });

    assert.deepEqual(result, { status: 'not-husky', removed: [] });
    assert.deepEqual(await readdir(path.join(root, '.husky', '_')), ['pre-push']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('is a no-op when husky has not installed any hook directory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'husky-prune-'));
  try {
    assert.deepEqual(await pruneUnusedHuskyHooks({ root }), { status: 'missing', removed: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
