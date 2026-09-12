/* global process */
import { spawnSync } from 'node:child_process';

const git = (args) => {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.error !== undefined || result.status !== 0) {
    process.stderr.write(`git ${args.join(' ')} failed\n`);
    process.exit(result.status ?? 1);
  }
  return result.stdout.trim();
};

const head = git(['rev-parse', '--verify', 'HEAD']);
const dirty = git(['status', '--porcelain']);
if (dirty.length > 0) {
  process.stderr.write(`Release verification requires a clean tree at ${head}\n${dirty}\n`);
  process.exit(1);
}
if (process.env.RELEASE_EXPECTED_SHA !== undefined && process.env.RELEASE_EXPECTED_SHA !== head) {
  process.stderr.write(`Release HEAD mismatch: expected ${process.env.RELEASE_EXPECTED_SHA}, got ${head}\n`);
  process.exit(1);
}
process.stdout.write(`Release evidence SHA: ${head}\n`);

const commands = [
  ['corepack', ['pnpm', 'version:check']],
  ['corepack', ['pnpm', 'typecheck']],
  ['corepack', ['pnpm', 'lint']],
  ['corepack', ['pnpm', 'test']],
  ['corepack', ['pnpm', 'build']],
  [process.execPath, ['scripts/test-config-mutation-lock.mjs']],
  ['npx', ['vitest', 'run', 'tests/']],
  ['git', ['diff', '--check']],
  ['cargo', ['test', '--manifest-path', 'native/linux-host/Cargo.toml', '--locked']],
];

for (const [command, args] of commands) {
  process.stdout.write(`\n$ ${command} ${args.join(' ')}\n`);
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error !== undefined) {
    process.stderr.write(`${result.error.message}\n`);
    process.exit(127);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}