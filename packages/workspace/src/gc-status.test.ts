import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ArtifactQuarantineStore } from './artifact-quarantine.js';
import { GcLeaseStore } from './gc-lease.js';
import { gcStatus } from './gc-status.js';

const H = (n: string): string => n.repeat(64).slice(0, 64);
const REPO = 'repo_abc123';
const KEY = (n: string): string => `file:v1:${H(n)}`;
const NOW = new Date('2026-11-04T00:00:00.000Z');
const GRACE = 60_000;

async function tempStores(): Promise<{ root: string; quarantine: ArtifactQuarantineStore; lease: GcLeaseStore }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gc-status-'));
  return { root, quarantine: new ArtifactQuarantineStore(root), lease: new GcLeaseStore(root) };
}

describe('gc status projection (#210 §7)', () => {
  it('reports a free lease and an empty ledger as healthy', async () => {
    const { root, quarantine, lease } = await tempStores();
    try {
      const report = await gcStatus({ quarantine, lease }, { now: NOW });
      expect(report).toEqual({
        status: 'healthy',
        lease: { status: 'free' },
        quarantine: { total: 0, due: 0, inGrace: 0, rows: [] },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('splits due from in-grace rows across both id spaces, due first', async () => {
    const { root, quarantine, lease } = await tempStores();
    try {
      // Old rows are past grace; a fresh row is still inside its window.
      await quarantine.quarantine([H('1'), { kind: 'artifact-key', repositoryId: REPO, artifactKey: KEY('2') }], {
        now: new Date(NOW.getTime() - GRACE * 2),
        graceMs: GRACE,
      });
      await quarantine.quarantine([H('3')], { now: NOW, graceMs: GRACE });

      const report = await gcStatus({ quarantine, lease }, { now: NOW });
      expect(report.status).toBe('healthy');
      expect(report.quarantine.total).toBe(3);
      expect(report.quarantine.due).toBe(2);
      expect(report.quarantine.inGrace).toBe(1);
      expect(report.quarantine.rows.map((row) => row.due)).toEqual([true, true, false]);
      // Both id spaces survive the projection unchanged; within a bucket the
      // order is the target key, so the bare hash sorts before the scoped key.
      expect(report.quarantine.rows.map((row) => row.target)).toEqual([
        H('1'),
        { kind: 'artifact-key', repositoryId: REPO, artifactKey: KEY('2') },
        H('3'),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports a held lease with its deadline and whether it already expired', async () => {
    const { root, quarantine, lease } = await tempStores();
    try {
      await lease.acquire({ ownerId: 'gc-test', now: NOW, ttlMs: GRACE });
      const held = await gcStatus({ quarantine, lease }, { now: NOW });
      expect(held.lease).toEqual({
        status: 'held',
        ownerId: 'gc-test',
        generation: 1,
        acquiredAt: NOW.toISOString(),
        expiresAt: new Date(NOW.getTime() + GRACE).toISOString(),
        expired: false,
      });

      // The record still exists after its deadline: the next acquire grants,
      // so the status must not claim a fence that would not hold.
      const timedOut = await gcStatus({ quarantine, lease }, { now: new Date(NOW.getTime() + GRACE) });
      expect(timedOut.lease).toMatchObject({ status: 'held', expired: true });
      expect(timedOut.status).toBe('healthy');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports a released lease as released, not free', async () => {
    const { root, quarantine, lease } = await tempStores();
    try {
      const acquired = await lease.acquire({ ownerId: 'gc-test', now: NOW, ttlMs: GRACE });
      if (acquired.status !== 'granted') throw new Error('lease was not granted');
      await lease.release({ ownerId: 'gc-test', generation: acquired.generation });

      const report = await gcStatus({ quarantine, lease }, { now: NOW });
      expect(report.lease).toMatchObject({ status: 'released', ownerId: 'gc-test', generation: acquired.generation });
      expect(report.status).toBe('healthy');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('degrades on a corrupt lease record instead of reporting it free', async () => {
    const { root, quarantine, lease } = await tempStores();
    try {
      await mkdir(path.join(root, 'gc'), { recursive: true });
      await writeFile(path.join(root, 'gc', 'lease.json'), '{not json', 'utf8');

      const report = await gcStatus({ quarantine, lease }, { now: NOW });
      expect(report.lease).toEqual({ status: 'corrupt' });
      expect(report.status).toBe('degraded');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('never makes a row due when its own deadline cannot be read', async () => {
    const { root, quarantine, lease } = await tempStores();
    try {
      await mkdir(path.join(root, 'quarantine'), { recursive: true });
      await writeFile(
        path.join(root, 'quarantine', 'candidates.json'),
        JSON.stringify([{ kind: 'content-hash', hash: H('4'), quarantinedAt: 'not-a-date', graceMs: GRACE }]),
        'utf8',
      );
      const report = await gcStatus({ quarantine, lease }, { now: NOW });
      expect(report.quarantine.rows).toEqual([{
        target: H('4'),
        quarantinedAt: 'not-a-date',
        graceMs: GRACE,
        expiresAt: null,
        due: false,
      }]);
      expect(report.quarantine.inGrace).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
