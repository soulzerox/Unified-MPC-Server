/* global process */
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  applyEvidencePlan,
  evidencePlanBlocker,
  planEvidencePrune,
  planLocalVerifyEvidence,
  planReviewEvidence,
  planReviewEvidencePrune,
  pruneLocalVerifyEvidence,
  pruneReviewEvidence,
  resolveProtectedHeads,
} from './prune-evidence.mjs';

const execFileAsync = promisify(execFile);

const UUID_1 = '11111111-1111-4111-8111-111111111111';
const UUID_2 = '22222222-2222-4222-8222-222222222222';
const UUID_3 = '33333333-3333-4333-8333-333333333333';
const UUID_4 = '44444444-4444-4444-8444-444444444444';

function receipt(fileName, headSha, verificationId, completedAt) {
  return { fileName, headSha, verificationId, completedAt };
}

test('keeps a receipt for the current head even when it is the oldest run', () => {
  const plan = planEvidencePrune({
    receipts: [
      receipt(`aaaaaaaaaaaa-${UUID_1}.json`, 'aaaaaaaaaaaa', UUID_1, '2026-01-01T00:00:00.000Z'),
      receipt(`bbbbbbbbbbbb-${UUID_2}.json`, 'bbbbbbbbbbbb', UUID_2, '2026-02-01T00:00:00.000Z'),
    ],
    mergeVerificationIds: new Set(),
    currentHeadSha: 'aaaaaaaaaaaa',
    keepRecent: 0,
  });

  assert.deepEqual(plan.keep, [{
    fileName: `aaaaaaaaaaaa-${UUID_1}.json`,
    verificationId: UUID_1,
    headSha: 'aaaaaaaaaaaa',
    reason: 'current-head',
  }]);
  assert.deepEqual(plan.remove.map((entry) => entry.fileName), [`bbbbbbbbbbbb-${UUID_2}.json`]);
});

test('keeps a receipt a merge record spent even when it is superseded', () => {
  const plan = planEvidencePrune({
    receipts: [
      receipt(`aaaaaaaaaaaa-${UUID_1}.json`, 'aaaaaaaaaaaa', UUID_1, '2026-01-01T00:00:00.000Z'),
      receipt(`bbbbbbbbbbbb-${UUID_2}.json`, 'bbbbbbbbbbbb', UUID_2, '2026-02-01T00:00:00.000Z'),
    ],
    mergeVerificationIds: new Set([UUID_1]),
    currentHeadSha: 'bbbbbbbbbbbb',
    keepRecent: 0,
  });

  assert.deepEqual(plan.keep.map((entry) => entry.reason), ['merge-record', 'current-head']);
  assert.deepEqual(plan.remove, []);
});

test('keeps the newest runs as a floor even when nothing references them', () => {
  const plan = planEvidencePrune({
    receipts: [
      receipt(`aaaaaaaaaaaa-${UUID_1}.json`, 'aaaaaaaaaaaa', UUID_1, '2026-01-01T00:00:00.000Z'),
      receipt(`bbbbbbbbbbbb-${UUID_2}.json`, 'bbbbbbbbbbbb', UUID_2, '2026-02-01T00:00:00.000Z'),
      receipt(`cccccccccccc-${UUID_3}.json`, 'cccccccccccc', UUID_3, '2026-03-01T00:00:00.000Z'),
    ],
    mergeVerificationIds: new Set(),
    currentHeadSha: 'dddddddddddd',
    keepRecent: 2,
  });

  assert.deepEqual(plan.keep.map((entry) => entry.reason), ['recent', 'recent']);
  assert.deepEqual(plan.keep.map((entry) => entry.fileName), [
    `bbbbbbbbbbbb-${UUID_2}.json`,
    `cccccccccccc-${UUID_3}.json`,
  ]);
  assert.deepEqual(plan.remove.map((entry) => entry.fileName), [`aaaaaaaaaaaa-${UUID_1}.json`]);
});

