/**
 * Notify Strategy Interface
 *
 * Abstraction for how to notify the event bus worker that new events are available.
 * This allows different notification mechanisms:
 * - PostgreSQL: LISTEN/NOTIFY
 * - Redis: Pub/Sub (future)
 * - NATS: Subscribe (future)
 *
 * If no strategy is provided, the worker falls back to polling.
 */

/**
 * NotifyStrategy allows the event bus to wake up the worker immediately
 * when new events are published, instead of waiting for the next poll interval.
 */
export interface NotifyStrategy {
  /**
   * Start listening for notifications.
   * When a notification is received, call onNotify to wake up the worker.
   */
  start(onNotify: () => void): Promise<void>;

  /**
   * Stop listening for notifications.
   */
  stop(): Promise<void>;

  /**
   * Send a notification that new events are available.
   * Called after publishing an event to wake up workers immediately.
   *
   * @param eventId - The ID of the newly published event (for debugging/logging)
   */
  notify(eventId: string): Promise<void>;
}

/**
 * Compose multiple notify strategies into one.
 *
 * This allows combining different notification mechanisms, e.g.:
 * - PostgreSQL LISTEN/NOTIFY for immediate event-driven notifications
 * - Polling as a safety net for missed notifications
 *
 * @example
 * ```ts
 * import { compose } from "./notify-strategy";
 * import { NatsNotifyStrategy } from "./nats-notify";
 *
 * const strategy = compose(
 *   new NatsNotifyStrategy(natsProvider),  // Primary: NATS pub/sub
 * );
 * ```
 */
export function compose(...strategies: NotifyStrategy[]): NotifyStrategy {
  return {
    async start(onNotify: () => void): Promise<void> {
      // Start all strategies with the same callback
      await Promise.all(strategies.map((s) => s.start(onNotify)));
    },

    async stop(): Promise<void> {
      // Stop all strategies
      await Promise.all(
        strategies.map((s) =>
          s.stop().catch((error) => {
            console.error("[NotifyStrategy] Error stopping strategy:", error);
          }),
        ),
      );
    },

    async notify(eventId: string): Promise<void> {
      // Notify all strategies (fire and forget for non-critical)
      await Promise.all(
        strategies.map((s) =>
          s.notify(eventId).catch((error) => {
            console.warn(
              "[NotifyStrategy] Notify failed (non-critical):",
              error,
            );
          }),
        ),
      );
    },
  };
}
