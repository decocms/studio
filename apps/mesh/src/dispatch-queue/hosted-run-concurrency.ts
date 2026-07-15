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

const gate = createConcurrencyGate(
  Number(process.env.DECOPILOT_MAX_CONCURRENT_HOSTED_RUNS ?? 3),
);

export const acquireHostedRunSlot = (): Promise<() => void> => gate.acquire();
