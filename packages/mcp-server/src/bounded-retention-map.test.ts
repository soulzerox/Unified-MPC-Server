import { describe, expect, it } from 'vitest';
import { BoundedRetentionMap } from './bounded-retention-map.js';

describe('BoundedRetentionMap eviction evidence', () => {
  it('surfaces an item that expires during lookup so callers can dispose it', () => {
    let now = 0;
    const map = new BoundedRetentionMap<string, { readonly id: string }>({
      maxEntries: 2,
      ttlMs: 100,
      now: () => now,
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
      now: () => now,
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
