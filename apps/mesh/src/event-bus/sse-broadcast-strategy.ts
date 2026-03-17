/**
 * SSE Broadcast Strategy Interface
 *
 * Abstraction for how SSE events are broadcast across processes.
 * Uses NATS pub/sub to ensure SSE clients on any pod receive events
 * published from any other pod.
 *
 * Mirrors the NotifyStrategy pattern used for event bus worker wake-up.
 */

import type { SSEEvent } from "./sse-hub";

/**
 * Callback that delivers an event to local SSE listeners.
 * Provided by SSEHub when starting the strategy.
 */
export type LocalEmitFn = (organizationId: string, event: SSEEvent) => void;

export interface SSEBroadcastStrategy {
  /**
   * Start the broadcast strategy.
   * @param localEmit - Callback to deliver events to SSE listeners on this process
   */
  start(localEmit: LocalEmitFn): Promise<void>;

  /**
   * Broadcast an event to all processes (including this one).
   * The strategy is responsible for calling localEmit on every process.
   */
  broadcast(organizationId: string, event: SSEEvent): void;

  /** Stop the strategy and release resources. */
  stop(): Promise<void>;
}
