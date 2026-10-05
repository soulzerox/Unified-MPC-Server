/* global process */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-lock-test-'));
const sharedConfig = path.join(root, 'mcp.json');
const leftConfig = path.join(root, 'left.json');
const rightConfig = path.join(root, 'right.json');
const events = path.join(root, 'events.log');
await Promise.all([
  writeFile(sharedConfig, '{}\n'),
  writeFile(leftConfig, '{}\n'),
  writeFile(rightConfig, '{}\n'),
]);
const modulePath = path.resolve('packages/extensions/dist/config-mutation-lock.js');
const worker = `import { appendFile } from 'node:fs/promises'; import { withConfigMutationTransaction } from ${JSON.stringify(modulePath)}; const [shared, unique, events] = process.argv.slice(1); await withConfigMutationTransaction([shared, unique], async () => { await appendFile(events, 'start\\n'); await new Promise((resolve) => setTimeout(resolve, 100)); await appendFile(events, 'end\\n'); });`;

const run = (uniqueConfig) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', worker, sharedConfig, uniqueConfig, events], { stdio: 'inherit' });
  child.once('error', reject);
  child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`lock worker exited ${code}`)));
});

try {
  await Promise.all([run(leftConfig), run(rightConfig)]);
  const lines = (await readFile(events, 'utf8')).trim().split('\n');
  if (lines.join(',') !== 'start,end,start,end') {
    throw new Error(`Config mutation lock allowed overlapping file sets to race: ${lines.join(',')}`);
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
