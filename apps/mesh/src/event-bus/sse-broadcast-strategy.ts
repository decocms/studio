/**
 * SSE Broadcast Strategy Interface
 *
 * Abstraction for how SSE events are broadcast across processes.
 * In a single-process deployment, events are emitted locally.
 * In multi-pod deployments (K8s), a cross-process strategy (e.g., NATS)
 * ensures SSE clients on any pod receive events published from any other pod.
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

/**
 * Local-only broadcast — events are emitted to the current process only.
 * Suitable for single-process deployments and local development.
 */
export class LocalSSEBroadcast implements SSEBroadcastStrategy {
  private localEmit: LocalEmitFn | null = null;

  async start(localEmit: LocalEmitFn): Promise<void> {
    this.localEmit = localEmit;
  }

  broadcast(organizationId: string, event: SSEEvent): void {
    this.localEmit?.(organizationId, event);
  }

  async stop(): Promise<void> {
    this.localEmit = null;
  }
}
