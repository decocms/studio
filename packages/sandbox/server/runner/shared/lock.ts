/**
 * Uniform wrapper over the three state-store shapes:
 *   - no store            → pass null ops
 *   - store without lock  → pass the store itself (tests; single-pod dev)
 *   - store with lock     → serialize on (id, kind); pass the lock-scoped ops
 *
 * The scoped ops reuse the lock's connection so nested reads/writes don't
 * starve the main pool during long provisioning.
 */
import type { RunnerStateStore, RunnerStateStoreOps } from "../state-store";
import type { RunnerKind, SandboxId } from "../types";

export function withSandboxLock<T>(
  store: RunnerStateStore | null,
  id: SandboxId,
  kind: RunnerKind,
  fn: (ops: RunnerStateStoreOps | null) => Promise<T>,
): Promise<T> {
  if (!store) return fn(null);
  if (!store.withLock) return fn(store);
  return store.withLock(id, kind, fn);
}
