/**
 * Per-update emitter (does not batch across SSE chunks). React subscribes via
 * useSyncExternalStore.
 */
export class Store<T> {
  private subs = new Set<() => void>();
  constructor(private value: T) {}
  get = (): T => this.value;
  set = (next: T): void => {
    if (Object.is(next, this.value)) return;
    this.value = next;
    this.subs.forEach((s) => s());
  };
  update = (fn: (prev: T) => T): void => {
    this.set(fn(this.value));
  };
  subscribe = (s: () => void): (() => void) => {
    this.subs.add(s);
    return () => {
      this.subs.delete(s);
    };
  };
}
