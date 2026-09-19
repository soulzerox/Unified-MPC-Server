import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ThaiRagIndexJobStore } from './index-job-store.js';

const roots: string[] = [];

async function root(): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), 'thai-rag-jobs-'));
  roots.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

describe('ThaiRagIndexJobStore', () => {
  it('persists terminal results across provider restarts', async () => {
    const dataRoot = await root();
    const first = new ThaiRagIndexJobStore(dataRoot);
    const job = await first.create('11111111-1111-4111-8111-111111111111', false, 'owner-a');
    await first.complete(job.jobId, { indexed: 2 }, 'owner-a');

    const replacement = new ThaiRagIndexJobStore(dataRoot);
    const restored = await replacement.get(job.jobId, 'owner-a');
    expect(restored).toMatchObject({ status: 'completed', result: { indexed: 2 } });
  });

  it('marks previously running jobs interrupted after a restart instead of pretending they still run', async () => {
    const dataRoot = await root();
    const first = new ThaiRagIndexJobStore(dataRoot, () => new Date('2026-09-17T01:00:00.000Z'));
    const job = await first.create('11111111-1111-4111-8111-111111111111', true, 'owner-a');

    const replacement = new ThaiRagIndexJobStore(dataRoot, () => new Date('2026-09-17T02:00:00.000Z'));
    await replacement.initialize();
    const restored = await replacement.get(job.jobId, 'owner-a');
    expect(restored).toMatchObject({
      status: 'interrupted',
      finishedAt: '2026-09-17T02:00:00.000Z',
      error: expect.stringContaining('restarted'),
    });
    expect(await replacement.active('owner-a')).toEqual([]);
  });

  it('rejects unscoped jobs and foreign owners', async () => {
    const dataRoot = await root();
    const store = new ThaiRagIndexJobStore(dataRoot);

    await expect(store.create('', false, 'owner-a')).rejects.toThrow('canonical Unified workspace UUID');
    await expect(store.create('not-a-workspace', false, 'owner-a')).rejects.toThrow('canonical Unified workspace UUID');

    const job = await store.create('11111111-1111-4111-8111-111111111111', false, 'owner-a');
    await expect(store.get(job.jobId, 'owner-b')).resolves.toBeNull();
    await expect(store.complete(job.jobId, { indexed: 1 }, 'owner-b')).resolves.toBeNull();
    await expect(store.complete(job.jobId, { indexed: 1 }, 'owner-a')).resolves.toMatchObject({ status: 'completed' });
  });
});
