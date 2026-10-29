export interface BoundedRetentionMapOptions<V = unknown> {
  readonly maxEntries: number;
  readonly ttlMs: number;
  /**
   * Optional byte/weight budget for everything the map retains. Requires `weigh`.
   * The most recently written entry is always kept so a caller never hands out a
   * token that its own write already evicted; the budget bounds older entries.
   */
  readonly maxBytes?: number;
  /** Approximate retained size of one value in bytes. */
  readonly weigh?: (value: V) => number;
  readonly now?: () => number;
}

interface RetainedValue<V> {
  readonly value: V;
  readonly touchedAt: number;
  readonly bytes: number;
}

export type BoundedRetentionEvictionReason = 'ttl' | 'capacity' | 'weight';

export interface BoundedRetentionEviction<K, V> {
  readonly key: K;
  readonly value: V;
  readonly reason: BoundedRetentionEvictionReason;
}

export type BoundedRetentionLookup<K, V> =
  | { readonly state: 'missing' }
  | { readonly state: 'value'; readonly value: V }
  | { readonly state: 'evicted'; readonly eviction: BoundedRetentionEviction<K, V> };

/** Small LRU+TTL store for transient runtime state that must not grow forever. */
export class BoundedRetentionMap<K, V> {
  private readonly values = new Map<K, RetainedValue<V>>();
  private readonly now: () => number;
  private readonly maxBytes: number;
  private retainedBytesTotal = 0;

  public constructor(private readonly options: BoundedRetentionMapOptions<V>) {
    if (!Number.isInteger(options.maxEntries) || options.maxEntries < 1) throw new Error('maxEntries must be a positive integer');
    if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) throw new Error('ttlMs must be positive');
    if (options.maxBytes !== undefined) {
      if (!Number.isInteger(options.maxBytes) || options.maxBytes < 1) throw new Error('maxBytes must be a positive integer');
      if (options.weigh === undefined) throw new Error('maxBytes requires a weigh function');
    }
    this.maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
    this.now = options.now ?? Date.now;
  }

  /** Number of entries currently retained. */
  public get size(): number {
    return this.values.size;
  }

  /** Sum of the weighed size of every retained entry. */
  public get retainedBytes(): number {
    return this.retainedBytesTotal;
  }

  private weigh(value: V): number {
    const weighed = this.options.weigh?.(value) ?? 0;
    if (!Number.isFinite(weighed) || weighed < 0) throw new Error('weigh must return a finite non-negative number');
    return weighed;
  }

  public get(key: K): V | undefined {
    const lookup = this.getWithEviction(key);
    return lookup.state === 'value' ? lookup.value : undefined;
  }

  public getWithEviction(key: K): BoundedRetentionLookup<K, V> {
    const retained = this.values.get(key);
    if (retained === undefined) return { state: 'missing' };
    const now = this.now();
    if (now - retained.touchedAt >= this.options.ttlMs) {
      this.values.delete(key);
      this.retainedBytesTotal -= retained.bytes;
      return {
        state: 'evicted',
        eviction: { key, value: retained.value, reason: 'ttl' },
      };
    }
    this.values.delete(key);
    this.values.set(key, { value: retained.value, touchedAt: now, bytes: retained.bytes });
    return { state: 'value', value: retained.value };
  }

  public take(key: K): V | undefined {
    const retained = this.values.get(key);
    if (retained === undefined) return undefined;
    this.values.delete(key);
    this.retainedBytesTotal -= retained.bytes;
    return this.now() - retained.touchedAt >= this.options.ttlMs ? undefined : retained.value;
  }

  public peek(key: K): V | undefined {
    return this.values.get(key)?.value;
  }

  public delete(key: K): V | undefined {
    const retained = this.values.get(key);
    if (retained === undefined) return undefined;
    this.values.delete(key);
    this.retainedBytesTotal -= retained.bytes;
    return retained.value;
  }

  public set(key: K, value: V): readonly (readonly [K, V])[] {
    return this.setWithEvictions(key, value).map((entry) => [entry.key, entry.value] as const);
  }

  public setWithEvictions(key: K, value: V): readonly BoundedRetentionEviction<K, V>[] {
    // Weigh before mutating so a rejected value leaves the map untouched.
    const bytes = this.weigh(value);
    const evicted: BoundedRetentionEviction<K, V>[] = this.pruneExpired()
      .map(([expiredKey, expiredValue]) => ({ key: expiredKey, value: expiredValue, reason: 'ttl' }));
    const previous = this.values.get(key);
    if (previous !== undefined) this.retainedBytesTotal -= previous.bytes;
    this.values.delete(key);
    this.values.set(key, { value, touchedAt: this.now(), bytes });
    this.retainedBytesTotal += bytes;
    while (this.values.size > this.options.maxEntries) {
      const oldest = this.values.entries().next().value as [K, RetainedValue<V>] | undefined;
      if (oldest === undefined) break;
      this.values.delete(oldest[0]);
      this.retainedBytesTotal -= oldest[1].bytes;
      evicted.push({ key: oldest[0], value: oldest[1].value, reason: 'capacity' });
    }
    // The newest entry is never evicted by the byte budget: the caller that just
    // wrote it is about to hand out its key, and a dead token is worse than one
    // oversized entry that the request budget already bounds.
    while (this.retainedBytesTotal > this.maxBytes && this.values.size > 1) {
      const oldest = this.values.entries().next().value as [K, RetainedValue<V>] | undefined;
      if (oldest === undefined) break;
      this.values.delete(oldest[0]);
      this.retainedBytesTotal -= oldest[1].bytes;
      evicted.push({ key: oldest[0], value: oldest[1].value, reason: 'weight' });
    }
    return evicted;
  }

  public pruneExpired(): readonly (readonly [K, V])[] {
    const now = this.now();
    const removed: Array<readonly [K, V]> = [];
    for (const [key, retained] of this.values) {
      if (now - retained.touchedAt < this.options.ttlMs) continue;
      this.values.delete(key);
      this.retainedBytesTotal -= retained.bytes;
      removed.push([key, retained.value]);
    }
    return removed;
  }

  public drain(): readonly (readonly [K, V])[] {
    const entries = [...this.values.entries()].map(([key, retained]) => [key, retained.value] as const);
    this.values.clear();
    this.retainedBytesTotal = 0;
    return entries;
  }
}
