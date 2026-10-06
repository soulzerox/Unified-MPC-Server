import { describe, expect, it } from 'vitest';
import {
  reconcileMergeEvidence,
  type MergeObservation,
  type MergeReconciliationRecord,
  type MergeVerificationReceipt,
  type RepositoryMergePolicy,
} from '@unified-mpc/domain';
import { SqliteDatabase } from './database.js';
import { SqliteMergeReconciliationRepository } from './merge-reconciliation-repository.js';

const HEAD = '1111111111111111111111111111111111111111';
const BASE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const MERGE = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const NOW = '2026-10-07T01:31:00.000Z';

const policy: RepositoryMergePolicy = {
  repository: 'soulzerox/Unified-MPC-Server',
  defaultBranch: 'main',
  verificationMode: 'local_exact_head',
  requiredGates: [{ name: 'test', source: 'local_command' }],
  reviewPolicy: { required: true, acceptedOutcomes: ['clean_llm_review'] },
};

const receipt: MergeVerificationReceipt = {
  repository: policy.repository,
  pullRequest: 279,
  headSha: HEAD,
  baseSha: BASE,
  verificationMode: 'local_exact_head',
  gates: [{ name: 'test', source: 'local_command', headSha: HEAD, outcome: 'passed' }],
  review: { outcome: 'clean_llm_review', headSha: HEAD },
  createdAt: '2026-10-07T01:20:00.000Z',
};

const observation: MergeObservation = {
  repository: policy.repository,
  pullRequest: 279,
  headSha: HEAD,
  baseBranch: 'main',
  baseSha: BASE,
  merged: true,
  mergeMethod: 'merge',
  mergeSha: MERGE,
  observedAt: '2026-10-07T01:30:22.000Z',
};

function record(overrides: Partial<MergeReconciliationRecord> = {}): MergeReconciliationRecord {
  return {
    reconciliationRef: 'merge-reconciliation:279@bbbbbbbb',
    receiptRef: 'merge-verification:279@1111111',
    receipt,
    policy,
    expectedMergeMethod: 'merge',
    observation,
    decision: reconcileMergeEvidence(policy, observation, receipt, 'merge'),
    recordedAt: NOW,
    ...overrides,
  };
}

describe('SqliteMergeReconciliationRepository', () => {
  it('persists immutable post-merge reconciliation history and indexes it by pull request', async () => {
    const database = new SqliteDatabase(':memory:');
    try {
      const repository = new SqliteMergeReconciliationRepository(database);
      const first = await repository.append(record());

      expect(first).toMatchObject({
        appended: true,
        record: {
          sequence: 1,
          reconciliationRef: 'merge-reconciliation:279@bbbbbbbb',
          observation: { pullRequest: 279, headSha: HEAD, mergeSha: MERGE },
          decision: { status: 'RECONCILED' },
        },
      });
      expect(await repository.getByRef('merge-reconciliation:279@bbbbbbbb')).toEqual(first.record);
      expect(await repository.listForPullRequest({
        repository: policy.repository,
        pullRequest: 279,
        limit: 10,
      })).toEqual([first.record]);
    } finally {
      database.close();
    }
  });

  it('treats a retry with the same evidence and a later recordedAt as idempotent', async () => {
    const database = new SqliteDatabase(':memory:');
    try {
      const repository = new SqliteMergeReconciliationRepository(database);
      const first = await repository.append(record());

      await expect(repository.append(record({
        recordedAt: '2026-10-07T01:32:00.000Z',
      }))).resolves.toEqual({ appended: false, record: first.record });
    } finally {
      database.close();
    }
  });

  it('is idempotent for an identical reconciliation ref and rejects conflicting evidence under that ref', async () => {
    const database = new SqliteDatabase(':memory:');
    try {
      const repository = new SqliteMergeReconciliationRepository(database);
      const first = await repository.append(record());
      await expect(repository.append(record())).resolves.toEqual({ appended: false, record: first.record });

      await expect(repository.append(record({
        observation: { ...observation, mergeSha: 'cccccccccccccccccccccccccccccccccccccccc' },
      }))).rejects.toMatchObject({ reason: 'reconciliation_ref_conflict' });
    } finally {
      database.close();
    }
  });

  it('fails closed when persisted reconciliation JSON is corrupt or disagrees with indexed columns', async () => {
    const database = new SqliteDatabase(':memory:');
    try {
      const repository = new SqliteMergeReconciliationRepository(database);
      await repository.append(record());

      database.connection.prepare(
        'UPDATE merge_reconciliation_records SET record_json = ? WHERE reconciliation_ref = ?',
      ).run('{broken', 'merge-reconciliation:279@bbbbbbbb');

      await expect(repository.getByRef('merge-reconciliation:279@bbbbbbbb'))
        .rejects.toMatchObject({ reason: 'corrupt' });
    } finally {
      database.close();
    }
  });
});
