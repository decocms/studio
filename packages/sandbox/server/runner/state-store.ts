import type { SandboxId } from "./types";

/** Persisted per (sandboxId, runnerKind). `state` is an opaque runner-private blob. */
export interface RunnerStateRecord {
  handle: string;
  state: Record<string, unknown>;
  updatedAt: Date;
}

/** Like RunnerStateRecord but carries the SandboxId (handle-only lookups after restart). */
export interface RunnerStateRecordWithId extends RunnerStateRecord {
  id: SandboxId;
}

export interface RunnerStatePut {
  handle: string;
  state: Record<string, unknown>;
}

/**
 * CRUD operations on runner state. Kept separate from `RunnerStateStore` so
 * `withLock` can hand callers a connection-scoped view (same pg txn as the
 * advisory lock) without exposing DB types. Nested reads/writes inside the
 * lock go through this scoped store — not `this.stateStore` — which is what
 * prevents main-pool starvation during long provisioning.
 */
export interface RunnerStateStoreOps {
  get(id: SandboxId, kind: string): Promise<RunnerStateRecord | null>;
  getByHandle(
    kind: string,
    handle: string,
  ): Promise<RunnerStateRecordWithId | null>;
  put(id: SandboxId, kind: string, entry: RunnerStatePut): Promise<void>;
  delete(id: SandboxId, kind: string): Promise<void>;
  deleteByHandle(kind: string, handle: string): Promise<void>;
}

/** Pluggable persistence; storage-agnostic so this package stays DB-free. */
export interface RunnerStateStore extends RunnerStateStoreOps {
  /**
   * Cross-pod serialization for concurrent `ensure()` on the same (id, kind).
   * Must transactionally release on connection loss so a crashed pod never
   * strands a sandbox. The callback receives a scoped ops view bound to the
   * lock's connection — use it for any reads/writes inside the critical
   * section so nested queries don't race the main pool. Optional in tests;
   * prod deploys MUST implement it.
   */
  withLock?<T>(
    id: SandboxId,
    kind: string,
    fn: (store: RunnerStateStoreOps) => Promise<T>,
  ): Promise<T>;
}
