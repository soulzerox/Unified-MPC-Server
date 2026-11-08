import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { discoverPackages } from './check-workspace-dependencies.mjs';
import {
  PROFILE_VERSION,
  assertProfileStepSet,
  buildReceipt,
  diffFingerprint,
  gatedTestSuites,
  mergeReadiness,
  parseArgs,
  profileStepSetVerdict,
  profileSteps,
  stepSetDigest,
  summarize,
  truncateLog,
} from './local-verify.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Repository gate tests normally run inside the merge profile's `test:merge-gate`
 * step. This one is intentionally standalone: it rebuilds the CLI and starts the
 * web control plane, so it is minutes long and needs built `dist` output the
 * merge gate does not have at that point.
 */
const STANDALONE_SCRIPT_TESTS = new Set(['gateway-persistence-restart.test.mjs']);

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
    'test:merge-gate',
    'build',
    'test:audit',
    'test:domain',
    'test:ipc-contracts',
    'test:shared',
    'test:cf-gateway',
    'test:permissions',
    'test:process',
    'test:project',
    'test:workspace',
    'test:capabilities',
    'test:codex',
    'test:filesystem',
    'test:git',
    'test:search',
    'test:storage',
    'test:thai-rag',
    'test:application',
    'test:extensions',
    'test:mcp-server',
    'test:web',
    'test:cli',
    'version',
    'docs:tools',
    'provenance',
  ]);
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.indexOf('build') < names.indexOf('test:mcp-server'), 'build precedes package tests');
});

test('the profile version names the exact merge step set', () => {
  const stepNames = profileSteps('merge').map((step) => step.name);
  const verdict = profileStepSetVerdict({ version: PROFILE_VERSION, stepNames });

  assert.equal(verdict.ok, true, verdict.reason);
  assert.equal(verdict.digest, stepSetDigest(stepNames));
  assert.doesNotThrow(() => assertProfileStepSet());
});

test('a changed step set cannot reuse the recorded profile version', () => {
  const stepNames = profileSteps('merge').map((step) => step.name);

  const added = [...stepNames, 'test:new-package'];
  const addedVerdict = profileStepSetVerdict({ version: PROFILE_VERSION, stepNames: added });
  assert.equal(addedVerdict.ok, false, 'a new step must force a version bump');
  assert.match(addedVerdict.reason, new RegExp(`version ${PROFILE_VERSION}`));
  assert.notEqual(addedVerdict.digest, stepSetDigest(stepNames), 'a new step changes the digest');
  assert.throws(
    () => assertProfileStepSet({ version: PROFILE_VERSION, stepNames: added }),
    /Bump PROFILE_VERSION/,
  );

  const reordered = [...stepNames].reverse();
  assert.equal(
    profileStepSetVerdict({ version: PROFILE_VERSION, stepNames: reordered }).ok,
    false,
    'step order is part of the recorded set',
  );

  const removed = stepNames.slice(1);
  assert.equal(
    profileStepSetVerdict({ version: PROFILE_VERSION, stepNames: removed }).ok,
    false,
    'a removed step must force a version bump',
  );
});

test('a profile version with no recorded step set is refused', () => {
  const stepNames = profileSteps('merge').map((step) => step.name);
  const unrecorded = PROFILE_VERSION + 1;
  const verdict = profileStepSetVerdict({ version: unrecorded, stepNames });

  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /no recorded step set/);
  assert.throws(() => assertProfileStepSet({ version: unrecorded, stepNames }), /Bump PROFILE_VERSION/);
  assert.equal(
    profileStepSetVerdict({ version: PROFILE_VERSION, stepNames }).ok,
    true,
    'the recorded version keeps passing for its own set',
  );
});

test('every workspace project with a test script runs in the merge profile', () => {
  const projects = discoverPackages(ROOT);
  const withTests = [...projects]
    .filter(([, workspacePackage]) => typeof workspacePackage.manifest.scripts?.test === 'string')
    .map(([packageName]) => packageName)
    .sort();
  const gated = gatedTestSuites();

  assert.deepEqual(
    withTests.filter((packageName) => !gated.has(packageName)),
    [],
    'a workspace project with a test script must be added to STEP_DEFINITIONS',
  );
  assert.deepEqual(
    [...gated].filter((packageName) => !withTests.includes(packageName)).sort(),
    [],
    'STEP_DEFINITIONS runs a test script for a project that no longer defines one',
  );
});

test('every repository gate test runs in the merge-gate step unless declared standalone', () => {
  const mergeGate = profileSteps('merge').find((step) => step.name === 'test:merge-gate');
  assert.ok(mergeGate, 'the merge profile defines the merge-gate step');
  const listed = new Set(
    mergeGate.command
      .filter((argument) => argument.startsWith('scripts/') && argument.endsWith('.test.mjs'))
      .map((argument) => path.basename(argument)),
  );
  const onDisk = new Set(readdirSync(path.join(ROOT, 'scripts')).filter((name) => name.endsWith('.test.mjs')));

  assert.deepEqual(
    [...onDisk].filter((name) => !listed.has(name) && !STANDALONE_SCRIPT_TESTS.has(name)).sort(),
    [],
    'a scripts/*.test.mjs gate test must be listed in the test:merge-gate step or declared standalone',
  );
  assert.deepEqual(
    [...new Set([...listed, ...STANDALONE_SCRIPT_TESTS])].filter((name) => !onDisk.has(name)).sort(),
    [],
    'the merge-gate step or the standalone list names a test file that does not exist',
  );
});

test('every gated suite runs after the workspace packages it depends on', () => {
  const projects = discoverPackages(ROOT);
  const positions = new Map();
  for (const [index, step] of profileSteps('merge').entries()) {
    const filterIndex = step.command.indexOf('--filter');
    if (filterIndex === -1 || step.command.at(-1) !== 'test') continue;
    positions.set(step.command[filterIndex + 1], index);
  }

  const violations = [];
  for (const [packageName, position] of positions) {
    const manifest = projects.get(packageName)?.manifest ?? {};
    const workspaceDependencies = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ].filter((dependency) => projects.has(dependency));
    for (const dependency of workspaceDependencies) {
      const dependencyPosition = positions.get(dependency);
      // A dependency without a suite is covered by the workspace `build` step.
      if (dependencyPosition === undefined) continue;
      if (dependencyPosition >= position) {
        violations.push(`${packageName} is gated before its dependency ${dependency}`);
      }
    }
  }

  assert.deepEqual(violations, [], 'a suite must run after the suites of the packages it depends on');
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
