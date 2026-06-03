/**
 * Public surface. `cluster` (agent-sandbox) sits behind its own subpath export
 * (./provider/agent-sandbox) because its SDK is heavy and not every deploy
 * needs it. `desktop` is constructed per-run from the acting user's link entry.
 */

import type { SandboxProviderKind } from "./types";

export type {
  EnsureOptions,
  ProxyRequestInit,
  SandboxProviderKind,
  Sandbox,
  SandboxId,
  SandboxProvider,
  Workload,
} from "./types";
export type { ClaimFailureReason, ClaimPhase } from "./lifecycle-types";
export { sandboxIdKey } from "./types";
// Needed by mesh callers (decopilot dispatch-run) that compute handles
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

const SANDBOX_PROVIDER_KINDS: ReadonlySet<SandboxProviderKind> = new Set([
  "cluster",
  "user-desktop",
]);

/**
 * Single resolution rule:
 *   - explicit STUDIO_SANDBOX_PROVIDER wins (validated against the kind set);
 *   - otherwise default to "user-desktop" (the user's desktop link daemon —
 *     auto-spawned by `bun run dev` in local dev, and the supported
 *     topology for single-machine self-hosts running the link side-by-side).
 *
 * Production deploys MUST set STUDIO_SANDBOX_PROVIDER explicitly to
 * "cluster" — the default is only meaningful when paired with a co-located
 * link binary.
 */
export function resolveSandboxProviderKindFromEnv(): SandboxProviderKind {
  const raw = process.env.STUDIO_SANDBOX_PROVIDER;
  const kind = (
    raw && raw.length > 0 ? raw : "user-desktop"
  ) as SandboxProviderKind;
  if (!SANDBOX_PROVIDER_KINDS.has(kind)) {
    throw new Error(
      `Unknown STUDIO_SANDBOX_PROVIDER="${raw}" — expected "cluster" or "user-desktop".`,
    );
  }
  return kind;
}
