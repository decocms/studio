/**
 * Process-wide gates on concurrent hosted agent-loop runs — TWO of them, one per
 * kind of run, because the two cost this process wildly different amounts:
 *
 * - **in-process** (hosted Decopilot): a full agent loop right here, ~450MB p90.
 *   Bounded by `MAX`, sized against the pod's 2Gi memory limit.
 * - **sandboxed** (`claude-code`): the loop runs in its own pod; this process
 *   only proxies the stream. Bounded by `SANDBOX_MAX`, which is much higher
 *   because memory is not the constraint.
 *
 * They used to share one gate at the in-process number, so a handful of
 * sandboxed runs that cost this pod almost nothing could park an entire board's
 * worth of work behind them.
 *
 * Each in-process run (hostedHarnessWorkflow → runHostedHarness → dispatchRunFn)
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
 * The limit comes from `Settings.decopilotMaxConcurrentHostedRuns`
 * (DECOPILOT_MAX_CONCURRENT_HOSTED_RUNS), validated at startup like every
 * other numeric env var in this codebase — a malformed value fails boot
 * instead of silently coercing to the default.
 */

import { createConcurrencyGate } from "@/harnesses/decopilot/built-in-tools/subagent-concurrency";
import { getSettings } from "@/settings";
import { meter } from "@/observability";
import { harnessRunsInSandbox } from "@/harnesses/sandbox-dispatch-client";

// Default 3: prod worker is 768Mi request / 2Gi limit, run working set p90
// ~450MB — 3×450≈1.35GB stays under the limit, 4-5 would OOM on p90 alone, and
// a lower cap just parks more (which the KEDA queue-depth trigger can't see —
// parked runs are PENDING, not ENQUEUED). The 1.8GB JSON.parse tail can still
// OOM at any cap≥2; that's recovery's job, not this gate's.
const MAX = getSettings().decopilotMaxConcurrentHostedRuns;

/**
 * The cap for a run whose agent loop is NOT in this process.
 *
 * A `claude-code` run executes in its own sandbox pod; this process only proxies
 * its stream, so it never holds the ~450MB working set the number above is sized
 * against. Both harnesses shared that one gate, which meant three sandboxed runs
 * — costing this pod almost nothing — could park a whole board's worth of work
 * behind them. Sizing this off the same memory budget was simply the wrong unit.
 *
 * Default 12 rather than unbounded: a proxied run still costs a NATS
 * subscription, an HTTP stream and its projector, and the sandbox side has its
 * own pool limits. The two gates are independent, so a burst of sandboxed runs
 * can no longer starve an in-process Decopilot run (or vice versa).
 */
const SANDBOX_MAX = getSettings().sandboxMaxConcurrentHostedRuns;

const gate = createConcurrencyGate(MAX);
const sandboxGate = createConcurrencyGate(SANDBOX_MAX);

// The gate caps memory, which flattens the CPU/memory signals a plain HPA scales
// on — so the backlog of PARKED runs is the only thing that reflects saturation.
// Export it as a gauge so a queue-depth/KEDA trigger can add workers when runs
// start waiting (parked runs are pinned to this pod; scaling relieves the queue,
// not the in-flight backlog).
// Both gates are summed into the existing series so the KEDA trigger and any
// dashboard keep working unchanged — saturation of either one is still "runs are
// waiting on this pod", which is what the signal means.
meter
  .createObservableGauge("hosted_runs.active", {
    description: "Hosted agent-loop runs executing on this pod",
    unit: "{runs}",
  })
  .addCallback((r) => r.observe(gate.active + sandboxGate.active));
meter
  .createObservableGauge("hosted_runs.pending", {
    description: "Hosted agent-loop runs parked waiting for a slot on this pod",
    unit: "{runs}",
  })
  .addCallback((r) => r.observe(gate.pending + sandboxGate.pending));

/**
 * Live gate stats for the `/hosted-run-pending` metrics-api endpoint (KEDA).
 * `pending` is the scale signal: parked runs are DBOS-PENDING (dequeued), so
 * they're invisible to the ENQUEUED-only queue-depth endpoint.
 */
export const hostedRunStats = (): {
  active: number;
  pending: number;
  max: number;
} => ({
  active: gate.active + sandboxGate.active,
  pending: gate.pending + sandboxGate.pending,
  max: MAX + SANDBOX_MAX,
});

/** The two caps, separately — for diagnostics and for tests that need to
 *  saturate one specific gate. `hostedRunStats` reports the pod's total
 *  backlog, which is what the KEDA trigger scales on. */
export const HOSTED_RUN_CAPS: { inProcess: number; sandboxed: number } = {
  inProcess: MAX,
  sandboxed: SANDBOX_MAX,
};

/**
 * Acquire a run slot. `onPark` fires (synchronously, before the wait) only when
 * this caller has to queue for a slot — the same condition the log below
 * reports. Callers use it to tell the user their run is waiting: a parked run
 * publishes nothing on its own, and silence on a run's subject is what the
 * projector's idle window reads as a dead executor (see
 * `hosted-harness-workflow.ts`'s `runHostedHarness`).
 */
export const acquireHostedRunSlot = (
  args: {
    harnessId: string | null | undefined;
    /** See `runPriority` — lower goes first. Omit for FIFO. */
    priority?: number;
  },
  onPark?: () => void,
): Promise<() => void> => {
  // Which budget this run spends: its own sandbox pod's, or this pod's memory.
  const sandboxed = harnessRunsInSandbox(args.harnessId);
  const chosen = sandboxed ? sandboxGate : gate;
  const max = sandboxed ? SANDBOX_MAX : MAX;
  // Log when a run parks so a saturating pod is visible in prod — the whole
  // point of the cap. (gate exposes active/pending for exactly this.)
  if (chosen.active >= max) {
    console.log("[hostedHarness] run parked at concurrency cap", {
      active: chosen.active,
      pending: chosen.pending,
      max,
      sandboxed,
      priority: args.priority ?? 0,
    });
    onPark?.();
  }
  return chosen.acquire(args.priority);
};
