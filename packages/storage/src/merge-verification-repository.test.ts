import { describe, expect, it } from 'vitest';
import type { MergeVerificationReceipt } from '@unified-mpc/domain';
import { SqliteDatabase } from './database.js';
import { SqliteMergeVerificationReceiptRepository } from './merge-verification-repository.js';

const HEAD = '1111111111111111111111111111111111111111';
const NEXT_HEAD = '2222222222222222222222222222222222222222';
const BASE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const NOW = '2026-10-06T10:00:00.000Z';

function receipt(headSha = HEAD): MergeVerificationReceipt {
  return {
    repository: 'soulzerox/Unified-MPC-Server',
    pullRequest: 231,
    headSha,
    baseSha: BASE,
    verificationMode: 'local_exact_head',
    gates: [{
      name: 'test',
      source: 'local_command',
      headSha,
      outcome: 'passed',
      evidence: 'task:test-1',
    }],
    review: {
      outcome: 'clean_llm_review',
      headSha,
      evidence: 'review:clean',
    },
    createdAt: NOW,
  };
}

describe('SqliteMergeVerificationReceiptRepository', () => {
  it('persists immutable receipt records and resolves only the exact PR head', async () => {
    const database = new SqliteDatabase(':memory:');
    try {
      const repository = new SqliteMergeVerificationReceiptRepository(database);
      const first = await repository.append({
        receiptRef: 'merge-verification:231@1111111',
        receipt: receipt(),
        recordedAt: NOW,
      });

      expect(first).toMatchObject({
        appended: true,
        record: {
          sequence: 1,
          receiptRef: 'merge-verification:231@1111111',
          receipt: { pullRequest: 231, headSha: HEAD },
          recordedAt: NOW,
        },
      });

      expect(await repository.listForExactHead({
        repository: 'soulzerox/Unified-MPC-Server',
        pullRequest: 231,
        headSha: HEAD,
        limit: 10,
      })).toEqual([first.record]);

      expect(await repository.listForExactHead({
        repository: 'soulzerox/Unified-MPC-Server',
        pullRequest: 231,
        headSha: NEXT_HEAD,
        limit: 10,
      })).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('persists normalized identifiers consistently in indexed columns and receipt JSON', async () => {
    const database = new SqliteDatabase(':memory:');
    try {
      const repository = new SqliteMergeVerificationReceiptRepository(database);
      const stored = await repository.append({
        receiptRef: ' merge-verification:231@normalized ',
        receipt: {
          ...receipt(),
          repository: ' soulzerox/Unified-MPC-Server ',
          gates: [{ ...receipt().gates[0]!, name: ' test ' }],
        },
        recordedAt: NOW,
      });

      expect(stored.record).toMatchObject({
        receiptRef: 'merge-verification:231@normalized',
        receipt: {
          repository: 'soulzerox/Unified-MPC-Server',
          gates: [{ name: 'test' }],
        },
      });
      expect(await repository.listForExactHead({
        repository: 'soulzerox/Unified-MPC-Server',
        pullRequest: 231,
        headSha: HEAD,
      })).toEqual([stored.record]);
    } finally {
      database.close();
    }
  });

  it('is idempotent for the same receipt ref and rejects that ref identifying different evidence', async () => {
    const database = new SqliteDatabase(':memory:');
    try {
      const repository = new SqliteMergeVerificationReceiptRepository(database);
      const request = {
        receiptRef: 'merge-verification:231@1111111',
        receipt: receipt(),
        recordedAt: NOW,
      } as const;

      const first = await repository.append(request);
      const retry = await repository.append({
        ...request,
        recordedAt: '2026-10-06T10:00:01.000Z',
      });

      expect(retry).toEqual({ appended: false, record: first.record });

      await expect(repository.append({
        ...request,
        receipt: receipt(NEXT_HEAD),
      })).rejects.toMatchObject({ reason: 'receipt_ref_conflict' });
    } finally {
      database.close();
    }
  });

  it('keeps multiple exact-head verification attempts as ordered durable history', async () => {
    const database = new SqliteDatabase(':memory:');
    try {
      const repository = new SqliteMergeVerificationReceiptRepository(database);
      await repository.append({
        receiptRef: 'merge-verification:231@1111111:attempt-1',
        receipt: {
          ...receipt(),
          gates: [{ ...receipt().gates[0]!, outcome: 'failed' }],
        },
        recordedAt: NOW,
      });
      await repository.append({
        receiptRef: 'merge-verification:231@1111111:attempt-2',
        receipt: receipt(),
        recordedAt: '2026-10-06T10:00:02.000Z',
      });

      const records = await repository.listForExactHead({
        repository: 'soulzerox/Unified-MPC-Server',
        pullRequest: 231,
        headSha: HEAD,
        limit: 10,
      });

      expect(records.map((record) => record.receiptRef)).toEqual([
        'merge-verification:231@1111111:attempt-2',
        'merge-verification:231@1111111:attempt-1',
      ]);
    } finally {
      database.close();
    }
  });
});
