/**
 * Public surface. `agent-sandbox` sits behind its own subpath export
 * (./provider/agent-sandbox) because its SDK is heavy and not every deploy
 * needs it. `desktop` is constructed per-run from the acting user's link entry.
 */

import {
  normalizeSandboxProviderKind,
  type LegacySandboxProviderKind,
  type SandboxProviderKind,
} from "./types";

export type {
  EnsureOptions,
  LegacySandboxProviderKind,
  ProxyRequestInit,
  SandboxDaemonImpl,
  SandboxProviderKind,
  Sandbox,
  SandboxId,
  SandboxProvider,
  Workload,
} from "./types";
export type { ClaimFailureReason, ClaimPhase } from "./lifecycle-types";
export {
  normalizeSandboxProviderKind,
  sandboxDaemonImplSchema,
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

function isSandboxProviderKind(
  kind: string,
): kind is LegacySandboxProviderKind {
  return (
    kind === "agent-sandbox" || kind === "cluster" || kind === "user-desktop"
  );
}

/**
 * Single resolution rule:
 *   - explicit STUDIO_SANDBOX_PROVIDER wins (validated against the kind set);
 *   - otherwise default to "user-desktop" (the user's desktop link daemon —
 *     auto-spawned by `bun run dev` in local dev, and the supported
 *     topology for single-machine self-hosts running the link side-by-side).
 *
 * Production deploys MUST set STUDIO_SANDBOX_PROVIDER explicitly to
 * "agent-sandbox" (legacy "cluster" is accepted) — the default is only
 * meaningful when paired with a co-located link binary.
 */
export function resolveSandboxProviderKindFromEnv(): SandboxProviderKind {
  const raw = process.env.STUDIO_SANDBOX_PROVIDER;
  const kind = raw && raw.length > 0 ? raw : "user-desktop";
  if (!isSandboxProviderKind(kind)) {
    throw new Error(
      `Unknown STUDIO_SANDBOX_PROVIDER="${raw}" — expected "agent-sandbox", "cluster", or "user-desktop".`,
    );
  }
  return normalizeSandboxProviderKind(kind);
}
