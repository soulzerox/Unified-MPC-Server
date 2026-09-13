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

const rustPreflight = () => {
  const rustToolchain = 'stable-x86_64-unknown-linux-gnu';
  const rustc = spawnSync('rustc', ['--version'], { encoding: 'utf8' });
  if (rustc.error === undefined && rustc.status === 0) {
    process.stdout.write(`Rust toolchain ready: ${rustc.stdout.trim()}\n`);
    return;
  }
  const output = `${rustc.stderr ?? ''}${rustc.stdout ?? ''}`.trim();
  if (output.includes('missing manifest in toolchain')) {
    process.stderr.write(
      `Rust release gate blocked: toolchain '${rustToolchain}' has no compiler manifest. `
      + 'The rustup installation is incomplete. Repair it with '
      + '`rustup toolchain uninstall stable-x86_64-unknown-linux-gnu && '
      + 'rustup toolchain install stable --profile minimal`, then rerun release:verify.\n',
    );
  } else if (rustc.error?.code === 'ENOENT') {
    process.stderr.write(
      'Rust release gate blocked: rustc is unavailable. Install rustup and the stable toolchain, '
      + 'then rerun release:verify.\n',
    );
  } else {
    process.stderr.write(`Rust release gate blocked: rustc --version failed\n${output}\n`);
  }
  process.exit(rustc.status ?? 1);
};

const commands = [
  ['corepack', ['pnpm', 'version:check']],
  ['corepack', ['pnpm', 'typecheck']],
  ['corepack', ['pnpm', 'lint']],
  ['corepack', ['pnpm', 'test']],
  ['corepack', ['pnpm', 'build']],
  [process.execPath, ['scripts/test-config-mutation-lock.mjs']],
  ['npx', ['vitest', 'run', 'tests/']],
  ['git', ['diff', '--check']],
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

rustPreflight();
const cargo = spawnSync('cargo', ['test', '--manifest-path', 'native/linux-host/Cargo.toml', '--locked'], { stdio: 'inherit' });
if (cargo.error !== undefined) {
  process.stderr.write(`${cargo.error.message}\n`);
  process.exit(127);
}
if (cargo.status !== 0) process.exit(cargo.status ?? 1);