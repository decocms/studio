export {
  AgentSandboxProvider,
  PREVIEW_NOT_READY_HEADER,
  type PortForwarder,
} from "./runner";
import type { AgentSandboxProvider } from "./runner";

/** What Studio calls, served in-process or by `RemoteSandboxProvider`. */
export type SandboxProvider = Pick<
  AgentSandboxProvider,
  | "ensure"
  | "delete"
  | "lastTermination"
  | "alive"
  | "watchClaimLifecycle"
  | "hasSchedulableCapacity"
  | "getPreviewUrl"
  | "proxyDaemonRequest"
  | "adoptLiveClaim"
  | "resolvePreviewUpstreamUrl"
  | "proxyPreviewRequest"
  | "markTenantPoolsDirty"
  | "releaseAfter"
  | "renewTtl"
  | "close"
>;
export {
  parseTenantPools,
  repoKeyFromCloneUrl,
  type TenantPool,
} from "./tenant-pools";
// Lifecycle types live in their own module (no K8s deps) so type-only
// consumers — notably the studio web bundle — can import them safely.
export type { ClaimFailureReason, ClaimPhase } from "./lifecycle-types";
