import { describe, expect, it } from 'vitest';
import { BoundedRetentionMap } from './bounded-retention-map.js';

describe('BoundedRetentionMap eviction evidence', () => {
  it('surfaces an item that expires during lookup so callers can dispose it', () => {
    let now = 0;
    const map = new BoundedRetentionMap<string, { readonly id: string }>({
      maxEntries: 2,
      ttlMs: 100,
      now: (): number => now,
    });
    const value = { id: 'session-1' };
    map.set('session-1', value);

    now = 100;
    expect(map.getWithEviction('session-1')).toEqual({
      state: 'evicted',
      eviction: { key: 'session-1', value, reason: 'ttl' },
    });
    expect(map.getWithEviction('session-1')).toEqual({ state: 'missing' });
  });

  it('refreshes ttl and lru position on a successful lookup', () => {
    let now = 0;
    const map = new BoundedRetentionMap<string, string>({
      maxEntries: 2,
      ttlMs: 100,
      now: (): number => now,
    });
    map.set('a', 'A');
    now = 50;
    expect(map.getWithEviction('a')).toEqual({ state: 'value', value: 'A' });

    now = 120;
    expect(map.getWithEviction('a')).toEqual({ state: 'value', value: 'A' });
    now = 220;
    expect(map.getWithEviction('a')).toMatchObject({
      state: 'evicted',
      eviction: { key: 'a', value: 'A', reason: 'ttl' },
    });
  });
});

describe('BoundedRetentionMap weight budget', () => {
  it('evicts the oldest entries once retained weight exceeds the byte budget', () => {
    const map = new BoundedRetentionMap<string, string>({
      maxEntries: 10,
      ttlMs: 1_000,
      maxBytes: 250,
      weigh: (value): number => value.length,
    });
    map.set('a', 'x'.repeat(100));
    map.set('b', 'y'.repeat(100));
    expect(map.size).toBe(2);
    expect(map.retainedBytes).toBe(200);

    const evicted = map.setWithEvictions('c', 'z'.repeat(100));
    expect(evicted).toEqual([{ key: 'a', value: 'x'.repeat(100), reason: 'weight' }]);
    expect(map.peek('a')).toBeUndefined();
    expect(map.peek('b')).toBe('y'.repeat(100));
    expect(map.peek('c')).toBe('z'.repeat(100));
    expect(map.retainedBytes).toBe(200);
  });

  it('keeps the newest entry even when it alone exceeds the budget so its token stays valid', () => {
    const map = new BoundedRetentionMap<string, string>({
      maxEntries: 10,
      ttlMs: 1_000,
      maxBytes: 50,
      weigh: (value): number => value.length,
    });
    map.set('small', 'x');
    const evicted = map.setWithEvictions('huge', 'y'.repeat(200));
    expect(evicted).toEqual([{ key: 'small', value: 'x', reason: 'weight' }]);
    expect(map.peek('huge')).toBe('y'.repeat(200));
    expect(map.retainedBytes).toBe(200);
  });

  it('keeps retained weight accurate across take, delete, ttl expiry and drain', () => {
    let now = 0;
    const map = new BoundedRetentionMap<string, string>({
      maxEntries: 10,
      ttlMs: 100,
      maxBytes: 1_000,
      weigh: (value): number => value.length,
      now: (): number => now,
    });
    map.set('a', 'aaa');
    map.set('b', 'bb');
    expect(map.retainedBytes).toBe(5);

    expect(map.take('a')).toBe('aaa');
    expect(map.retainedBytes).toBe(2);

    expect(map.delete('b')).toBe('bb');
    expect(map.retainedBytes).toBe(0);

    map.set('c', 'cccc');
    now = 100;
    expect(map.pruneExpired()).toEqual([['c', 'cccc']]);
    expect(map.retainedBytes).toBe(0);

    map.set('d', 'ddddd');
    expect(map.drain()).toEqual([['d', 'ddddd']]);
    expect(map.retainedBytes).toBe(0);
    expect(map.size).toBe(0);
  });

  it('replaces the weight of an overwritten key instead of double counting it', () => {
    const map = new BoundedRetentionMap<string, string>({
      maxEntries: 5,
      ttlMs: 1_000,
      maxBytes: 1_000,
      weigh: (value): number => value.length,
    });
    map.set('a', 'x'.repeat(400));
    map.set('a', 'x'.repeat(10));
    expect(map.retainedBytes).toBe(10);
  });

  it('rejects an unusable byte budget configuration', () => {
    expect(() => new BoundedRetentionMap<string, string>({ maxEntries: 1, ttlMs: 1, maxBytes: 0 })).toThrow(/maxBytes/);
    expect(() => new BoundedRetentionMap<string, string>({ maxEntries: 1, ttlMs: 1, maxBytes: 10 })).toThrow(/weigh/);
    const map = new BoundedRetentionMap<string, string>({ maxEntries: 1, ttlMs: 1, maxBytes: 10, weigh: (): number => Number.NaN });
    expect(() => map.set('a', 'A')).toThrow(/weigh/);
  });

  it('leaves retained state untouched when a value fails weighing', () => {
    let reject = false;
    const map = new BoundedRetentionMap<string, string>({
      maxEntries: 5,
      ttlMs: 1_000,
      maxBytes: 1_000,
      weigh: (value): number => {
        if (reject) return Number.NaN;
        return value.length;
      },
    });
    map.set('keep', 'value');
    reject = true;
    expect(() => map.set('keep', 'replacement')).toThrow(/weigh/);
    expect(map.peek('keep')).toBe('value');
    expect(map.retainedBytes).toBe(5);
  });
});

