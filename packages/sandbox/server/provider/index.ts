/**
 * Public surface. `agent-sandbox` sits behind its own subpath export
 * (./provider/agent-sandbox) because its SDK is heavy and not every deploy
 * needs it. `local-api` remains in shared persisted/native contracts but
 * has no server-side provider implementation.
 */

export type {
  EnsureOptions,
  EnsureRepo,
  PodTermination,
  SandboxPurpose,
  Sandbox,
  SandboxId,
  Workload,
} from "./types";
// Needed by studio callers (decopilot dispatch-run) that compute handles
// directly. Re-exported here so consumers don't dig into shared/.
export { computeHandle } from "./shared";
export type {
  RunnerStateRecord,
  RunnerStateRecordWithId,
  RunnerStatePut,
  RunnerStateStore,
  RunnerStateStoreOps,
} from "./state-store";
export { composeSandboxRef } from "./sandbox-ref";
export { createSandboxFsHooks } from "./sandbox-fs-hooks";
