import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ThaiRagIndexJobStore } from './index-job-store.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('durable native Thai-RAG indexing progress', () => {
  it('persists monotonic scoped counters across reload, cancellation and terminal transitions', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'thai-rag-progress-'));
    roots.push(root);
    const ws = '11111111-1111-4111-8111-111111111111';
    const first = new ThaiRagIndexJobStore(root);
    const job = await first.create(ws, false, 'owner-a');
    await expect(first.recordProgress(job.jobId, { indexedFiles: 3, skippedFiles: 2, totalFiles: 8 }, 'owner-b'))
      .resolves.toBeNull();
    await expect(first.recordProgress(job.jobId, { indexedFiles: 3, skippedFiles: 2, totalFiles: 8 }, 'owner-a'))
      .resolves.toMatchObject({ indexedFiles: 3, skippedFiles: 2, totalFiles: 8 });
    // Out-of-order progress responses do not make the progress bar go backward.
    await expect(first.recordProgress(job.jobId, { indexedFiles: 2, skippedFiles: 1, totalFiles: 6 }, 'owner-a'))
      .resolves.toMatchObject({ indexedFiles: 3, skippedFiles: 2, totalFiles: 8 });
    await expect(first.recordProgress(job.jobId, { indexedFiles: 7, skippedFiles: 5, totalFiles: 8 }, 'owner-a'))
      .resolves.toBeNull();
    await expect(first.recordProgress(job.jobId, { indexedFiles: Number.NaN, skippedFiles: 0, totalFiles: 8 }, 'owner-a'))
      .resolves.toBeNull();

    const reloaded = new ThaiRagIndexJobStore(root);
    await expect(reloaded.get(job.jobId, 'owner-a', ws)).resolves.toMatchObject({
      indexedFiles: 3, skippedFiles: 2, totalFiles: 8, status: 'running',
    });
    await reloaded.requestCancellation(job.jobId, 'owner-a');
    await expect(reloaded.recordProgress(job.jobId, { indexedFiles: 5, skippedFiles: 3, totalFiles: 8 }, 'owner-a'))
      .resolves.toMatchObject({ indexedFiles: 5, skippedFiles: 3, totalFiles: 8, status: 'cancelling' });
    await reloaded.cancel(job.jobId, { status: 'cancelled' }, 'owner-a');
    await expect(reloaded.recordProgress(job.jobId, { indexedFiles: 6, skippedFiles: 2, totalFiles: 8 }, 'owner-a'))
      .resolves.toBeNull();
    await expect(new ThaiRagIndexJobStore(root).get(job.jobId, 'owner-b', ws))
      .resolves.toMatchObject({ status: 'cancelled', indexedFiles: 5, skippedFiles: 3, totalFiles: 8 });
  });

  it('keeps legacy schema-v2 rows with no counters readable and non-invented', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'thai-rag-progress-'));
    roots.push(root);
    const ws = '11111111-1111-4111-8111-111111111111';
    const store = new ThaiRagIndexJobStore(root);
    const job = await store.create(ws, false, 'owner-a');
    await expect(store.get(job.jobId, 'owner-a', ws)).resolves.not.toHaveProperty('totalFiles');
  });
});
