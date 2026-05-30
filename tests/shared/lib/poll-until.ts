/**
 * Poll a condition until it returns truthy or the deadline passes.
 *
 * The distributed-systems analogue of `expect(x).toBe(y)` — in a multi-pod
 * or chaos-injection setup, assertions are "this becomes true within N
 * seconds", not "this is true right now". Wrap every cross-process
 * assertion in `pollUntil` and you stop writing setTimeout-littered tests.
 *
 * Shared by tests/resilience and tests/multi-pod via re-export.
 */
export async function pollUntil(
  condition: () => Promise<boolean>,
  opts: { timeoutMs: number; intervalMs?: number; label?: string },
): Promise<void> {
  const { timeoutMs, intervalMs = 1000, label = "pollUntil" } = opts;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      if (await condition()) {
        return;
      }
    } catch (err) {
      lastError = err;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await Bun.sleep(Math.min(intervalMs, remaining));
  }

  const base = `[${label}] Condition not met within ${timeoutMs}ms (polled every ${intervalMs}ms)`;
  const cause =
    lastError instanceof Error ? lastError.message : String(lastError ?? "");
  throw new Error(cause ? `${base}: ${cause}` : base);
}
