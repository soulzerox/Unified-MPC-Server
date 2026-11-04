import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GcLeaseHeartbeat, GcLeaseLostError, GcLeaseStore } from './gc-lease.js';

const T0 = new Date('2026-10-17T00:00:00.000Z');
const at = (ms: number): Date => new Date(T0.getTime() + ms);
const TTL = 60_000;

async function store(): Promise<{ leases: GcLeaseStore; dir: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gc-lease-'));
  return { leases: new GcLeaseStore(dir), dir };
}

describe('GC cleanup lease (#210 U28)', () => {
  it('grants a free lease and records owner and generation', async () => {
    const { leases, dir } = await store();
    try {
      const result = await leases.acquire({ ownerId: 'gc_a', now: T0, ttlMs: TTL });
      expect(result).toMatchObject({ status: 'granted', ownerId: 'gc_a', generation: 1, token: expect.any(String) });
      expect(await leases.read()).toMatchObject({ ownerId: 'gc_a', generation: 1 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('denies a second owner while the lease is live and names the holder', async () => {
    const { leases, dir } = await store();
    try {
      await leases.acquire({ ownerId: 'gc_a', now: T0, ttlMs: TTL });
      const denied = await leases.acquire({ ownerId: 'gc_b', now: at(TTL / 2), ttlMs: TTL });
      expect(denied).toMatchObject({ status: 'denied', reason: 'held', holder: 'gc_a' });
      expect((await leases.read())?.ownerId).toBe('gc_a');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('takes over an expired lease and advances the generation', async () => {
    const { leases, dir } = await store();
    try {
      await leases.acquire({ ownerId: 'gc_a', now: T0, ttlMs: TTL });
      const taken = await leases.acquire({ ownerId: 'gc_b', now: at(TTL + 1), ttlMs: TTL });
      expect(taken).toMatchObject({ status: 'granted', ownerId: 'gc_b', generation: 2 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('renews only for the holder and refuses a stale generation', async () => {
    const { leases, dir } = await store();
    try {
      const first = await leases.acquire({ ownerId: 'gc_a', now: T0, ttlMs: TTL });
      if (first.status !== 'granted') throw new Error('expected grant');
      expect(await leases.renew({ ownerId: 'gc_b', generation: first.generation, now: at(1000), ttlMs: TTL })).toBe(false);
      expect(await leases.renew({ ownerId: 'gc_a', generation: first.generation + 1, now: at(1000), ttlMs: TTL })).toBe(false);
      expect(await leases.renew({ ownerId: 'gc_a', generation: first.generation, now: at(1000), ttlMs: TTL })).toBe(true);
      // Renewal must extend, not just return true: a now-past-old-expiry
      // acquisition still finds the lease live.
      const denied = await leases.acquire({ ownerId: 'gc_b', now: at(TTL + 1), ttlMs: TTL });
      expect(denied).toMatchObject({ status: 'denied', reason: 'held' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('releases only for the holder and the current generation', async () => {
    const { leases, dir } = await store();
    try {
      const first = await leases.acquire({ ownerId: 'gc_a', now: T0, ttlMs: TTL });
      if (first.status !== 'granted') throw new Error('expected grant');
      expect(await leases.release({ ownerId: 'gc_b', generation: first.generation })).toBe(false);
      expect(await leases.release({ ownerId: 'gc_a', generation: first.generation + 1 })).toBe(false);
      expect(await leases.read()).not.toBeNull();
      expect(await leases.release({ ownerId: 'gc_a', generation: first.generation })).toBe(true);
      expect(await leases.read()).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps the generation monotonic across release and re-acquire', async () => {
    const { leases, dir } = await store();
    try {
      const first = await leases.acquire({ ownerId: 'gc_a', now: T0, ttlMs: TTL });
      if (first.status !== 'granted') throw new Error('expected grant');
      await leases.release({ ownerId: 'gc_a', generation: first.generation });
      const second = await leases.acquire({ ownerId: 'gc_a', now: at(1000), ttlMs: TTL });
      expect(second).toMatchObject({ status: 'granted', generation: 2 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses to hand out a lease when the recorded fence is unreadable', async () => {
    const { leases, dir } = await store();
    try {
      await leases.acquire({ ownerId: 'gc_a', now: T0, ttlMs: TTL });
      await writeFile(path.join(dir, 'gc', 'lease.json'), '{ not json', 'utf8');
      const denied = await leases.acquire({ ownerId: 'gc_b', now: at(1), ttlMs: TTL });
      expect(denied).toMatchObject({ status: 'denied', reason: 'corrupt' });
      // The unreadable fence is left untouched for an operator, never rewritten.
      expect(await readFile(path.join(dir, 'gc', 'lease.json'), 'utf8')).toBe('{ not json');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('GC lease heartbeat (#210 §12)', () => {
  async function granted(): Promise<{
    leases: GcLeaseStore;
    dir: string;
    generation: number;
    tick: (value: Date) => void;
    heartbeat: GcLeaseHeartbeat;
  }> {
    const { leases, dir } = await store();
    const result = await leases.acquire({ ownerId: 'gc_a', now: T0, ttlMs: TTL });
    if (result.status !== 'granted') throw new Error('expected grant');
    let now = T0;
    const heartbeat = new GcLeaseHeartbeat({
      store: leases,
      ownerId: 'gc_a',
      generation: result.generation,
      ttlMs: TTL,
      grantedAt: T0,
      clock: (): Date => now,
    });
    return { leases, dir, generation: result.generation, tick: (value: Date): void => { now = value; }, heartbeat };
  }

  it('writes nothing before half the window has elapsed', async () => {
    const s = await granted();
    try {
      s.tick(at(TTL / 2 - 1));
      await expect(s.heartbeat.ensure()).resolves.toBe(true);
      // The original deadline is untouched: no renewal was needed yet.
      expect(await s.leases.inspect()).toMatchObject({ status: 'held', expiresAt: at(TTL).toISOString() });
    } finally {
      await rm(s.dir, { recursive: true, force: true });
    }
  });

  it('renews at half the window and then waits for the next half', async () => {
    const s = await granted();
    try {
      s.tick(at(TTL / 2));
      await expect(s.heartbeat.ensure()).resolves.toBe(true);
      const extended = at(TTL / 2 + TTL).toISOString();
      expect(await s.leases.inspect()).toMatchObject({ status: 'held', generation: s.generation, expiresAt: extended });
      // The window restarts at the renewal, so the next tick is due a half
      // window later, not immediately.
      s.tick(at(TTL - 1));
      await expect(s.heartbeat.ensure()).resolves.toBe(true);
      expect(await s.leases.inspect()).toMatchObject({ status: 'held', expiresAt: extended });
      // A now-past-the-old-deadline acquisition still sees a live fence.
      const denied = await s.leases.acquire({ ownerId: 'gc_b', now: at(TTL + 1), ttlMs: TTL });
      expect(denied).toMatchObject({ status: 'denied', reason: 'held', holder: 'gc_a' });
    } finally {
      await rm(s.dir, { recursive: true, force: true });
    }
  });

  it('fails closed once a newer generation owns the fence', async () => {
    const s = await granted();
    try {
      await s.leases.release({ ownerId: 'gc_a', generation: s.generation });
      const successor = await s.leases.acquire({ ownerId: 'gc_b', now: at(TTL + 1), ttlMs: TTL });
      expect(successor).toMatchObject({ status: 'granted', generation: 2 });
      s.tick(at(TTL + 2));
      await expect(s.heartbeat.ensure()).resolves.toBe(false);
      await expect(s.heartbeat.assert()).rejects.toThrow(GcLeaseLostError);
      // The successor's record is never rewritten or released by the stale run.
      expect(await s.leases.inspect()).toMatchObject({ status: 'held', ownerId: 'gc_b', generation: 2 });
    } finally {
      await rm(s.dir, { recursive: true, force: true });
    }
  });
});
