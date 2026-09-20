export interface BoundedRetentionMapOptions {
  readonly maxEntries: number;
  readonly ttlMs: number;
  readonly now?: () => number;
}

interface RetainedValue<V> {
  readonly value: V;
  readonly touchedAt: number;
}

export type BoundedRetentionEvictionReason = 'ttl' | 'capacity';

export interface BoundedRetentionEviction<K, V> {
  readonly key: K;
  readonly value: V;
  readonly reason: BoundedRetentionEvictionReason;
}

/** Small LRU+TTL store for transient runtime state that must not grow forever. */
export class BoundedRetentionMap<K, V> {
  private readonly values = new Map<K, RetainedValue<V>>();
  private readonly now: () => number;

  public constructor(private readonly options: BoundedRetentionMapOptions) {
    if (!Number.isInteger(options.maxEntries) || options.maxEntries < 1) throw new Error('maxEntries must be a positive integer');
    if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) throw new Error('ttlMs must be positive');
    this.now = options.now ?? Date.now;
  }

  public get(key: K): V | undefined {
    const retained = this.values.get(key);
    if (retained === undefined) return undefined;
    const now = this.now();
    if (now - retained.touchedAt >= this.options.ttlMs) {
      this.values.delete(key);
      return undefined;
    }
    this.values.delete(key);
    this.values.set(key, { value: retained.value, touchedAt: now });
    return retained.value;
  }

  public take(key: K): V | undefined {
    const retained = this.values.get(key);
    if (retained === undefined) return undefined;
    this.values.delete(key);
    return this.now() - retained.touchedAt >= this.options.ttlMs ? undefined : retained.value;
  }

  public peek(key: K): V | undefined {
    return this.values.get(key)?.value;
  }

  public delete(key: K): V | undefined {
    const retained = this.values.get(key);
    if (retained === undefined) return undefined;
    this.values.delete(key);
    return retained.value;
  }

  public set(key: K, value: V): readonly (readonly [K, V])[] {
    return this.setWithEvictions(key, value).map((entry) => [entry.key, entry.value] as const);
  }

  public setWithEvictions(key: K, value: V): readonly BoundedRetentionEviction<K, V>[] {
    const evicted: BoundedRetentionEviction<K, V>[] = this.pruneExpired()
      .map(([expiredKey, expiredValue]) => ({ key: expiredKey, value: expiredValue, reason: 'ttl' }));
    this.values.delete(key);
    this.values.set(key, { value, touchedAt: this.now() });
    while (this.values.size > this.options.maxEntries) {
      const oldest = this.values.entries().next().value as [K, RetainedValue<V>] | undefined;
      if (oldest === undefined) break;
      this.values.delete(oldest[0]);
      evicted.push({ key: oldest[0], value: oldest[1].value, reason: 'capacity' });
    }
    return evicted;
  }

  public pruneExpired(): readonly (readonly [K, V])[] {
    const now = this.now();
    const removed: Array<readonly [K, V]> = [];
    for (const [key, retained] of this.values) {
      if (now - retained.touchedAt < this.options.ttlMs) continue;
      this.values.delete(key);
      removed.push([key, retained.value]);
    }
    return removed;
  }

  public drain(): readonly (readonly [K, V])[] {
    const entries = [...this.values.entries()].map(([key, retained]) => [key, retained.value] as const);
    this.values.clear();
    return entries;
  }
}
