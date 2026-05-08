/**
 * Docker-only sweeps. Other runners' sandboxes outlive mesh by design — a
 * polymorphic sweep would nuke user VMs on K8s rolling restart. So this
 * lives on `DockerSandboxRunner`, not on the `SandboxRunner` interface.
 */

import { DockerSandboxRunner, type DockerRunnerOptions } from "./runner";

const BOOT_SWEEP_KEY = Symbol.for("mesh.sandbox.bootSweepDone");

export type SweepDockerOrphansOnBootOptions = Pick<
  DockerRunnerOptions,
  "labelPrefix" | "exec"
>;

/**
 * Runs once per process to clean up crashed/SIGKILL'd prior runs.
 * Uses `globalThis` (not module scope) because `bun --hot` re-runs top-level
 * awaits on every save — that would otherwise kill the actively-previewed
 * sandbox. A real restart gets a fresh globalThis, so the sweep still fires.
 * Best-effort; failures are logged and never block startup.
 */
export async function sweepDockerOrphansOnBoot(
  opts: SweepDockerOrphansOnBootOptions = {},
): Promise<void> {
  const g = globalThis as Record<symbol, unknown>;
  if (g[BOOT_SWEEP_KEY]) return;
  g[BOOT_SWEEP_KEY] = true;
  try {
    const runner = new DockerSandboxRunner(opts);
    const n = await runner.sweepOrphans();
    if (n > 0) {
      console.log(`[sandbox] Boot sweep: stopped ${n} stale container(s).`);
    }
  } catch (err) {
    console.warn(
      "[sandbox] Boot sweep failed (continuing without it):",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Caveat: filters only by `studio-sandbox=1`, so multiple studio pods sharing
 * one docker host would nuke each other's containers on SIGTERM. Fine for
 * single-pod-per-host (the only sane docker deployment shape today).
 */
export async function sweepDockerOrphansOnShutdown(
  runner: DockerSandboxRunner | null,
): Promise<void> {
  if (!runner) return;
  console.log("[shutdown] Sweeping docker sandbox containers...");
  try {
    const n = await runner.sweepOrphans();
    if (n > 0) {
      console.log(`[shutdown] Swept ${n} sandbox container(s).`);
    }
  } catch (err) {
    console.error("[shutdown] Sandbox sweep error:", err);
  }
}
