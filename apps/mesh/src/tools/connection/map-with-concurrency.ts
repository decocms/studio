/**
 * Run `fn` over `items` with at most `concurrency` tasks in flight at once.
 *
 * Used to bound the live tool-probe fan-out during binding filtering: each probe
 * eagerly connects to a downstream MCP server, so an unbounded `Promise.all` over
 * a large org saturates the DB pool and blocks the single-threaded event loop.
 */
export async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      await fn(items[index]!);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
}