test('reports nothing to keep when there is no evidence root', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'evidence-prune-missing-'));
  try {
    const result = await pruneLocalVerifyEvidence({ root, headSha: 'aaaaaaaaaaaa' });
    assert.equal(result.status, 'missing');
    assert.deepEqual(result.keep, []);
    assert.deepEqual(result.remove, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('refuses instead of guessing when a merge record is unreadable', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'evidence-prune-bad-merge-'));
  try {
    const receiptRoot = path.join(root, '.unified-mpc', 'local-verify');
    await mkdir(path.join(receiptRoot, 'merges'), { recursive: true });
    await writeFile(path.join(receiptRoot, 'merges', 'broken.json'), '{not json', 'utf8');
    await writeReceipt(receiptRoot, `aaaaaaaaaaaa-${UUID_1}.json`, 'aaaaaaaaaaaa', '2026-01-01T00:00:00.000Z');

    const result = await pruneLocalVerifyEvidence({ root, headSha: 'bbbbbbbbbbbb', dryRun: false });

    assert.equal(result.status, 'refused');
    assert.match(result.reason, /unreadable merge record/);
    assert.deepEqual(result.remove, []);
    assert.equal((await readdir(receiptRoot)).includes(`aaaaaaaaaaaa-${UUID_1}.json`), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('refuses instead of guessing when a receipt is unreadable', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'evidence-prune-bad-receipt-'));
  try {
    const receiptRoot = path.join(root, '.unified-mpc', 'local-verify');
    await mkdir(receiptRoot, { recursive: true });
    await writeFile(path.join(receiptRoot, `aaaaaaaaaaaa-${UUID_1}.json`), '{not json', 'utf8');

    const result = await pruneLocalVerifyEvidence({ root, headSha: 'bbbbbbbbbbbb', dryRun: false });

    assert.equal(result.status, 'refused');
    assert.match(result.reason, /unreadable receipt/);
    assert.equal((await readdir(receiptRoot)).includes(`aaaaaaaaaaaa-${UUID_1}.json`), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a dry run reports the plan and deletes nothing', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'evidence-prune-dry-'));
  try {
    const receiptRoot = path.join(root, '.unified-mpc', 'local-verify');
    await writeReceipt(receiptRoot, `aaaaaaaaaaaa-${UUID_1}.json`, 'aaaaaaaaaaaa', '2026-01-01T00:00:00.000Z');
    await writeReceipt(receiptRoot, `bbbbbbbbbbbb-${UUID_2}.json`, 'bbbbbbbbbbbb', '2026-02-01T00:00:00.000Z');
    await writeFile(path.join(receiptRoot, 'latest.json'), `{"headSha":"bbbbbbbbbbbb","verificationId":"${UUID_2}"}\n`, 'utf8');
    await mkdir(path.join(receiptRoot, 'logs', UUID_1), { recursive: true });
    await writeFile(path.join(receiptRoot, 'logs', UUID_1, 'step.log'), 'log\n', 'utf8');

    const result = await pruneLocalVerifyEvidence({
      root,
      headSha: 'bbbbbbbbbbbb',
      keepRecent: 0,
      dryRun: true,
    });

    assert.equal(result.status, 'pruned');
    assert.equal(result.dryRun, true);
    assert.deepEqual(result.remove.map((entry) => entry.verificationId), [UUID_1]);
    assert.deepEqual((await readdir(receiptRoot)).sort(), [
      `aaaaaaaaaaaa-${UUID_1}.json`,
      `bbbbbbbbbbbb-${UUID_2}.json`,
      'latest.json',
      'logs',
    ]);
    assert.deepEqual(await readdir(path.join(receiptRoot, 'logs')), [UUID_1]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('applying deletes superseded receipts and their log directories only', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'evidence-prune-apply-'));
  try {
    const receiptRoot = path.join(root, '.unified-mpc', 'local-verify');
    await writeReceipt(receiptRoot, `aaaaaaaaaaaa-${UUID_1}.json`, 'aaaaaaaaaaaa', '2026-01-01T00:00:00.000Z');
    await writeReceipt(receiptRoot, `bbbbbbbbbbbb-${UUID_2}.json`, 'bbbbbbbbbbbb', '2026-02-01T00:00:00.000Z');
    await writeReceipt(receiptRoot, `cccccccccccc-${UUID_3}.json`, 'cccccccccccc', '2026-03-01T00:00:00.000Z');
    await writeFile(path.join(receiptRoot, 'latest.json'), `{"headSha":"cccccccccccc","verificationId":"${UUID_3}"}\n`, 'utf8');
    await mkdir(path.join(receiptRoot, 'merges'), { recursive: true });
    await writeFile(
      path.join(receiptRoot, 'merges', 'bbbbbbbbbbbb-1.json'),
      `${JSON.stringify({
        headSha: 'bbbbbbbbbbbb',
        verificationId: UUID_2,
        reviewId: UUID_4,
        state: 'MERGED',
      })}\n`,
      'utf8',
    );
    for (const [id, name] of [[UUID_1, 'one'], [UUID_2, 'two'], [UUID_3, 'three']]) {
      await mkdir(path.join(receiptRoot, 'logs', id), { recursive: true });
      await writeFile(path.join(receiptRoot, 'logs', id, `${name}.log`), 'log\n', 'utf8');
    }

    const result = await pruneLocalVerifyEvidence({
      root,
      headSha: 'cccccccccccc',
      keepRecent: 0,
      dryRun: false,
    });

    assert.equal(result.status, 'pruned');
    assert.equal(result.dryRun, false);
    assert.deepEqual(result.keep.map((entry) => entry.fileName), [
      `bbbbbbbbbbbb-${UUID_2}.json`,
      `cccccccccccc-${UUID_3}.json`,
    ]);
    assert.deepEqual(result.remove.map((entry) => entry.fileName), [`aaaaaaaaaaaa-${UUID_1}.json`]);
    assert.deepEqual((await readdir(receiptRoot)).sort(), [
      `bbbbbbbbbbbb-${UUID_2}.json`,
      `cccccccccccc-${UUID_3}.json`,
      'latest.json',
      'logs',
      'merges',
    ]);
    assert.deepEqual((await readdir(path.join(receiptRoot, 'logs'))).sort(), [UUID_2, UUID_3]);
    assert.deepEqual(await readdir(path.join(receiptRoot, 'merges')), ['bbbbbbbbbbbb-1.json']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('prunes receipts whose log directory was never written', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'evidence-prune-no-logs-'));
  try {
    const receiptRoot = path.join(root, '.unified-mpc', 'local-verify');
    await writeReceipt(receiptRoot, `aaaaaaaaaaaa-${UUID_1}.json`, 'aaaaaaaaaaaa', '2026-01-01T00:00:00.000Z');

    const result = await pruneLocalVerifyEvidence({
      root,
      headSha: 'bbbbbbbbbbbb',
      keepRecent: 0,
      dryRun: false,
    });

    assert.equal(result.status, 'pruned');
    assert.deepEqual(result.remove.map((entry) => entry.verificationId), [UUID_1]);
    assert.deepEqual((await readdir(receiptRoot)).sort(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test('collects an orphan log directory older than every kept run', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'evidence-prune-orphan-'));
  try {
    const receiptRoot = path.join(root, '.unified-mpc', 'local-verify');
    await writeReceipt(receiptRoot, `aaaaaaaaaaaa-${UUID_1}.json`, 'aaaaaaaaaaaa', '2026-01-01T00:00:00.000Z');
    const orphan = path.join(receiptRoot, 'logs', UUID_2);
    await mkdir(orphan, { recursive: true });
    await writeFile(path.join(orphan, 'step.log'), 'log\n', 'utf8');
    await utimes(orphan, new Date('2025-12-01T00:00:00.000Z'), new Date('2025-12-01T00:00:00.000Z'));
    await writeFile(path.join(receiptRoot, 'logs', 'notes.txt'), 'keep\n', 'utf8');

    const result = await pruneLocalVerifyEvidence({ root, headSha: 'bbbbbbbbbbbb', keepRecent: 5, dryRun: false });

    assert.equal(result.status, 'pruned');
    assert.deepEqual(result.remove, [{ kind: 'log', verificationId: UUID_2, reason: 'orphan-log' }]);
    assert.deepEqual(await readdir(path.join(receiptRoot, 'logs')), ['notes.txt']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('keeps a log directory younger than the newest kept run', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'evidence-prune-orphan-fresh-'));
  try {
    const receiptRoot = path.join(root, '.unified-mpc', 'local-verify');
    await writeReceipt(receiptRoot, `aaaaaaaaaaaa-${UUID_1}.json`, 'aaaaaaaaaaaa', '2026-01-01T00:00:00.000Z');
    await mkdir(path.join(receiptRoot, 'logs', UUID_2), { recursive: true });

    const result = await pruneLocalVerifyEvidence({ root, headSha: 'bbbbbbbbbbbb', keepRecent: 5, dryRun: false });

    assert.equal(result.status, 'pruned');
    assert.deepEqual(result.remove, []);
    assert.deepEqual(await readdir(path.join(receiptRoot, 'logs')), [UUID_2]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('keeps an orphan log with a fresh heartbeat even when the directory is old', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'evidence-prune-orphan-live-'));
  try {
    const receiptRoot = path.join(root, '.unified-mpc', 'local-verify');
    await writeReceipt(receiptRoot, `aaaaaaaaaaaa-${UUID_1}.json`, 'aaaaaaaaaaaa', '2026-01-01T00:00:00.000Z');
    const orphan = path.join(receiptRoot, 'logs', UUID_2);
    await mkdir(orphan, { recursive: true });
    await writeFile(path.join(orphan, 'active.json'), '{"pid":1}\n', 'utf8');
    await utimes(orphan, new Date('2025-12-01T00:00:00.000Z'), new Date('2025-12-01T00:00:00.000Z'));

    const result = await pruneLocalVerifyEvidence({ root, headSha: 'bbbbbbbbbbbb', keepRecent: 5, dryRun: false });

    assert.equal(result.status, 'pruned');
    assert.deepEqual(result.remove, []);
    assert.deepEqual(await readdir(path.join(receiptRoot, 'logs')), [UUID_2]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('collects an orphan log whose heartbeat stopped and whose process is gone', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'evidence-prune-orphan-stopped-'));
  try {
    const receiptRoot = path.join(root, '.unified-mpc', 'local-verify');
    await writeReceipt(receiptRoot, `aaaaaaaaaaaa-${UUID_1}.json`, 'aaaaaaaaaaaa', '2026-01-01T00:00:00.000Z');
    const orphan = path.join(receiptRoot, 'logs', UUID_2);
    await mkdir(orphan, { recursive: true });
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    const marker = path.join(orphan, 'active.json');
    await writeFile(marker, `${JSON.stringify({ pid: dead })}\n`, 'utf8');
    await utimes(marker, new Date('2025-12-01T00:00:00.000Z'), new Date('2025-12-01T00:00:00.000Z'));
    await utimes(orphan, new Date('2025-12-01T00:00:00.000Z'), new Date('2025-12-01T00:00:00.000Z'));

    const result = await pruneLocalVerifyEvidence({ root, headSha: 'bbbbbbbbbbbb', keepRecent: 5, dryRun: false });

    assert.equal(result.status, 'pruned');
    assert.deepEqual(result.remove, [{ kind: 'log', verificationId: UUID_2, reason: 'orphan-log' }]);
    assert.deepEqual(await readdir(path.join(receiptRoot, 'logs')), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('keeps a stale heartbeat whose recorded process is still alive', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'evidence-prune-orphan-live-pid-'));
  try {
    const receiptRoot = path.join(root, '.unified-mpc', 'local-verify');
    await writeReceipt(receiptRoot, `aaaaaaaaaaaa-${UUID_1}.json`, 'aaaaaaaaaaaa', '2026-01-01T00:00:00.000Z');
    const orphan = path.join(receiptRoot, 'logs', UUID_2);
    await mkdir(orphan, { recursive: true });
    const marker = path.join(orphan, 'active.json');
    await writeFile(marker, `${JSON.stringify({ pid: 1 })}\n`, 'utf8');
    await utimes(marker, new Date('2025-12-01T00:00:00.000Z'), new Date('2025-12-01T00:00:00.000Z'));
    await utimes(orphan, new Date('2025-12-01T00:00:00.000Z'), new Date('2025-12-01T00:00:00.000Z'));

    const result = await pruneLocalVerifyEvidence({ root, headSha: 'bbbbbbbbbbbb', keepRecent: 5, dryRun: false });

    assert.equal(result.status, 'pruned');
    assert.deepEqual(result.remove, []);
    assert.deepEqual(await readdir(path.join(receiptRoot, 'logs')), [UUID_2]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('keeps a stale heartbeat it cannot read', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'evidence-prune-orphan-unreadable-'));
  try {
    const receiptRoot = path.join(root, '.unified-mpc', 'local-verify');
    await writeReceipt(receiptRoot, `aaaaaaaaaaaa-${UUID_1}.json`, 'aaaaaaaaaaaa', '2026-01-01T00:00:00.000Z');
    const orphan = path.join(receiptRoot, 'logs', UUID_2);
    await mkdir(orphan, { recursive: true });
    const marker = path.join(orphan, 'active.json');
    await writeFile(marker, '', 'utf8');
    await utimes(marker, new Date('2025-12-01T00:00:00.000Z'), new Date('2025-12-01T00:00:00.000Z'));
    await utimes(orphan, new Date('2025-12-01T00:00:00.000Z'), new Date('2025-12-01T00:00:00.000Z'));

    const result = await pruneLocalVerifyEvidence({ root, headSha: 'bbbbbbbbbbbb', keepRecent: 5, dryRun: false });

    assert.equal(result.status, 'pruned');
    assert.deepEqual(result.remove, []);
    assert.deepEqual(await readdir(path.join(receiptRoot, 'logs')), [UUID_2]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('keeps an orphan log whose heartbeat marker is not a plain file', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'evidence-prune-orphan-odd-marker-'));
  try {
    const receiptRoot = path.join(root, '.unified-mpc', 'local-verify');
    await writeReceipt(receiptRoot, `aaaaaaaaaaaa-${UUID_1}.json`, 'aaaaaaaaaaaa', '2026-01-01T00:00:00.000Z');
    const orphan = path.join(receiptRoot, 'logs', UUID_2);
    await mkdir(path.join(orphan, 'active.json'), { recursive: true });
    await utimes(orphan, new Date('2025-12-01T00:00:00.000Z'), new Date('2025-12-01T00:00:00.000Z'));

    const result = await pruneLocalVerifyEvidence({ root, headSha: 'bbbbbbbbbbbb', keepRecent: 5, dryRun: false });

    assert.equal(result.status, 'pruned');
    assert.deepEqual(result.remove, []);
    assert.deepEqual(await readdir(path.join(receiptRoot, 'logs')), [UUID_2]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('collects no orphan log when no run is kept to prove it is not in flight', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'evidence-prune-orphan-nocutoff-'));
  try {
    const receiptRoot = path.join(root, '.unified-mpc', 'local-verify');
    const orphan = path.join(receiptRoot, 'logs', UUID_2);
    await mkdir(orphan, { recursive: true });
    await utimes(orphan, new Date('2025-12-01T00:00:00.000Z'), new Date('2025-12-01T00:00:00.000Z'));

    const result = await pruneLocalVerifyEvidence({ root, headSha: 'bbbbbbbbbbbb', keepRecent: 5, dryRun: false });

    assert.equal(result.status, 'pruned');
    assert.deepEqual(result.remove, []);
    assert.deepEqual(await readdir(path.join(receiptRoot, 'logs')), [UUID_2]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('keeps an orphan log whose id a merge record names', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'evidence-prune-orphan-merge-'));
  try {
    const receiptRoot = path.join(root, '.unified-mpc', 'local-verify');
    await writeReceipt(receiptRoot, `aaaaaaaaaaaa-${UUID_1}.json`, 'aaaaaaaaaaaa', '2026-01-01T00:00:00.000Z');
    await writeFile(
      path.join(receiptRoot, 'latest.json'),
      `{"headSha":"aaaaaaaaaaaa","verificationId":"${UUID_1}"}\n`,
      'utf8',
    );
    await mkdir(path.join(receiptRoot, 'merges'), { recursive: true });
    await writeFile(
      path.join(receiptRoot, 'merges', 'cccccccccccc-9.json'),
      `${JSON.stringify({ headSha: 'cccccccccccc', verificationId: UUID_2, state: 'MERGED' })}\n`,
      'utf8',
    );
    const orphan = path.join(receiptRoot, 'logs', UUID_2);
    await mkdir(orphan, { recursive: true });
    await utimes(orphan, new Date('2025-12-01T00:00:00.000Z'), new Date('2025-12-01T00:00:00.000Z'));

    const result = await pruneLocalVerifyEvidence({ root, headSha: 'bbbbbbbbbbbb', keepRecent: 5, dryRun: false });

    assert.equal(result.status, 'pruned');
    assert.deepEqual(result.remove, []);
    assert.deepEqual(await readdir(path.join(receiptRoot, 'logs')), [UUID_2]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('keeps an orphan log the latest pointer still names', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'evidence-prune-orphan-latest-'));
  try {
    const receiptRoot = path.join(root, '.unified-mpc', 'local-verify');
    await writeReceipt(receiptRoot, `aaaaaaaaaaaa-${UUID_1}.json`, 'aaaaaaaaaaaa', '2026-01-01T00:00:00.000Z');
    await writeFile(
      path.join(receiptRoot, 'latest.json'),
      `{"headSha":"cccccccccccc","verificationId":"${UUID_2}"}\n`,
      'utf8',
    );
    const orphan = path.join(receiptRoot, 'logs', UUID_2);
    await mkdir(orphan, { recursive: true });
    await utimes(orphan, new Date('2025-12-01T00:00:00.000Z'), new Date('2025-12-01T00:00:00.000Z'));

    const result = await pruneLocalVerifyEvidence({ root, headSha: 'bbbbbbbbbbbb', keepRecent: 5, dryRun: false });

    assert.equal(result.status, 'pruned');
    assert.deepEqual(result.remove, []);
    assert.deepEqual(await readdir(path.join(receiptRoot, 'logs')), [UUID_2]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('keeps a receipt whose head is still a branch tip', () => {
  const plan = planEvidencePrune({
    receipts: [
      receipt(`aaaaaaaaaaaa-${UUID_1}.json`, 'aaaaaaaaaaaa', UUID_1, '2026-01-01T00:00:00.000Z'),
      receipt(`bbbbbbbbbbbb-${UUID_2}.json`, 'bbbbbbbbbbbb', UUID_2, '2026-02-01T00:00:00.000Z'),
    ],
    mergeVerificationIds: new Set(),
    protectedHeadShas: new Set(['aaaaaaaaaaaa']),
    currentHeadSha: 'bbbbbbbbbbbb',
    keepRecent: 0,
  });

  assert.deepEqual(plan.keep.map((entry) => entry.reason), ['branch-tip', 'current-head']);
  assert.deepEqual(plan.remove, []);
});

test('applying keeps a verified head that is still a branch tip', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'evidence-prune-branch-tip-'));
  try {
    const receiptRoot = path.join(root, '.unified-mpc', 'local-verify');
    await writeReceipt(receiptRoot, `aaaaaaaaaaaa-${UUID_1}.json`, 'aaaaaaaaaaaa', '2026-01-01T00:00:00.000Z');
    await writeReceipt(receiptRoot, `bbbbbbbbbbbb-${UUID_2}.json`, 'bbbbbbbbbbbb', '2026-02-01T00:00:00.000Z');

    const result = await pruneLocalVerifyEvidence({
      root,
      headSha: 'cccccccccccc',
      protectedHeadShas: new Set(['aaaaaaaaaaaa']),
      keepRecent: 0,
      dryRun: false,
    });

    assert.equal(result.status, 'pruned');
    assert.deepEqual(result.keep.map((entry) => entry.fileName), [`aaaaaaaaaaaa-${UUID_1}.json`]);
    assert.deepEqual(result.remove.map((entry) => entry.fileName), [`bbbbbbbbbbbb-${UUID_2}.json`]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolveProtectedHeads returns every branch and tag tip', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'evidence-prune-refs-'));
  try {
    const git = (...args) => execFileAsync('git', ['-C', root, ...args]);
    const identity = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false'];
    await git('init', '-q', '-b', 'main');
    await writeFile(path.join(root, 'a.txt'), 'a\n', 'utf8');
    await git('add', 'a.txt');
    await git(...identity, 'commit', '-q', '-m', 'one');
    const first = (await git('rev-parse', 'HEAD')).stdout.trim();
    await git('tag', 'v1');
    await git('checkout', '-q', '-b', 'feature');
    await writeFile(path.join(root, 'b.txt'), 'b\n', 'utf8');
    await git('add', 'b.txt');
    await git(...identity, 'commit', '-q', '-m', 'two');
    const second = (await git('rev-parse', 'HEAD')).stdout.trim();
    await git('checkout', '-q', 'main');

    const heads = await resolveProtectedHeads(root);

    assert.equal(heads.has(first), true);
    assert.equal(heads.has(second), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolveProtectedHeads includes detached worktree heads', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'evidence-prune-worktree-'));
  const worktree = await mkdtemp(path.join(tmpdir(), 'evidence-prune-worktree-linked-'));
  try {
    const git = (...args) => execFileAsync('git', ['-C', root, ...args]);
    const identity = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false'];
    await git('init', '-q', '-b', 'main');
    await writeFile(path.join(root, 'a.txt'), 'a\n', 'utf8');
    await git('add', 'a.txt');
    await git(...identity, 'commit', '-q', '-m', 'one');
    const first = (await git('rev-parse', 'HEAD')).stdout.trim();
    await git('checkout', '-q', '-b', 'feature');
    await writeFile(path.join(root, 'b.txt'), 'b\n', 'utf8');
    await git('add', 'b.txt');
    await git(...identity, 'commit', '-q', '-m', 'two');
    const second = (await git('rev-parse', 'HEAD')).stdout.trim();
    await git('checkout', '-q', 'main');
    await git('worktree', 'add', '--detach', worktree, second);
    await git('branch', '-f', 'feature', first);

    const heads = await resolveProtectedHeads(root);

    assert.equal(heads.has(first), true);
    assert.equal(heads.has(second), true);
  } finally {
    try {
      await execFileAsync('git', ['-C', root, 'worktree', 'remove', '--force', worktree]);
    } catch {
      await rm(worktree, { recursive: true, force: true });
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('refuses to prune through a symlinked evidence root', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'evidence-prune-symlink-evidence-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'evidence-prune-symlink-evidence-target-'));
  try {
    await mkdir(path.join(root, '.unified-mpc'), { recursive: true });
    await writeReceipt(path.join(outside, 'local-verify'), `aaaaaaaaaaaa-${UUID_1}.json`, 'aaaaaaaaaaaa', '2026-01-01T00:00:00.000Z');
    await symlink(path.join(outside, 'local-verify'), path.join(root, '.unified-mpc', 'local-verify'));

    const result = await pruneLocalVerifyEvidence({ root, headSha: 'bbbbbbbbbbbb', keepRecent: 0, dryRun: false });

    assert.equal(result.status, 'refused');
    assert.match(result.reason, /evidence root is a symlink/);
    assert.equal((await readdir(path.join(outside, 'local-verify'))).includes(`aaaaaaaaaaaa-${UUID_1}.json`), true);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('refuses to prune when the metadata directory is a symlink', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'evidence-prune-symlink-meta-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'evidence-prune-symlink-meta-target-'));
  try {
    await writeReceipt(path.join(outside, 'local-verify'), `aaaaaaaaaaaa-${UUID_1}.json`, 'aaaaaaaaaaaa', '2026-01-01T00:00:00.000Z');
    await symlink(outside, path.join(root, '.unified-mpc'));

    const result = await pruneLocalVerifyEvidence({ root, headSha: 'bbbbbbbbbbbb', keepRecent: 0, dryRun: false });

    assert.equal(result.status, 'refused');
    assert.match(result.reason, /evidence root is a symlink/);
    assert.equal((await readdir(path.join(outside, 'local-verify'))).includes(`aaaaaaaaaaaa-${UUID_1}.json`), true);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('refuses to read merge records through a symlink', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'evidence-prune-symlink-merges-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'evidence-prune-symlink-merges-target-'));
  try {
    const receiptRoot = path.join(root, '.unified-mpc', 'local-verify');
    await writeReceipt(receiptRoot, `aaaaaaaaaaaa-${UUID_1}.json`, 'aaaaaaaaaaaa', '2026-01-01T00:00:00.000Z');
    await symlink(outside, path.join(receiptRoot, 'merges'));

    const result = await pruneLocalVerifyEvidence({ root, headSha: 'bbbbbbbbbbbb', keepRecent: 0, dryRun: false });

    assert.equal(result.status, 'refused');
    assert.match(result.reason, /merge records directory is not a real directory/);
    assert.equal((await readdir(receiptRoot)).includes(`aaaaaaaaaaaa-${UUID_1}.json`), true);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('reads a symlinked merge record instead of skipping it', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'evidence-prune-symlink-record-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'evidence-prune-symlink-record-target-'));
  try {
    const receiptRoot = path.join(root, '.unified-mpc', 'local-verify');
    await writeReceipt(receiptRoot, `aaaaaaaaaaaa-${UUID_1}.json`, 'aaaaaaaaaaaa', '2026-01-01T00:00:00.000Z');
    await mkdir(path.join(receiptRoot, 'merges'), { recursive: true });
    const recordPath = path.join(outside, 'record.json');
    await writeFile(recordPath, `${JSON.stringify({ headSha: 'aaaaaaaaaaaa', verificationId: UUID_1, state: 'MERGED' })}\n`, 'utf8');
    await symlink(recordPath, path.join(receiptRoot, 'merges', 'aaaaaaaaaaaa-1.json'));

    const result = await pruneLocalVerifyEvidence({ root, headSha: 'bbbbbbbbbbbb', keepRecent: 0, dryRun: false });

    assert.equal(result.status, 'pruned');
    assert.deepEqual(result.keep.map((entry) => entry.reason), ['merge-record']);
    assert.deepEqual(result.remove, []);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('refuses when a merge record symlink is broken', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'evidence-prune-broken-record-'));
  try {
    const receiptRoot = path.join(root, '.unified-mpc', 'local-verify');
    await writeReceipt(receiptRoot, `aaaaaaaaaaaa-${UUID_1}.json`, 'aaaaaaaaaaaa', '2026-01-01T00:00:00.000Z');
    await mkdir(path.join(receiptRoot, 'merges'), { recursive: true });
    await symlink(path.join(root, 'gone.json'), path.join(receiptRoot, 'merges', 'gone.json'));

    const result = await pruneLocalVerifyEvidence({ root, headSha: 'bbbbbbbbbbbb', keepRecent: 0, dryRun: false });

    assert.equal(result.status, 'refused');
    assert.match(result.reason, /unreadable merge record/);
    assert.equal((await readdir(receiptRoot)).includes(`aaaaaaaaaaaa-${UUID_1}.json`), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('refuses a dangling evidence-root symlink instead of reporting nothing to prune', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'evidence-prune-dangling-'));
  try {
    await mkdir(path.join(root, '.unified-mpc'), { recursive: true });
    await symlink(path.join(root, '.unified-mpc', 'gone'), path.join(root, '.unified-mpc', 'local-verify'));

    const result = await pruneLocalVerifyEvidence({ root, headSha: 'bbbbbbbbbbbb', keepRecent: 0, dryRun: false });

    assert.equal(result.status, 'refused');
    assert.match(result.reason, /evidence root is a symlink/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('refuses a root that does not exist', async () => {
  const root = path.join(tmpdir(), `evidence-prune-absent-${process.pid}-${Date.now()}`);

  const result = await pruneLocalVerifyEvidence({ root, headSha: 'bbbbbbbbbbbb', keepRecent: 0, dryRun: false });

  assert.equal(result.status, 'refused');
  assert.match(result.reason, /cannot resolve local verification evidence root/);
});

test('refuses a symlinked metadata root even before the evidence root exists', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'evidence-prune-meta-only-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'evidence-prune-meta-only-target-'));
  try {
    await symlink(outside, path.join(root, '.unified-mpc'));

    const result = await pruneLocalVerifyEvidence({ root, headSha: 'bbbbbbbbbbbb', keepRecent: 0, dryRun: false });

    assert.equal(result.status, 'refused');
    assert.match(result.reason, /metadata root is not a real directory/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('keeps the receipt latest.json points at even when it is superseded', () => {
  const plan = planEvidencePrune({
    receipts: [
      receipt(`aaaaaaaaaaaa-${UUID_1}.json`, 'aaaaaaaaaaaa', UUID_1, '2026-01-01T00:00:00.000Z'),
      receipt(`bbbbbbbbbbbb-${UUID_2}.json`, 'bbbbbbbbbbbb', UUID_2, '2026-02-01T00:00:00.000Z'),
    ],
    mergeVerificationIds: new Set(),
    latestVerificationId: UUID_1,
    currentHeadSha: 'bbbbbbbbbbbb',
    keepRecent: 0,
  });

  assert.deepEqual(plan.keep.map((entry) => entry.reason), ['latest', 'current-head']);
  assert.deepEqual(plan.remove, []);
});

test('applying keeps the latest receipt and its log directory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'evidence-prune-latest-'));
  try {
    const receiptRoot = path.join(root, '.unified-mpc', 'local-verify');
    await writeReceipt(receiptRoot, `aaaaaaaaaaaa-${UUID_1}.json`, 'aaaaaaaaaaaa', '2026-01-01T00:00:00.000Z');
    await writeReceipt(receiptRoot, `bbbbbbbbbbbb-${UUID_2}.json`, 'bbbbbbbbbbbb', '2026-02-01T00:00:00.000Z');
    await writeFile(
      path.join(receiptRoot, 'latest.json'),
      `{"headSha":"aaaaaaaaaaaa","verificationId":"${UUID_1}"}\n`,
      'utf8',
    );
    await mkdir(path.join(receiptRoot, 'logs', UUID_1), { recursive: true });
    await writeFile(path.join(receiptRoot, 'logs', UUID_1, 'step.log'), 'log\n', 'utf8');

    const result = await pruneLocalVerifyEvidence({
      root,
      headSha: 'bbbbbbbbbbbb',
      keepRecent: 0,
      dryRun: false,
    });

    assert.equal(result.status, 'pruned');
    assert.deepEqual(result.keep.map((entry) => entry.reason).sort(), ['current-head', 'latest']);
    assert.deepEqual(result.remove, []);
    assert.deepEqual(await readdir(path.join(receiptRoot, 'logs')), [UUID_1]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('refuses when latest.json is unreadable', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'evidence-prune-bad-latest-'));
  try {
    const receiptRoot = path.join(root, '.unified-mpc', 'local-verify');
    await writeReceipt(receiptRoot, `aaaaaaaaaaaa-${UUID_1}.json`, 'aaaaaaaaaaaa', '2026-01-01T00:00:00.000Z');
    await writeFile(path.join(receiptRoot, 'latest.json'), '{not json', 'utf8');

    const result = await pruneLocalVerifyEvidence({ root, headSha: 'bbbbbbbbbbbb', dryRun: false });

    assert.equal(result.status, 'refused');
    assert.match(result.reason, /latest receipt pointer/);
    assert.equal((await readdir(receiptRoot)).includes(`aaaaaaaaaaaa-${UUID_1}.json`), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('refuses to delete through a symlinked logs root', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'evidence-prune-symlink-root-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'evidence-prune-outside-'));
  try {
    const receiptRoot = path.join(root, '.unified-mpc', 'local-verify');
    await writeReceipt(receiptRoot, `aaaaaaaaaaaa-${UUID_1}.json`, 'aaaaaaaaaaaa', '2026-01-01T00:00:00.000Z');
    await mkdir(path.join(outside, UUID_1), { recursive: true });
    await writeFile(path.join(outside, UUID_1, 'keep.log'), 'keep\n', 'utf8');
    await symlink(outside, path.join(receiptRoot, 'logs'));

    const result = await pruneLocalVerifyEvidence({ root, headSha: 'bbbbbbbbbbbb', keepRecent: 0, dryRun: false });

    assert.equal(result.status, 'refused');
    assert.match(result.reason, /log root is not a real directory/);
    assert.equal((await readdir(receiptRoot)).includes(`aaaaaaaaaaaa-${UUID_1}.json`), true);
    assert.deepEqual(await readdir(path.join(outside, UUID_1)), ['keep.log']);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('unlinks a symlinked log entry instead of following it', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'evidence-prune-symlink-entry-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'evidence-prune-symlink-target-'));
  try {
    const receiptRoot = path.join(root, '.unified-mpc', 'local-verify');
    await writeReceipt(receiptRoot, `aaaaaaaaaaaa-${UUID_1}.json`, 'aaaaaaaaaaaa', '2026-01-01T00:00:00.000Z');
    await mkdir(path.join(outside, UUID_1), { recursive: true });
    await writeFile(path.join(outside, UUID_1, 'keep.log'), 'keep\n', 'utf8');
    await mkdir(path.join(receiptRoot, 'logs'), { recursive: true });
    await symlink(path.join(outside, UUID_1), path.join(receiptRoot, 'logs', UUID_1));

    const result = await pruneLocalVerifyEvidence({ root, headSha: 'bbbbbbbbbbbb', keepRecent: 0, dryRun: false });

    assert.equal(result.status, 'pruned');
    assert.deepEqual(result.remove.map((entry) => entry.verificationId), [UUID_1]);
    assert.deepEqual(await readdir(path.join(receiptRoot, 'logs')), []);
    assert.deepEqual(await readdir(path.join(outside, UUID_1)), ['keep.log']);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

async function writeReceipt(receiptRoot, fileName, headSha, completedAt) {
  await mkdir(receiptRoot, { recursive: true });
  await writeFile(
    path.join(receiptRoot, fileName),
    `${JSON.stringify({
      verificationId: fileName.slice(13, -5),
      profile: 'merge',
      headSha,
      dirty: false,
      completedAt,
    })}\n`,
    'utf8',
  );
}

const HEAD_OLD = '1'.repeat(40);
const HEAD_CURRENT = '2'.repeat(40);
const HEAD_MERGED = '3'.repeat(40);
const SCRIPT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function reviewKey(headSha, prNumber) {
  return `${headSha}-${String(prNumber)}`;
}

function capsuleEntry(headSha, prNumber, createdAt) {
  const key = reviewKey(headSha, prNumber);
  return { name: `${headSha.slice(0, 12)}-${String(prNumber)}`, key, headSha, prNumber, createdAt };
}

function receiptEntry(headSha, prNumber, createdAt, reviewId) {
  const key = reviewKey(headSha, prNumber);
  return { name: `${headSha.slice(0, 12)}-${String(prNumber)}.json`, key, headSha, prNumber, reviewId, createdAt };
}

test('review plan keeps the current head pair and drops a superseded one', () => {
  const plan = planReviewEvidencePrune({
    capsules: [
      capsuleEntry(HEAD_OLD, 1, '2026-01-01T00:00:00.000Z'),
      capsuleEntry(HEAD_CURRENT, 2, '2026-02-01T00:00:00.000Z'),
    ],
    receipts: [
      receiptEntry(HEAD_OLD, 1, '2026-01-01T00:00:00.000Z', UUID_1),
      receiptEntry(HEAD_CURRENT, 2, '2026-02-01T00:00:00.000Z', UUID_2),
    ],
    currentHeadSha: HEAD_CURRENT,
    keepRecent: 0,
  });

  assert.deepEqual(plan.keep.map((entry) => `${entry.kind}:${entry.reason}`), ['capsule:current-head', 'receipt:current-head']);
  assert.deepEqual(plan.remove.map((entry) => `${entry.kind}:${entry.reason}`), ['capsule:superseded', 'receipt:superseded']);
});

test('review plan keeps the capsule behind a review a merge record spent', () => {
  const plan = planReviewEvidencePrune({
    capsules: [capsuleEntry(HEAD_MERGED, 7, '2026-01-01T00:00:00.000Z')],
    receipts: [receiptEntry(HEAD_MERGED, 7, '2026-01-01T00:00:00.000Z', UUID_3)],
    mergeReviewIds: new Set([UUID_3]),
    mergeHeadShas: new Set([HEAD_MERGED]),
    currentHeadSha: HEAD_CURRENT,
    keepRecent: 0,
  });

  assert.deepEqual(plan.keep.map((entry) => entry.reason), ['merge-record', 'merge-record']);
  assert.deepEqual(plan.remove, []);
});

test('review plan keeps the capsule beside a receipt a merge record spent even without a named head', () => {
  const plan = planReviewEvidencePrune({
    capsules: [capsuleEntry(HEAD_MERGED, 7, '2026-01-01T00:00:00.000Z')],
    receipts: [receiptEntry(HEAD_MERGED, 7, '2026-01-01T00:00:00.000Z', UUID_3)],
    mergeReviewIds: new Set([UUID_3]),
    currentHeadSha: HEAD_CURRENT,
    keepRecent: 0,
  });

  assert.deepEqual(plan.keep.map((entry) => entry.reason), ['merge-record', 'merge-record']);
  assert.deepEqual(plan.remove, []);
});

test('review plan keeps a capsule whose head a merge record names', () => {
  const plan = planReviewEvidencePrune({
    capsules: [capsuleEntry(HEAD_MERGED, 7, '2026-01-01T00:00:00.000Z')],
    receipts: [],
    mergeHeadShas: new Set([HEAD_MERGED]),
    currentHeadSha: HEAD_CURRENT,
    keepRecent: 0,
  });

  assert.deepEqual(plan.keep.map((entry) => entry.reason), ['merge-record']);
  assert.deepEqual(plan.remove, []);
});

test('review plan keeps a pair whose head is still a branch tip', () => {
  const plan = planReviewEvidencePrune({
    capsules: [capsuleEntry(HEAD_OLD, 1, '2026-01-01T00:00:00.000Z')],
    receipts: [receiptEntry(HEAD_OLD, 1, '2026-01-01T00:00:00.000Z', UUID_1)],
    protectedHeadShas: new Set([HEAD_OLD]),
    currentHeadSha: HEAD_CURRENT,
    keepRecent: 0,
  });

  assert.deepEqual(plan.keep.map((entry) => entry.reason), ['branch-tip', 'branch-tip']);
  assert.deepEqual(plan.remove, []);
});

test('review plan keeps the newest pair as a floor even when nothing references it', () => {
  const plan = planReviewEvidencePrune({
    capsules: [
      capsuleEntry(HEAD_OLD, 1, '2026-01-01T00:00:00.000Z'),
      capsuleEntry(HEAD_MERGED, 7, '2026-03-01T00:00:00.000Z'),
      capsuleEntry(HEAD_CURRENT, 2, '2026-02-01T00:00:00.000Z'),
    ],
    receipts: [
      receiptEntry(HEAD_OLD, 1, '2026-01-01T00:00:00.000Z', UUID_1),
      receiptEntry(HEAD_MERGED, 7, '2026-03-01T00:00:00.000Z', UUID_2),
      receiptEntry(HEAD_CURRENT, 2, '2026-02-01T00:00:00.000Z', UUID_3),
    ],
    currentHeadSha: '4'.repeat(40),
    keepRecent: 1,
  });

  assert.deepEqual(plan.keep.map((entry) => entry.headSha), [HEAD_MERGED, HEAD_MERGED]);
  assert.deepEqual(plan.remove.map((entry) => entry.headSha), [HEAD_OLD, HEAD_OLD, HEAD_CURRENT, HEAD_CURRENT]);
  assert.deepEqual(plan.keep.map((entry) => entry.reason), ['recent', 'recent']);
});

test('a review dry run reports the plan and deletes nothing', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'review-prune-dry-'));
  try {
    const reviewRoot = path.join(root, '.unified-mpc', 'reviews');
    await writeCapsule(reviewRoot, HEAD_OLD, 1, '2026-01-01T00:00:00.000Z');
    await writeReviewReceipt(reviewRoot, HEAD_OLD, 1, '2026-01-01T00:00:00.000Z', UUID_1);

    const result = await pruneReviewEvidence({ root, headSha: HEAD_CURRENT, keepRecent: 0, dryRun: true });

    assert.equal(result.status, 'pruned');
    assert.equal(result.dryRun, true);
    assert.deepEqual(result.remove.map((entry) => entry.name), [
      `${HEAD_OLD.slice(0, 12)}-1`,
      `${HEAD_OLD.slice(0, 12)}-1.json`,
    ]);
    assert.equal((await readdir(path.join(reviewRoot, 'capsules'))).length, 1);
    assert.equal((await readdir(path.join(reviewRoot, 'receipts'))).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('applying removes a superseded capsule and its receipt together', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'review-prune-apply-'));
  try {
    const reviewRoot = path.join(root, '.unified-mpc', 'reviews');
    await writeCapsule(reviewRoot, HEAD_OLD, 1, '2026-01-01T00:00:00.000Z');
    await writeReviewReceipt(reviewRoot, HEAD_OLD, 1, '2026-01-01T00:00:00.000Z', UUID_1);
    await writeCapsule(reviewRoot, HEAD_CURRENT, 2, '2026-02-01T00:00:00.000Z');
    await writeReviewReceipt(reviewRoot, HEAD_CURRENT, 2, '2026-02-01T00:00:00.000Z', UUID_2);

    const result = await pruneReviewEvidence({ root, headSha: HEAD_CURRENT, keepRecent: 0, dryRun: false });

    assert.equal(result.status, 'pruned');
    assert.deepEqual(result.keep.map((entry) => entry.kind), ['capsule', 'receipt']);
    assert.deepEqual(result.remove.map((entry) => entry.kind), ['capsule', 'receipt']);
    assert.deepEqual(await readdir(path.join(reviewRoot, 'capsules')), [`${HEAD_CURRENT.slice(0, 12)}-2`]);
    assert.deepEqual(await readdir(path.join(reviewRoot, 'receipts')), [`${HEAD_CURRENT.slice(0, 12)}-2.json`]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('applying a plan deletes exactly what it reported, even when the store changes first', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'review-prune-plan-pinned-'));
  try {
    const reviewRoot = path.join(root, '.unified-mpc', 'reviews');
    await writeCapsule(reviewRoot, HEAD_OLD, 1, '2026-01-01T00:00:00.000Z');
    await writeReviewReceipt(reviewRoot, HEAD_OLD, 1, '2026-01-01T00:00:00.000Z', UUID_1);

    const plan = await planReviewEvidence({ root, headSha: HEAD_CURRENT, keepRecent: 0 });
    // Planning again here would refuse on this receipt; applying the plan must not.
    await writeFile(path.join(reviewRoot, 'receipts', 'late.json'), '{not json', 'utf8');

    await applyEvidencePlan(plan);

    assert.deepEqual(await readdir(path.join(reviewRoot, 'capsules')), []);
    assert.deepEqual(await readdir(path.join(reviewRoot, 'receipts')), ['late.json']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('applying a plan refuses a capsule root swapped for a symlink after planning', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'review-prune-root-swap-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'review-prune-root-swap-target-'));
  try {
    const reviewRoot = path.join(root, '.unified-mpc', 'reviews');
    await writeCapsule(reviewRoot, HEAD_OLD, 1, '2026-01-01T00:00:00.000Z');
    const plan = await planReviewEvidence({ root, headSha: HEAD_CURRENT, keepRecent: 0 });

    await writeCapsule(path.join(outside, 'reviews'), HEAD_CURRENT, 2, '2026-02-01T00:00:00.000Z');
    await rm(path.join(reviewRoot, 'capsules'), { recursive: true, force: true });
    await symlink(path.join(outside, 'reviews', 'capsules'), path.join(reviewRoot, 'capsules'));

    assert.match(await evidencePlanBlocker(plan), /became a symlink after planning/);
    await assert.rejects(applyEvidencePlan(plan), /became a symlink after planning/);
    assert.deepEqual(await readdir(path.join(outside, 'reviews', 'capsules')), [`${HEAD_CURRENT.slice(0, 12)}-2`]);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('applying a plan refuses a verification root replaced after planning', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'verification-prune-root-swap-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'verification-prune-root-swap-target-'));
  try {
    const verificationRoot = path.join(root, '.unified-mpc', 'local-verify');
    await writeReceipt(verificationRoot, `aaaaaaaaaaaa-${UUID_1}.json`, 'aaaaaaaaaaaa', '2026-01-01T00:00:00.000Z');
    const plan = await planLocalVerifyEvidence({ root, headSha: 'bbbbbbbbbbbb', keepRecent: 0 });

    await writeReceipt(path.join(outside, 'local-verify'), `aaaaaaaaaaaa-${UUID_1}.json`, 'aaaaaaaaaaaa', '2026-01-01T00:00:00.000Z');
    await rm(verificationRoot, { recursive: true, force: true });
    await symlink(path.join(outside, 'local-verify'), verificationRoot);

    assert.match(await evidencePlanBlocker(plan), /became a symlink after planning/);
    await assert.rejects(applyEvidencePlan(plan), /became a symlink after planning/);
    assert.deepEqual(await readdir(path.join(outside, 'local-verify')), [`aaaaaaaaaaaa-${UUID_1}.json`]);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('applying a plan refuses a logs root that appeared after planning', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'verification-prune-logs-appeared-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'verification-prune-logs-appeared-target-'));
  try {
    const verificationRoot = path.join(root, '.unified-mpc', 'local-verify');
    await writeReceipt(verificationRoot, `aaaaaaaaaaaa-${UUID_1}.json`, 'aaaaaaaaaaaa', '2026-01-01T00:00:00.000Z');
    const plan = await planLocalVerifyEvidence({ root, headSha: 'bbbbbbbbbbbb', keepRecent: 0 });

    await mkdir(path.join(outside, UUID_1), { recursive: true });
    await writeFile(path.join(outside, UUID_1, 'step.log'), 'keep\n', 'utf8');
    await symlink(outside, path.join(verificationRoot, 'logs'));

    assert.match(await evidencePlanBlocker(plan), /logs appeared after planning/);
    await assert.rejects(applyEvidencePlan(plan), /logs appeared after planning/);
    assert.deepEqual(await readdir(path.join(outside, UUID_1)), ['step.log']);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('review prune reports nothing to keep when there is no review store', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'review-prune-missing-'));
  try {
    const result = await pruneReviewEvidence({ root, headSha: HEAD_CURRENT });
    assert.equal(result.status, 'missing');
    assert.deepEqual(result.keep, []);
    assert.deepEqual(result.remove, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('review prune refuses instead of guessing when a review receipt is unreadable', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'review-prune-bad-receipt-'));
  try {
    const reviewRoot = path.join(root, '.unified-mpc', 'reviews');
    await mkdir(path.join(reviewRoot, 'receipts'), { recursive: true });
    await writeCapsule(reviewRoot, HEAD_OLD, 1, '2026-01-01T00:00:00.000Z');
    await writeFile(path.join(reviewRoot, 'receipts', 'anything.json'), '{not json', 'utf8');

    const result = await pruneReviewEvidence({ root, headSha: HEAD_CURRENT, keepRecent: 0, dryRun: false });

    assert.equal(result.status, 'refused');
    assert.match(result.reason, /unreadable review receipt/);
    assert.deepEqual(result.remove, []);
    assert.equal((await readdir(path.join(reviewRoot, 'capsules'))).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('review prune refuses instead of guessing when a capsule manifest is unreadable', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'review-prune-bad-capsule-'));
  try {
    const reviewRoot = path.join(root, '.unified-mpc', 'reviews');
    const capsuleRoot = path.join(reviewRoot, 'capsules');
    await mkdir(path.join(capsuleRoot, 'broken-1'), { recursive: true });
    await writeFile(path.join(capsuleRoot, 'broken-1', 'capsule.json'), '{not json', 'utf8');

    const result = await pruneReviewEvidence({ root, headSha: HEAD_CURRENT, keepRecent: 0, dryRun: false });

    assert.equal(result.status, 'refused');
    assert.match(result.reason, /unreadable review capsule/);
    assert.deepEqual(result.remove, []);
    assert.deepEqual(await readdir(capsuleRoot), ['broken-1']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('review prune refuses to walk a symlinked review store', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'review-prune-symlink-store-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'review-prune-symlink-store-target-'));
  try {
    await mkdir(path.join(root, '.unified-mpc'), { recursive: true });
    await writeCapsule(path.join(outside, 'reviews'), HEAD_OLD, 1, '2026-01-01T00:00:00.000Z');
    await symlink(path.join(outside, 'reviews'), path.join(root, '.unified-mpc', 'reviews'));

    const result = await pruneReviewEvidence({ root, headSha: HEAD_CURRENT, keepRecent: 0, dryRun: false });

    assert.equal(result.status, 'refused');
    assert.match(result.reason, /exact-head review evidence root is a symlink/);
    assert.equal((await readdir(path.join(outside, 'reviews', 'capsules'))).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('review prune refuses to delete through a symlinked receipts directory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'review-prune-symlink-receipts-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'review-prune-symlink-receipts-target-'));
  try {
    const reviewRoot = path.join(root, '.unified-mpc', 'reviews');
    await writeCapsule(reviewRoot, HEAD_OLD, 1, '2026-01-01T00:00:00.000Z');
    await mkdir(path.join(outside, 'receipts'), { recursive: true });
    await writeFile(path.join(outside, 'receipts', 'keep.json'), '{}\n', 'utf8');
    await symlink(path.join(outside, 'receipts'), path.join(reviewRoot, 'receipts'));

    const result = await pruneReviewEvidence({ root, headSha: HEAD_CURRENT, keepRecent: 0, dryRun: false });

    assert.equal(result.status, 'refused');
    assert.match(result.reason, /review receipt root is not a real directory/);
    assert.deepEqual(await readdir(path.join(outside, 'receipts')), ['keep.json']);
    assert.equal((await readdir(path.join(reviewRoot, 'capsules'))).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('review prune unlinks a symlinked capsule instead of deleting its target', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'review-prune-symlink-capsule-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'review-prune-symlink-capsule-target-'));
  try {
    const reviewRoot = path.join(root, '.unified-mpc', 'reviews');
    const capsuleRoot = path.join(reviewRoot, 'capsules');
    await mkdir(capsuleRoot, { recursive: true });
    await writeCapsule(path.join(outside, 'reviews'), HEAD_OLD, 1, '2026-01-01T00:00:00.000Z');
    await symlink(
      path.join(outside, 'reviews', 'capsules', `${HEAD_OLD.slice(0, 12)}-1`),
      path.join(capsuleRoot, `${HEAD_OLD.slice(0, 12)}-1`),
    );

    const result = await pruneReviewEvidence({ root, headSha: HEAD_CURRENT, keepRecent: 0, dryRun: false });

    assert.equal(result.status, 'pruned');
    assert.deepEqual(result.remove.map((entry) => entry.kind), ['capsule']);
    assert.deepEqual(await readdir(capsuleRoot), []);
    assert.deepEqual(await readdir(path.join(outside, 'reviews', 'capsules')), [`${HEAD_OLD.slice(0, 12)}-1`]);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('review prune refuses when the verification store it reads merge records from is a symlink', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'review-prune-symlink-verification-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'review-prune-symlink-verification-target-'));
  try {
    const reviewRoot = path.join(root, '.unified-mpc', 'reviews');
    await writeCapsule(reviewRoot, HEAD_OLD, 1, '2026-01-01T00:00:00.000Z');
    await symlink(path.join(outside, 'local-verify'), path.join(root, '.unified-mpc', 'local-verify'));

    const result = await pruneReviewEvidence({ root, headSha: HEAD_CURRENT, keepRecent: 0, dryRun: false });

    assert.equal(result.status, 'refused');
    assert.match(result.reason, /local verification evidence root is a symlink/);
    assert.equal((await readdir(path.join(reviewRoot, 'capsules'))).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('the command refuses both stores when one of them cannot be planned', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'prune-evidence-cli-refuse-'));
  try {
    await initRepository(root);
    const verificationRoot = path.join(root, '.unified-mpc', 'local-verify');
    await writeReceipt(verificationRoot, `aaaaaaaaaaaa-${UUID_1}.json`, 'aaaaaaaaaaaa', '2026-01-01T00:00:00.000Z');
    const reviewRoot = path.join(root, '.unified-mpc', 'reviews');
    await mkdir(path.join(reviewRoot, 'receipts'), { recursive: true });
    await writeFile(path.join(reviewRoot, 'receipts', 'broken.json'), '{not json', 'utf8');

    const result = await runPruneCommand(root, ['--keep', '0', '--apply']);

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /evidence prune refused: unreadable review receipt/);
    assert.deepEqual(await readdir(verificationRoot), [`aaaaaaaaaaaa-${UUID_1}.json`]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the command applies both stores when every plan is safe', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'prune-evidence-cli-apply-'));
  try {
    await initRepository(root);
    const verificationRoot = path.join(root, '.unified-mpc', 'local-verify');
    await writeReceipt(verificationRoot, `aaaaaaaaaaaa-${UUID_1}.json`, 'aaaaaaaaaaaa', '2026-01-01T00:00:00.000Z');
    const reviewRoot = path.join(root, '.unified-mpc', 'reviews');
    await writeCapsule(reviewRoot, HEAD_OLD, 1, '2026-01-01T00:00:00.000Z');
    await writeReviewReceipt(reviewRoot, HEAD_OLD, 1, '2026-01-01T00:00:00.000Z', UUID_2);

    const result = await runPruneCommand(root, ['--keep', '0', '--apply']);

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /local verification: removed 1 receipt\(s\); kept 0 receipt\(s\)/);
    assert.match(result.stdout, /exact-head review: removed 1 capsule\(s\) and 1 receipt\(s\); kept 0 receipt\(s\)/);
    assert.deepEqual(await readdir(verificationRoot), []);
    assert.deepEqual(await readdir(path.join(reviewRoot, 'capsules')), []);
    assert.deepEqual(await readdir(path.join(reviewRoot, 'receipts')), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function initRepository(root) {
  const git = (...args) => execFileAsync('git', ['-C', root, ...args]);
  const identity = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false'];
  await git('init', '-q', '-b', 'main');
  await writeFile(path.join(root, 'a.txt'), 'a\n', 'utf8');
  await git('add', 'a.txt');
  await git(...identity, 'commit', '-q', '-m', 'one');
}

async function runPruneCommand(root, args) {
  return await new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(SCRIPT_ROOT, 'scripts', 'prune-evidence.mjs'), '--root', root, ...args],
      { env: { ...process.env, GIT_HEAD_SHA: 'f'.repeat(40) } },
      (error, stdout, stderr) => resolve({ exitCode: error === null ? 0 : Number(error.code), stdout, stderr }),
    );
  });
}

async function writeCapsule(reviewRoot, headSha, prNumber, createdAt) {
  const directory = path.join(reviewRoot, 'capsules', `${headSha.slice(0, 12)}-${String(prNumber)}`);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, 'capsule.json'),
    `${JSON.stringify({ capsuleId: UUID_3, headSha, prNumber, createdAt })}\n`,
    'utf8',
  );
  await writeFile(path.join(directory, 'diff.patch'), 'diff --git a/a b/a\n', 'utf8');
  return directory;
}

async function writeReviewReceipt(reviewRoot, headSha, prNumber, createdAt, reviewId) {
  const directory = path.join(reviewRoot, 'receipts');
  await mkdir(directory, { recursive: true });
  const fileName = `${headSha.slice(0, 12)}-${String(prNumber)}.json`;
  await writeFile(
    path.join(directory, fileName),
    `${JSON.stringify({ reviewId, headSha, prNumber, createdAt, verdict: 'clean' })}\n`,
    'utf8',
  );
  return fileName;
}
