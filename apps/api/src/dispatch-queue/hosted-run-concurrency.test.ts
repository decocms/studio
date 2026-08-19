import { describe, expect, test } from "bun:test";
import {
  acquireHostedRunSlot,
  HOSTED_RUN_CAPS,
  hostedRunStats,
} from "./hosted-run-concurrency";

describe("hostedRunStats", () => {
  test("reports each gate's own cap, not the summed one", async () => {
    // A saturated in-process gate used to report `active: 3, max: 15`.
    const releases = await Promise.all(
      Array.from({ length: HOSTED_RUN_CAPS.inProcess }, () =>
        acquireHostedRunSlot({ harnessId: "decopilot" }),
      ),
    );
    try {
      const stats = hostedRunStats();
      expect(stats.in_process.active).toBe(HOSTED_RUN_CAPS.inProcess);
      expect(stats.in_process.max).toBe(HOSTED_RUN_CAPS.inProcess);
      // Saturation is only visible per gate — the sandbox budget is untouched.
      expect(stats.sandboxed.active).toBe(0);
      expect(stats.sandboxed.max).toBe(HOSTED_RUN_CAPS.sandboxed);
    } finally {
      for (const release of releases) release();
    }
  });

  test("keeps the summed triple the KEDA trigger reads", async () => {
    const release = await acquireHostedRunSlot({ harnessId: "decopilot" });
    try {
      const stats = hostedRunStats();
      expect(stats.active).toBe(
        stats.in_process.active + stats.sandboxed.active,
      );
      expect(stats.pending).toBe(
        stats.in_process.pending + stats.sandboxed.pending,
      );
      expect(stats.max).toBe(stats.in_process.max + stats.sandboxed.max);
    } finally {
      release();
    }
  });
});
