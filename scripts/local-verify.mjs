#!/usr/bin/env node
/* global process, console, Buffer */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Local-only merge-readiness verification profile (#144).
 *
 * GitHub is the PR/merge surface; build, test, lint and typecheck run here.
 * One command replaces the hand-derived command list every session used to
 * assemble, and it writes a durable exact-head receipt so a later merge can
 * prove which tree was verified.
 *
 * The `merge` profile is the only one that can report `mergeReady`. It refuses
 * a dirty worktree by default because `dist` provenance and the build
 * provenance test both describe the committed tree, not the working copy.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RECEIPT_ROOT = path.join(ROOT, '.unified-mpc', 'local-verify');
const MAX_LOG_CHARS = 2 * 1024 * 1024;
const PNPM = 'corepack';
const PNPM_PREFIX = ['pnpm@10.15.0'];

export const PROFILE_VERSION = 1;
export const PROFILES = ['merge', 'targeted'];

/**
 * Ordered profile steps. `diff-check` runs first because it is the cheapest
 * failure, and `build` runs before every package test because the suites import
 * built workspace output.
 */
export const STEP_DEFINITIONS = [
  { name: 'diff-check', profiles: ['targeted', 'merge'], command: ['git', 'diff', '--check'] },
  { name: 'typecheck', profiles: ['targeted', 'merge'], command: [PNPM, ...PNPM_PREFIX, 'typecheck'] },
  { name: 'lint', profiles: ['targeted', 'merge'], command: [PNPM, ...PNPM_PREFIX, 'lint'] },
  { name: 'build', profiles: ['merge'], command: [PNPM, ...PNPM_PREFIX, 'build'] },
  { name: 'test:workspace', profiles: ['merge'], command: [PNPM, ...PNPM_PREFIX, '--filter', '@unified-mpc/workspace', 'test'] },
  { name: 'test:storage', profiles: ['merge'], command: [PNPM, ...PNPM_PREFIX, '--filter', '@unified-mpc/storage', 'test'] },
  { name: 'test:mcp-server', profiles: ['merge'], command: [PNPM, ...PNPM_PREFIX, '--filter', '@unified-mpc/mcp-server', 'test'] },
  { name: 'test:cli', profiles: ['merge'], command: [PNPM, ...PNPM_PREFIX, '--filter', '@unified-mpc/cli', 'test'] },
  { name: 'version', profiles: ['merge'], command: ['node', 'scripts/check-version-consistency.mjs'] },
  { name: 'docs:tools', profiles: ['merge'], command: ['node', 'scripts/generate-tool-catalog.mjs', '--check'] },
  { name: 'provenance', profiles: ['merge'], command: ['node', 'scripts/check-dist-provenance-freshness.mjs'] },
];

export function profileSteps(profile) {
  if (!PROFILES.includes(profile)) {
    throw new RangeError(`unknown profile '${profile}'`);
  }
  return STEP_DEFINITIONS
    .filter((step) => step.profiles.includes(profile))
    .map((step) => ({ name: step.name, command: [...step.command] }));
}

export function parseArgs(argv) {
  const options = { profile: 'merge', json: false, allowDirty: false, prNumber: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') {
      options.json = true;
    } else if (argument === '--allow-dirty') {
      options.allowDirty = true;
    } else if (argument === '--profile') {
      index += 1;
      options.profile = argv[index];
    } else if (argument === '--pr') {
      index += 1;
      const value = Number(argv[index]);
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new RangeError('--pr must be a positive integer');
      }
      options.prNumber = value;
    } else if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else {
      throw new RangeError(`unknown argument '${String(argument)}'`);
    }
  }
  if (!PROFILES.includes(options.profile)) {
    throw new RangeError(`--profile must be one of ${PROFILES.join(', ')}`);
  }
  return options;
}

/**
 * A merge profile is only merge-ready when every step ran and passed on a clean
 * worktree. A targeted run, a dirty tree or any skipped/failed step is never
 * evidence for a merge.
 */
export function mergeReadiness({ profile, dirty, steps }) {
  if (profile !== 'merge') return false;
  if (dirty) return false;
  if (!Array.isArray(steps) || steps.length === 0) return false;
  return steps.every((step) => step.status === 'passed');
}

export function buildReceipt(input) {
  const ok = input.steps.length > 0 && input.steps.every((step) => step.status === 'passed');
  const receipt = {
    verificationId: input.verificationId,
    profile: input.profile,
    profileVersion: PROFILE_VERSION,
    workspacePath: input.workspacePath,
    headSha: input.headSha,
    branch: input.branch,
    dirty: input.dirty,
    diffFingerprint: input.diffFingerprint,
    toolchain: input.toolchain,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    ok,
    mergeReady: mergeReadiness({ profile: input.profile, dirty: input.dirty, steps: input.steps }),
    steps: input.steps,
  };
  if (input.prNumber !== undefined) receipt.prNumber = input.prNumber;
  return receipt;
}

/** Stable identity for the verified input: the commit plus any local delta. */
export function diffFingerprint({ headSha, status, diff }) {
  return `sha256:${createHash('sha256').update(headSha).update('\n').update(status).update('\n').update(diff).digest('hex')}`;
}

