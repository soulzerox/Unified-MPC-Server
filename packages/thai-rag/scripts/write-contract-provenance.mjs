#!/usr/bin/env node
/* global console, URL */
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Rewrites the `files` sha256 map in PROVENANCE.json from the vendored tree.
 *
 * The corpus test is the authority on whether the result is correct; this
 * script only makes the documented refresh procedure produce the expected
 * contract-relative keys instead of repository-root paths.
 */
const CONTRACT_ROOT = fileURLToPath(new URL('../contract', import.meta.url));
const PROVENANCE_PATH = path.join(CONTRACT_ROOT, 'PROVENANCE.json');
const DESCRIPTIVE_FILES = new Set(['PROVENANCE.json', 'VENDORED.md']);

async function listContractFiles(directory = CONTRACT_ROOT, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await listContractFiles(path.join(directory, entry.name), relative));
    else files.push(relative);
  }
  return files.sort();
}

const provenance = JSON.parse(await readFile(PROVENANCE_PATH, 'utf8'));
const files = {};
for (const file of await listContractFiles()) {
  if (DESCRIPTIVE_FILES.has(file)) continue;
  files[file] = createHash('sha256').update(await readFile(path.join(CONTRACT_ROOT, file))).digest('hex');
}

provenance.files = files;
const rendered = `${JSON.stringify(provenance, null, 2)}\n`;
const current = await readFile(PROVENANCE_PATH, 'utf8');
if (current === rendered) {
  console.log(`contract provenance already current (${Object.keys(files).length} files)`);
} else {
  await writeFile(PROVENANCE_PATH, rendered, 'utf8');
  console.log(`wrote ${Object.keys(files).length} contract hashes to PROVENANCE.json`);
}
