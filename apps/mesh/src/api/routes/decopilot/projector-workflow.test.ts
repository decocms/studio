import { describe, expect, test } from "bun:test";
import {
  PROJECTOR_PARTITION_CONCURRENCY,
  PROJECTOR_QUEUE,
  projectorWorkflowId,
  shouldSkipProjection,
} from "./projector-workflow";

describe("projector workflow helpers", () => {
  test("builds deterministic workflow ids on a single partitioned queue", () => {
    expect(projectorWorkflowId("run_1", "fence_a")).toBe(
      "decopilot-project:run_1:fence_a",
    );
    // Single partitioned queue (partitioned by orgId at enqueue time), NOT a
    // per-org queue — mirrors AUTOMATIONS_QUEUE/THREAD_GATE_QUEUE.
    expect(PROJECTOR_QUEUE).toBe("decopilot-projector");
    expect(PROJECTOR_PARTITION_CONCURRENCY).toBe(10);
  });

  test("skips terminal and superseded runs", () => {
    expect(
      shouldSkipProjection({
        status: "completed",
        runFenceToken: "fence_a",
        fenceToken: "fence_a",
      }),
    ).toBe(true);
    expect(
      shouldSkipProjection({
        status: "in_progress",
        runFenceToken: "newer",
        fenceToken: "fence_a",
      }),
    ).toBe(true);
    expect(
      shouldSkipProjection({
        status: "in_progress",
        runFenceToken: "fence_a",
        fenceToken: "fence_a",
      }),
    ).toBe(false);
  });
});
