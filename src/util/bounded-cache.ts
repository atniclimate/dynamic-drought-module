interface CacheEntry<Value> {
  readonly value: Value;
  readonly expiresAt: number;
}

/**
 * Small in-memory least-recently-used cache with per-entry expiry.
 *
 * Only completed values belong here. Callers keep in-flight requests scoped to
 * their owning AbortSignal so one superseded operation never pins another
 * operation to work it can no longer cancel.
 */
export class ExpiringLruCache<Key, Value> {
  readonly #entries = new Map<Key, CacheEntry<Value>>();
  readonly #maxEntries: number;
  readonly #now: () => number;

  constructor(maxEntries: number, now: () => number = Date.now) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error('ExpiringLruCache maxEntries must be a positive integer.');
    }
    this.#maxEntries = maxEntries;
    this.#now = now;
  }

  get(key: Key): Value | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.#now()) {
      this.#entries.delete(key);
      return undefined;
    }
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value;
  }

  set(key: Key, value: Value, ttlMs: number): void {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error('ExpiringLruCache ttlMs must be positive.');
    }
    this.#entries.delete(key);
    this.#entries.set(key, {
      value,
      expiresAt: this.#now() + ttlMs
    });
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next().value as Key | undefined;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }

  clear(): void {
    this.#entries.clear();
  }

  get size(): number {
    return this.#entries.size;
  }
}
