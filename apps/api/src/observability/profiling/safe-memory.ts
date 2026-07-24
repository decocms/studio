/**
 * `process.memoryUsage()` can throw on Bun under load — observed as
 * `SystemError: Failed to get memory usage, errno: 4` (EINTR, an interrupted
 * syscall) while the process is under heavy GC pressure. Because the profiling
 * tick runs unguarded, that throw became an `uncaughtException` and took the
 * whole pod down — i.e. the observability tooling crashed the process under
 * exactly the conditions it exists to observe.
 *
 * This wrapper makes the read non-fatal: callers degrade gracefully (skip a
 * tick, omit memory fields) instead of crashing.
 */
export function safeMemoryUsage(): NodeJS.MemoryUsage | null {
  try {
    return process.memoryUsage();
  } catch {
    return null;
  }
}
