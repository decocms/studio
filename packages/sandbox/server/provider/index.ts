/**
 * Public surface. `agent-sandbox` sits behind its own subpath export
 * (./provider/agent-sandbox) because its SDK is heavy and not every deploy
 * needs it. The public contract retains the persisted desktop kind while the
 * native migration is rolled out; the hosted API constructs only agent-sandbox.
 */

export type {
  EnsureOptions,
  LegacySandboxProviderKind,
  ProxyRequestInit,
  SandboxProviderKind,
  Sandbox,
  SandboxId,
  SandboxProvider,
  Workload,
} from "./types";
export type { ClaimFailureReason, ClaimPhase } from "./lifecycle-types";
export {
  normalizeSandboxProviderKind,
  sandboxIdKey,
  sandboxProviderKindSchema,
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
