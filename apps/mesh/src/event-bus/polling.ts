/**
 * Polling Notify Strategy
 *
 * A simple timer-based polling approach for triggering event processing.
 * The timer fires at regular intervals, triggering the worker to check for pending events.
 *
 * Use this when a pub/sub mechanism is not available (e.g., PGlite, file-based storage).
 */

import type { NotifyStrategy } from "./notify-strategy";

/**
 * Timer-based polling strategy for waking up the event bus worker.
 *
 * @example
 * ```ts
 * const strategy = new PollingStrategy(5000); // Poll every 5 seconds
 * ```
 */
export class PollingStrategy implements NotifyStrategy {
  private timer: Timer | null = null;
  private onNotify: (() => void) | null = null;

  /**
   * Create a polling strategy.
   *
   * @param intervalMs - How often to poll for new events (milliseconds)
   */
  constructor(private intervalMs: number) {}

  async start(onNotify: () => void): Promise<void> {
    if (this.timer) return; // Already started

    this.onNotify = onNotify;
    this.scheduleNext();
    console.log(`[Polling] Started polling every ${this.intervalMs}ms`);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      console.log("[Polling] Stopped polling");
    }
    this.onNotify = null;
  }

  async notify(_eventId: string): Promise<void> {
    // Optionally trigger immediate processing when an event is published.
    // This provides faster delivery while still having the timer as a backup.
    if (this.onNotify) {
      this.onNotify();
    }
  }

  private scheduleNext(): void {
    this.timer = setTimeout(() => {
      if (this.onNotify) {
        this.onNotify();
      }
      // Schedule next poll
      if (this.timer) {
        this.scheduleNext();
      }
    }, this.intervalMs);
  }
}
