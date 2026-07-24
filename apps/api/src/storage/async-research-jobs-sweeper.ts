/**
 * Periodic sweeper that flips stale `async_research_jobs` rows to
 * status='abandoned'. Without this, a row whose pod died before the
 * runtime could mark it `failed` or `cancelled` would sit in `polling`
 * forever, hiding from "is anything stuck?" queries.
 *
 * Defaults: sweep every 5 minutes, abandon anything that hasn't been
 * polled in 1 hour. Gemini Deep Research worst-case is around 20min, so
 * 1h leaves enough margin for slow runs while still bounding cleanup
 * time at one heartbeat interval.
 *
 * The sweeper writes nothing if nothing is stale — DB cost is one
 * partial-index scan per tick.
 */

import type { AsyncResearchJobStoragePort } from "./ports";

const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_STALE_AFTER_MS = 60 * 60 * 1000;

export interface AsyncResearchJobSweeperOptions {
  intervalMs?: number;
  staleAfterMs?: number;
}

export class AsyncResearchJobSweeper {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly storage: AsyncResearchJobStoragePort,
    private readonly options: AsyncResearchJobSweeperOptions = {},
  ) {}

  start(): void {
    if (this.timer) return;
    const interval = this.options.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.timer = setInterval(() => {
      void this.runOnce();
    }, interval);
  }

  /** Exposed so tests can drive a single tick deterministically. */
  async runOnce(): Promise<number> {
    const staleAfterMs = this.options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    try {
      const n = await this.storage.sweepAbandoned(staleAfterMs);
      if (n > 0) {
        console.log(
          `[async-research-sweeper] marked ${n} stale jobs as abandoned`,
        );
      }
      return n;
    } catch (err) {
      console.error("[async-research-sweeper] sweep failed", err);
      return 0;
    }
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
