/**
 * Public surface. Ships `DockerSandboxRunner` only via the default entry;
 * agent-sandbox sits behind its own subpath export (./runner/agent-sandbox)
 * because its SDK is heavy and not every deploy needs it.
 */

import { DockerSandboxRunner, type DockerRunnerOptions } from "./docker";
import type { RunnerStateStore } from "./state-store";
import type { RunnerKind, SandboxRunner } from "./types";

export type {
  EnsureOptions,
  ExecInput,
  ExecOutput,
  ProxyRequestInit,
  RunnerKind,
  Sandbox,
  SandboxId,
  SandboxRunner,
  Workload,
} from "./types";
export type { ClaimFailureReason, ClaimPhase } from "./lifecycle-types";
export { sandboxIdKey } from "./types";
export { DockerSandboxRunner } from "./docker";
export type { DockerExec, DockerRunnerOptions, ExecResult } from "./docker";
export { HostSandboxRunner } from "./host";
export type { HostRunnerOptions } from "./host";
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

export interface CreateDockerRunnerOptions {
  stateStore?: RunnerStateStore;
  docker?: Omit<DockerRunnerOptions, "stateStore">;
}

/** Convenience for host apps wiring only the in-package runner. */
export function createDockerRunner(
  opts: CreateDockerRunnerOptions = {},
): SandboxRunner {
  return new DockerSandboxRunner({
    ...opts.docker,
    stateStore: opts.stateStore,
  });
}

const RUNNER_KINDS: ReadonlySet<RunnerKind> = new Set([
  "host",
  "docker",
  "agent-sandbox",
]);

/**
 * Single resolution rule:
 *   - explicit STUDIO_SANDBOX_RUNNER wins (validated against the kind set);
 *   - otherwise default to "host".
 *
 * Docker CLI presence is not probed. Any non-host runner must be opted into
 * explicitly.
 */
export function resolveRunnerKindFromEnv(): RunnerKind {
  const raw = process.env.STUDIO_SANDBOX_RUNNER;
  const kind = (raw && raw.length > 0 ? raw : "host") as RunnerKind;
  if (!RUNNER_KINDS.has(kind)) {
    throw new Error(
      `Unknown STUDIO_SANDBOX_RUNNER="${raw}" — expected "host", "docker", or "agent-sandbox".`,
    );
  }
  return kind;
}
