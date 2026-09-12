/* eslint-disable no-undef */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const expected = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
const packageFiles = ['apps', 'packages'];
const mismatches = [];

async function walk(directory) {
  const entries = await readdir(path.join(root, directory), { withFileTypes: true });
  for (const entry of entries) {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(relative);
    else if (entry.name === 'package.json') {
      const version = JSON.parse(await readFile(path.join(root, relative), 'utf8')).version;
      if (version !== expected) mismatches.push(`${relative}: ${version}`);
    }
  }
}

for (const directory of packageFiles) await walk(directory);
const shared = await readFile(path.join(root, 'packages/shared/src/index.ts'), 'utf8');
const appVersion = shared.match(/APP_VERSION\s*=\s*'([^']+)'/)?.[1];
if (appVersion !== expected) mismatches.push(`packages/shared/src/index.ts: ${appVersion ?? 'missing'}`);
const ipcContracts = await readFile(path.join(root, 'packages/ipc-contracts/src/index.ts'), 'utf8');
const ipcVersion = ipcContracts.match(/APP_VERSION\s*=\s*'([^']+)'/)?.[1];
if (ipcVersion !== expected) mismatches.push(`packages/ipc-contracts/src/index.ts: ${ipcVersion ?? 'missing'}`);
if (mismatches.length > 0) {
  console.error(`Version mismatch; expected ${expected}\n${mismatches.join('\n')}`);
  process.exitCode = 1;
} else {
  console.log(`Version consistency OK: ${expected}`);
}