/** Keep the tail: test failures and stack traces are at the end of a log. */
export function truncateLog(text, limit = MAX_LOG_CHARS) {
  if (text.length <= limit) return { text, truncated: false };
  const marker = `[truncated ${text.length - limit} characters from the start]\n`;
  return { text: marker + text.slice(text.length - limit), truncated: true };
}

export function summarize(receipt, receiptPath) {
  const lines = [
    `local-verify ${receipt.profile} v${receipt.profileVersion} — ${receipt.headSha.slice(0, 12)}`
      + `${receipt.dirty ? ' (dirty)' : ''}`,
  ];
  for (const step of receipt.steps) {
    const seconds = (step.durationMs / 1000).toFixed(1);
    lines.push(`  ${step.status === 'passed' ? 'ok  ' : step.status === 'skipped' ? 'skip' : 'FAIL'} ${step.name} (${seconds}s)`);
  }
  lines.push(receipt.mergeReady
    ? 'merge-ready: yes'
    : `merge-ready: no${receipt.profile !== 'merge' ? ' (targeted profile)' : receipt.dirty ? ' (dirty worktree)' : ''}`);
  lines.push(`receipt: ${receiptPath}`);
  return lines.join('\n');
}

function runCommand(argv, { cwd, onChunk }) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    const collect = (chunk) => {
      chunks.push(chunk);
      if (onChunk !== undefined) onChunk(chunk);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', reject);
    child.on('close', (code) => resolve({ exitCode: code ?? 1, output: Buffer.concat(chunks).toString('utf8') }));
  });
}

function git(argv) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', argv, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => chunks.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`git ${argv.join(' ')} failed: ${Buffer.concat(chunks).toString('utf8').trim()}`));
        return;
      }
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

async function readTreeIdentity() {
  const [headSha, branch, status, diff] = await Promise.all([
    git(['rev-parse', 'HEAD']),
    git(['rev-parse', '--abbrev-ref', 'HEAD']),
    git(['status', '--porcelain=v1']),
    git(['diff', '--binary', 'HEAD']),
  ]);
  return {
    headSha: headSha.trim(),
    branch: branch.trim(),
    dirty: status.trim().length > 0,
    status: status.trim(),
    diff,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help === true) {
    console.log('usage: node scripts/local-verify.mjs [--profile merge|targeted] [--pr N] [--json] [--allow-dirty]');
    return 0;
  }

  const identity = await readTreeIdentity();
  if (options.profile === 'merge' && identity.dirty && !options.allowDirty) {
    console.error(
      'refusing the merge profile on a dirty worktree: commit first, then verify the exact head\n'
      + '(use --profile targeted for iterative checks, or --allow-dirty to run anyway without merge evidence)',
    );
    return 2;
  }

  const verificationId = randomUUID();
  const startedAt = new Date().toISOString();
  const logDirectory = path.join(RECEIPT_ROOT, 'logs', verificationId);
  await mkdir(logDirectory, { recursive: true });

  const steps = [];
  for (const step of profileSteps(options.profile)) {
    const stepStartedAt = Date.now();
    const result = await runCommand(step.command, {
      cwd: ROOT,
      onChunk: options.json ? undefined : (chunk) => process.stdout.write(chunk),
    });
    const durationMs = Date.now() - stepStartedAt;
    const log = truncateLog(result.output);
    const logPath = path.join(logDirectory, `${step.name.replace(/[^a-z0-9.-]+/gi, '-')}.log`);
    await writeFile(logPath, log.text, 'utf8');
    const status = result.exitCode === 0 ? 'passed' : 'failed';
    steps.push({
      name: step.name,
      command: step.command.join(' '),
      status,
      exitCode: result.exitCode,
      durationMs,
      logRef: path.relative(ROOT, logPath),
      logTruncated: log.truncated,
    });
    if (status === 'failed') break;
  }
  for (const remaining of profileSteps(options.profile).slice(steps.length)) {
    steps.push({ name: remaining.name, command: remaining.command.join(' '), status: 'skipped', exitCode: null, durationMs: 0, logRef: null, logTruncated: false });
  }

  const receipt = buildReceipt({
    verificationId,
    profile: options.profile,
    workspacePath: ROOT,
    headSha: identity.headSha,
    branch: identity.branch,
    dirty: identity.dirty,
    diffFingerprint: diffFingerprint(identity),
    toolchain: { node: process.version, pnpm: '10.15.0' },
    startedAt,
    completedAt: new Date().toISOString(),
    prNumber: options.prNumber,
    steps,
  });

  await mkdir(RECEIPT_ROOT, { recursive: true });
  const receiptPath = path.join(RECEIPT_ROOT, `${identity.headSha.slice(0, 12)}-${verificationId}.json`);
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  await writeFile(path.join(RECEIPT_ROOT, 'latest.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');

  if (options.json) {
    console.log(JSON.stringify({ receiptPath, receipt }));
  } else {
    console.log(`\n${summarize(receipt, path.relative(ROOT, receiptPath))}`);
  }
  return receipt.ok && (options.profile !== 'merge' || receipt.mergeReady) ? 0 : 1;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
