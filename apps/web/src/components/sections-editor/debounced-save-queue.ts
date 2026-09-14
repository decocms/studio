/**
 * Small latest-value scheduler used by the autosave hook. Keeping timer
 * ownership outside React makes the teardown policy explicit and unit-testable:
 * callers either flush every pending value or deliberately discard them.
 */
export class DebouncedSaveQueue<Value> {
  readonly #pending = new Map<
    string,
    { value: Value; timer: ReturnType<typeof setTimeout> }
  >();

  constructor(private readonly consume: (value: Value) => void) {}

  schedule(key: string, value: Value, delay: number): void {
    const existing = this.#pending.get(key);
    if (existing) clearTimeout(existing.timer);

    const timer = setTimeout(() => this.#consume(key), delay);
    this.#pending.set(key, { value, timer });
  }

  flush(): void {
    const values = [...this.#pending.values()].map(({ value }) => value);
    this.discard();

    let firstError: unknown;
    let hasError = false;
    for (const value of values) {
      try {
        this.consume(value);
      } catch (error) {
        if (!hasError) firstError = error;
        hasError = true;
      }
    }
    if (hasError) throw firstError;
  }

  discard(): void {
    for (const pending of this.#pending.values()) clearTimeout(pending.timer);
    this.#pending.clear();
  }

  settleOnUnmount(): void {
    this.flush();
  }

  #consume(key: string): void {
    const pending = this.#pending.get(key);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#pending.delete(key);
    this.consume(pending.value);
  }
}
