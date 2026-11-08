#!/usr/bin/env node
/* global process, console */
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Husky 9 writes one dispatcher shim into `.husky/_` for every Git hook name,
 * not only for the hooks this repository actually defines. Those shims are
 * generated files, but `git rev-parse --git-path hooks` still resolves to
 * `.husky/_`, so an unused shim looks like a configured hook to any safety
 * check that inspects the hook directory. The guarded Git push refuses to run
 * a configured `pre-push` hook, which would otherwise block the only approved
 * publish path in every fresh worktree.
 *
 * This script deletes shims that have no matching `.husky/<hook>` script, so
 * the hook directory describes the hooks the repository really has. Husky
 * recreates every shim on the next install, and `prepare` runs this script
 * afterwards, so the state is reproducible. A shim for a hook this repository
 * adds later is kept as soon as that hook file exists.
 */

/** Files husky generates next to the shims; they are not hooks. */
const NON_HOOK_FILES = new Set(['h', 'husky.sh', '.gitignore']);

/**
 * Names in `.husky/_` that do not describe a hook the repository defines.
 * `hookNames` are the files at `.husky/` root; hidden files are husky metadata.
 */
export function unusedHookShims({ shimNames, hookNames }) {
  const defined = new Set(hookNames.filter((name) => !name.startsWith('.')));
  return shimNames
    .filter((name) => !NON_HOOK_FILES.has(name) && !defined.has(name))
    .sort();
}

async function listDirectory(directory) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * Prunes unused shims under `<root>/.husky/_`. Refuses to delete anything when
 * the dispatcher is missing, because that directory is then not husky-managed.
 */
export async function pruneUnusedHuskyHooks({ root, dryRun = false }) {
  const huskyDir = path.join(root, '.husky');
  const shimsDir = path.join(huskyDir, '_');
  const shimEntries = await listDirectory(shimsDir);
  if (shimEntries === undefined) return { status: 'missing', removed: [] };
  const hasDispatcher = shimEntries.some((entry) => entry.isFile() && entry.name === 'h');
  if (!hasDispatcher) return { status: 'not-husky', removed: [] };
  const hookEntries = await listDirectory(huskyDir);
  const removed = unusedHookShims({
    shimNames: shimEntries.filter((entry) => entry.isFile()).map((entry) => entry.name),
    hookNames: (hookEntries ?? []).filter((entry) => entry.isFile()).map((entry) => entry.name),
  });
  if (!dryRun) {
    for (const name of removed) await rm(path.join(shimsDir, name), { force: true });
  }
  return { status: 'pruned', removed, dryRun };
}

function parseArguments(argv) {
  const options = { root: process.cwd(), dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--root') {
      const value = argv[index + 1];
      if (value === undefined) throw new Error('--root requires a directory');
      options.root = path.resolve(value);
      index += 1;
    } else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(`prune-unused-husky-hooks: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
    return;
  }
  const result = await pruneUnusedHuskyHooks(options);
  if (result.status === 'missing') {
    console.log('prune-unused-husky-hooks: no .husky/_ directory, nothing to do');
    return;
  }
  if (result.status === 'not-husky') {
    console.error('prune-unused-husky-hooks: .husky/_ has no husky dispatcher, refusing to delete anything');
    process.exitCode = 1;
    return;
  }
  const verb = options.dryRun ? 'would remove' : 'removed';
  console.log(result.removed.length === 0
    ? 'prune-unused-husky-hooks: every shim matches a repository hook'
    : `prune-unused-husky-hooks: ${verb} ${result.removed.join(', ')}`);
}

const invokedDirectly = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) await main();
