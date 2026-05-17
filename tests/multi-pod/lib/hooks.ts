/**
 * Standard test hooks for multi-pod scenarios.
 *
 * Call `registerTestHooks()` at the top of each scenario file. It (1)
 * restarts any mesh pods that were left stopped by a previous scenario
 * (the pod-death scenarios SIGKILL pods and don't currently restore
 * them themselves) and (2) waits for every pod to report /health/live
 * before any test body runs.
 */

import { beforeAll } from "bun:test";
import { waitReady } from "./cluster";
import { start } from "./pod";
import { ALL_PODS } from "./pods";

const COMPOSE_FILE = new URL("../docker-compose.yml", import.meta.url).pathname;

async function restoreStoppedPods(): Promise<void> {
  const proc = Bun.spawn(
    [
      "docker",
      "compose",
      "-f",
      COMPOSE_FILE,
      "ps",
      "-a",
      "--format",
      "{{.Service}}\t{{.State}}",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  // Fail loudly: if compose can't even list services (daemon down,
  // compose file moved, etc.), silently treating it as "no pods to
  // restore" turns the real failure into a 2-minute waitReady timeout
  // with a misleading "mesh-1 not healthy" message.
  if (code !== 0) {
    throw new Error(
      `docker compose ps failed (exit ${code}): ${err.trim() || out.trim() || "<no output>"}`,
    );
  }

  const services = new Set(ALL_PODS.map((p) => p.service as string));
  const lines = out.split("\n").filter(Boolean);
  await Promise.all(
    lines.map(async (line) => {
      const [service, state] = line.split("\t");
      if (
        service &&
        services.has(service) &&
        state &&
        state.toLowerCase() !== "running"
      ) {
        // `docker compose start` is a no-op if the container is already
        // running — we only reach here when it's stopped/exited.
        await start(service as never).catch(() => {
          /* best effort; waitReady will surface a real problem */
        });
      }
    }),
  );
}

export function registerTestHooks(): void {
  beforeAll(async () => {
    await restoreStoppedPods();
    await waitReady();
  }, 180_000);
}
