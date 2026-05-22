/**
 * Public surface. Ships `DockerSandboxProvider` only via the default entry;
 * agent-sandbox sits behind its own subpath export (./provider/agent-sandbox)
 * because its SDK is heavy and not every deploy needs it. `desktop` is
 * constructed per-run from the acting user's link entry.
 */

import { DockerSandboxProvider, type DockerProviderOptions } from "./docker";
import type { RunnerStateStore } from "./state-store";
import type { SandboxProviderKind, SandboxProvider } from "./types";

export type {
  EnsureOptions,
  ExecInput,
  ExecOutput,
  ProxyRequestInit,
  SandboxProviderKind,
  Sandbox,
  SandboxId,
  SandboxProvider,
  Workload,
} from "./types";
export type { ClaimFailureReason, ClaimPhase } from "./lifecycle-types";
export { sandboxIdKey } from "./types";
export { DockerSandboxProvider } from "./docker";
export type { DockerExec, DockerProviderOptions, ExecResult } from "./docker";
// Needed by mesh callers (decopilot dispatch-run) that compute handles
// directly. Re-exported here so consumers don't dig into shared/.
export { computeHandle } from "./shared";
export { ensureSandboxImage } from "../image-build";
export type { EnsureImageOptions } from "../image-build";
export { startLocalSandboxIngress } from "./docker";
export {
  sweepDockerOrphansOnBoot,
  sweepDockerOrphansOnShutdown,
} from "./docker";
export type { SweepDockerOrphansOnBootOptions } from "./docker";
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

export interface CreateDockerProviderOptions {
  stateStore?: RunnerStateStore;
  docker?: Omit<DockerProviderOptions, "stateStore">;
}

/** Convenience for host apps wiring only the in-package provider. */
export function createDockerProvider(
  opts: CreateDockerProviderOptions = {},
): SandboxProvider {
  return new DockerSandboxProvider({
    ...opts.docker,
    stateStore: opts.stateStore,
  });
}

const RUNNER_KINDS: ReadonlySet<SandboxProviderKind> = new Set([
  "local-docker",
  "cluster",
  "user-desktop",
]);

/**
 * Single resolution rule:
 *   - explicit STUDIO_SANDBOX_RUNNER wins (validated against the kind set);
 *   - otherwise default to "user-desktop" (the user's desktop link daemon —
 *     auto-spawned by `bun run dev` in local dev, and the supported
 *     topology for single-machine self-hosts running the link side-by-side).
 *
 * Production deploys MUST set STUDIO_SANDBOX_RUNNER explicitly to
 * "local-docker" or "cluster" — the default is only meaningful when paired
 * with a co-located link binary.
 */
export function resolveSandboxProviderKindFromEnv(): SandboxProviderKind {
  const raw = process.env.STUDIO_SANDBOX_RUNNER;
  const kind = (
    raw && raw.length > 0 ? raw : "user-desktop"
  ) as SandboxProviderKind;
  if (!RUNNER_KINDS.has(kind)) {
    throw new Error(
      `Unknown STUDIO_SANDBOX_RUNNER="${raw}" — expected "local-docker", "cluster", or "user-desktop".`,
    );
  }
  return kind;
}
