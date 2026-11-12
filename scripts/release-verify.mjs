/* global process */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const git = (args) => {
  const result = spawnSync('git', args, { encoding: 'utf8', cwd: ROOT });
  if (result.error !== undefined || result.status !== 0) {
    process.stderr.write(`git ${args.join(' ')} failed\n`);
    process.exit(result.status ?? 1);
  }
  return result.stdout.trim();
};

/**
 * Ordered release-gate commands.
 *
 * Kept as data so `release-verify.test.mjs` can prove the gate still runs the
 * artifact it ships. Every entry is `[command, args]` with repository-relative
 * script paths, the same shape the gate executes.
 */
export const RELEASE_COMMANDS = [
  ['corepack', ['pnpm', 'version:check']],
  ['corepack', ['pnpm', 'typecheck']],
  // The gate above must never touch a deployed dist; prove it before building.
  ['corepack', ['pnpm', 'provenance:check']],
  ['corepack', ['pnpm', 'lint']],
  // Run the destructive clean-build guard before recursive workspace tests.
  [process.execPath, ['scripts/verify-native-rag-migration.mjs']],
  [process.execPath, ['scripts/generate-tool-catalog.mjs', '--check']],
  ['corepack', ['pnpm', 'test']],
  ['corepack', ['pnpm', 'build']],
  [process.execPath, ['scripts/smoke-mcp-http-runtime.mjs']],
  // Boot the artifact the release actually ships: materialize a portable
  // release from this tree, then prove it starts and restarts with the source
  // `apps/` and `packages/` hidden. The script restores them on exit, and it
  // must run after `build` because it materializes from built output.
  ['bash', ['scripts/materialize-runtime-release.test.sh']],
  [process.execPath, ['scripts/test-config-mutation-lock.mjs']],
  ['npx', ['vitest', 'run', 'tests/']],
  ['git', ['diff', '--check']],
];

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

export function runReleaseVerify() {
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

  for (const [command, args] of RELEASE_COMMANDS) {
    process.stdout.write(`\n$ ${command} ${args.join(' ')}\n`);
    const result = spawnSync(command, args, { stdio: 'inherit', cwd: ROOT });
    if (result.error !== undefined) {
      process.stderr.write(`${result.error.message}\n`);
      process.exit(127);
    }
    if (result.status !== 0) process.exit(result.status ?? 1);
  }

  rustPreflight();
  const cargo = spawnSync('cargo', ['test', '--manifest-path', 'native/linux-host/Cargo.toml', '--locked'], { stdio: 'inherit', cwd: ROOT });
  if (cargo.error !== undefined) {
    process.stderr.write(`${cargo.error.message}\n`);
    process.exit(127);
  }
  if (cargo.status !== 0) process.exit(cargo.status ?? 1);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runReleaseVerify();
}
