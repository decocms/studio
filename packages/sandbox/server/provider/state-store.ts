import type { SandboxId } from "./types";

/** Persisted per AgentSandbox identity. `state` is an opaque runner-private blob. */
export interface AgentSandboxStateRecord {
  handle: string;
  state: Record<string, unknown>;
  updatedAt: Date;
}

/** Like AgentSandboxStateRecord but carries the SandboxId (handle-only lookups after restart). */
export interface AgentSandboxStateRecordWithId extends AgentSandboxStateRecord {
  id: SandboxId;
}

export interface AgentSandboxStatePut {
  handle: string;
  state: Record<string, unknown>;
}

/**
 * CRUD operations on AgentSandbox state. Kept separate from
 * `AgentSandboxStateStore` so
 * `withLock` can hand callers a connection-scoped view (same pg txn as the
 * advisory lock) without exposing DB types. Nested reads/writes inside the
 * lock go through this scoped store — not `this.stateStore` — which is what
 * prevents main-pool starvation during long provisioning.
 */
export interface AgentSandboxStateStoreOps {
  get(id: SandboxId): Promise<AgentSandboxStateRecord | null>;
  getByHandle(handle: string): Promise<AgentSandboxStateRecordWithId | null>;
  put(id: SandboxId, entry: AgentSandboxStatePut): Promise<void>;
  delete(id: SandboxId): Promise<void>;
  deleteByHandle(handle: string): Promise<void>;
}

/** AgentSandbox persistence; storage-agnostic so this package stays DB-free. */
export interface AgentSandboxStateStore extends AgentSandboxStateStoreOps {
  /**
   * Cross-pod serialization for concurrent `ensure()` on the same identity.
   * Must transactionally release on connection loss so a crashed pod never
   * strands a sandbox. The callback receives a scoped ops view bound to the
   * lock's connection — use it for any reads/writes inside the critical
   * section so nested queries don't race the main pool. Optional in tests;
   * prod deploys MUST implement it.
   */
  withLock?<T>(
    id: SandboxId,
    fn: (store: AgentSandboxStateStoreOps) => Promise<T>,
  ): Promise<T>;
}
