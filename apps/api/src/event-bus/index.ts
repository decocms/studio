/**
 * SSE Hub Module
 *
 * Cross-pod Server-Sent Events fan-out for real-time streaming (e.g. decopilot
 * run updates). Uses NATS pub/sub to broadcast events to listeners connected to
 * any pod.
 *
 * Usage:
 * ```ts
 * startSSEHub(natsProvider);
 * ```
 */

import { retry, RetryError } from "@decocms/shared/std";
import type { NatsConnectionProvider } from "../nats/connection";
import { NatsSSEBroadcast } from "./nats-sse-broadcast";
import { sseHub } from "./sse-hub";

export { sseHub, type SSEEvent } from "./sse-hub";

async function startWithRetry(
  label: string,
  fn: () => Promise<void>,
  maxRetries = 5,
): Promise<void> {
  try {
    await retry(fn, {
      maxAttempts: maxRetries,
      minTimeout: 1000,
      maxTimeout: 10_000,
      jitter: 0,
    });
  } catch (err) {
    // Log and swallow — a deferred start failing must not crash the process.
    console.error(
      `${label} Deferred start failed:`,
      err instanceof RetryError ? err.cause : err,
    );
  }
}

/**
 * Start the SSE hub with NATS cross-pod broadcast.
 *
 * @param natsProvider - Shared NATS connection provider (required)
 */
export function startSSEHub(natsProvider: NatsConnectionProvider): void {
  const sseBroadcast = new NatsSSEBroadcast({
    getConnection: () => natsProvider.getConnection(),
  });

  sseHub.start(sseBroadcast).catch((err) => {
    console.error("[SSEHub] Failed to start broadcast strategy:", err);
  });

  natsProvider.onReady(() => {
    startWithRetry("[NatsSSEBroadcast]", () => sseBroadcast.start());
  });
}
