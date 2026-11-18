import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WORKFLOW_FINGERPRINT,
  WORKFLOW_GATES,
  WORKFLOW_ID,
  WORKFLOW_PHASES,
  WORKFLOW_VERSION,
  workflowStamp,
  workflowStampBlockers,
} from './workflow-definition.mjs';

/**
 * Append-only, keyed by `WORKFLOW_VERSION`. A phase or gate edit without a new
 * version changes the fingerprint and fails here; a new version without a new
 * row fails too, so the definition cannot drift away from its recorded digest.
 */
const RECORDED_FINGERPRINTS = new Map([
  [1, 'sha256:1adec0b0b23c526492474a9911aec9494d2e2cc26014c4429412f91d5df508b5'],
]);

test('the workflow identity and its phase/gate tables are stable and frozen', () => {
  assert.equal(WORKFLOW_ID, 'unified-mpc.workflow-gate');
  assert.equal(WORKFLOW_VERSION, 1);
  assert.deepEqual(WORKFLOW_PHASES, [
    'intake', 'discover', 'prepare', 'mutate', 'verify', 'review', 'integrate', 'close',
  ]);
  assert.deepEqual(WORKFLOW_GATES, {
    mutate: 'mutation_preparation',
    verify: 'verification_evidence',
    review: 'exact_head_review',
    integrate: 'merge_evidence',
    close: 'retention_clear',
  });
  assert.equal(Object.isFrozen(WORKFLOW_PHASES), true);
  assert.equal(Object.isFrozen(WORKFLOW_GATES), true);
});

test('the definition fingerprint is recorded per version and is append-only', () => {
  assert.match(WORKFLOW_FINGERPRINT, /^sha256:[0-9a-f]{64}$/);
  assert.equal(WORKFLOW_FINGERPRINT, RECORDED_FINGERPRINTS.get(WORKFLOW_VERSION));
});

test('a stamp names the definition, phase and gate that decided', () => {
  assert.deepEqual(workflowStamp('review'), {
    id: WORKFLOW_ID,
    version: WORKFLOW_VERSION,
    phase: 'review',
    gate: 'exact_head_review',
    definitionFingerprint: WORKFLOW_FINGERPRINT,
  });
  assert.throws(() => workflowStamp('deploy'), /unknown workflow phase/);
});

test('a valid stamp has no blockers', () => {
  assert.deepEqual(workflowStampBlockers(workflowStamp('verify')), []);
  assert.deepEqual(workflowStampBlockers(workflowStamp('verify'), 'verify'), []);
});

test('a receipt that names no definition is refused with the remedy', () => {
  // This PR invalidates every receipt already on disk, so the refusal has to say
  // what writes a new one instead of only naming the absence.
  const [missing] = workflowStampBlockers(undefined);
  assert.match(missing, /^receipt names no workflow definition; rerun `corepack pnpm@10\.15\.0 verify:local`/);
  const [malformed] = workflowStampBlockers(null);
  assert.match(malformed, /^workflow block must be an object; rerun `corepack pnpm@10\.15\.0 verify:local`/);
});

test('each wrong field is named as its own refusal', () => {
  const stamp = workflowStamp('verify');

  assert.match(
    workflowStampBlockers({ ...stamp, id: 'other.workflow' }).join('\n'),
    /names definition 'other\.workflow', expected 'unified-mpc\.workflow-gate'/,
  );
  assert.match(
    workflowStampBlockers({ ...stamp, version: WORKFLOW_VERSION - 1 }).join('\n'),
    new RegExp(`used version ${WORKFLOW_VERSION - 1}, current is ${WORKFLOW_VERSION}`),
  );
  assert.match(
    workflowStampBlockers({ ...stamp, phase: 'deploy' }).join('\n'),
    /names unknown phase 'deploy'/,
  );
  assert.match(
    workflowStampBlockers({ ...stamp, gate: 'merge_evidence' }).join('\n'),
    /gate 'merge_evidence' is not 'verification_evidence' for phase 'verify'/,
  );
  assert.match(
    workflowStampBlockers({ ...stamp, definitionFingerprint: 'sha256:' + '0'.repeat(64) }).join('\n'),
    /different definition fingerprint/,
  );
  assert.match(
    workflowStampBlockers(workflowStamp('review'), 'verify').join('\n'),
    /names phase 'review', expected 'verify'/,
  );
});
