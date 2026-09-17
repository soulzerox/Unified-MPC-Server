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
    const job = await first.create('11111111-1111-4111-8111-111111111111', false);
    await first.complete(job.jobId, { indexed: 2 });

    const replacement = new ThaiRagIndexJobStore(dataRoot);
    const restored = await replacement.get(job.jobId);
    expect(restored).toMatchObject({ status: 'completed', result: { indexed: 2 } });
  });

  it('marks previously running jobs interrupted after a restart instead of pretending they still run', async () => {
    const dataRoot = await root();
    const first = new ThaiRagIndexJobStore(dataRoot, () => new Date('2026-09-17T01:00:00.000Z'));
    const job = await first.create('11111111-1111-4111-8111-111111111111', true);

    const replacement = new ThaiRagIndexJobStore(dataRoot, () => new Date('2026-09-17T02:00:00.000Z'));
    await replacement.initialize();
    const restored = await replacement.get(job.jobId);
    expect(restored).toMatchObject({
      status: 'interrupted',
      finishedAt: '2026-09-17T02:00:00.000Z',
      error: expect.stringContaining('restarted'),
    });
    expect(await replacement.active()).toEqual([]);
  });
});
