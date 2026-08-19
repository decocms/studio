export {
  enqueueThreadRun,
  runDispatchSteps,
  setThreadGateRuntime,
  THREAD_GATE_PARTITION_CONCURRENCY,
  THREAD_GATE_QUEUE,
  type SerializableDispatchRunInput,
  type ThreadGateContext,
  type ThreadGateOutcome,
  type ThreadGateRuntime,
} from "./thread-gate-workflow";
export {
  cancelHostedHarness,
  HOSTED_HARNESS_QUEUE,
  HOSTED_HARNESS_SANDBOXED_QUEUE,
  setHostedHarnessRuntime,
  type HostedHarnessInput,
  type HostedHarnessRuntime,
} from "./hosted-harness-workflow";
// `hostedChildWorkflowId` is intentionally NOT re-exported here — no caller
// outside this module needs it (`startHostedHarness` and
// `cancelHostedHarness`, both already barrel-exported above, are the only
// consumers). Knip flags an unconsumed barrel re-export as dead code, and per
// repo policy that's fixed by not adding the export, not by suppressing the
// warning. unified-control-plane T7 (stop cancels the live hosted child, not
// just the in-memory run registry) landed by reusing `cancelHostedHarness`
// from `cancelActiveThreadRun` (routes.ts) rather than importing
// `hostedChildWorkflowId` directly — so this stayed internal-only.
