/**
 * Process-wide gate on concurrent hosted agent-loop runs.
 *
 * Each hosted run (hostedHarnessWorkflow → runHostedHarness → dispatchRunFn)
 * drives a full in-process agent loop — LLM streaming + tool calls, ~300MB
 * working set with multi-hundred-MB JSON.parse spikes. The DBOS queue's
 * per-partition concurrency=1 only serializes ONE thread; nothing bounds how
 * many DISTINCT threads' runs a single worker pod executes at once, so a burst
 * can pile up unbounded loops and OOM the pod (2Gi limit). This caps concurrent
 * top-level runs per process — excess park and start as slots free (KEDA's CPU
 * trigger adds pods as the running load grows).
 *
 * DBOS `workerConcurrency` can't express this: in dbos-sdk it's enforced
 * per-partition (same scope as `concurrency`), not per-process across threads,
 * and it's rejected outright on the concurrency=1 queue. Mirrors the subagent
 * gate (subagent-concurrency.ts) and reuses its factory; the two gates compose
 * — subagent fan-out is bounded independently.
 *
 * The acquire sits INSIDE the DBOS step (`runHostedHarness`), so a parked run
 * just delays that step — the workflow's step sequence and recorded I/O are
 * unchanged (recovery-compatible; no DBOS_WORKFLOW_VERSION bump).
 *
 * DRAFT: limit is read from the environment with a conservative default. If we
 * keep this, move it into Settings (resolve-config.ts) so it's tunable per
 * deployment without an env redeploy.
 */

import { createConcurrencyGate } from "@/harnesses/decopilot/built-in-tools/subagent-concurrency";
import { meter } from "@/observability";

// A non-finite / non-positive env value would make the gate never block (fail
// OPEN — the exact unbounded OOM this file prevents), so guard the default.
// Default 3: prod worker is 768Mi request / 2Gi limit, run working set p90
// ~450MB — 3×450≈1.35GB stays under the limit, 4-5 would OOM on p90 alone, and
// a lower cap just parks more (which the KEDA queue-depth trigger can't see —
// parked runs are PENDING, not ENQUEUED). The 1.8GB JSON.parse tail can still
// OOM at any cap≥2; that's recovery's job, not this gate's.
const parsed = Number(process.env.DECOPILOT_MAX_CONCURRENT_HOSTED_RUNS);
const MAX = Number.isFinite(parsed) && parsed > 0 ? parsed : 3;

const gate = createConcurrencyGate(MAX);

// The gate caps memory, which flattens the CPU/memory signals a plain HPA scales
// on — so the backlog of PARKED runs is the only thing that reflects saturation.
// Export it as a gauge so a queue-depth/KEDA trigger can add workers when runs
// start waiting (parked runs are pinned to this pod; scaling relieves the queue,
// not the in-flight backlog).
meter
  .createObservableGauge("hosted_runs.active", {
    description: "Hosted agent-loop runs executing on this pod",
    unit: "{runs}",
  })
  .addCallback((r) => r.observe(gate.active));
meter
  .createObservableGauge("hosted_runs.pending", {
    description: "Hosted agent-loop runs parked waiting for a slot on this pod",
    unit: "{runs}",
  })
  .addCallback((r) => r.observe(gate.pending));

/**
 * Live gate stats for the `/hosted-run-pending` metrics-api endpoint (KEDA).
 * `pending` is the scale signal: parked runs are DBOS-PENDING (dequeued), so
 * they're invisible to the ENQUEUED-only queue-depth endpoint.
 */
export const hostedRunStats = (): {
  active: number;
  pending: number;
  max: number;
} => ({ active: gate.active, pending: gate.pending, max: MAX });

/**
 * Acquire a run slot. `onPark` fires (synchronously, before the wait) only when
 * this caller has to queue for a slot — the same condition the log below
 * reports. Callers use it to tell the user their run is waiting: a parked run
 * publishes nothing on its own, and silence on a run's subject is what the
 * projector's idle window reads as a dead executor (see
 * `hosted-harness-workflow.ts`'s `runHostedHarness`).
 */
export const acquireHostedRunSlot = (
  onPark?: () => void,
): Promise<() => void> => {
  // Log when a run parks so a saturating pod is visible in prod — the whole
  // point of the cap. (gate exposes active/pending for exactly this.)
  if (gate.active >= MAX) {
    console.log("[hostedHarness] run parked at concurrency cap", {
      active: gate.active,
      pending: gate.pending,
      max: MAX,
    });
    onPark?.();
  }
  return gate.acquire();
};
