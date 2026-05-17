/**
 * Per-pod control via docker compose. Tests use these to simulate pod
 * death, restart, or to inspect logs for assertions.
 *
 * Failure-injection helpers (kill, stop, restart) operate on the compose
 * service name (e.g. "mesh-1"); the test never speaks Docker directly.
 */

import type { PodName } from "./pods";

const COMPOSE_FILE = new URL("../docker-compose.yml", import.meta.url).pathname;

async function compose(...args: string[]): Promise<string> {
  const proc = Bun.spawn(["docker", "compose", "-f", COMPOSE_FILE, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(
      `docker compose ${args.join(" ")} exited ${code}: ${stderr || stdout}`,
    );
  }
  return stdout;
}

/**
 * SIGKILL the pod. Simulates abrupt host loss — no graceful shutdown, no
 * Hono cleanup hooks, no DBOS deregister. Use this for the "did DBOS
 * recovery work" scenarios.
 */
export async function kill(pod: PodName): Promise<void> {
  await compose("kill", "-s", "SIGKILL", pod);
}

/** SIGTERM, allowing the pod to drain. Closer to a rolling-deploy stop. */
export async function stop(pod: PodName): Promise<void> {
  await compose("stop", pod);
}

/** Bring a stopped/killed pod back up. */
export async function start(pod: PodName): Promise<void> {
  await compose("start", pod);
}

/**
 * Return the pod's full container logs since boot. Useful for asserting
 * "after pod B died, pod A's logs mention picking up the workflow".
 */
export async function logs(pod: PodName): Promise<string> {
  return compose("logs", "--no-color", pod);
}

/** Polling-friendly: does the pod's log output contain this substring? */
export async function logsContain(
  pod: PodName,
  needle: string,
): Promise<boolean> {
  const out = await logs(pod);
  return out.includes(needle);
}
