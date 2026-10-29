import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PROFILE_VERSION,
  buildReceipt,
  diffFingerprint,
  mergeReadiness,
  parseArgs,
  profileSteps,
  summarize,
  truncateLog,
} from './local-verify.mjs';

const STEP = (name, status = 'passed') => ({
  name,
  command: `run ${name}`,
  status,
  exitCode: status === 'passed' ? 0 : 1,
  durationMs: 10,
  logRef: `log/${name}.log`,
  logTruncated: false,
});

test('merge profile runs every gate in a deterministic order', () => {
  const names = profileSteps('merge').map((step) => step.name);
  assert.deepEqual(names, [
    'diff-check',
    'typecheck',
    'lint',
    'build',
    'test:workspace',
    'test:storage',
    'test:mcp-server',
    'test:cli',
    'version',
    'docs:tools',
    'provenance',
  ]);
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.indexOf('build') < names.indexOf('test:mcp-server'), 'build precedes package tests');
});

test('targeted profile is a fast subset with no build or package suite', () => {
  assert.deepEqual(profileSteps('targeted').map((step) => step.name), ['diff-check', 'typecheck', 'lint']);
});

test('profileSteps rejects an unknown profile and returns copies', () => {
  assert.throws(() => profileSteps('release'), RangeError);
  const first = profileSteps('targeted');
  first[0].command.push('--mutation');
  assert.deepEqual(profileSteps('targeted')[0].command, ['git', 'diff', '--check']);
});

test('parseArgs defaults to the merge profile and accepts explicit options', () => {
  assert.deepEqual(parseArgs([]), { profile: 'merge', json: false, allowDirty: false, prNumber: undefined });
  assert.deepEqual(parseArgs(['--profile', 'targeted', '--json', '--allow-dirty', '--pr', '533']), {
    profile: 'targeted',
    json: true,
    allowDirty: true,
    prNumber: 533,
  });
});

test('parseArgs rejects unknown flags, bad profiles and bad PR numbers', () => {
  assert.throws(() => parseArgs(['--watch']), /unknown argument/);
  assert.throws(() => parseArgs(['--profile', 'release']), /--profile/);
  assert.throws(() => parseArgs(['--pr', '0']), /--pr/);
  assert.throws(() => parseArgs(['--pr', 'abc']), /--pr/);
});

test('mergeReadiness requires the merge profile, a clean tree and every step passed', () => {
  const passed = [STEP('diff-check'), STEP('test:cli')];
  assert.equal(mergeReadiness({ profile: 'merge', dirty: false, steps: passed }), true);
  assert.equal(mergeReadiness({ profile: 'merge', dirty: true, steps: passed }), false);
  assert.equal(mergeReadiness({ profile: 'targeted', dirty: false, steps: passed }), false);
  assert.equal(mergeReadiness({ profile: 'merge', dirty: false, steps: [STEP('diff-check'), STEP('lint', 'failed')] }), false);
  assert.equal(mergeReadiness({ profile: 'merge', dirty: false, steps: [STEP('diff-check'), STEP('lint', 'skipped')] }), false);
  assert.equal(mergeReadiness({ profile: 'merge', dirty: false, steps: [] }), false);
});

test('buildReceipt records the exact head, fingerprint and verdict', () => {
  const receipt = buildReceipt({
    verificationId: 'verification-1',
    profile: 'merge',
    workspacePath: '/repo',
    headSha: 'a'.repeat(40),
    branch: 'feat/x',
    dirty: false,
    diffFingerprint: 'sha256:abc',
    toolchain: { node: 'v22.0.0', pnpm: '10.15.0' },
    startedAt: '2026-10-30T06:00:00.000Z',
    completedAt: '2026-10-30T06:10:00.000Z',
    steps: [STEP('diff-check'), STEP('test:cli')],
  });

  assert.equal(receipt.profileVersion, PROFILE_VERSION);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.mergeReady, true);
  assert.equal(receipt.headSha, 'a'.repeat(40));
  assert.equal('prNumber' in receipt, false, 'omitted when not supplied');

  const withPr = buildReceipt({
    verificationId: 'verification-2',
    profile: 'merge',
    workspacePath: '/repo',
    headSha: 'b'.repeat(40),
    branch: 'feat/x',
    dirty: true,
    diffFingerprint: 'sha256:def',
    toolchain: { node: 'v22.0.0', pnpm: '10.15.0' },
    startedAt: '2026-10-30T06:00:00.000Z',
    completedAt: '2026-10-30T06:10:00.000Z',
    prNumber: 533,
    steps: [STEP('diff-check')],
  });
  assert.equal(withPr.prNumber, 533);
  assert.equal(withPr.mergeReady, false, 'a dirty tree is never merge evidence');
});

test('a failed step makes the receipt not ok', () => {
  const receipt = buildReceipt({
    verificationId: 'verification-3',
    profile: 'merge',
    workspacePath: '/repo',
    headSha: 'c'.repeat(40),
    branch: 'feat/x',
    dirty: false,
    diffFingerprint: 'sha256:ghi',
    toolchain: { node: 'v22.0.0', pnpm: '10.15.0' },
    startedAt: '2026-10-30T06:00:00.000Z',
    completedAt: '2026-10-30T06:10:00.000Z',
    steps: [STEP('diff-check'), STEP('lint', 'failed')],
  });
  assert.equal(receipt.ok, false);
  assert.equal(receipt.mergeReady, false);
});

test('diffFingerprint changes with the head, the dirty set and the diff', () => {
  const base = { headSha: 'a'.repeat(40), status: '', diff: '' };
  assert.equal(diffFingerprint(base), diffFingerprint({ ...base }));
  assert.notEqual(diffFingerprint(base), diffFingerprint({ ...base, headSha: 'b'.repeat(40) }));
  assert.notEqual(diffFingerprint(base), diffFingerprint({ ...base, status: ' M src/a.ts' }));
  assert.notEqual(diffFingerprint(base), diffFingerprint({ ...base, diff: '+line' }));
  assert.match(diffFingerprint(base), /^sha256:[a-f0-9]{64}$/);
});

test('truncateLog keeps the tail where failures are printed', () => {
  const short = truncateLog('hello', 32);
  assert.deepEqual(short, { text: 'hello', truncated: false });

  const long = truncateLog(`${'a'.repeat(100)}TAIL`, 20);
  assert.equal(long.truncated, true);
  assert.ok(long.text.endsWith('TAIL'));
  assert.ok(long.text.startsWith('[truncated'));
});

test('summarize states merge readiness and explains the common false cases', () => {
  const steps = [STEP('diff-check')];
  const receipt = buildReceipt({
    verificationId: 'verification-4',
    profile: 'merge',
    workspacePath: '/repo',
    headSha: 'd'.repeat(40),
    branch: 'main',
    dirty: false,
    diffFingerprint: 'sha256:jkl',
    toolchain: { node: 'v22.0.0', pnpm: '10.15.0' },
    startedAt: '2026-10-30T06:00:00.000Z',
    completedAt: '2026-10-30T06:10:00.000Z',
    steps,
  });

  assert.match(summarize(receipt, 'receipt.json'), /merge-ready: yes/);
  assert.match(summarize(receipt, 'receipt.json'), /receipt: receipt\.json/);
  assert.match(
    summarize({ ...receipt, mergeReady: false, dirty: true }, 'receipt.json'),
    /merge-ready: no \(dirty worktree\)/,
  );
  assert.match(
    summarize({ ...receipt, mergeReady: false, profile: 'targeted' }, 'receipt.json'),
    /merge-ready: no \(targeted profile\)/,
  );
});
