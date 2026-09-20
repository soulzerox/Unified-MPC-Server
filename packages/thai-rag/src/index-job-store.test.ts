import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
    const restored = await replacement.get(job.jobId, 'owner-a', '11111111-1111-4111-8111-111111111111');
    expect(restored).toMatchObject({ status: 'completed', result: { indexed: 2 } });
  });

  it('marks previously running jobs interrupted after a restart instead of pretending they still run', async () => {
    const dataRoot = await root();
    const first = new ThaiRagIndexJobStore(dataRoot, () => new Date('2026-09-17T01:00:00.000Z'));
    const job = await first.create('11111111-1111-4111-8111-111111111111', true, 'owner-a');

    const replacement = new ThaiRagIndexJobStore(dataRoot, () => new Date('2026-09-17T02:00:00.000Z'));
    await replacement.initialize('owner-a');
    const restored = await replacement.get(job.jobId, 'owner-a', '11111111-1111-4111-8111-111111111111');
    expect(restored).toMatchObject({
      status: 'interrupted',
      finishedAt: '2026-09-17T02:00:00.000Z',
      error: expect.stringContaining('restarted'),
    });
    expect(await replacement.active('owner-a')).toEqual([]);
  });

  it('does not interrupt another owner job during startup', async () => {
    const dataRoot = await root();
    const first = new ThaiRagIndexJobStore(dataRoot, () => new Date('2026-09-17T01:00:00.000Z'));
    const job = await first.create('11111111-1111-4111-8111-111111111111', true, 'owner-a');

    const replacement = new ThaiRagIndexJobStore(dataRoot, () => new Date('2026-09-17T02:00:00.000Z'));
    await replacement.initialize('owner-b');

    await expect(replacement.get(job.jobId, 'owner-a', '11111111-1111-4111-8111-111111111111')).resolves.toMatchObject({
      status: 'running',
      ownerId: 'owner-a',
    });
    expect(await replacement.active('owner-b')).toEqual([]);
  });

  it('rejects unscoped jobs and foreign owners', async () => {
    const dataRoot = await root();
    const store = new ThaiRagIndexJobStore(dataRoot);

    await expect(store.create('', false, 'owner-a')).rejects.toThrow('canonical Unified workspace UUID');
    await expect(store.create('not-a-workspace', false, 'owner-a')).rejects.toThrow('canonical Unified workspace UUID');

    const job = await store.create('11111111-1111-4111-8111-111111111111', false, 'owner-a');
    await expect(store.get(job.jobId, 'owner-a', '')).resolves.toBeNull();
    await expect(store.get(job.jobId, 'owner-b', '11111111-1111-4111-8111-111111111111')).resolves.toBeNull();
    await expect(store.get(job.jobId, 'owner-a', '22222222-2222-4222-8222-222222222222')).resolves.toBeNull();
    await expect(store.complete(job.jobId, { indexed: 1 }, 'owner-b')).resolves.toBeNull();
    await expect(store.complete(job.jobId, { indexed: 1 }, 'owner-a')).resolves.toMatchObject({ status: 'completed' });
  });

  it('persists provider job identity and cooperative cancellation lifecycle', async () => {
    const dataRoot = await root();
    const store = new ThaiRagIndexJobStore(dataRoot);
    const workspaceId = '11111111-1111-4111-8111-111111111111';
    const job = await store.create(workspaceId, false, 'owner-a');

    await expect(store.bindProviderJob(job.jobId, 'idx_provider_1', 'owner-a')).resolves.toMatchObject({
      status: 'running',
      providerJobId: 'idx_provider_1',
    });
    await expect(store.requestCancellation(job.jobId, 'owner-a')).resolves.toMatchObject({
      status: 'cancelling',
      providerJobId: 'idx_provider_1',
    });
    await expect(store.active('owner-a')).resolves.toEqual([
      expect.objectContaining({ jobId: job.jobId, status: 'cancelling' }),
    ]);
    await expect(store.cancel(job.jobId, { status: 'cancelled' }, 'owner-a')).resolves.toMatchObject({
      status: 'cancelled',
      providerJobId: 'idx_provider_1',
      result: { status: 'cancelled' },
    });
    await expect(store.active('owner-a')).resolves.toEqual([]);

    const replacement = new ThaiRagIndexJobStore(dataRoot);
    await expect(replacement.get(job.jobId, 'owner-a', workspaceId)).resolves.toMatchObject({
      status: 'cancelled',
      providerJobId: 'idx_provider_1',
    });
  });

  it('does not let late completion overwrite a terminal cancellation or interruption', async () => {
    const dataRoot = await root();
    const store = new ThaiRagIndexJobStore(dataRoot);
    const workspaceId = '11111111-1111-4111-8111-111111111111';

    const cancelled = await store.create(workspaceId, false, 'owner-a');
    await store.requestCancellation(cancelled.jobId, 'owner-a');
    await store.cancel(cancelled.jobId, { cancelled: true }, 'owner-a');
    await expect(store.complete(cancelled.jobId, { indexed: 99 }, 'owner-a')).resolves.toMatchObject({
      status: 'cancelled',
      result: { cancelled: true },
    });

    const interrupted = await store.create(workspaceId, false, 'owner-a');
    await store.interruptRunning('owner-a', 'shutdown');
    await expect(store.complete(interrupted.jobId, { indexed: 99 }, 'owner-a')).resolves.toMatchObject({
      status: 'interrupted',
      error: 'shutdown',
    });
  });

  it('preserves legacy records without owner IDs as unavailable instead of dropping them', async () => {
    const dataRoot = await root();
    const filePath = path.join(dataRoot, 'thai-rag', 'index-jobs.json');
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify({ schemaVersion: 1, jobs: [
      {
        jobId: 'idx_umcp_legacy',
        workspaceId: '11111111-1111-4111-8111-111111111111',
        status: 'running',
        force: true,
        startedAt: '2026-09-17T01:00:00.000Z',
      },
      {
        jobId: 'legacy-arbitrary-id',
        workspaceId: 'legacy-workspace-name',
        status: 'completed',
        force: false,
        startedAt: '2026-09-17T01:30:00.000Z',
        result: { indexed: 3 },
      },
    ] }));

    const store = new ThaiRagIndexJobStore(dataRoot, () => new Date('2026-09-17T02:00:00.000Z'));
    await store.initialize();

    await expect(store.get('idx_umcp_legacy', 'owner-a', '11111111-1111-4111-8111-111111111111')).resolves.toBeNull();
    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as { schemaVersion: number; jobs: Array<Record<string, unknown>> };
    expect(persisted.schemaVersion).toBe(2);
    expect(persisted.jobs).toHaveLength(2);
    expect(persisted.jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({ jobId: 'idx_umcp_legacy', status: 'legacy-unavailable' }),
      expect.objectContaining({
        jobId: 'legacy-arbitrary-id',
        workspaceId: 'legacy-workspace-name',
        status: 'legacy-unavailable',
        legacyData: expect.objectContaining({ result: { indexed: 3 }, workspaceId: 'legacy-workspace-name' }),
      }),
    ]));

    const migratedBytes = await readFile(filePath, 'utf8');
    const replacement = new ThaiRagIndexJobStore(dataRoot, () => new Date('2026-09-17T03:00:00.000Z'));
    await replacement.initialize();
    expect(await readFile(filePath, 'utf8')).toBe(migratedBytes);

    const secondReplacement = new ThaiRagIndexJobStore(dataRoot, () => new Date('2026-09-17T04:00:00.000Z'));
    await secondReplacement.initialize();
    expect(await readFile(filePath, 'utf8')).toBe(migratedBytes);
  });
});
