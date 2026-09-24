/**
 * Public surface. The hosted provider (`./provider/remote`) talks to the
 * sandbox controller. `local-api` remains in shared persisted/native contracts
 * but has no server-side provider implementation.
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
export type { HostedSandboxProvider } from "./hosted";
export type { ClaimFailureReason, ClaimPhase } from "./lifecycle-types";
export { PREVIEW_NOT_READY_HEADER } from "./shared/preview-proxy";
export { createSandboxFsHooks } from "./sandbox-fs-hooks";
