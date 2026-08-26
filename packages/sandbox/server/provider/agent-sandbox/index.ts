export { AgentSandboxProvider, PREVIEW_NOT_READY_HEADER } from "./runner";
export { parseTenantPools } from "./tenant-pools";
// Lifecycle types live in their own module (no K8s deps) so type-only
// consumers — notably the studio web bundle — can import them safely.
export type { ClaimFailureReason, ClaimPhase } from "./lifecycle-types";
