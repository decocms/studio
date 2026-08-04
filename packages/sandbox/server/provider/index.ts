/**
 * Public agent-sandbox provider surface. The implementation sits behind its
 * own subpath export because its SDK is heavy and not every deploy needs it.
 */

export type {
  EnsureOptions,
  ProxyRequestInit,
  Sandbox,
  SandboxId,
  Workload,
} from "./types";
export type { ClaimFailureReason, ClaimPhase } from "./lifecycle-types";
export { sandboxIdKey } from "./types";
// Needed by Studio callers (hosted Decopilot runs) that compute handles
// directly. Re-exported here so consumers don't dig into shared/.
export { computeHandle } from "./shared";
export {
  composeSandboxRef,
  type AgentSandboxRefInput,
  type SandboxRefInput,
  type ThreadSandboxRefInput,
} from "./sandbox-ref";
export {
  createSandboxFsHooks,
  type SandboxFsBashOpts,
  type SandboxFsBashResult,
  type SandboxFsEdit,
  type SandboxFsGrepHit,
  type SandboxFsGrepOpts,
  type SandboxFsHooks,
  type SandboxFsHooksLifecycle,
} from "./sandbox-fs-hooks";
