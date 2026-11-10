import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  planEvidencePrune,
  pruneLocalVerifyEvidence,
} from './prune-local-verify-evidence.mjs';

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
    await writeFile(path.join(receiptRoot, 'latest.json'), '{"headSha":"bbbbbbbbbbbb"}\n', 'utf8');
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
    await writeFile(path.join(receiptRoot, 'latest.json'), '{"headSha":"cccccccccccc"}\n', 'utf8');
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
