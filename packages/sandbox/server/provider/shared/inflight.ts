/**
 * In-process dedupe: concurrent calls with the same key share one promise.
 * Paired with the state store's advisory lock for cross-pod serialization;
 * this map only covers intra-process races.
 */
export class Inflight<K, V> {
  private readonly map = new Map<K, Promise<V>>();

  async run(key: K, fn: () => Promise<V>): Promise<V> {
    const pending = this.map.get(key);
    if (pending) return pending;
    const p = fn();
    this.map.set(key, p);
    try {
      return await p;
    } finally {
      this.map.delete(key);
    }
  }
}
