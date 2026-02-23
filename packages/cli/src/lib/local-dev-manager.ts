/**
 * Local-dev daemon lifecycle manager.
 *
 * Provides:
 * - probeLocalDev: check if local-dev is alive on a given port
 * - startLocalDev: spawn mcp-local-dev if not already running, wait for readiness
 * - stopLocalDev: send SIGTERM to the managed child process
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

const DEFAULT_PORT = 4201;
const READY_POLL_INTERVAL_MS = 500;
const READY_TIMEOUT_MS = 10_000;

/**
 * Probe whether a local-dev daemon is alive on the given port.
 *
 * Sends a GET to /_ready with a 500ms timeout.
 * Returns true if the response is OK, false otherwise.
 */
export async function probeLocalDev(
  port: number = DEFAULT_PORT,
): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/_ready`, {
      signal: AbortSignal.timeout(READY_POLL_INTERVAL_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Spawn the mcp-local-dev daemon for the given folder and wait for readiness.
 *
 * If local-dev is already running on the port, returns null immediately
 * (caller should treat null as "already running, no child to manage").
 *
 * Otherwise, spawns `mcp-local-dev <folder> --port <port>` and polls /_ready
 * every 500ms for up to 10 seconds. Throws if readiness is not reached.
 *
 * The process is kept attached (not detached) so Ctrl+C propagates to it.
 */
export async function startLocalDev(
  folder: string,
  port: number = DEFAULT_PORT,
): Promise<ChildProcess | null> {
  // If already running, nothing to do
  const alive = await probeLocalDev(port);
  if (alive) {
    return null;
  }

  const child = spawn("mcp-local-dev", [folder, "--port", String(port)], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Wait for /_ready with polling
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let ready = false;

  while (Date.now() < deadline) {
    await sleep(READY_POLL_INTERVAL_MS);
    if (await probeLocalDev(port)) {
      ready = true;
      break;
    }
  }

  if (!ready) {
    // Kill the child before throwing so we don't leave an orphan
    try {
      child.kill("SIGTERM");
    } catch {
      // Ignore kill errors
    }
    throw new Error(
      `local-dev failed to start on port ${port} within ${READY_TIMEOUT_MS / 1000}s`,
    );
  }

  return child;
}

/**
 * Stop a managed local-dev child process by sending SIGTERM.
 *
 * No-op if child is null or already killed.
 */
export function stopLocalDev(child: ChildProcess | null): void {
  if (!child) return;
  if (child.killed) return;
  try {
    child.kill("SIGTERM");
  } catch {
    // Ignore kill errors (process may have already exited)
  }
}

/** Simple sleep utility */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
