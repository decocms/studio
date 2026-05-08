// Re-exported so external tooling can build a KubeConfig without
// declaring @kubernetes/client-node itself.
export { KubeConfig } from "@kubernetes/client-node";
export { K8S_CONSTANTS, SandboxError, SandboxTimeoutError } from "./constants";
export {
  createHttpRoute,
  createSandboxClaim,
  deleteHttpRoute,
  deleteSandboxClaim,
  getHttpRoute,
  getSandboxClaim,
  HTTPROUTE_CONSTANTS,
  waitForSandboxReady,
} from "./client";
export type {
  HttpRoute,
  SandboxClaim,
  SandboxClaimEnvVar,
  SandboxCondition,
  SandboxResource,
} from "./client";
export { AgentSandboxRunner } from "./runner";
export type { AgentSandboxRunnerOptions } from "./runner";
// Lifecycle types live in their own module (no K8s deps) so type-only
// consumers — notably the studio web bundle — can import them safely.
export type { ClaimFailureReason, ClaimPhase } from "./lifecycle-types";
export type { WatchClaimLifecycleOptions } from "./lifecycle-watcher";
