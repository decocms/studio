/**
 * Standard test hooks for multi-pod scenarios.
 *
 * Call `registerTestHooks()` at the top of each scenario file. It:
 *   1. Clears DBOS workflow state from prior scenarios so a pod that's
 *      about to restart (next step) doesn't re-execute someone else's
 *      half-finished workflow on boot.
 *   2. Restarts any mesh pods that were left stopped by a previous
 *      scenario (the pod-death scenarios SIGKILL pods and don't restore
 *      them themselves).
 *   3. Waits for every pod to report /health/live before any test body
 *      runs.
 *
 * Order matters: 1 must precede 2 — if we clean DBOS state after the
 * dead pod is back up, it has a window to start recovery against the
 * stale rows before we delete them, and the next scenario races a
 * ghost workflow.
 */

import { beforeAll } from "bun:test";
import { waitReady } from "./cluster";
import { dbQuery } from "./db";
import { start } from "./pod";
import { ALL_PODS } from "./pods";

const COMPOSE_FILE = new URL("../docker-compose.yml", import.meta.url).pathname;

/**
 * DELETE every DBOS workflow row from prior scenarios.
 *
 * Background: when pod-death scenarios SIGKILL a pod, DBOS's
 * `workflow_status` table is left with the dead pod's in-progress
 * workflows. When that pod (or any pod sharing its executor_id) boots
 * later, DBOS's launch-time recovery re-executes those workflows — which
 * publishes chunks to a thread's JetStream subject long after the
 * originating test scenario has ended. Subsequent scenarios then see
 * "phantom" runs they didn't initiate.
 *
 * The FK constraints DBOS sets up (`ON DELETE CASCADE` to
 * operation_outputs, workflow_inputs, notifications, workflow_events)
 * mean a single DELETE on workflow_status takes the rest with it.
 * workflow_queue isn't FK'd back to workflow_status, so it gets its
 * own DELETE.
 */
async function clearDbosState(): Promise<void> {
  await dbQuery("DELETE FROM dbos.workflow_status");
  await dbQuery("DELETE FROM dbos.workflow_queue");
}

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
    await clearDbosState();
    await restoreStoppedPods();
    await waitReady();
  }, 180_000);
}
