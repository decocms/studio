/**
 * Operational signals for the durable projector (spec §5.4 red-team):
 *  - `decopilot.projector.poison_runs`: counter of runs that exhausted retries
 *    and hit the DLQ (so alerting fires without log scraping).
 *
 * Instrument style mirrors `nats-stream-buffer.ts`'s `publishErrorsCounter`.
 */
import { meter } from "@/observability";

const poisonRunsCounter = meter.createCounter(
  "decopilot.projector.poison_runs",
  {
    description:
      "Number of decopilot runs that exhausted retries and were sent to the DLQ",
    unit: "{runs}",
  },
);

/**
 * Projector lag in ms: how long ago the message was published. Clamped at 0 so
 * clock skew (now < publish time) never reports negative lag.
 */
export function computeLagMs(publishedAtMs: number, nowMs: number): number {
  return Math.max(0, nowMs - publishedAtMs);
}

/**
 * Record a poisoned run that hit the DLQ. The counter is tagged by org.id only
 * (low cardinality) — mirroring `publishErrorsCounter` in nats-stream-buffer.ts.
 * `runId` is deliberately NOT a metric attribute: it is unique per run, so
 * tagging by it would explode the time-series cardinality. The runId belongs in
 * the DLQ log line (emitted by the caller's onRunErrored/onDlq), not the metric.
 * Falls back to "unknown" when org context isn't available at the call site.
 */
export function recordPoison(runId: string, orgId?: string): void {
  void runId;
  poisonRunsCounter.add(1, { "org.id": orgId ?? "unknown" });
}
