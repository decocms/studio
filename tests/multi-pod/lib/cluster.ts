/**
 * Cluster lifecycle for multi-pod tests.
 *
 * Wraps `docker compose` so test files don't have to know about it. The
 * usual flow is run.sh-managed (bring cluster up before tests, tear down
 * after), but `up()` / `down()` are exposed for ad-hoc local debugging.
 */

import { pollUntil } from "./poll-until";
import { ALL_PODS } from "./pods";

const COMPOSE_FILE = new URL("../docker-compose.yml", import.meta.url).pathname;

async function compose(...args: string[]): Promise<void> {
  const proc = Bun.spawn(["docker", "compose", "-f", COMPOSE_FILE, ...args], {
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`docker compose ${args.join(" ")} exited ${code}`);
  }
}

/**
 * Bring the cluster up and wait until all mesh pods report /health/live.
 *
 * We don't pass `--wait` to docker compose because the one-shot `migrate`
 * service (`Exited 0` once schemas are created) is mis-classified as a
 * failure by `--wait` and exits non-zero. The `waitReady()` poll below
 * is the source of truth for readiness instead — same approach as
 * `run.sh`.
 */
export async function up(): Promise<void> {
  await compose("up", "-d", "--build");
  await waitReady();
}

/** `docker compose down -v` — destroys volumes too. */
export async function down(): Promise<void> {
  await compose("down", "-v");
}

/** Poll /health/live on each pod until all respond 200. */
export async function waitReady(timeoutMs = 120_000): Promise<void> {
  await Promise.all(
    ALL_PODS.map((pod) =>
      pollUntil(
        async () => {
          const res = await fetch(`${pod.baseUrl}/health/live`).catch(
            () => null,
          );
          return res?.ok ?? false;
        },
        {
          timeoutMs,
          intervalMs: 1000,
          label: `wait-ready:${pod.service}`,
        },
      ),
    ),
  );
}
