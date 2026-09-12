/* global process */
import { spawnSync } from 'node:child_process';

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